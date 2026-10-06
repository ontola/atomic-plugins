// @wc-ignore-file
/**
 * One import pass: the chosen Google task lists into the app's `issue-v1`
 * table, through tasks.ts for what each task becomes and for what happens to
 * a task that stops appearing.
 *
 * Reads first, all of them, then writes: a read that fails leaves the table
 * as it was. Rows are matched by `google-tasks-task-id`. Google owns the
 * imported columns: a task that changed there overwrites them, a local edit
 * to one of them is overwritten at the next pass (#97's policy question; the
 * read-only Todoist and Moneybird apps do the same), and nothing is ever
 * sent to Google. No row is ever removed.
 *
 * A pass that finds nothing changed writes no row. `last-seen` would change
 * on every pass if it were kept on every row, so it is not: a present task's
 * last sighting is the App's `google-tasks-last-sync` (one write per
 * complete read), and only a task no longer in its list carries its own
 * `google-tasks-last-seen`.
 */
import {
  createResolver,
  incompleteNote,
} from '../../../ontology-kit/resolver.mjs';
import { classes } from '../../../ontology-kit/terms.mjs';
import {
  chosenLists,
  type Drive,
  IS_A,
  ISSUE_V1,
  lastSync,
  NAME,
  PARENT,
  recordSync,
  TAG_DONE,
  TAG_TODO,
  TASK_BODY,
  TASK_DUE_DATE,
  TASK_STATUS,
} from './drive.js';
import {
  type GoogleGet,
  type GoogleResponse,
  lookupTasks,
  rateLimited,
  type RateLimitOptions,
  readTaskLists,
  readTasks,
} from './read.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';
import {
  absentTasks,
  type Fetched,
  type FetchedList,
  isRow,
  PRESENCE,
  type Presence,
  reconcileTasks,
  taskFields,
  type TaskListEntry,
  type TaskRecord,
} from './tasks.js';

/** The integration proxy's platform id for Google Tasks. */
export const PLATFORM = 'google-tasks';

/** Reads and writes `issue-v1` rows by property subject, strictly (#177 decision 1). */
const resolver = createResolver({ classes: [classes['issue-v1']] });
/** The class's required field as the host table heads its column. */
const COLUMN_NAMES: Readonly<Record<string, string>> = { [NAME]: 'Name' };

export interface SyncSummary {
  /** Task rows in the table after the pass. */
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Task rows by presence after the pass. */
  presence: Record<Presence, number>;
  /** Tasks back in a read after being absent or settled. */
  reappeared: number;
  /** How many absent tasks were looked up by id in this pass. */
  checked: number;
  /** Whether every chosen list was read completely (a partial read settles nothing). */
  complete: boolean;
  /** The person's task lists as Google listed them in this pass. */
  lists: TaskListEntry[];
  /** The lists the person chose, by id, as stored on the App. */
  chosen: string[];
}

/**
 * A `GoogleGet` over the host's proxy relay. The frame never holds a
 * credential or calls the network itself; the host's frame client does.
 */
export function relayGet(
  proxy: HostProxy,
  connection: { platform: string; connectionId: string },
): GoogleGet {
  return async (path, query) => {
    if (!path.startsWith('/tasks/v1/'))
      throw new Error(`Refusing a Google Tasks path: ${path}`);
    const response = await proxy.request({
      platform: connection.platform,
      connectionId: connection.connectionId,
      path,
      method: 'GET',
      ...(query && Object.keys(query).length ? { query } : {}),
    });

    return {
      status: response.status,
      body: response.body,
      ...(response.headers ? { headers: response.headers } : {}),
    } as GoogleResponse;
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** Deep enough for the values written here: strings and string arrays. */
const same = (a: JSONValue, b: JSONValue) =>
  Array.isArray(a) || Array.isArray(b)
    ? JSON.stringify(a) === JSON.stringify(b)
    : a === b;

/** The task rows of the table as tasks.ts last returned them. */
async function previousTasks(
  store: PluginStore,
  drive: Drive,
): Promise<{ previous: TaskRecord[]; rows: Map<string, PluginResource> }> {
  const p = drive.properties;
  const previous: TaskRecord[] = [];
  const rows = new Map<string, PluginResource>();

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    const id = text(row.get(p.taskId));
    // A row made in the table by hand has no Google task behind it: local
    // only, left alone. A second row for the same task is left alone too.
    if (!id || rows.has(id)) continue;
    rows.set(id, row);
    let task: Record<string, JSONValue> = {};

    try {
      const parsed: unknown = JSON.parse(text(row.get(p.source)) ?? '{}');
      if (isRow(parsed)) task = parsed;
    } catch {
      // Unreadable source: the row is treated as a present task with no
      // provider values, and the next read replaces them.
    }

    const presence = row.get(p.presence);
    previous.push({
      id,
      listId: text(row.get(p.listId)) ?? '',
      listTitle: text(row.get(p.list)) ?? '',
      task,
      presence: PRESENCE.includes(presence as Presence)
        ? (presence as Presence)
        : 'present',
      ...(text(row.get(p.lastSeen))
        ? { lastSeen: text(row.get(p.lastSeen)) }
        : {}),
    });
  }

  return { previous, rows };
}

/** What a row should hold for one reconciled task record. */
function rowValues(
  record: TaskRecord,
  drive: Drive,
): { set: Record<string, JSONValue>; unset: string[] } {
  const p = drive.properties;
  const fields = taskFields(record.task);
  const shared: Record<string, unknown> = {
    [NAME]: fields.name,
    [TASK_STATUS]: [fields.done ? TAG_DONE : TAG_TODO],
  };
  const unset: string[] = [];
  if (fields.body) shared[TASK_BODY] = fields.body;
  else unset.push(TASK_BODY);
  if (fields.dueDay) shared[TASK_DUE_DATE] = fields.dueDay;
  else unset.push(TASK_DUE_DATE);

  const set = resolver.write(shared, ISSUE_V1) as Record<string, JSONValue>;
  set[p.taskId] = record.id;
  set[p.listId] = record.listId;
  set[p.presence] = record.presence;
  set[p.source] = JSON.stringify(record.task);

  const optional: [string, string | undefined][] = [
    [p.list, text(record.listTitle)],
    [p.parent, fields.parent],
    // A present task was seen at the App's last sync; see the header.
    [p.lastSeen, record.presence === 'present' ? undefined : record.lastSeen],
  ];
  for (const [property, value] of optional)
    if (value === undefined) unset.push(property);
    else set[property] = value;

  return { set, unset };
}

export interface SyncOptions {
  /** The pass's time, stored exactly; tests pin it. */
  now?: () => string;
  /** Page cap for the reads; tests force a partial read with it. */
  read?: { pageSize?: number; maxPages?: number };
  /** The by-id lookups per pass; tests lower it. */
  maxLookups?: number;
  /** How a rate limit is waited out (`read.ts` `rateLimited`); tests pin the clock and the wait. */
  rateLimit?: RateLimitOptions;
}

/**
 * Reads the person's task lists, every chosen list's tasks (completed and
 * hidden ones included) and, for each previously imported task now missing
 * from a complete read, that task by id; then reconciles (`reconcileTasks`)
 * and writes what changed. A rate limit that cannot be waited out throws
 * `GoogleRateLimited` before any write.
 */
export async function syncTasks(
  store: PluginStore,
  rawGet: GoogleGet,
  drive: Drive,
  {
    now = () => new Date().toISOString(),
    read,
    maxLookups,
    rateLimit,
  }: SyncOptions = {},
): Promise<SyncSummary> {
  const clock = () => Date.parse(now());
  const get = rateLimited(rawGet, rateLimit);
  const readOptions = { ...read, now: clock };
  const chosen = await chosenLists(store, drive);
  const lists = await readTaskLists(get, readOptions);
  const known = new Set(lists.lists.map(l => l.id));
  const titles = new Map(lists.lists.map(l => [l.id, l.title]));
  const fetchedLists: FetchedList[] = [];

  for (const id of chosen) {
    // A chosen list that a complete read no longer names is gone: its tasks
    // are settled by `reconcileTasks`, with no call that could only 404.
    if (!lists.partial && !known.has(id)) continue;
    const { rows, partial } = await readTasks(get, id, readOptions);
    fetchedLists.push({
      id,
      title: titles.get(id) ?? '',
      tasks: rows,
      ...(partial ? { partial } : {}),
    });
  }

  const fetched: Fetched = {
    lists: lists.lists,
    listsComplete: !lists.partial,
    read: fetchedLists,
  };
  const lastCompleteAt = await lastSync(store, drive, clock());
  const { previous, rows } = await previousTasks(store, drive);
  const lookups = await lookupTasks(get, absentTasks(previous, fetched), {
    ...(maxLookups === undefined ? {} : { maxLookups }),
    now: clock,
  });
  const seenAt = now();
  const { records, summary } = reconcileTasks({
    previous,
    fetched,
    chosen,
    lookups,
    seenAt,
    ...(lastCompleteAt ? { lastCompleteAt } : {}),
  });

  const out: SyncSummary = {
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    presence: {
      present: summary.present,
      deleted: summary.deleted,
      unavailable: summary.unavailable,
      unconfirmed: summary.unconfirmed,
    },
    reappeared: summary.reappeared,
    checked: lookups.length,
    complete: summary.complete,
    lists: lists.lists,
    chosen,
  };

  for (const record of records) {
    out.total++;
    const { set, unset } = rowValues(record, drive);
    const row = rows.get(record.id);

    if (!row) {
      await store.newResource({
        parent: drive.table,
        isA: [drive.rowClass],
        propVals: set,
      });
      out.added++;
      continue;
    }

    const changed = Object.entries(set).filter(
      ([property, value]) => !same(row.get(property), value),
    );
    const removed = unset.filter(property => row.get(property) !== undefined);

    if (!changed.length && !removed.length) {
      out.unchanged++;
      continue;
    }

    for (const [property, value] of changed) row.set(property, value);
    for (const property of removed) row.remove(property);
    await row.save();
    out.updated++;
  }

  // Rows are written first: a failed record of the read's time must not
  // leave imported tasks unwritten, only this one timestamp stale.
  if (summary.complete) await recordSync(store, drive, seenAt);

  return out;
}

/**
 * The table's rows as the view lists them. Reads only. A row made in the
 * table by hand has no `taskId`: its presence is `local`, and the pass
 * leaves it alone. A row missing the class's required Name (#177;
 * ontology-kit's rule: shown as incomplete, never skipped) carries the note;
 * Google's next pass fills the Name of an imported row whose title it has, a
 * hand-made one is completed in the table.
 */
export interface TaskRow {
  subject: string;
  taskId?: string;
  name: string;
  done: boolean;
  presence: string;
  /** "Incomplete: missing Name". */
  incomplete?: string;
  dueDay?: string;
  listId?: string;
  list?: string;
  parent?: string;
  lastSeen?: string;
}

export async function listTasks(
  store: PluginStore,
  drive: Drive,
): Promise<TaskRow[]> {
  const p = drive.properties;
  const out: TaskRow[] = [];

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    const isA = row.get(IS_A);
    if (!Array.isArray(isA) || !isA.includes(ISSUE_V1)) continue;
    const taskId = text(row.get(p.taskId));
    const { values, missing } = resolver.read(row.props, ISSUE_V1);
    const status = values[TASK_STATUS];
    const optional = {
      taskId,
      dueDay: text(values[TASK_DUE_DATE]),
      listId: text(row.get(p.listId)),
      list: text(row.get(p.list)),
      parent: text(row.get(p.parent)),
      lastSeen: text(row.get(p.lastSeen)),
      incomplete: incompleteNote(missing, COLUMN_NAMES),
    };
    out.push({
      subject,
      name: text(values[NAME]) ?? '',
      done: Array.isArray(status) && status.includes(TAG_DONE),
      presence: taskId ? (text(row.get(p.presence)) ?? 'present') : 'local',
      ...Object.fromEntries(
        Object.entries(optional).filter(([, v]) => v !== undefined),
      ),
    });
  }

  return out.sort(
    (a, b) =>
      a.name.localeCompare(b.name) || a.subject.localeCompare(b.subject),
  );
}
