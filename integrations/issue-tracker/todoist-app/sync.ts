// @wc-ignore-file
/**
 * One import pass: Todoist's active tasks into the app's `issue-v1` table,
 * through ../todoist.ts for what each task becomes and for what happens to a
 * task that stops appearing (#99).
 *
 * Reads first, all of them, then writes: a read that fails leaves the table
 * as it was. Rows are matched by `todoist-task-id`. Todoist owns the
 * imported columns: a task that changed there overwrites them, a local edit
 * to one of them is overwritten at the next pass (#97's policy question; the
 * read-only Moneybird app does the same), and nothing is ever sent to
 * Todoist. No row is ever removed.
 *
 * A pass that finds nothing changed writes no row. `last-seen` would change
 * on every pass if it were kept on every row, so it is not: an active task's
 * last sighting is the App's `todoist-last-sync` (one write per complete
 * read), and only a task no longer in the active list carries its own
 * `todoist-last-seen`, as ../todoist.ts hands it over.
 */
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes } from '../../../ontology-kit/terms.mjs';
import type { JSONValue as AtomicJSON } from '../../../browser/lib/src/value.js';
import type {
  FetchedPlatform,
  FetchedRecord,
} from '../../localthought/schema.js';
import {
  absentTodoistTasks,
  reconcileTodoistTasks,
  TODOIST_PLATFORM,
  TODOIST_PRESENCE,
  todoistFields,
  type TodoistPresence,
} from '../todoist.js';
import {
  type Drive,
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
  lookupTasks,
  readActiveTasks,
  readProjects,
  type TodoistGet,
  type TodoistResponse,
} from './read.js';
import type {
  HostProxy,
  JSONValue,
  PluginResource,
  PluginStore,
} from './store.js';

export const PLATFORM = TODOIST_PLATFORM;

/** Reads and writes `issue-v1` rows by property subject, strictly (#177 decision 1). */
const resolver = createResolver({ classes: [classes['issue-v1']] });

export interface SyncSummary {
  /** Task rows in the table after the pass. */
  total: number;
  added: number;
  updated: number;
  unchanged: number;
  /** Task rows by presence after the pass. */
  presence: Record<TodoistPresence, number>;
  /** Tasks back in the active list after being absent or settled. */
  reappeared: number;
  /** How many absent tasks were looked up by id in this pass. */
  checked: number;
  /** Whether the active-task read was complete (a partial read settles nothing). */
  complete: boolean;
}

/**
 * A `TodoistGet` over the host's proxy relay. The frame never holds a
 * credential or calls the network itself; the host's frame client does.
 */
export function relayGet(
  proxy: HostProxy,
  connection: { platform: string; connectionId: string },
): TodoistGet {
  return async path => {
    if (!path.startsWith('/api/v1/'))
      throw new Error(`Refusing a Todoist path: ${path}`);
    const response = await proxy.request({
      platform: connection.platform,
      connectionId: connection.connectionId,
      path,
      method: 'GET',
    });

    return { status: response.status, body: response.body } as TodoistResponse;
  };
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** Deep enough for the values written here: strings, booleans, string arrays. */
const same = (a: JSONValue, b: JSONValue) =>
  Array.isArray(a) || Array.isArray(b)
    ? JSON.stringify(a) === JSON.stringify(b)
    : a === b;

/** The task rows of the table as ../todoist.ts last returned them. */
async function previousTasks(
  store: PluginStore,
  drive: Drive,
  seenAt: string | undefined,
): Promise<{ previous: FetchedRecord[]; rows: Map<string, PluginResource> }> {
  const { taskId, source } = drive.properties;
  const previous: FetchedRecord[] = [];
  const rows = new Map<string, PluginResource>();

  for (const subject of await store.query({
    property: PARENT,
    value: drive.table,
  })) {
    const row = await store.getResource(subject);
    const id = text(row.get(taskId));
    // A row made in the table by hand has no Todoist task behind it: local
    // only, left alone. A second row for the same task is left alone too.
    if (!id || rows.has(id)) continue;
    rows.set(id, row);
    let values: Record<string, AtomicJSON> = {};

    try {
      const parsed: unknown = JSON.parse(text(row.get(source)) ?? '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        values = parsed as Record<string, AtomicJSON>;
    } catch {
      // Unreadable source: the row is treated as an active task with no
      // provider values, and the next read replaces them.
    }

    const presence = values[todoistFields.presence];
    const active =
      !TODOIST_PRESENCE.includes(presence as TodoistPresence) ||
      presence === 'active';
    if (active && seenAt && values[todoistFields.lastSeen] === undefined)
      values = { ...values, [todoistFields.lastSeen]: seenAt };
    previous.push({
      resource: 'task',
      namespace: PLATFORM,
      id,
      name: text(row.get(NAME)) ?? id,
      values,
    });
  }

  return { previous, rows };
}

/** What a row should hold for one reconciled task record. */
function rowValues(
  record: FetchedRecord,
  drive: Drive,
  projects: Map<string, string>,
): { set: Record<string, JSONValue>; unset: string[] } {
  const p = drive.properties;
  const v = record.values;
  const presence = v[todoistFields.presence] as TodoistPresence;
  const active = presence === 'active';
  const shared: Record<string, unknown> = {
    [NAME]: record.name,
    [TASK_STATUS]: [v[todoistFields.done] === true ? TAG_DONE : TAG_TODO],
  };
  const unset: string[] = [];
  const body = text(v.description);
  if (body) shared[TASK_BODY] = body;
  else unset.push(TASK_BODY);
  const due = text(v[todoistFields.dueDay]);
  if (due) shared[TASK_DUE_DATE] = due;
  else unset.push(TASK_DUE_DATE);

  const set = resolver.write(shared, ISSUE_V1) as Record<string, JSONValue>;
  set[p.taskId] = record.id;
  set[p.presence] = presence;

  const optional: [string, string | undefined][] = [
    // An active task was seen at the App's last sync; see the header.
    [p.lastSeen, active ? undefined : text(v[todoistFields.lastSeen])],
    [p.priority, text(v[todoistFields.priorityLabel])],
    [p.project, projects.get(text(v.project_id) ?? '')],
  ];
  for (const [property, value] of optional)
    if (value === undefined) unset.push(property);
    else set[property] = value;

  const { [todoistFields.lastSeen]: seen, ...rest } = v;
  set[p.source] = JSON.stringify(
    active ? rest : { ...rest, [todoistFields.lastSeen]: seen },
  );

  return { set, unset };
}

export interface SyncOptions {
  /** The pass's time, stored exactly; tests pin it. */
  now?: () => string;
  /** Page cap for the reads; tests force a partial read with it. */
  read?: { pageSize?: number; maxPages?: number };
}

/**
 * Reads the projects, the complete active-task list and, for each previously
 * imported task now missing from a complete list, that task by id; then
 * reconciles (`reconcileTodoistTasks`) and writes what changed.
 */
export async function syncTasks(
  store: PluginStore,
  get: TodoistGet,
  drive: Drive,
  { now = () => new Date().toISOString(), read }: SyncOptions = {},
): Promise<SyncSummary> {
  const projects = await readProjects(get, read);
  const fetched: FetchedPlatform = await readActiveTasks(get, read);
  const { previous, rows } = await previousTasks(
    store,
    drive,
    await lastSync(store, drive),
  );
  const absent = absentTodoistTasks(previous, fetched);
  const lookups = await lookupTasks(get, absent);
  const seenAt = now();
  const { platform, summary } = reconcileTodoistTasks({
    previous,
    fetched,
    lookups,
    seenAt,
  });

  const out: SyncSummary = {
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    presence: {
      active: summary.active,
      completed: summary.completed,
      deleted: summary.deleted,
      unavailable: summary.unavailable,
      unconfirmed: summary.unconfirmed,
    },
    reappeared: summary.reappeared,
    checked: lookups.length,
    complete: summary.complete,
  };

  for (const record of platform.records) {
    if (record.resource !== 'task') continue;
    out.total++;
    const { set, unset } = rowValues(record, drive, projects);
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

/** The table's task rows as the view lists them. Reads only. */
export interface TaskRow {
  subject: string;
  taskId: string;
  name: string;
  done: boolean;
  presence: string;
  dueDay?: string;
  priority?: string;
  project?: string;
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
    const taskId = text(row.get(p.taskId));
    if (!taskId) continue;
    const { values } = resolver.read(row.props, ISSUE_V1);
    const status = values[TASK_STATUS];
    const optional = {
      dueDay: text(values[TASK_DUE_DATE]),
      priority: text(row.get(p.priority)),
      project: text(row.get(p.project)),
      lastSeen: text(row.get(p.lastSeen)),
    };
    out.push({
      subject,
      taskId,
      name: text(values[NAME]) ?? taskId,
      done: Array.isArray(status) && status.includes(TAG_DONE),
      presence: text(row.get(p.presence)) ?? 'active',
      ...Object.fromEntries(
        Object.entries(optional).filter(([, v]) => v !== undefined),
      ),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}
