// @wc-ignore-file
/**
 * Google Tasks' task shape (`tasks#task`, Tasks API v1), translated onto
 * what an `issue-v1` row needs, and what happens to a task that stops
 * appearing in its list. Pure: no store, no network. `sync.ts` is the host.
 *
 * Read-only: nothing an issue table changes here is sent back to Google.
 *
 * The app reads each chosen task list with `showCompleted=true` and
 * `showHidden=true`, so a task completed in Google (also in Google's own
 * apps, which hide a completed task at once) stays in the read with
 * `status: "completed"` and becomes a done row. What leaves the read is a
 * task deleted in Google (`showDeleted` stays false), moved to another list,
 * or one whose list was deleted; absence alone is never read as completion:
 *
 * - `present`: in the last complete read of its list, open or completed.
 * - `deleted`: Google returned the task by id with `deleted: true`.
 * - `unavailable`: gone from a complete read, and the by-id check answered
 *   404, or the task list itself is gone from the person's lists. Deleted
 *   for good, moved, or access lost: Google does not say which, so this is
 *   never shown as completed.
 * - `unconfirmed`: gone from a complete read, and the by-id check failed or
 *   was not made (a partial read, or more absent tasks than one pass
 *   checks). The row keeps its last known values; `last-seen` says how old
 *   they are.
 */
import type { JSONValue } from './store.js';

export const PRESENCE = [
  'present',
  'deleted',
  'unavailable',
  'unconfirmed',
] as const;
export type Presence = (typeof PRESENCE)[number];

/** Presences that stay until the task shows up in a read again. */
const SETTLED: Presence[] = ['deleted', 'unavailable'];

export type Row = Record<string, JSONValue>;

export const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** One task list, as `GET /tasks/v1/users/@me/lists` names it. */
export interface TaskListEntry {
  id: string;
  title: string;
}

/** A task as this app keeps it: Google's record plus the app's bookkeeping. */
export interface TaskRecord {
  /** Google's task id: the row's identity. */
  id: string;
  listId: string;
  /** The list's title as last read; the id is what matters. */
  listTitle: string;
  /** The task as Google last sent it. */
  task: Row;
  presence: Presence;
  /** When Google last returned the task; set only when it is not `present`. */
  lastSeen?: string;
}

/** The tasks of one chosen list, as read. */
export interface FetchedList {
  id: string;
  title: string;
  tasks: Row[];
  /** Set when the page cap stopped the read: absence then says nothing. */
  partial?: string;
}

export interface Fetched {
  /** Every task list the account has, when that read was complete. */
  lists: TaskListEntry[];
  /** Whether the task-list read itself was complete. */
  listsComplete: boolean;
  /** The chosen lists that were read (a chosen list Google no longer has is absent here). */
  read: FetchedList[];
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/** `due` is an RFC 3339 timestamp whose time part Google discards: the day. */
const DUE_DAY = /^(\d{4}-\d{2}-\d{2})T/;

/**
 * The shared fields of a task, as exact strings: the title (`''` when Google
 * sent none; the row is then incomplete, never skipped), whether it is done,
 * the notes, and the due day, taken from Google's RFC 3339 `due` as the
 * date it writes (its time portion is always midnight UTC and carries no
 * information), with no local-time shift.
 */
export function taskFields(task: Row): {
  name: string;
  done: boolean;
  body?: string;
  dueDay?: string;
  parent?: string;
} {
  const due = text(task.due);
  const day = due ? DUE_DAY.exec(due)?.[1] : undefined;

  return {
    name: typeof task.title === 'string' ? task.title : '',
    done: task.status === 'completed',
    ...(text(task.notes) ? { body: text(task.notes) } : {}),
    ...(day ? { dueDay: day } : {}),
    ...(text(task.parent) ? { parent: text(task.parent) } : {}),
  };
}

/** Google's answer to `GET .../lists/{list}/tasks/{id}` for one task, or why there is none. */
export type Lookup =
  | { id: string; status: number; body?: JSONValue }
  | { id: string; error: string };

const isComplete = (fetched: Fetched) =>
  fetched.listsComplete && fetched.read.every(list => !list.partial);

/**
 * The previous tasks to check by id before `reconcileTasks`: those that were
 * present or unconfirmed and that a complete read no longer holds. In order
 * of their list, then id, so a cap takes the same ones each pass. None when
 * any part of the read was partial (the task-list read, or any chosen list):
 * the pass then settles nothing, so the card's "no task was settled" is
 * true. A task whose list is gone from a complete read is not here either:
 * `reconcileTasks` marks it unavailable without a call.
 */
export function absentTasks(
  previous: TaskRecord[],
  fetched: Fetched,
): { id: string; listId: string }[] {
  const out: { id: string; listId: string }[] = [];
  if (!isComplete(fetched)) return out;

  for (const list of fetched.read) {
    const present = new Set(list.tasks.map(t => t.id).filter(Boolean));
    out.push(
      ...previous
        .filter(
          r =>
            r.listId === list.id &&
            !present.has(r.id) &&
            !SETTLED.includes(r.presence),
        )
        .map(r => ({ id: r.id, listId: r.listId }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  return out;
}

export interface ReconcileSummary extends Record<Presence, number> {
  /** Tasks back in a read after being absent or settled. */
  reappeared: number;
  /** Whether every chosen list was read completely. */
  complete: boolean;
}

/**
 * What the table should hold after a read (the analogue of the Todoist
 * app's #99 rule):
 *
 * - A task in the read is `present`, with Google's current values; a task
 *   that was absent or settled before counts as reappeared.
 * - After a complete read (the task lists and every chosen list), a
 *   previous task missing from its list takes the presence its lookup
 *   supports (see the header). It keeps the values Google last sent and
 *   `lastSeen` stays what it was.
 * - After a complete read, a previous task whose list is gone from the
 *   person's lists is `unavailable` with no lookup.
 * - A partial read (of the task lists or of any chosen list) settles no
 *   previous task at all; it only takes the tasks it did read.
 * - A previous task of a list the person no longer chose is kept as it is.
 * - Nothing is removed, and nothing is written to Google.
 *
 * `seenAt` is the read's time as an ISO 8601 string, stored exactly.
 * `lastCompleteAt` is when the previous complete read was, if any: a task
 * that leaves its list was last seen then, not now.
 */
export function reconcileTasks({
  previous,
  fetched,
  chosen,
  lookups = [],
  seenAt,
  lastCompleteAt,
}: {
  previous: TaskRecord[];
  fetched: Fetched;
  /** The task lists the person chose, by id. */
  chosen: string[];
  lookups?: Lookup[];
  seenAt: string;
  lastCompleteAt?: string;
}): { records: TaskRecord[]; summary: ReconcileSummary } {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(seenAt))
    throw new Error('seenAt must be an ISO 8601 date and time');
  const before = new Map(previous.map(r => [r.id, r]));
  const answers = new Map(lookups.map(l => [l.id, l]));
  const check = new Set(absentTasks(previous, fetched).map(a => a.id));
  const readLists = new Map(fetched.read.map(l => [l.id, l]));
  const knownLists = new Set(fetched.lists.map(l => l.id));
  const complete = isComplete(fetched);
  let reappeared = 0;
  const seen: TaskRecord[] = [];
  const present = new Set<string>();

  for (const list of fetched.read)
    for (const task of list.tasks) {
      const id = text(task.id);
      if (!id || present.has(id)) continue;
      present.add(id);
      const earlier = before.get(id);
      if (earlier && earlier.presence !== 'present') reappeared++;
      seen.push({
        id,
        listId: list.id,
        listTitle: list.title,
        task,
        presence: 'present',
      });
    }

  const carried = previous
    .filter(row => !present.has(row.id))
    .map((row): TaskRecord => {
      const mark = (presence: Presence): TaskRecord => ({
        ...row,
        presence,
        lastSeen: row.lastSeen ?? lastCompleteAt ?? seenAt,
      });
      // The list itself is gone: no call can find the task. Only after a
      // complete read, like every other settling.
      if (
        complete &&
        chosen.includes(row.listId) &&
        !knownLists.has(row.listId) &&
        !SETTLED.includes(row.presence)
      )
        return mark('unavailable');
      if (!check.has(row.id)) return row;
      const answer = answers.get(row.id);
      if (!answer || 'error' in answer) return mark('unconfirmed');
      if (answer.status === 404) return mark('unavailable');
      const body = isRow(answer.body) ? answer.body : {};
      if (answer.status !== 200 || body.id !== row.id)
        return mark('unconfirmed');
      if (body.deleted === true) return { ...mark('deleted'), task: body };
      // Google returned the task itself (hidden, say): take its values.
      const { lastSeen: _seen, ...rest } = row;

      return {
        ...rest,
        task: body,
        presence: 'present',
        listTitle: readLists.get(row.listId)?.title ?? row.listTitle,
      };
    });

  const records = [...seen, ...carried];
  const summary: ReconcileSummary = {
    present: 0,
    deleted: 0,
    unavailable: 0,
    unconfirmed: 0,
    reappeared,
    complete,
  };
  for (const row of records) summary[row.presence]++;

  return { records, summary };
}
