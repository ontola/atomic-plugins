// @wc-ignore-file
/**
 * Edits in the drive reach Clockify (#123 M3, following #177 §4).
 *
 * - **Bookkeeping on the row** (#177 Q4). Each row carries, as provider
 *   extras that are not table columns: `clockify-sync-baseline`, the values
 *   the row and Clockify last agreed on; `clockify-outbox`, a marker written
 *   before a write and cleared once a read confirmed it; and
 *   `clockify-delete`, a requested deletion.
 * - **A change is the row differing from its baseline**, however it was
 *   made: in this app's drawer, in the table, in another view or on another
 *   device. It is found when the app opens or syncs (compare on open; the
 *   host has no change feed yet, #177 H6), and never sent without review.
 * - **Three-way decision** per row with `reconcileRecord` (the sync engine's,
 *   as the calendar app uses it) over (baseline, row, Clockify): a change on
 *   one side only is taken over by the other; a field changed on both sides
 *   is a conflict, and **Clockify wins** (#177 §4.4): the row gets
 *   Clockify's value and the view says which value was dropped.
 * - **Sending** (`sendChanges`), per entry, one request at a time: a fresh
 *   `GET` of the entry; the three-way check against it (a conflict sends
 *   nothing); the outbox marker; a full-replacement `PUT` built by the lens
 *   from the fresh full record, or a `DELETE`; a verification `GET`. The
 *   baseline advances only after that read, to what Clockify then holds.
 *   Every read and write response goes into the observation log, so the
 *   views follow. Clockify has no ETag or If-Match (#97 §4.4): a change made
 *   in Clockify between the fresh read and the write is overwritten; the
 *   verification read shows what won.
 *
 * Not here: range edits ("worked on P over [a, b)", trims and splits; #123
 * M4), the multi-device lease (M5), and noticing a row deleted in the
 * table (needs the host's change list with tombstones, #177 H6b).
 */
import { reconcileRecord } from '../../../browser/lib/src/plugin-reconcile.js';
import {
  blockers,
  changedFields,
  ENTRY_FIELDS,
  entryValues,
  NO_DESCRIPTION,
  putBody,
  snapToMinute,
  type ClockifyProject,
  type ClockifyTimeEntry,
  type EntryField,
  type EntryValues,
  type WriteContext,
} from '../devonian/clockify/lens/index.js';
import type { RawTimeEntry } from './clockifyApi.js';
import {
  canonicalEntry,
  ENTRY_MASK,
  rawFromCanonical,
  readOne,
  TIME_ENTRY,
  timeEntries,
  type ReadContext,
} from './clockifyObserve.js';
import type { ObservationLog } from './observationLog.js';
import type { Mirror, MirrorRecord } from './observations.js';
import { atomic, NAME } from './ontology.js';
import { retryAfterSeconds } from './problem.js';
import type { CompleteSchema } from './schema.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';
import { ProxyRefusal, type WriteInit } from './transport.js';

export type {
  EntryField,
  EntryValues,
} from '../devonian/clockify/lens/index.js';

/** What a row says about its sync, read from its values and extras. */
export interface RowState {
  subject: string;
  entryId: string;
  local: EntryValues;
  baseline?: EntryValues;
  outbox?: OutboxMarker;
  deleteRequested: boolean;
}

/** Written before a write goes out, cleared once a read confirmed it. */
export interface OutboxMarker {
  op: 'put' | 'delete';
  /** ISO 8601. */
  sentAt: string;
}

export interface PendingChange {
  kind: 'update' | 'delete';
  entryId: string;
  subject: string;
  /** The entry's Name as Clockify last had it. */
  title: string;
  /** The baseline: Clockify's values when the row last agreed. */
  base: EntryValues;
  /** The row as it was when this change was listed (the review). */
  local: EntryValues;
  /** What would be sent: the row, with changed times snapped to minutes
   * and a typed project name resolved to its id. */
  desired: EntryValues;
  /** `base` → `desired`, in display order. Empty for a deletion. */
  fields: EntryField[];
  /** Why it cannot be sent, if it cannot. */
  blockers: string[];
}

/** A field changed here and in Clockify: Clockify's value was kept. */
export interface ProviderWon {
  entryId: string;
  title: string;
  fields: Array<{
    field: EntryField | 'delete';
    yours: EntryValues[EntryField] | 'delete';
    clockify: EntryValues[EntryField] | 'kept';
  }>;
}

export type SendStatus =
  /** Clockify confirmed exactly what was sent. */
  | 'sent'
  /** Clockify confirmed the write but holds other values; the row has them. */
  | 'adjusted'
  /** Clockify already had these values: nothing was written. */
  | 'already'
  /** Changed in Clockify since the review: nothing was written, Clockify's
   * values were kept for the fields changed on both sides. */
  | 'conflict'
  /** Not writable (locked, running, custom fields, …): nothing was written. */
  | 'refused'
  /** Clockify or the proxy answered with an error: not applied. */
  | 'failed'
  /** No answer, or a 5xx: it may or may not have been applied. The next
   * sync reads it back. The batch stops here. */
  | 'uncertain'
  /** Not attempted, after an uncertain one. */
  | 'not-sent'
  /** The row changed after the review: not sent; review it again. */
  | 'changed'
  /** Deleted in Clockify: the row was removed. */
  | 'gone';

export interface SendOutcome {
  entryId: string;
  title: string;
  kind: PendingChange['kind'];
  status: SendStatus;
  message?: string;
  /** For `adjusted` and `conflict`: the fields concerned. */
  fields?: EntryField[];
}

const text = (value: JSONValue) =>
  typeof value === 'string' && value ? value : null;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const ordered = (v: EntryValues): EntryValues => ({
  name: v.name,
  start: v.start,
  end: v.end,
  billable: v.billable,
  projectId: v.projectId,
  project: v.project,
});

function parseJson<T>(value: JSONValue): T | undefined {
  if (typeof value !== 'string' || !value) return undefined;

  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function isValues(value: unknown): value is EntryValues {
  const v = value as EntryValues | undefined;

  return (
    !!v &&
    typeof v.name === 'string' &&
    typeof v.start === 'number' &&
    typeof v.end === 'number' &&
    typeof v.billable === 'boolean'
  );
}

/** The row's own values, as the lens compares them. */
export function localValues(
  row: PluginResource,
  schema: CompleteSchema,
): EntryValues | undefined {
  const start = row.get(schema.row.start);
  const end = row.get(schema.row.end);
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  const name = row.get(NAME);

  return {
    name: typeof name === 'string' ? name : '',
    start,
    end,
    billable: row.get(schema.row.billable) === true,
    projectId: text(row.get(schema.row.projectId)),
    project: text(row.get(schema.row.projectName)),
  };
}

export function readRowState(
  row: PluginResource,
  schema: CompleteSchema,
): RowState | undefined {
  const entryId = text(row.get(schema.row.entryId));
  const local = localValues(row, schema);
  if (!entryId || !local) return undefined;
  const baseline = parseJson<EntryValues>(row.get(schema.sync.baseline));
  const outbox = parseJson<OutboxMarker>(row.get(schema.sync.outbox));

  return {
    subject: row.subject,
    entryId,
    local,
    ...(isValues(baseline) ? { baseline: ordered(baseline) } : {}),
    ...(outbox?.op ? { outbox } : {}),
    deleteRequested: row.get(schema.sync.deleteRequested) === true,
  };
}

/**
 * Sets the row's synced values to `values`, only where they differ. A
 * value that goes away is written as an empty string (the host's `remove`
 * is not needed for that). Returns whether anything was set.
 */
export function setRowValues(
  row: PluginResource,
  schema: CompleteSchema,
  values: EntryValues,
): boolean {
  const wanted: Record<string, JSONValue> = {
    [NAME]: values.name,
    [schema.row.start]: values.start,
    [schema.row.end]: values.end,
    [schema.row.billable]: values.billable,
    [schema.row.projectId]: values.projectId ?? '',
    [schema.row.projectName]: values.project ?? '',
  };
  let changed = false;

  for (const [property, value] of Object.entries(wanted)) {
    const current = row.get(property);
    if (current === value || (value === '' && current === undefined)) continue;
    row.set(property, value);
    changed = true;
  }

  return changed;
}

/** The row values for a new row; no project stays unset. */
export function newRowValues(
  schema: CompleteSchema,
  values: EntryValues,
): Record<string, JSONValue> {
  return {
    [NAME]: values.name,
    [schema.row.start]: values.start,
    [schema.row.end]: values.end,
    [schema.row.billable]: values.billable,
    ...(values.projectId ? { [schema.row.projectId]: values.projectId } : {}),
    ...(values.project ? { [schema.row.projectName]: values.project } : {}),
    [schema.sync.baseline]: JSON.stringify(ordered(values)),
  };
}

function setBookkeeping(
  row: PluginResource,
  schema: CompleteSchema,
  p: { baseline?: EntryValues; outbox?: OutboxMarker | null; delete?: boolean },
): boolean {
  let changed = false;

  const put = (property: string, value: JSONValue) => {
    const current = row.get(property);
    if (current === value || (value === '' && current === undefined)) return;
    if (value === false && current === undefined) return;
    row.set(property, value);
    changed = true;
  };

  if (p.baseline)
    put(schema.sync.baseline, JSON.stringify(ordered(p.baseline)));
  if (p.outbox !== undefined)
    put(schema.sync.outbox, p.outbox ? JSON.stringify(p.outbox) : '');
  if (p.delete !== undefined) put(schema.sync.deleteRequested, p.delete);

  return changed;
}

/** The mirror's entry `id` in Clockify's shape, if it holds a live one. */
export function mirrorEntry(
  mirror: Mirror,
  id: string,
): ClockifyTimeEntry | undefined {
  const record: MirrorRecord | undefined = timeEntries(mirror).find(
    r => r.id === id,
  );
  if (!record || record.deletedAt) return undefined;

  return rawFromCanonical(record) as ClockifyTimeEntry;
}

export const projectNames =
  (projects: ClockifyProject[]) =>
  (id: string): string | undefined =>
    projects.find(p => p.id === id)?.name;

/**
 * What would be sent for a row: its values, with changed times snapped to
 * whole minutes (#97 answer 7), an empty Name as "no description", and a
 * project name typed into the table resolved to that project's id (an
 * exact, active name; otherwise a blocker).
 */
export function desiredValues(
  local: EntryValues,
  base: EntryValues,
  projects: ClockifyProject[],
): { desired: EntryValues; problems: string[] } {
  const problems: string[] = [];
  const desired: EntryValues = {
    ...ordered(local),
    name: local.name.trim() || NO_DESCRIPTION,
  };
  if (desired.start !== base.start) desired.start = snapToMinute(desired.start);
  if (desired.end !== base.end) desired.end = snapToMinute(desired.end);

  if (desired.projectId === base.projectId && desired.project !== base.project)
    if (!desired.project) desired.projectId = null;
    else {
      const named = projects.filter(
        p => p.name === desired.project && p.archived !== true,
      );
      if (named.length === 1) desired.projectId = named[0].id;
      else
        problems.push(
          named.length
            ? `More than one active project is named “${desired.project}”.`
            : `No active project is named “${desired.project}”.`,
        );
    }

  // The name shown is the chosen project's, unless a typed name could not
  // be resolved: then it stays as typed, next to the problem.
  if (!problems.length)
    desired.project = desired.projectId
      ? (projectNames(projects)(desired.projectId) ?? desired.project)
      : null;

  return { desired, problems };
}

/**
 * The change a row holds, if any: a requested deletion, or its values
 * differing from its baseline. `entry` is the mirror's copy of the Clockify
 * entry (for what may be written); `undefined` blocks the change.
 */
export function planChange(
  state: RowState,
  entry: ClockifyTimeEntry | undefined,
  context: WriteContext,
): PendingChange | undefined {
  const base = state.baseline;
  if (!base) return undefined;
  const missing = entry
    ? []
    : ['This entry is not in what was last read from Clockify. Sync first.'];
  const common = {
    entryId: state.entryId,
    subject: state.subject,
    title: base.name,
    base,
    local: state.local,
  };

  if (state.deleteRequested)
    return {
      ...common,
      kind: 'delete',
      desired: base,
      fields: [],
      blockers: [...missing, ...(entry ? blockers(entry, context) : [])],
    };

  const { desired, problems } = desiredValues(
    state.local,
    base,
    context.projects,
  );
  const changed = changedFields(base, desired);
  // A project name that resolves to no project still changed the row.
  const fields = ENTRY_FIELDS.filter(
    f =>
      changed.includes(f) ||
      (f === 'projectId' && desired.project !== base.project),
  );
  if (!fields.length) return undefined;

  return {
    ...common,
    kind: 'update',
    desired,
    fields,
    blockers: [
      ...missing,
      ...problems,
      ...(entry ? blockers(entry, context, desired) : []),
    ],
  };
}

export interface RowReconcile {
  /** What the row should hold now. */
  values: EntryValues;
  baseline: EntryValues;
  /** Fields changed on both sides, where Clockify's value was kept. */
  providerWon: EntryField[];
  /** A requested deletion dropped because Clockify changed the entry. */
  deleteDropped: boolean;
}

/**
 * One row against Clockify's current values (a sync pass). Without a
 * baseline (a row from before 0.2.0), the row takes Clockify's values, as
 * every pass did before.
 */
export function reconcileRow(
  state: RowState,
  remote: EntryValues,
): RowReconcile {
  const base = state.baseline;
  if (!base)
    return {
      values: remote,
      baseline: remote,
      providerWon: [],
      deleteDropped: false,
    };
  const decision = reconcileRecord(
    ordered(base),
    ordered(state.local),
    ordered(remote),
  );
  const values: EntryValues = { ...ordered(state.local) };
  for (const key of Object.keys(decision.local) as EntryField[])
    (values as Record<string, unknown>)[key] = remote[key];
  const providerWon: EntryField[] = [];

  for (const conflict of decision.conflicts) {
    const key = conflict.property as EntryField;
    (values as Record<string, unknown>)[key] = remote[key];
    if ((ENTRY_FIELDS as readonly string[]).includes(key))
      providerWon.push(key);
  }

  return {
    values,
    baseline: remote,
    providerWon,
    deleteDropped:
      state.deleteRequested && !same(ordered(base), ordered(remote)),
  };
}

/** The row's side of a `ProviderWon` notice. */
export function providerWonNotice(
  state: RowState,
  result: RowReconcile,
): ProviderWon | undefined {
  const fields: ProviderWon['fields'] = result.providerWon.map(field => ({
    field,
    yours: state.local[field],
    clockify: result.values[field],
  }));
  if (result.deleteDropped)
    fields.push({ field: 'delete', yours: 'delete', clockify: 'kept' });
  if (!fields.length) return undefined;

  return { entryId: state.entryId, title: result.values.name, fields };
}

/**
 * Applies a sync pass's reading of Clockify (`remote`) to a row: takes
 * Clockify's changes, keeps the row's own, lets Clockify win conflicts,
 * clears an outbox marker (the read just made settles it either way), and
 * advances the baseline. `extras` are provider-only columns (who tracked
 * it), set as Clockify has them. Saves only when something changed.
 * Returns what the pass reports.
 */
export async function syncRow(
  row: PluginResource,
  schema: CompleteSchema,
  remote: EntryValues,
  extras: Record<string, JSONValue> = {},
): Promise<{
  valuesChanged: boolean;
  notice?: ProviderWon;
  recovered?: 'applied' | 'not-applied';
  state: RowState;
}> {
  const state = readRowState(row, schema);
  let extrasChanged = false;

  for (const [property, value] of Object.entries(extras))
    if (row.get(property) !== value) {
      row.set(property, value);
      extrasChanged = true;
    }

  if (!state) {
    const changed = setRowValues(row, schema, remote) || extrasChanged;
    setBookkeeping(row, schema, { baseline: remote });
    await row.save();

    return {
      valuesChanged: changed,
      state: readRowState(row, schema)!,
    };
  }

  const result = reconcileRow(state, remote);
  const valuesChanged =
    setRowValues(row, schema, result.values) || extrasChanged;
  const bookkeeping = setBookkeeping(row, schema, {
    baseline: result.baseline,
    ...(state.outbox ? { outbox: null } : {}),
    ...(result.deleteDropped ? { delete: false } : {}),
  });
  if (valuesChanged || bookkeeping) await row.save();
  const notice = providerWonNotice(state, result);

  return {
    valuesChanged,
    ...(notice ? { notice } : {}),
    ...(state.outbox
      ? {
          recovered: same(ordered(state.local), ordered(remote))
            ? ('applied' as const)
            : ('not-applied' as const),
        }
      : {}),
    state: { ...state, local: result.values, baseline: result.baseline },
  };
}

/** Marks a row's entry for deletion in Clockify (sent after review). */
export async function requestDelete(
  row: PluginResource,
  schema: CompleteSchema,
  wanted: boolean,
): Promise<void> {
  if (setBookkeeping(row, schema, { delete: wanted })) await row.save();
}

/** Puts the row back to its baseline and drops a requested deletion. */
export async function discardChange(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<void> {
  const state = readRowState(row, schema);
  if (!state?.baseline) return;
  const changed = setRowValues(row, schema, state.baseline);
  const flag = setBookkeeping(row, schema, { delete: false });
  if (changed || flag) await row.save();
}

export interface SendContext {
  store: PluginStore;
  schema: CompleteSchema;
  log: ObservationLog;
  read: ReadContext;
  write: WriteContext;
  /** Waits before retrying a 429. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** The longest `retry-after` the app waits for before giving up on a send. */
export const MAX_RETRY_WAIT_SECONDS = 60;

const NOT_IN_CATALOG = 'method or path is not in the catalog';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const bodyMessage = (body: unknown) =>
  typeof body === 'string'
    ? body
    : body && typeof body === 'object' && 'message' in body
      ? String((body as { message: unknown }).message)
      : '';

class Uncertain extends Error {}
class Stop extends Error {}

/**
 * Sends reviewed changes, one entry at a time, in the order given. An
 * uncertain write stops the batch (the rest are `not-sent`), as does a
 * proxy refusal or a proxy without the write overlay. Flushes the log.
 */
export async function sendChanges(
  context: SendContext,
  changes: PendingChange[],
): Promise<SendOutcome[]> {
  const outcomes: SendOutcome[] = [];
  let stopped = false;

  for (const [index, change] of changes.entries()) {
    context.onProgress?.(index, changes.length);
    const base = {
      entryId: change.entryId,
      title: change.title,
      kind: change.kind,
    };

    if (stopped) {
      outcomes.push({ ...base, status: 'not-sent' });
      continue;
    }

    try {
      outcomes.push({ ...base, ...(await sendOne(context, change)) });
    } catch (error) {
      if (error instanceof Uncertain) {
        outcomes.push({ ...base, status: 'uncertain', message: error.message });
        stopped = true;
      } else if (error instanceof Stop) {
        outcomes.push({ ...base, status: 'failed', message: error.message });
        stopped = true;
      } else
        outcomes.push({ ...base, status: 'failed', message: message(error) });
    }
  }

  context.onProgress?.(changes.length, changes.length);
  await context.log.compactIfNeeded();
  await context.log.flush();

  return outcomes;
}

type Result = Omit<SendOutcome, 'entryId' | 'title' | 'kind'>;

async function sendOne(
  context: SendContext,
  change: PendingChange,
): Promise<Result> {
  const { store, schema, log } = context;
  const row = await store.getResource(change.subject);
  const state = readRowState(row, schema);

  if (
    !state ||
    !same(ordered(state.local), ordered(change.local)) ||
    state.deleteRequested !== (change.kind === 'delete')
  )
    return {
      status: 'changed',
      message: 'The row changed after this list was made. Review it again.',
    };

  // Fresh read: the only concurrency check Clockify allows (#97 §4.4).
  const names = projectNames(context.write.projects);
  const fresh = await readEntry(context, change.entryId);

  if (!fresh) {
    await row.destroy();

    return {
      status: change.kind === 'delete' ? 'sent' : 'gone',
      ...(change.kind === 'delete'
        ? { message: 'Already deleted in Clockify.' }
        : {}),
    };
  }

  const remote = entryValues(fresh, names);
  if (!remote)
    return {
      status: 'refused',
      message: blockers(fresh, context.write).join(' '),
    };

  let desired = change.desired;

  if (change.kind === 'delete') {
    if (!same(ordered(remote), ordered(change.base))) {
      setRowValues(row, schema, remote);
      setBookkeeping(row, schema, { baseline: remote, delete: false });
      await row.save();

      return {
        status: 'conflict',
        message: 'Changed in Clockify since it was read; it was not deleted.',
      };
    }
  } else {
    const decision = reconcileRecord(
      ordered(change.base),
      ordered(change.desired),
      ordered(remote),
    );

    if (decision.agreed) {
      setRowValues(row, schema, remote);
      setBookkeeping(row, schema, { baseline: remote });
      await row.save();

      return { status: 'already' };
    }

    if (decision.conflicts.length) {
      const fields = decision.conflicts
        .map(c => c.property as EntryField)
        .filter(f => ENTRY_FIELDS.includes(f));
      const values = { ...ordered(state.local) };
      for (const key of [
        ...Object.keys(decision.local),
        ...decision.conflicts.map(c => c.property),
      ])
        (values as Record<string, unknown>)[key] = remote[key as EntryField];
      setRowValues(row, schema, values);
      setBookkeeping(row, schema, { baseline: remote });
      await row.save();

      return {
        status: 'conflict',
        fields,
        message:
          'Changed in Clockify since it was read; Clockify’s values were kept for those fields.',
      };
    }

    desired = { ...ordered(remote), ...decision.remote } as EntryValues;
    desired.project = desired.projectId
      ? (names(desired.projectId) ?? desired.project)
      : null;
  }

  const reasons = blockers(
    fresh,
    context.write,
    change.kind === 'update' ? desired : undefined,
  );
  if (reasons.length) return { status: 'refused', message: reasons.join(' ') };

  const path = `/api/v1/workspaces/${encodeURIComponent(context.read.workspaceId)}/time-entries/${encodeURIComponent(change.entryId)}`;
  const init: WriteInit =
    change.kind === 'delete'
      ? { method: 'DELETE' }
      : { method: 'PUT', body: JSON.stringify(putBody(fresh, desired)) };

  // Sent before send: a reload from here on re-reads before anything else.
  const sentAt = new Date(context.read.clock()).toISOString();
  setBookkeeping(row, schema, {
    outbox: { op: change.kind === 'delete' ? 'delete' : 'put', sentAt },
  });
  await row.save();

  const response = await write(context, path, init);

  if (response.status === 404 && change.kind === 'delete') {
    // Already gone: the verification read below confirms it.
  } else if (response.status < 200 || response.status >= 300) {
    setBookkeeping(row, schema, { outbox: null });
    await row.save();
    const detail = bodyMessage(response.body);

    if (response.status === 404 && detail === NOT_IN_CATALOG)
      throw new Stop(
        'The integration proxy does not allow writing to Clockify (its catalog has no time-entry write overlay).',
      );

    return {
      status: 'failed',
      message: `Clockify answered ${response.status}${detail ? `: ${detail}` : ''}.`,
    };
  } else if (change.kind === 'update' && response.body) {
    await log.append({
      id: context.read.newId(),
      device: context.read.device,
      sentAt,
      receivedAt: new Date(context.read.clock()).toISOString(),
      kind: 'write-response',
      scope: { type: 'id', collection: TIME_ENTRY, id: change.entryId },
      mask: ENTRY_MASK,
      complete: true,
      records: [canonicalEntry(response.body as RawTimeEntry)],
    });
  }

  // Verification read: only this settles the change (#97 §4.1 step 7).
  let verified: ClockifyTimeEntry | undefined;

  try {
    verified = await readEntry(context, change.entryId);
  } catch (error) {
    throw new Uncertain(
      `Sent, but the check afterwards failed (${message(error)}). The next sync reads it back.`,
    );
  }

  if (change.kind === 'delete') {
    if (verified) {
      setBookkeeping(row, schema, { outbox: null });
      await row.save();

      return {
        status: 'failed',
        message: 'Clockify still has the entry after the delete.',
      };
    }

    await row.destroy();

    return { status: 'sent' };
  }

  const after = verified && entryValues(verified, names);

  if (!after) {
    if (!verified) await row.destroy();
    else {
      setBookkeeping(row, schema, { outbox: null });
      await row.save();
    }

    return {
      status: verified ? 'failed' : 'gone',
      ...(verified
        ? { message: 'Clockify no longer lists it as a completed entry.' }
        : {}),
    };
  }

  setRowValues(row, schema, after);
  setBookkeeping(row, schema, { baseline: after, outbox: null });
  await row.save();
  const differs = changedFields(desired, after);

  return differs.length
    ? {
        status: 'adjusted',
        fields: differs,
        message:
          'Clockify stored other values than were sent; the row has them.',
      }
    : { status: 'sent' };
}

/** GET by id, appended to the log; undefined when Clockify says deleted. */
async function readEntry(
  context: SendContext,
  id: string,
): Promise<ClockifyTimeEntry | undefined> {
  const observation = await readOne(context.read, id);
  await context.log.append(observation);

  return mirrorEntry(context.log.mirror, id);
}

/**
 * One write through the proxy. A 429 waits for `retry-after` (at most
 * `MAX_RETRY_WAIT_SECONDS`) and tries once more; it was not applied. A
 * thrown call or a 5xx may have reached Clockify: `Uncertain`. A proxy
 * refusal never did: `Stop`.
 */
async function write(
  context: SendContext,
  path: string,
  init: WriteInit,
): Promise<{ status: number; body: unknown }> {
  const sleep =
    context.sleep ??
    ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  for (let attempt = 0; ; attempt++) {
    let response: Awaited<ReturnType<ReadContext['transport']['request']>>;

    try {
      response = await context.read.transport.request(path, undefined, init);
    } catch (error) {
      if (error instanceof ProxyRefusal) throw new Stop(error.message);
      throw new Uncertain(
        `No answer from Clockify (${message(error)}). The next sync reads back whether it was applied.`,
      );
    }

    if (response.status >= 500)
      throw new Uncertain(
        `Clockify or the proxy answered ${response.status}; it may have been applied. The next sync reads it back.`,
      );
    if (response.status !== 429 || attempt > 0) return response;
    const wait =
      retryAfterSeconds(
        response.headers?.['retry-after'],
        context.read.clock(),
      ) ?? MAX_RETRY_WAIT_SECONDS;
    if (wait > MAX_RETRY_WAIT_SECONDS) return response;
    await sleep(wait * 1000);
  }
}

/** Reads every row of the table: the changes they hold and their states. */
export async function planAll(
  store: PluginStore,
  schema: CompleteSchema,
  mirror: Mirror,
  context: WriteContext,
): Promise<PendingChange[]> {
  const changes: PendingChange[] = [];

  for (const subject of await store.query({
    property: atomic.parent,
    value: schema.table,
  })) {
    const row = await store.getResource(subject);
    const state = readRowState(row, schema);
    if (!state) continue;
    const change = planChange(
      state,
      mirrorEntry(mirror, state.entryId),
      context,
    );
    if (change) changes.push(change);
  }

  return sortChanges(changes);
}

export const sortChanges = (changes: PendingChange[]) =>
  [...changes].sort(
    (a, b) => a.base.start - b.base.start || (a.entryId < b.entryId ? -1 : 1),
  );
