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
  readSettings,
  recordPass,
  titled,
} from './drive.js';
import {
  absentNotes,
  accountOf,
  type Action,
  fingerprint,
  invalid,
  isRow,
  itemsOf,
  type Kind,
  keepNote,
  type KnownRow,
  type LocalRow,
  noteFields,
  noteId,
  parseList,
  plan,
  PRESENCE,
  type Presence,
  replaceBlock,
  type Row,
} from './notes.js';
import {
  type FlatItem,
  flatten,
  type ItemRow,
  itemText,
  keepListBody,
  listText,
  localList,
  mergeList,
} from './lists.js';
import {
  createNote,
  deleteNote,
  GoogleError,
  type GoogleResponse,
  type KeepCall,
  lookupNotes,
  notePath,
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
/** The hold on a row whose edit waits because sending to Keep is off. */
export const READ_ONLY =
  'Sending edits to Google Keep is off; it is sent once you turn it on.';

/** Thrown for a write while sending to Keep is off; nothing was sent. */
export class ReadOnly extends Error {
  constructor(method: string) {
    super(
      `Sending edits to Google Keep is off, so ${method} was not sent. Turn it on in the settings below.`,
    );
    this.name = 'ReadOnly';
  }
}

/** `call` that sends reads only: every other method throws `ReadOnly` unsent. */
export const readsOnly =
  (call: KeepCall): KeepCall =>
  (method, path, options) => {
    if (method !== 'GET') throw new ReadOnly(method);

    return call(method, path, options);
  };

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
  /** List items (and list titles) changed on both sides: the drive's kept. */
  itemConflicts: number;
}

const text = (value: JSONValue): string =>
  typeof value === 'string' ? value : '';

const titleOf = (row: { title: string; body: string }) =>
  row.title.trim() ||
  row.body.trim().split('\n')[0]?.slice(0, 60) ||
  '(empty note)';

interface ItemEntry {
  row: ItemRow;
  resource: PluginResource;
}

interface TableRows {
  known: KnownRow[];
  locals: LocalRow[];
  resources: Map<string, PluginResource>;
  /** The note ids the table's rows hold now. */
  held: string[];
  /** Each note row's item rows. */
  items: Map<string, ItemEntry[]>;
  /** Item rows whose note row is gone. */
  orphans: PluginResource[];
}

const numberOf = (value: JSONValue): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** The App's item rows, grouped by the note they name. */
async function itemRows(
  store: PluginStore,
  drive: Drive,
): Promise<Map<string, ItemEntry[]>> {
  const p = drive.properties;
  const out = new Map<string, ItemEntry[]>();

  for (const subject of await store.query({
    property: PARENT,
    value: drive.itemsTable,
  })) {
    const resource = await store.getResource(subject);
    if (!asList(resource.get(IS_A)).includes(drive.itemClass)) continue;
    const note = text(resource.get(p.note));
    const under = text(resource.get(p.under));
    const base = numberOf(resource.get(p.base));
    const row: ItemRow = {
      subject,
      text: itemText(text(resource.get(NAME))),
      done: resource.get(p.done) === true,
      position: numberOf(resource.get(p.position)) ?? 0,
      ...(under ? { under } : {}),
      ...(base === undefined ? {} : { base }),
    };
    out.set(note, [...(out.get(note) ?? []), { row, resource }]);
  }

  return out;
}

async function tableRows(store: PluginStore, drive: Drive): Promise<TableRows> {
  const p = drive.properties;
  const items = await itemRows(store, drive);
  const out: TableRows = {
    known: [],
    locals: [],
    resources: new Map(),
    held: [],
    items: new Map(),
    orphans: [],
  };
  const seen = new Set<string>();

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    if (!asList(row.get(IS_A)).includes(drive.rowClass)) continue;
    out.resources.set(subject, row);
    const own = items.get(subject) ?? [];
    items.delete(subject);
    out.items.set(subject, own);
    const listed = text(row.get(p.kind)) === 'list' && own.length > 0;
    const local = {
      title: text(row.get(NAME)),
      body: listed
        ? listText(localList(own.map(i => i.row)))
        : text(row.get(DESCRIPTION)),
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
    const kind: Kind = text(row.get(p.kind)) === 'list' ? 'list' : 'text';
    out.known.push({
      subject,
      id,
      kind,
      // A missing fingerprint counts as "Keep had what the row has", so
      // the next read is taken as Keep's change, never as an edit here.
      synced: text(row.get(p.synced)) || fingerprint(local, kind),
      presence: PRESENCE.includes(presence) ? presence : 'present',
      local,
    });
  }

  for (const entries of items.values())
    out.orphans.push(...entries.map(e => e.resource));

  return out;
}

/** A list note's title as its fingerprint keeps it (its items are merged apart). */
const listPrint = (title: string) => fingerprint({ title, body: '' }, 'list');

/** The row properties for a note as Keep sent it. */
function noteValues(note: Row, drive: Drive): Record<string, JSONValue> {
  const p = drive.properties;
  const fields = noteFields(note);
  const list = fields.kind === 'list';

  return {
    [NAME]: fields.title,
    [DESCRIPTION]: list ? '' : fields.body,
    [p.noteId]: noteId(note)!,
    [p.kind]: fields.kind,
    [p.presence]: 'present',
    [p.updated]: text(note.updateTime as JSONValue),
    [p.synced]: list
      ? listPrint(fields.title)
      : fingerprint(fields, fields.kind),
    ...(list ? { [p.list]: listText(flatten(itemsOf(note))) } : {}),
  };
}

/** Keep's items of a note, flat. */
const keepItems = (note: Row): FlatItem[] => flatten(itemsOf(note));

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

/**
 * The rows a pass with `onlyTitle` set looks at: those of the notes read
 * (already filtered by title), and those whose own title is it. Without a
 * title, all of them.
 */
function only(rows: TableRows, notes: Row[], onlyTitle: string): TableRows {
  if (!onlyTitle) return rows;
  const read = new Set(notes.map(noteId));
  const known = rows.known.filter(
    r => read.has(r.id) || titled(r.local.title, onlyTitle),
  );

  // `held` stays whole: a retiring note another row holds is never deleted.
  return {
    ...rows,
    known,
    locals: rows.locals.filter(r => titled(r.local.title, onlyTitle)),
  };
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
  const { writeBack, onlyTitle } = await readSettings(store, drive);
  // Off, the pass cannot write to Keep even through a path missed below.
  const call = rateLimited(writeBack ? rawCall : readsOnly(rawCall), rateLimit);
  const p = drive.properties;

  // Reads.
  const all = await readNotes(call, { ...read, now: clock });
  const { partial } = all;
  // With a title chosen, every other note and row is left out of the pass.
  const notes = onlyTitle
    ? all.notes.filter(n => titled(noteFields(n).title, onlyTitle))
    : all.notes;
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
  const rows = only(await tableRows(store, drive), notes, onlyTitle);
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
    itemConflicts: 0,
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
    // A list made of item rows is checked by its title only.
    const listed =
      text(row.get(p.kind)) === 'list' &&
      (rows.items.get(subject)?.length ?? 0) > 0;
    const latest = {
      title: text(row.get(NAME)),
      body: listed ? planned.body : text(row.get(DESCRIPTION)),
    };

    return latest.title === planned.title && latest.body === planned.body
      ? row
      : undefined;
  };

  const clearHold = [p.hold, p.lastSeen];

  // Item rows whose note row was deleted here go with it.
  for (const orphan of rows.orphans) await orphan.destroy();

  /**
   * Makes `note`'s item rows the list `items`, in order: updates the rows
   * named, creates the rest, destroys `removed`. `baseOf(j)` is the index of
   * item `j` in the baseline the note row now keeps.
   */
  const writeItems = async (
    note: string,
    items: (FlatItem & { subject?: string })[],
    baseOf: (j: number) => number | undefined,
    removed: string[] = [],
  ) => {
    const own = new Map(
      (rows.items.get(note) ?? []).map(e => [e.row.subject, e.resource]),
    );
    let top: string | undefined;

    for (const [j, item] of items.entries()) {
      const base = baseOf(j);
      const under = item.depth === 1 ? top : undefined;
      const values: Record<string, JSONValue> = {
        [NAME]: item.text,
        [p.done]: item.done,
        [p.note]: note,
        [p.position]: j,
        ...(under ? { [p.under]: under } : {}),
        ...(base === undefined ? {} : { [p.base]: base }),
      };
      const unset = [
        ...(under ? [] : [p.under]),
        ...(base === undefined ? [p.base] : []),
      ];
      const existing = item.subject ? own.get(item.subject) : undefined;
      const subject = existing
        ? (await write(existing, values, unset), existing.subject)
        : (
            await store.newResource({
              parent: drive.itemsTable,
              isA: [drive.itemClass],
              propVals: values,
            })
          ).subject;
      if (item.depth === 0) top = subject;
    }

    for (const subject of removed) await own.get(subject)?.destroy();
  };

  /** All of a note's item rows go (it became a text note). */
  const dropItems = async (note: string) =>
    writeItems(
      note,
      [],
      () => undefined,
      (rows.items.get(note) ?? []).map(e => e.row.subject),
    );

  /**
   * A list note on both sides: its title and items merged (`lists.ts`).
   * When the merge differs from Keep's list, the note is replaced by it,
   * on the same terms as a text note's edit (not shared, no attachment,
   * within Keep's limits, within the pass's writes); otherwise, or until
   * then, the rows take Keep's changes and the baseline becomes Keep's list.
   */
  const mergeNote = async (subject: string, note: Row) => {
    const resource = rows.resources.get(subject)!;
    const own = rows.items.get(subject) ?? [];
    const keepList = keepItems(note);
    const merge = mergeList({
      base: flatten(parseList(text(resource.get(p.list)))),
      rows: own.map(e => e.row),
      keep: keepList,
    });
    const keepTitle = noteFields(note).title;
    const rowTitle = text(resource.get(NAME));
    const synced = text(resource.get(p.synced)) || listPrint(rowTitle);
    const titleHere = listPrint(rowTitle) !== synced;
    const titleThere = listPrint(keepTitle) !== synced;
    const title = titleHere ? rowTitle : keepTitle;
    const titleConflict =
      titleHere && titleThere && rowTitle.trim() !== keepTitle.trim();
    summary.itemConflicts += merge.conflicts + (titleConflict ? 1 : 0);
    const send = merge.send || title.trim() !== keepTitle.trim();

    /** The rows take the merge; the baseline is Keep's list as it is. */
    const keepBaseline = async (hold?: string) => {
      await writeItems(
        subject,
        merge.items,
        j => merge.items[j].keep,
        merge.removed,
      );
      const changed = await write(
        resource,
        {
          ...noteValues(note, drive),
          [NAME]: title,
          ...(hold ? { [p.hold]: hold } : {}),
        },
        hold ? [p.lastSeen] : clearHold,
      );
      if (changed) summary.updated++;
      else summary.unchanged++;
    };

    if (!send) return keepBaseline();

    const reason =
      replaceBlock(note, account) ??
      invalid({ title, body: listText(merge.items), kind: 'list' });

    if (reason) {
      summary.blocked.push({ title: titleOf({ title, body: '' }), reason });

      return keepBaseline(reason);
    }

    if (!writeBack) {
      summary.blocked.push({
        title: titleOf({ title, body: '' }),
        reason: READ_ONLY,
      });

      return keepBaseline(READ_ONLY);
    }

    if (writes >= maxWrites) {
      summary.waiting++;

      return keepBaseline();
    }

    writes++;
    let made: Row;

    try {
      made = await createNote(
        call,
        {
          ...(title.trim() ? { title: title.trim() } : {}),
          body: keepListBody(merge.items),
        },
        clock,
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'GoogleRateLimited')
        throw error;
      summary.failed.push({
        title: titleOf({ title, body: '' }),
        reason: error instanceof Error ? error.message : String(error),
      });

      return keepBaseline();
    }

    const sent = keepItems(made);
    await writeItems(
      subject,
      sent.map((item, j) => ({
        ...item,
        ...(merge.items[j]?.subject ? { subject: merge.items[j].subject } : {}),
      })),
      j => j,
      merge.removed,
    );
    await write(resource, noteValues(made, drive), clearHold);
    ids.add(noteId(made)!);
    summary.replaced++;
    const old = noteId(note)!;

    try {
      await deleteNote(call, old, clock);
    } catch {
      failedDeletes.push(old);
    }
  };

  for (const action of actions as Action[]) {
    switch (action.kind) {
      case 'import': {
        const made = await store.newResource({
          parent: drive.table,
          isA: [drive.rowClass],
          propVals: noteValues(action.note, drive),
        });
        await writeItems(made.subject, keepItems(action.note), j => j);
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
        // A note that changed kind in Keep: its items follow.
        await dropItems(action.subject);
        await writeItems(action.subject, keepItems(action.note), j => j);
        summary.updated++;
        break;
      }

      case 'list': {
        await mergeNote(action.subject, action.note);
        break;
      }

      case 'rebase': {
        const changed = await write(
          rows.resources.get(action.subject)!,
          {
            [p.synced]: fingerprint(
              noteFields(action.note),
              noteFields(action.note).kind,
            ),
            [p.kind]: noteFields(action.note).kind,
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
        if (action.clean) await write(row, {}, [p.hold]);
        summary.unchanged++;
        break;
      }

      case 'conflict': {
        await write(rows.resources.get(action.subject)!, {
          [p.hold]: CONFLICT,
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
        const changed = await write(resource, {
          [p.presence]: action.presence,
          [p.lastSeen]:
            text(resource.get(p.lastSeen)) || lastCompleteAt || seenAt,
        });
        if (changed) summary.updated++;
        else summary.unchanged++;
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

        if (!writeBack) {
          await write(rows.resources.get(action.subject)!, {
            [p.hold]: READ_ONLY,
          });
          summary.blocked.push({ title: titleOf(planned), reason: READ_ONLY });
          break;
        }

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
        // A row made here as a list with item rows: the list from its rows.
        const fromRows =
          action.kind === 'create' && action.fields.kind === 'list'
            ? localList((rows.items.get(action.subject) ?? []).map(e => e.row))
            : [];

        try {
          made = await createNote(
            call,
            fromRows.length
              ? {
                  ...(action.fields.title.trim()
                    ? { title: action.fields.title.trim() }
                    : {}),
                  body: keepListBody(fromRows),
                }
              : keepNote(action.fields),
            clock,
          );
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
        if (noteFields(made).kind === 'list')
          await writeItems(
            action.subject,
            keepItems(made).map((item, j) => ({
              ...item,
              ...(fromRows[j]?.subject ? { subject: fromRows[j].subject } : {}),
            })),
            j => j,
          );
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
  const still: string[] = [...failedDeletes, ...(writeBack ? [] : retiring)];

  for (const id of writeBack ? retiring : []) {
    if (rows.held.includes(id)) continue;

    try {
      await deleteNote(call, id, clock);
    } catch {
      still.push(id);
    }
  }

  summary.retiring = still.length;
  if (account) summary.account = account;

  const after = only(await tableRows(store, drive), notes, onlyTitle);
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

/** Keep's version of a row's note now, read by id. */
async function current(
  call: KeepCall,
  row: PluginResource,
  drive: Drive,
): Promise<Row> {
  const id = text(row.get(drive.properties.noteId));
  const response = await call('GET', notePath(id));
  if (response.status !== 200 || !isRow(response.body))
    throw new GoogleError(
      response.status === 404
        ? 'The note is no longer in Google Keep.'
        : `Google Keep answered ${response.status} for the note.`,
      response.status,
    );

  return response.body as Row;
}

/** A conflict settled for Keep's version: the row takes Keep's note as it is now. */
export async function keepTheirs(
  store: PluginStore,
  call: KeepCall,
  drive: Drive,
  subject: string,
) {
  const row = await store.getResource(subject);
  const note = await current(call, row, drive);
  const p = drive.properties;
  await write(row, noteValues(note, drive), [p.hold, p.lastSeen]);
}

/**
 * A conflict settled for this row's version: Keep's version now becomes
 * the baseline, so the next pass sees only the row's edit and sends it.
 */
export async function keepMine(
  store: PluginStore,
  call: KeepCall,
  drive: Drive,
  subject: string,
) {
  const row = await store.getResource(subject);
  const note = await current(call, row, drive);
  const p = drive.properties;
  const fields = noteFields(note);
  await write(
    row,
    {
      [p.synced]: fingerprint(fields, fields.kind),
      [p.kind]: fields.kind,
      [p.updated]: text(note.updateTime as JSONValue),
    },
    [p.hold],
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
