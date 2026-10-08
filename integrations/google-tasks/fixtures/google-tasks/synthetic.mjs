/**
 * SYNTHETIC Google Tasks data. NOT RECORDED.
 *
 * Nobody working on this repository had a Google account to record against
 * when the Google Tasks drive app (app/) needed a mock-proxy fixture, so
 * these bodies are hand-written from the Tasks API v1 reference
 * (https://developers.google.com/workspace/tasks/reference/rest/v1/tasks,
 * .../tasklists, and the pinned OpenAPI document
 * APIs/googleapis.com/tasks/v1 at 7ca47c73cf2308c9812692b482b3713b397bc88c):
 * the field names, their types and the paged envelope
 * `{ kind, etag, items, nextPageToken }`. Every id, title, note and timestamp
 * is invented; the ids say so (`synthetic-…`). None belongs to a real
 * account. A live run (Decision Inbox Q-098) is what replaces this.
 *
 * What this cannot tell you: whether real responses carry fields, nulls or
 * values this file does not; whether a completed task really comes back
 * `hidden: true` from the first-party apps as the reference says; and what
 * Google answers for `GET .../tasks/{id}` on a deleted task (the reference
 * documents `deleted: true` on the resource, which `deleteTask` in
 * scenario.mjs models). Those are modelling choices of this fixture,
 * declared, not verified against Google.
 *
 * The seven tasks cover what tasks.ts reads: a due date, no due date, notes,
 * a completed (and hidden) task, a subtask under a parent, two lists, and
 * an empty title.
 */

export const SYNTHETIC = true;

export const MY_TASKS = 'synthetic-list-1';
export const GROCERIES = 'synthetic-list-2';

const API = 'https://www.googleapis.com/tasks/v1';

/** A task list as `tasklists.list` documents it, with synthetic values. */
function list(id, title, updated) {
  return {
    kind: 'tasks#taskList',
    id,
    etag: `"synthetic-etag-${id}"`,
    title,
    updated,
    selfLink: `${API}/users/@me/lists/${id}`,
  };
}

export const lists = [
  list(MY_TASKS, 'My Tasks', '2026-02-05T08:30:00.000Z'),
  list(GROCERIES, 'Synthetic groceries', '2026-02-06T08:30:00.000Z'),
];

/** A task as `tasks.list` documents it, with synthetic values. */
function task(n, listId, title, over = {}) {
  const id = `synthetic-task-${n}`;

  return {
    kind: 'tasks#task',
    id,
    etag: `"synthetic-etag-${id}"`,
    title,
    updated: `2026-02-0${n}T08:30:00.000Z`,
    selfLink: `${API}/lists/${listId}/tasks/${id}`,
    position: String(n).padStart(20, '0'),
    status: 'needsAction',
    links: [],
    webViewLink: `https://tasks.google.com/task/${id}`,
    ...over,
  };
}

/** Which list each task starts in (a task's own fields do not say). */
export const tasks = [
  {
    listId: MY_TASKS,
    ...task(1, MY_TASKS, 'Water the imaginary ferns', {
      due: '2026-03-02T00:00:00.000Z',
    }),
  },
  {
    listId: MY_TASKS,
    ...task(2, MY_TASKS, 'Call the fictional dentist', {
      notes: 'Ask about the pretend filling.',
      due: '2026-03-03T00:00:00.000Z',
    }),
  },
  {
    listId: MY_TASKS,
    ...task(3, MY_TASKS, 'Buy invented fern food', {
      parent: 'synthetic-task-1',
    }),
  },
  {
    listId: MY_TASKS,
    ...task(4, MY_TASKS, 'Return the made-up library books', {
      status: 'completed',
      completed: '2026-02-20T10:00:00.000Z',
      hidden: true,
    }),
  },
  {
    listId: MY_TASKS,
    ...task(5, MY_TASKS, 'Sort the pretend attic'),
  },
  {
    listId: GROCERIES,
    ...task(6, GROCERIES, 'Synthetic oat milk', {
      due: '2026-03-07T00:00:00.000Z',
    }),
  },
  {
    listId: GROCERIES,
    ...task(7, GROCERIES, '', { notes: 'A task Google sent without a title.' }),
  },
];
