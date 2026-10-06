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
 * - **Range edits** (#123 M4): "worked on P" or "did not work" over a range,
 *   and resolving a conflict, are planned by the lens (`planRange`) and
 *   staged on rows like any other edit (`stageRangePlan`): a trim, an
 *   extension or a project change edits that entry's row, a deletion marks
 *   it, and a new entry (a gap filled, the right part of a split) is a new
 *   row without an entry id that carries `clockify-create`. Sending one
 *   reads the range fresh first: if Clockify has any entry there by then,
 *   nothing is created (a conflict), unless it is exactly the entry this
 *   row would create, left by an earlier send that lost its answer: then
 *   the row is bound to it. A sync does the same binding for a create
 *   whose send was uncertain (`settleCreates`).
 *
 * - **One sender at a time** (#123 M5): with `lease`, a send takes the
 *   advisory lease on the log head first (`lease.ts`) and sends nothing
 *   while another open copy of the app holds it; a sync leaves an
 *   unconfirmed create alone while another copy is sending.
 *
 * Not here: noticing a row deleted in the table (needs the host's change
 * list with tombstones, #177 H6b).
 */
import { reconcileRecord } from '../../../browser/lib/src/plugin-reconcile.js';
import {
  blockers,
  changedFields,
  clockifyInstant,
  descriptionOf,
  ENTRY_FIELDS,
  entryValues,
  NO_DESCRIPTION,
  putBody,
  snapToMinute,
  type ClockifyProject,
  type ClockifyTimeEntry,
  type EntryField,
  type EntryValues,
  type PlanStep,
  type WriteContext,
} from '../devonian/clockify/lens/index.js';
import type { RawTimeEntry } from './clockifyApi.js';
import {
  canonicalEntry,
  ENTRY_MASK,
  MARGIN_MS,
  rawFromCanonical,
  readOne,
  readRange,
  TIME_ENTRY,
  timeEntries,
  type ReadContext,
} from './clockifyObserve.js';
import {
  heldMessage,
  SendLease,
  type LeaseOptions,
  type LeaseState,
} from './lease.js';
import {
  fields as rowFields,
  SHARED,
  sharedValues,
  TIME_ENTRY as TIME_ENTRY_CLASS,
} from './fields.js';
import type { LinkTarget } from './links.js';
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
  op: 'put' | 'delete' | 'post';
  /** ISO 8601. */
  sentAt: string;
}

/**
 * `clockify-create` on a new row (#123 M4): the entry still has to be
 * created. A split's right part names the entry it copies, with the task
 * and tags to carry over (the row holds the rest).
 */
export interface CreateMarker {
  copyOf?: string;
  taskId?: string;
  tagIds?: string[];
}

/** A new row, not yet created in Clockify. */
export interface CreateState {
  subject: string;
  local: EntryValues;
  create: CreateMarker;
  outbox?: OutboxMarker;
}

/** A create change's `entryId`: the row's subject, as the list's key. */
export const CREATE_KEY = 'new:';
export const createKey = (subject: string) => `${CREATE_KEY}${subject}`;
export const isCreateKey = (key: string) => key.startsWith(CREATE_KEY);

export interface PendingChange {
  /** `create`: a new entry (#123 M4); `entryId` is then `createKey(row)`. */
  kind: 'update' | 'delete' | 'create';
  entryId: string;
  subject: string;
  /** The entry's Name as Clockify last had it. */
  title: string;
  /** The baseline: Clockify's values when the row last agreed. For a
   * create, what would be created. */
  base: EntryValues;
  /** The row as it was when this change was listed (the review). */
  local: EntryValues;
  /** What would be sent: the row, with changed times snapped to minutes
   * and a typed project name resolved to its id. */
  desired: EntryValues;
  /** `base` → `desired`, in display order. Empty for a deletion or a
   * create. */
  fields: EntryField[];
  /** For a create: the split entry it copies, if any. */
  copyOf?: string;
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
  | 'gone'
  /** A create found the entry it would make already there (an earlier
   * send's lost answer): the row was bound to it, nothing was written. */
  | 'bound';

export interface SendOutcome {
  entryId: string;
  title: string;
  kind: PendingChange['kind'];
  status: SendStatus;
  message?: string;
  /** For `adjusted` and `conflict`: the fields concerned. */
  fields?: EntryField[];
  /**
   * For `failed`: the provider write itself succeeded, and what failed came
   * after it (the verification read found the entry no longer complete, or
   * saving the row threw). Absent: nothing was written.
   */
  written?: true;
  /** For a lease `not-sent`: when the other copy's turn ends, ISO 8601. */
  until?: string;
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

const NO_LINK: LinkTarget = { id: null, name: null };

/** What the row's `work-project` link points at. */
async function projectLink(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<LinkTarget> {
  const link = sharedValues(row.props)[SHARED.project];

  return typeof link === 'string'
    ? schema.links.describe('project', link)
    : NO_LINK;
}

/**
 * The row's own values, as the lens compares them, from its shared
 * `time-entry-v1` fields (read through the resolver, `fields.ts`). The
 * project is the linked project row's Clockify id and name; a link to a
 * row without a Clockify id is a project named by that row (resolved when
 * listed to send, `desiredValues`).
 */
export async function localValues(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<EntryValues | undefined> {
  const shared = sharedValues(row.props);
  const start = shared[SHARED.start];
  const end = shared[SHARED.end];
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  const name = shared[NAME];
  const project = await projectLink(row, schema);

  return {
    name: typeof name === 'string' ? name : '',
    start,
    end,
    billable: shared[SHARED.billable] === true,
    projectId: project.id,
    project: project.name,
  };
}

export async function readRowState(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<RowState | undefined> {
  const entryId = text(row.get(schema.row.entryId));
  const local = entryId ? await localValues(row, schema) : undefined;
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
 * The project row a row with `values` links to: the one standing for its
 * Clockify project (made when missing), or, with no id but a name, a
 * project row of that name without an id. `undefined`: no project.
 */
async function projectSubject(
  schema: CompleteSchema,
  values: Pick<EntryValues, 'projectId' | 'project'>,
): Promise<string | undefined> {
  if (values.projectId)
    return schema.links.ensure('project', values.projectId, values.project);
  if (values.project) return schema.links.named(values.project);

  return undefined;
}

/**
 * Sets the row's synced values to `values`, only where they differ, as
 * shared `time-entry-v1` fields (the resolver refuses anything else). The
 * project is a link: kept when it already stands for the same project,
 * removed for no project. Returns whether anything was set.
 */
export async function setRowValues(
  row: PluginResource,
  schema: CompleteSchema,
  values: EntryValues,
): Promise<boolean> {
  const wanted = rowFields.write(
    {
      [NAME]: values.name,
      [SHARED.start]: values.start,
      [SHARED.end]: values.end,
      [SHARED.billable]: values.billable,
    },
    TIME_ENTRY_CLASS,
  ) as Record<string, JSONValue>;
  let changed = false;

  for (const [property, value] of Object.entries(wanted)) {
    if (row.get(property) === value) continue;
    row.set(property, value);
    changed = true;
  }

  const now = await projectLink(row, schema);
  const kept = values.projectId
    ? now.id === values.projectId
    : now.id === null && now.name === (values.project ?? null);

  if (!kept) {
    const subject = await projectSubject(schema, values);
    if (subject) row.set(SHARED.project, subject);
    else row.remove(SHARED.project);
    changed = true;
  }

  return changed;
}

/** The shared fields of a new row; no project stays unset. */
export async function rowValues(
  schema: CompleteSchema,
  values: EntryValues,
): Promise<Record<string, JSONValue>> {
  const project = await projectSubject(schema, values);

  return rowFields.write(
    {
      [NAME]: values.name,
      [SHARED.start]: values.start,
      [SHARED.end]: values.end,
      [SHARED.billable]: values.billable,
      ...(project ? { [SHARED.project]: project } : {}),
    },
    TIME_ENTRY_CLASS,
  ) as Record<string, JSONValue>;
}

/** The row values for a new synced row: its fields and its baseline. */
export async function newRowValues(
  schema: CompleteSchema,
  values: EntryValues,
): Promise<Record<string, JSONValue>> {
  return {
    ...(await rowValues(schema, values)),
    [schema.sync.baseline]: JSON.stringify(ordered(values)),
  };
}

/**
 * Links the row to the person row of Clockify user `id` (made when
 * missing); who tracked an entry is shown, never written back. Returns
 * whether it changed the row.
 */
export async function setPerson(
  row: PluginResource,
  schema: CompleteSchema,
  id: string | undefined,
  name: string | null,
): Promise<boolean> {
  if (!id) return false;
  const subject = await schema.links.ensure('person', id, name);
  if (row.get(SHARED.person) === subject) return false;
  row.set(SHARED.person, subject);

  return true;
}

/**
 * A project's name for `id`: Clockify's, from its project list, or else
 * the name of the project row this operation read for it.
 */
export const namesFor =
  (schema: CompleteSchema, projects: ClockifyProject[]) =>
  (id: string): string | undefined =>
    projectNames(projects)(id) ?? schema.links.nameOf('project', id);

function setBookkeeping(
  row: PluginResource,
  schema: CompleteSchema,
  p: {
    baseline?: EntryValues;
    outbox?: OutboxMarker | null;
    delete?: boolean;
    create?: CreateMarker | null;
  },
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
  if (p.create !== undefined)
    put(schema.sync.create, p.create ? JSON.stringify(p.create) : '');

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
 * exact, active name; otherwise a blocker). A changed time that equals one
 * of `boundaries` (the start or end of an entry in Clockify) is not snapped.
 */
export function desiredValues(
  local: EntryValues,
  base: EntryValues,
  projects: ClockifyProject[],
  boundaries: ReadonlySet<number> = new Set(),
): { desired: EntryValues; problems: string[] } {
  const problems: string[] = [];
  const desired: EntryValues = {
    ...ordered(local),
    name: local.name.trim() || NO_DESCRIPTION,
  };
  // A time that lines up with another entry's start or end (a trim or an
  // extension from a range edit meeting its neighbour) is kept exact.
  const snap = (at: number) => (boundaries.has(at) ? at : snapToMinute(at));
  if (desired.start !== base.start) desired.start = snap(desired.start);
  if (desired.end !== base.end) desired.end = snap(desired.end);

  // A link to a project row without a Clockify id: the project of that name.
  if (desired.projectId === null && desired.project) {
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
  boundaries?: ReadonlySet<number>,
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
    boundaries,
  );
  const changed = changedFields(base, desired);
  // A project named by a row without a Clockify id that resolves to no
  // project still changed the row.
  const fields = ENTRY_FIELDS.filter(
    f =>
      changed.includes(f) ||
      (f === 'projectId' && desired.projectId === null && !!desired.project),
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
  const state = await readRowState(row, schema);
  let extrasChanged = false;

  for (const [property, value] of Object.entries(extras))
    if (row.get(property) !== value) {
      row.set(property, value);
      extrasChanged = true;
    }

  if (!state) {
    const changed = (await setRowValues(row, schema, remote)) || extrasChanged;
    setBookkeeping(row, schema, { baseline: remote });
    await row.save();

    return {
      valuesChanged: changed,
      state: (await readRowState(row, schema))!,
    };
  }

  const result = reconcileRow(state, remote);
  const valuesChanged =
    (await setRowValues(row, schema, result.values)) || extrasChanged;
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
    // An unconfirmed send, settled by this read. A delete that is still
    // requested cannot have arrived: the entry is here, being synced. (Its
    // values match the row's, so the value check alone would say it had.)
    ...(state.outbox
      ? {
          recovered:
            same(ordered(state.local), ordered(remote)) &&
            !state.deleteRequested &&
            state.outbox.op !== 'delete'
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

/** What a send says when a row of a table the app is a view of stays. */
export const ROW_KEPT =
  'The row stays in the table as a row of its own, no longer synced: the app may edit that table’s rows but not delete them. Delete it there.';

/**
 * Takes a row out of the sync once its entry is gone from Clockify, or a
 * new row is discarded before it was sent. On the app's own table the row
 * is destroyed. On a table the app is a view of (#177 item 14) the row
 * grant never deletes a row, so only the app's own extras are removed: the
 * row stays as one of the person's, local only, with its values. Returns
 * whether it was destroyed.
 */
export async function retireRow(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<boolean> {
  if (schema.own) {
    await row.destroy();

    return true;
  }

  let changed = false;

  for (const property of [schema.row.entryId, ...Object.values(schema.sync)])
    if (row.get(property) !== undefined) {
      row.remove(property);
      changed = true;
    }

  if (changed) await row.save();

  return false;
}

/** `message`, with `ROW_KEPT` after it when the row was kept. */
const kept = (destroyed: boolean, message?: string) =>
  destroyed
    ? message
      ? { message }
      : {}
    : { message: message ? `${message} ${ROW_KEPT}` : ROW_KEPT };

/** Puts the row back to its baseline and drops a requested deletion; a
 * new row not yet created in Clockify is removed (on a
 * table the app is a view of: kept as a row of its own, `retireRow`). */
export async function discardChange(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<void> {
  if (await readCreateState(row, schema)) {
    await retireRow(row, schema);

    return;
  }

  const state = await readRowState(row, schema);
  if (!state?.baseline) return;
  const changed = await setRowValues(row, schema, state.baseline);
  const flag = setBookkeeping(row, schema, { delete: false });
  if (changed || flag) await row.save();
}

// ---- range edits: new rows (#123 M4) ---------------------------------------

/** A new row's state, if it is one: no entry id, and `clockify-create`. */
export async function readCreateState(
  row: PluginResource,
  schema: CompleteSchema,
): Promise<CreateState | undefined> {
  if (text(row.get(schema.row.entryId))) return undefined;
  const create = parseJson<CreateMarker>(row.get(schema.sync.create));
  if (!create || typeof create !== 'object') return undefined;
  const local = await localValues(row, schema);
  if (!local) return undefined;
  const outbox = parseJson<OutboxMarker>(row.get(schema.sync.outbox));

  return {
    subject: row.subject,
    local,
    create,
    ...(outbox?.op ? { outbox } : {}),
  };
}

/** Why a new entry with these values cannot be created. */
export function createBlockers(
  desired: EntryValues,
  context: WriteContext,
): string[] {
  const reasons: string[] = [];
  if (!(desired.start < desired.end))
    reasons.push('Start has to be before end.');
  if (desired.end > context.now) reasons.push('End is in the future.');
  if (context.forceProjects && !desired.projectId)
    reasons.push('This workspace requires a project on every entry.');

  if (desired.projectId) {
    const project = context.projects.find(p => p.id === desired.projectId);
    if (!project)
      reasons.push('The project is not one of this workspace’s projects.');
    else if (project.archived === true)
      reasons.push(`The project ${project.name} is archived.`);
  }

  return reasons;
}

/** The create a new row holds. Its times are sent as they are. */
export function planCreate(
  state: CreateState,
  context: WriteContext,
): PendingChange {
  // Against itself with the project's own name, so a project name typed
  // into the table is resolved and the times are not snapped.
  const base = {
    ...ordered(state.local),
    project: state.local.projectId
      ? (projectNames(context.projects)(state.local.projectId) ?? null)
      : null,
  };
  const { desired, problems } = desiredValues(
    state.local,
    base,
    context.projects,
  );

  return {
    kind: 'create',
    entryId: createKey(state.subject),
    subject: state.subject,
    title: desired.name,
    base: desired,
    local: state.local,
    desired,
    fields: [],
    ...(state.create.copyOf ? { copyOf: state.create.copyOf } : {}),
    blockers: [
      ...(state.outbox
        ? [
            'An earlier send of this entry did not get an answer. Sync first: that settles whether it arrived.',
          ]
        : []),
      ...problems,
      ...createBlockers(desired, context),
    ],
  };
}

/** Every start and end of a live entry in the mirror, epoch ms. */
export function entryBoundaries(mirror: Mirror): Set<number> {
  const out = new Set<number>();

  for (const r of timeEntries(mirror)) {
    if (r.deletedAt) continue;
    for (const value of [r.fields.start, r.fields.end])
      if (typeof value === 'string') out.add(Date.parse(value));
  }

  return out;
}

/** The table's rows, by subject. */
async function tableRows(store: PluginStore, schema: CompleteSchema) {
  return store.query({ property: atomic.parent, value: schema.table });
}

/** The entry ids rows are bound to. */
async function boundIds(
  store: PluginStore,
  schema: CompleteSchema,
  subjects: Iterable<string>,
): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const subject of subjects) {
    const id = text((await store.getResource(subject)).get(schema.row.entryId));
    if (id) ids.add(id);
  }

  return ids;
}

/**
 * Writes a range plan (`planRange`) to the rows: an update edits the
 * entry's row, a deletion marks it, a create adds a new row carrying
 * `clockify-create`. Nothing is sent. `rowOf` finds an entry's row.
 * Returns the rows it staged on.
 */
export async function stageRangePlan(
  store: PluginStore,
  schema: CompleteSchema,
  mirror: Mirror,
  steps: PlanStep[],
  rowOf: (entryId: string) => Promise<string | undefined>,
): Promise<string[]> {
  const touched: string[] = [];

  const row = async (entryId: string) => {
    const subject = await rowOf(entryId);
    if (!subject) throw new Error(`Entry ${entryId} has no row in the table.`);
    touched.push(subject);

    return store.getResource(subject);
  };

  for (const step of steps) {
    if (step.op === 'update') {
      const r = await row(step.entryId);
      if (await setRowValues(r, schema, step.desired)) await r.save();
    } else if (step.op === 'delete')
      await requestDelete(await row(step.entryId), schema, true);
    else {
      const source = step.copyOf ? mirrorEntry(mirror, step.copyOf) : undefined;
      const marker: CreateMarker = {
        ...(step.copyOf ? { copyOf: step.copyOf } : {}),
        ...(typeof source?.taskId === 'string'
          ? { taskId: source.taskId }
          : {}),
        ...(Array.isArray(source?.tagIds) && source.tagIds.length
          ? { tagIds: [...source.tagIds] }
          : {}),
      };
      const created = await store.newResource({
        parent: schema.table,
        isA: [TIME_ENTRY_CLASS],
        propVals: {
          ...(await rowValues(schema, step.values)),
          [schema.sync.create]: JSON.stringify(marker),
        },
      });
      touched.push(created.subject);
    }
  }

  return [...new Set(touched)];
}

/** This user's live entries in the mirror overlapping `[from, to)`. */
function entriesOverlapping(
  mirror: Mirror,
  userId: string,
  span: { from: number; to: number },
  now: number,
): ClockifyTimeEntry[] {
  return timeEntries(mirror)
    .filter(
      r =>
        !r.deletedAt &&
        !r.absentSince &&
        (r.fields.userId ?? userId) === userId,
    )
    .map(r => rawFromCanonical(r) as ClockifyTimeEntry)
    .filter(e => {
      const start = Date.parse(e.timeInterval.start ?? '');
      const end = e.timeInterval.end ? Date.parse(e.timeInterval.end) : now;

      return start < span.to && end > span.from;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Is `entry` exactly what a create of `values` makes? */
const madeBy = (entry: ClockifyTimeEntry, values: EntryValues) => {
  const made = entryValues(entry);

  return (
    !!made &&
    made.start === values.start &&
    made.end === values.end &&
    made.projectId === values.projectId
  );
};

/** Who tracked an entry, as the row's Person link (sync sets the same on
 * imported rows). */
export interface Member {
  id: string;
  name?: unknown;
}

async function setMember(
  row: PluginResource,
  schema: CompleteSchema,
  entry: ClockifyTimeEntry,
  members: Member[] = [],
) {
  const id = typeof entry.userId === 'string' ? entry.userId : undefined;
  const name = members.find(m => m.id === id)?.name;
  await setPerson(
    row,
    schema,
    id,
    typeof name === 'string' && name ? name : null,
  );
}

/** Binds a new row to the entry created for it. */
async function bindRow(
  row: PluginResource,
  schema: CompleteSchema,
  entry: ClockifyTimeEntry,
  remote: EntryValues,
  members?: Member[],
) {
  row.set(schema.row.entryId, entry.id);
  await setMember(row, schema, entry, members);
  await setRowValues(row, schema, remote);
  setBookkeeping(row, schema, { baseline: remote, create: null, outbox: null });
  await row.save();
}

export interface SettledCreate {
  subject: string;
  title: string;
  /** The entry it was bound to; absent: the send had not arrived. */
  entryId?: string;
}

/**
 * Settles new rows whose create was sent without an answer (#123 S15),
 * from a sync's complete read: an entry no row is bound to, with exactly
 * the row's start, end and project, is taken to be that create's result
 * and the row is bound to it (#97 §4.2's binding rule); with none, the
 * send did not arrive, and the create is listed again. Run before rows
 * are created for unbound entries, so an applied create gets no second row.
 * Returns what it settled, and the new rows still to create (one pass over
 * the table's rows). While another copy of the app holds the send lease
 * (`busy`), such a row is left as it is: that copy may be sending it now,
 * and a read from before its `POST` landed would wrongly clear the marker.
 */
export async function settleCreates(
  store: PluginStore,
  schema: CompleteSchema,
  mirror: Mirror,
  context: Pick<ReadContext, 'userId'> & {
    now: number;
    projects: ClockifyProject[];
    members?: Member[];
    /** Another copy of the app holds the send lease (#123 M5). */
    busy?: boolean;
  },
): Promise<{ settled: SettledCreate[]; pending: CreateState[] }> {
  const creates: Array<{ row: PluginResource; state: CreateState }> = [];
  const bound = new Set<string>();

  for (const subject of await tableRows(store, schema)) {
    const row = await store.getResource(subject);
    const id = text(row.get(schema.row.entryId));
    const state = id ? undefined : await readCreateState(row, schema);
    if (id) bound.add(id);
    if (state) creates.push({ row, state });
  }

  const settled: SettledCreate[] = [];
  const pending: CreateState[] = [];

  for (const { row, state } of creates) {
    const { subject, local } = state;

    if (state.outbox?.op !== 'post' || context.busy) {
      pending.push(state);
      continue;
    }

    const match = entriesOverlapping(
      mirror,
      context.userId,
      { from: local.start, to: local.end },
      context.now,
    ).find(e => !bound.has(e.id) && madeBy(e, local));

    if (match) {
      const remote = entryValues(match, namesFor(schema, context.projects))!;
      await bindRow(row, schema, match, remote, context.members);
      bound.add(match.id);
      settled.push({ subject, title: remote.name, entryId: match.id });
    } else {
      setBookkeeping(row, schema, { outbox: null });
      await row.save();
      settled.push({ subject, title: local.name });
      pending.push({ subject, local, create: state.create });
    }
  }

  return { settled, pending };
}

export interface SendContext {
  store: PluginStore;
  schema: CompleteSchema;
  log: ObservationLog;
  read: ReadContext;
  write: WriteContext;
  /** The workspace's users, for a new entry's Member column. */
  members?: Member[];
  /** Waits before retrying a 429. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  /** Take the send lease as this app instance (#123 M5). Without it,
   * nothing coordinates with other copies (unit tests of one copy). */
  lease?: LeaseOptions;
  /** For the lease message's time. */
  timeZone?: string;
  /** Set by `sendChanges` while it holds the lease: keeps it before each
   * write, and throws when another copy took it. */
  renew?: () => Promise<void>;
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
/** Another copy holds the lease now: the rest waits for it. */
class LeaseLost extends Stop {
  constructor(
    reason: string,
    /** When the other copy's turn ends at the latest, ISO 8601. */
    readonly until: string,
  ) {
    super(reason);
  }
}

/**
 * Set by `sendOne`/`sendCreate` once the provider write succeeded, so a
 * failure after it (saving the row, say) is reported as `written`, not as
 * "nothing was written".
 */
interface WriteTrack {
  written: boolean;
}

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
  let lease: SendLease | undefined;
  const lost = (holder: LeaseState) =>
    new LeaseLost(heldMessage(holder, context.timeZone), holder.until);

  if (context.lease) {
    const taken = await SendLease.take(
      context.store,
      context.schema,
      context.lease,
    );

    if (!(taken instanceof SendLease)) {
      const reason = heldMessage(taken.heldBy, context.timeZone);

      return changes.map(change => ({
        entryId: change.entryId,
        title: change.title,
        kind: change.kind,
        status: 'not-sent',
        message: reason,
        until: taken.heldBy.until,
      }));
    }

    lease = taken;
  }

  const sending: SendContext = lease
    ? {
        ...context,
        renew: async () => {
          const holder = await lease!.renew();
          if (holder) throw lost(holder);
        },
      }
    : context;

  try {
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

      const track: WriteTrack = { written: false };

      try {
        await sending.renew?.();
        outcomes.push({
          ...base,
          ...(await (change.kind === 'create' ? sendCreate : sendOne)(
            sending,
            change,
            track,
          )),
        });
      } catch (error) {
        if (error instanceof Uncertain) {
          outcomes.push({
            ...base,
            status: 'uncertain',
            message: error.message,
          });
          stopped = true;
        } else if (error instanceof LeaseLost) {
          outcomes.push({
            ...base,
            status: 'not-sent',
            message: error.message,
            until: error.until,
          });
          stopped = true;
        } else if (error instanceof Stop) {
          outcomes.push({ ...base, status: 'failed', message: error.message });
          stopped = true;
        } else
          outcomes.push({
            ...base,
            status: 'failed',
            message: message(error),
            // The write stood; saving the row or the log afterwards threw.
            ...(track.written ? { written: true } : {}),
          });
      }
    }

    context.onProgress?.(changes.length, changes.length);
    await context.log.compactIfNeeded();
    await context.log.flush();
  } finally {
    await lease?.release();
  }

  return outcomes;
}

type Result = Omit<SendOutcome, 'entryId' | 'title' | 'kind'>;

async function sendOne(
  context: SendContext,
  change: PendingChange,
  track: WriteTrack = { written: false },
): Promise<Result> {
  const { store, schema, log } = context;
  const row = await store.getResource(change.subject);
  const state = await readRowState(row, schema);

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
  const names = namesFor(schema, context.write.projects);
  const fresh = await readEntry(context, change.entryId);

  if (!fresh) {
    const destroyed = await retireRow(row, schema);

    return {
      status: change.kind === 'delete' ? 'sent' : 'gone',
      ...kept(
        destroyed,
        change.kind === 'delete' ? 'Already deleted in Clockify.' : undefined,
      ),
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
      await setRowValues(row, schema, remote);
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
      await setRowValues(row, schema, remote);
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
      await setRowValues(row, schema, values);
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
  }

  // A delete answered 404 wrote nothing: the entry was already gone.
  if (!(response.status === 404 && change.kind === 'delete'))
    track.written = true;

  if (change.kind === 'update' && response.body) {
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

    return { status: 'sent', ...kept(await retireRow(row, schema)) };
  }

  const after = verified && entryValues(verified, names);

  if (!after) {
    let destroyed = true;

    if (!verified) destroyed = await retireRow(row, schema);
    else {
      setBookkeeping(row, schema, { outbox: null });
      await row.save();
    }

    return {
      ...(destroyed ? {} : { message: ROW_KEPT }),
      status: verified ? 'failed' : 'gone',
      ...(verified
        ? {
            message: 'Clockify no longer lists it as a completed entry.',
            written: true,
          }
        : {}),
    };
  }

  await setRowValues(row, schema, after);
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

/**
 * Creates one new entry (#123 M4): the row is re-read; the range is read
 * fresh (with the margin), and if Clockify has any entry there now nothing
 * is created, unless it is exactly this create's result from an earlier
 * send whose answer was lost (then the row is bound to it); the outbox
 * marker; one `POST`; a verification `GET` of the new entry. Only then is
 * the row bound and given a baseline.
 */
async function sendCreate(
  context: SendContext,
  change: PendingChange,
  track: WriteTrack = { written: false },
): Promise<Result> {
  const { store, schema, log } = context;
  const row = await store.getResource(change.subject);
  const state = await readCreateState(row, schema);

  if (!state || !same(ordered(state.local), ordered(change.local)))
    return {
      status: 'changed',
      message: 'The row changed after this list was made. Review it again.',
    };

  const desired = change.desired;
  const names = namesFor(schema, context.write.projects);
  let read: Awaited<ReturnType<typeof readRange>>;

  try {
    read = await readRange(
      context.read,
      desired.start - MARGIN_MS,
      desired.end,
    );
  } catch (error) {
    return {
      status: 'failed',
      message: `Could not read this range from Clockify first (${message(error)}). Nothing was created.`,
    };
  }

  await log.append(read.observation);
  if (read.error)
    return {
      status: 'failed',
      message: `Could not read all of this range from Clockify first (${message(read.error)}). Nothing was created.`,
    };

  const there = entriesOverlapping(
    log.mirror,
    context.read.userId,
    { from: desired.start, to: desired.end },
    context.write.now,
  );

  if (there.length) {
    const bound = await boundIds(store, schema, await tableRows(store, schema));
    const match = there.find(e => !bound.has(e.id) && madeBy(e, desired));

    if (match && there.length === 1) {
      await bindRow(
        row,
        schema,
        match,
        entryValues(match, names)!,
        context.members,
      );

      return {
        status: 'bound',
        message: 'Clockify already had it, from an earlier send.',
      };
    }

    return {
      status: 'conflict',
      message:
        'Clockify has time in this range now, so nothing was created. Discard this and edit the range again.',
    };
  }

  const reasons = createBlockers(desired, context.write);
  if (reasons.length) return { status: 'refused', message: reasons.join(' ') };

  const body = {
    start: clockifyInstant(desired.start),
    end: clockifyInstant(desired.end),
    billable: desired.billable,
    description: descriptionOf(desired.name),
    ...(desired.projectId ? { projectId: desired.projectId } : {}),
    ...(state.create.taskId ? { taskId: state.create.taskId } : {}),
    tagIds: [...(state.create.tagIds ?? [])],
    type: 'REGULAR',
  };
  const sentAt = new Date(context.read.clock()).toISOString();
  setBookkeeping(row, schema, { outbox: { op: 'post', sentAt } });
  await row.save();

  const response = await write(
    context,
    `/api/v1/workspaces/${encodeURIComponent(context.read.workspaceId)}/time-entries`,
    { method: 'POST', body: JSON.stringify(body) },
  );

  if (response.status < 200 || response.status >= 300) {
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
  }

  track.written = true;
  const made = response.body as RawTimeEntry | null;
  if (!made || typeof made.id !== 'string')
    throw new Uncertain(
      'Clockify’s answer did not name the new entry. The next sync looks for it.',
    );

  await log.append({
    id: context.read.newId(),
    device: context.read.device,
    sentAt,
    receivedAt: new Date(context.read.clock()).toISOString(),
    kind: 'write-response',
    scope: { type: 'id', collection: TIME_ENTRY, id: made.id },
    mask: ENTRY_MASK,
    complete: true,
    records: [canonicalEntry(made)],
  });
  // Bound now, so a reload never creates it twice; the marker stays until
  // the verification read below (or the next sync) settles it.
  row.set(schema.row.entryId, made.id);
  await setMember(row, schema, made as ClockifyTimeEntry, context.members);
  setBookkeeping(row, schema, { create: null, baseline: desired });
  await row.save();

  let verified: ClockifyTimeEntry | undefined;

  try {
    verified = await readEntry(context, made.id);
  } catch (error) {
    throw new Uncertain(
      `Created, but the check afterwards failed (${message(error)}). The next sync reads it back.`,
    );
  }

  const after = verified && entryValues(verified, names);

  if (!after) {
    let destroyed = true;

    if (!verified) destroyed = await retireRow(row, schema);
    else {
      setBookkeeping(row, schema, { outbox: null });
      await row.save();
    }

    return {
      ...(destroyed ? {} : { message: ROW_KEPT }),
      status: verified ? 'failed' : 'gone',
      ...(verified
        ? {
            message: 'Clockify does not list it as a completed entry.',
            written: true,
          }
        : {}),
    };
  }

  await setRowValues(row, schema, after);
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
    // Still this copy's turn? (A 429's wait can outlast half the lease.)
    await context.renew?.();

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
  const boundaries = entryBoundaries(mirror);

  for (const subject of await tableRows(store, schema)) {
    const row = await store.getResource(subject);
    const created = await readCreateState(row, schema);

    if (created) {
      changes.push(planCreate(created, context));
      continue;
    }

    const state = await readRowState(row, schema);
    if (!state) continue;
    const change = planChange(
      state,
      mirrorEntry(mirror, state.entryId),
      context,
      boundaries,
    );
    if (change) changes.push(change);
  }

  return sortChanges(changes);
}

/**
 * The order changes are sent in (#123 §3.5): deletions and changes that
 * only take time away first, then the rest, then new entries; by start
 * within each. An interrupted batch then leaves a gap, never an overlap.
 */
export function sendPhase(change: PendingChange): number {
  if (change.kind === 'delete') return 0;
  if (change.kind === 'create') return 2;
  const { base, desired } = change;

  return desired.start >= base.start &&
    desired.end <= base.end &&
    desired.projectId === base.projectId
    ? 0
    : 1;
}

export const sortChanges = (changes: PendingChange[]) =>
  [...changes].sort(
    (a, b) =>
      sendPhase(a) - sendPhase(b) ||
      a.desired.start - b.desired.start ||
      (a.entryId < b.entryId ? -1 : 1),
  );
