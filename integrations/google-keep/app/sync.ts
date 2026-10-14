// @wc-ignore-file
/**
 * One two-way pass between the connected Google Keep account and the app's
 * table, carrying out what notes.ts's `plan` decides.
 *
 * Reads first, all of them: the note list, then a by-id check of each note
 * that left it. A read that fails throws before anything is written, here
 * or in Keep. Then, row by row: Keep's changes into rows, rows' changes
 * into Keep, conflicts and blocks marked on their rows. Every Keep write is
 * followed at once by the row write that records it, so the gap in which a
 * closed tab could leave a note without its row is one call wide.
 *
 * At most `MAX_WRITES` notes are created or replaced in one pass; the rest
 * wait for the next pass, which the controller runs while the view is
 * open. A note a replacement could not delete is retried at later passes
 * (`google-keep-retiring`) and never imported meanwhile.
 *
 * A pass refuses to run against another Google account than the one the
 * table synced with before (`AccountMismatch`), so one person's notes never
 * mark another's as deleted.
 */
import {
  appValue,
  asList,
  DESCRIPTION,
  type Drive,
  idList,
  IS_A,
  lastSync,
  NAME,
  PARENT,
  recordPass,
} from './drive.js';
import {
  absentNotes,
  accountOf,
  type Action,
  isRow,
  keepNote,
  type KnownRow,
  type LocalRow,
  noteFields,
  noteId,
  plan,
  PRESENCE,
  type Presence,
  type Row,
} from './notes.js';
import {
  createNote,
  deleteNote,
  type GoogleResponse,
  type KeepCall,
  lookupNotes,
  rateLimited,
  type RateLimitOptions,
  readNotes,
} from './read.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

/** The integration proxy's platform id for Google Keep. */
export const PLATFORM = 'google-keep';
/** Notes created or replaced in Keep per pass at most. */
export const MAX_WRITES = 25;
/** The hold a conflict leaves on its row. */
export const CONFLICT = 'conflict';

/** A `KeepCall` over the host's proxy relay; the frame never holds a credential. */
export function relayCall(
  proxy: HostProxy,
  connection: { platform: string; connectionId: string },
): KeepCall {
  return async (method, path, options = {}) => {
    if (!/^\/v1\/notes(?:\/[^/]+)?$/.test(path))
      throw new Error(`Refusing a Google Keep path: ${path}`);
    const response = await proxy.request({
      platform: connection.platform,
      connectionId: connection.connectionId,
      path,
      method,
      ...(options.query && Object.keys(options.query).length
        ? { query: options.query }
        : {}),
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });

    return {
      status: response.status,
      body: response.body,
      ...(response.headers ? { headers: response.headers } : {}),
    } as GoogleResponse;
  };
}

/** The connection is to another Google account than the table syncs with. */
export class AccountMismatch extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `This table syncs with the Google account ${expected}; the connection is to ${actual}. Nothing was synced.`,
    );
    this.name = 'AccountMismatch';
  }
}

export interface SyncSummary {
  /** Rows from Keep in the table after the pass. */
  total: number;
  /** Rows imported from Keep. */
  added: number;
  /** Rows that took Keep's changes. */
  updated: number;
  unchanged: number;
  /** Notes created in Keep for rows made here. */
  created: number;
  /** Notes replaced in Keep with a row's edit. */
  replaced: number;
  /** Rows whose edit waits for a later pass (the per-pass write cap). */
  waiting: number;
  /** Rows marked as a conflict. */
  conflicts: number;
  /** Rows whose edit cannot be sent, with why. */
  blocked: { title: string; reason: string }[];
  /** Keep writes that failed, with why; nothing else was written for them. */
  failed: { title: string; reason: string }[];
  presence: Record<Presence, number>;
  /** Notes whose row was deleted here: still in Keep, not imported again. */
  removedHere: { id: string; title: string }[];
  /** Absent notes looked up by id in this pass. */
  checked: number;
  /** Whether the note list was read completely. */
  complete: boolean;
  /** The Google account, when the notes say. */
  account?: string;
  /** Old notes still to delete after a replacement. */
  retiring: number;
}

const text = (value: JSONValue): string =>
  typeof value === 'string' ? value : '';

const parse = (value: JSONValue): Row | undefined => {
  try {
    const parsed: unknown = JSON.parse(text(value) || 'null');

    return isRow(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const titleOf = (row: { title: string; body: string }) =>
  row.title.trim() ||
  row.body.trim().split('\n')[0]?.slice(0, 60) ||
  '(empty note)';

interface TableRows {
  known: KnownRow[];
  locals: LocalRow[];
  resources: Map<string, PluginResource>;
  /** The note ids the table's rows hold now. */
  held: string[];
}

async function tableRows(store: PluginStore, drive: Drive): Promise<TableRows> {
  const p = drive.properties;
  const out: TableRows = {
    known: [],
    locals: [],
    resources: new Map(),
    held: [],
  };
  const seen = new Set<string>();

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    if (!asList(row.get(IS_A)).includes(drive.rowClass)) continue;
    out.resources.set(subject, row);
    const local = {
      title: text(row.get(NAME)),
      body: text(row.get(DESCRIPTION)),
    };
    const id = text(row.get(p.noteId));

    if (!id) {
      out.locals.push({ subject, local });
      continue;
    }

    // A second row for the same note is left alone.
    if (seen.has(id)) continue;
    seen.add(id);
    out.held.push(id);
    const presence = text(row.get(p.presence)) as Presence;
    out.known.push({
      subject,
      id,
      // An unreadable baseline counts as "Keep had what the row has", so
      // the next read is taken as Keep's change, never as an edit here.
      source: parse(row.get(p.source)) ?? {
        name: id,
        title: local.title,
        body: { text: { text: local.body } },
      },
      presence: PRESENCE.includes(presence) ? presence : 'present',
      local,
    });
  }

  return out;
}

/** The row properties for a note as Keep sent it. */
function noteValues(note: Row, drive: Drive): Record<string, JSONValue> {
  const p = drive.properties;
  const fields = noteFields(note);

  return {
    [NAME]: fields.title,
    [DESCRIPTION]: fields.body,
    [p.noteId]: noteId(note)!,
    [p.kind]: fields.kind,
    [p.presence]: 'present',
    [p.updated]: text(note.updateTime as JSONValue),
    [p.source]: JSON.stringify(note),
  };
}

/** Sets what differs and removes what is set; saves only when something changed. */
async function write(
  row: PluginResource,
  set: Record<string, JSONValue>,
  unset: string[] = [],
): Promise<boolean> {
  const changed = Object.entries(set).filter(([k, v]) => row.get(k) !== v);
  const removed = unset.filter(
    k => row.get(k) !== undefined && row.get(k) !== '',
  );
  if (!changed.length && !removed.length) return false;
  for (const [k, v] of changed) row.set(k, v);
  for (const k of removed) row.remove(k);
  await row.save();

  return true;
}

export interface SyncOptions {
  now?: () => string;
  read?: { pageSize?: number; maxPages?: number };
  maxLookups?: number;
  maxWrites?: number;
  rateLimit?: RateLimitOptions;
}

/** One two-way pass. Throws before any write when a read fails or the account differs. */
export async function syncNotes(
  store: PluginStore,
  rawCall: KeepCall,
  drive: Drive,
  {
    now = () => new Date().toISOString(),
    read,
    maxLookups,
    maxWrites = MAX_WRITES,
    rateLimit,
  }: SyncOptions = {},
): Promise<SyncSummary> {
  const clock = () => Date.parse(now());
  const call = rateLimited(rawCall, rateLimit);
  const p = drive.properties;

  // Reads.
  const { notes, partial } = await readNotes(call, { ...read, now: clock });
  const recorded = text(await appValue(store, drive, 'account')) || undefined;
  const seenAccount = accountOf(notes);
  if (recorded && seenAccount && recorded !== seenAccount)
    throw new AccountMismatch(recorded, seenAccount);
  let account = recorded ?? seenAccount;
  const known = idList(await appValue(store, drive, 'known'));
  const retiring = idList(await appValue(store, drive, 'retiring'));
  /** Old notes this pass's replacements could not delete: retried next pass. */
  const failedDeletes: string[] = [];
  const lastCompleteAt = await lastSync(store, drive, clock());
  const rows = await tableRows(store, drive);
  const complete = !partial;
  const lookups = await lookupNotes(
    call,
    absentNotes(rows.known, notes, complete),
    {
      ...(maxLookups === undefined ? {} : { maxLookups }),
      now: clock,
    },
  );
  const seenAt = now();
  const actions = plan({
    rows: rows.known,
    locals: rows.locals,
    notes,
    complete,
    lookups,
    known,
    retiring,
    ...(account ? { account } : {}),
  });

  const summary: SyncSummary = {
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    created: 0,
    replaced: 0,
    waiting: 0,
    conflicts: 0,
    blocked: [],
    failed: [],
    presence: { present: 0, trashed: 0, deleted: 0, unconfirmed: 0 },
    removedHere: [],
    checked: lookups.length,
    complete,
    retiring: 0,
  };
  const ids = new Set([...known, ...rows.held]);
  const byRow = new Map(rows.known.map(r => [r.subject, r]));
  const localOf = new Map(rows.locals.map(r => [r.subject, r]));
  let writes = 0;

  /** Re-reads a row just before a Keep write: it may have changed, or another browser sent it. */
  const fresh = async (
    subject: string,
    planned: { title: string; body: string },
  ) => {
    const row = await store.getResource(subject).catch(() => undefined);
    if (!row) return undefined;
    const current = {
      title: text(row.get(NAME)),
      body: text(row.get(DESCRIPTION)),
    };

    return current.title === planned.title && current.body === planned.body
      ? row
      : undefined;
  };

  const clearHold = [p.hold, p.incoming, p.lastSeen];

  for (const action of actions as Action[]) {
    switch (action.kind) {
      case 'import': {
        await store.newResource({
          parent: drive.table,
          isA: [drive.rowClass],
          propVals: noteValues(action.note, drive),
        });
        ids.add(noteId(action.note)!);
        summary.added++;
        break;
      }

      case 'pull': {
        await write(
          rows.resources.get(action.subject)!,
          noteValues(action.note, drive),
          clearHold,
        );
        summary.updated++;
        break;
      }

      case 'rebase': {
        const changed = await write(
          rows.resources.get(action.subject)!,
          {
            [p.source]: JSON.stringify(action.note),
            [p.updated]: text(action.note.updateTime as JSONValue),
            [p.presence]: 'present',
          },
          clearHold,
        );
        if (changed) summary.updated++;
        else summary.unchanged++;
        break;
      }

      case 'unchanged': {
        const row = rows.resources.get(action.subject)!;
        if (action.clean) await write(row, {}, [p.hold, p.incoming]);
        summary.unchanged++;
        break;
      }

      case 'conflict': {
        await write(rows.resources.get(action.subject)!, {
          [p.hold]: CONFLICT,
          [p.incoming]: JSON.stringify(action.note),
        });
        summary.conflicts++;
        break;
      }

      case 'blocked': {
        const local =
          byRow.get(action.subject)?.local ??
          localOf.get(action.subject)!.local;
        await write(rows.resources.get(action.subject)!, {
          [p.hold]: action.reason,
        });
        summary.blocked.push({ title: titleOf(local), reason: action.reason });
        break;
      }

      case 'settle': {
        const resource = rows.resources.get(action.subject)!;
        await write(resource, {
          [p.presence]: action.presence,
          [p.lastSeen]:
            text(resource.get(p.lastSeen)) || lastCompleteAt || seenAt,
        });
        break;
      }

      case 'removed-here': {
        const id = noteId(action.note)!;
        summary.removedHere.push({
          id,
          title: titleOf(noteFields(action.note)),
        });
        break;
      }

      case 'push':

      case 'create': {
        const planned =
          action.kind === 'push'
            ? byRow.get(action.subject)!.local
            : localOf.get(action.subject)!.local;

        if (writes >= maxWrites) {
          summary.waiting++;
          break;
        }

        const row = await fresh(action.subject, planned);

        // Edited again since the read, or (a new row) sent by another
        // browser meanwhile: the next pass decides afresh.
        if (!row || (action.kind === 'create' && text(row.get(p.noteId)))) {
          summary.waiting++;
          break;
        }

        writes++;
        let made: Row;

        try {
          made = await createNote(call, keepNote(action.fields), clock);
        } catch (error) {
          if (error instanceof Error && error.name === 'GoogleRateLimited')
            throw error;
          summary.failed.push({
            title: titleOf(planned),
            reason: error instanceof Error ? error.message : String(error),
          });
          break;
        }

        await write(row, noteValues(made, drive), clearHold);
        ids.add(noteId(made)!);
        account ??= accountOf([made]);

        if (action.kind === 'create') {
          summary.created++;
          break;
        }

        summary.replaced++;
        const old = noteId(action.note)!;

        try {
          await deleteNote(call, old, clock);
        } catch {
          failedDeletes.push(old);
        }

        break;
      }
    }
  }

  // Old notes of earlier passes' replacements: try the delete again.
  const still: string[] = [...failedDeletes];

  for (const id of retiring) {
    if (rows.held.includes(id)) continue;

    try {
      await deleteNote(call, id, clock);
    } catch {
      still.push(id);
    }
  }

  summary.retiring = still.length;
  if (account) summary.account = account;

  const after = await tableRows(store, drive);
  summary.total = after.known.length;
  for (const row of after.known) summary.presence[row.presence]++;

  await recordPass(store, drive, {
    at: seenAt,
    complete,
    known: [...ids],
    retiring: still,
    ...(account ? { account } : {}),
  });

  return summary;
}

/** A row as the view lists it. */
export interface NoteRow {
  subject: string;
  noteId?: string;
  title: string;
  kind: string;
  /** present, trashed, deleted, unconfirmed, or `local` for a row not in Keep yet. */
  presence: string;
  /** Why an edit here is not sent: `conflict`, or a reason. */
  hold?: string;
  lastSeen?: string;
}

export async function listNotes(
  store: PluginStore,
  drive: Drive,
): Promise<NoteRow[]> {
  const p = drive.properties;
  const out: NoteRow[] = [];

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    if (!asList(row.get(IS_A)).includes(drive.rowClass)) continue;
    const id = text(row.get(p.noteId));
    const local = {
      title: text(row.get(NAME)),
      body: text(row.get(DESCRIPTION)),
    };
    const optional = {
      noteId: id || undefined,
      hold: text(row.get(p.hold)) || undefined,
      lastSeen: text(row.get(p.lastSeen)) || undefined,
    };
    out.push({
      subject,
      title: titleOf(local),
      kind: text(row.get(p.kind)) || 'text',
      presence: id ? text(row.get(p.presence)) || 'present' : 'local',
      ...Object.fromEntries(
        Object.entries(optional).filter(([, v]) => v !== undefined),
      ),
    });
  }

  return out.sort(
    (a, b) =>
      a.title.localeCompare(b.title) || a.subject.localeCompare(b.subject),
  );
}

/** A conflict settled for Keep's version: the row takes it. */
export async function keepTheirs(
  store: PluginStore,
  drive: Drive,
  subject: string,
) {
  const row = await store.getResource(subject);
  const incoming = parse(row.get(drive.properties.incoming));
  if (!incoming || !noteId(incoming)) return;
  const p = drive.properties;
  await write(row, noteValues(incoming, drive), [
    p.hold,
    p.incoming,
    p.lastSeen,
  ]);
}

/**
 * A conflict settled for this row's version: Keep's version becomes the
 * baseline, so the next pass sees only the row's edit and sends it.
 */
export async function keepMine(
  store: PluginStore,
  drive: Drive,
  subject: string,
) {
  const row = await store.getResource(subject);
  const p = drive.properties;
  const incoming = parse(row.get(p.incoming));
  if (!incoming || !noteId(incoming)) return;
  await write(
    row,
    {
      [p.source]: JSON.stringify(incoming),
      [p.updated]: text(incoming.updateTime as JSONValue),
    },
    [p.hold, p.incoming],
  );
}

/** A note whose row was deleted here is imported again at the next pass. */
export async function restoreRemoved(
  store: PluginStore,
  drive: Drive,
  id: string,
) {
  const app = await store.getResource(drive.app);
  const known = idList(app.get(drive.properties.known));
  if (!known.includes(id)) return;
  await app
    .set(drive.properties.known, JSON.stringify(known.filter(k => k !== id)))
    .save();
}

/** Deletes, for good, a note whose row was deleted here. Only on the person's request. */
export async function deleteRemoved(call: KeepCall, id: string): Promise<void> {
  await deleteNote(call, id);
}
