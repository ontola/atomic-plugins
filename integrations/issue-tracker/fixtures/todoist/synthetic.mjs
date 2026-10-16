/**
 * SYNTHETIC Todoist data. NOT RECORDED.
 *
 * Nobody working on this repository had a Todoist test account when the
 * Todoist drive app (todoist-app/) needed a mock-proxy fixture, so these
 * bodies are hand-written from Todoist's public API v1 documentation
 * (https://developer.todoist.com/api/v1/, "Get active tasks", "Get a task",
 * "Get all projects"): the field names, their types and the paged envelope
 * `{ results, next_cursor }`. Every id, name, task text and timestamp is
 * invented; the ids say so (`synthetic-…`). None belongs to a real account.
 * Recording the real thing is #46's job (record.mjs); once api/ exists,
 * scenario.mjs replays that instead of this file.
 *
 * What this cannot tell you: whether real responses carry fields, nulls or
 * values this file does not, and what Todoist answers for `GET /tasks/{id}`
 * on a completed task. todoist.ts reads `checked: true` from such an answer
 * (its README explains the fallback when the answer is 404 instead), and
 * scenario.mjs's `completeTask` driver answers that way. That is a modelling
 * choice of this fixture, declared, not verified against Todoist.
 *
 * The five tasks cover what todoist.ts reads: a due date, a due date with a
 * time, no due date, every priority from 1 (normal) to 4 (urgent), an empty
 * and a non-empty description, and two projects.
 */

export const SYNTHETIC = true;

const INBOX = 'synthetic-project-1';
const HOUSE = 'synthetic-project-2';
const USER = 'synthetic-user-1';

/** A project as "Get all projects" documents it, with synthetic values. */
function project(id, name, over = {}) {
  return {
    id,
    name,
    color: 'charcoal',
    parent_id: null,
    child_order: 1,
    view_style: 'list',
    is_favorite: false,
    is_archived: false,
    is_deleted: false,
    is_frozen: false,
    can_assign_tasks: false,
    created_at: '2026-01-05T09:00:00.000000Z',
    updated_at: '2026-01-05T09:00:00.000000Z',
    inbox_project: false,
    is_collapsed: false,
    is_shared: false,
    description: '',
    default_order: 0,
    creator_uid: USER,
    url: `https://app.todoist.com/app/project/${id}`,
    ...over,
  };
}

export const projects = [
  project(INBOX, 'Inbox', { inbox_project: true, color: 'grey' }),
  project(HOUSE, 'Synthetic house', { child_order: 2, color: 'teal' }),
];

/** A task as "Get active tasks" documents it, with synthetic values. */
function task(n, projectId, content, over = {}) {
  const id = `synthetic-task-${n}`;

  return {
    id,
    user_id: USER,
    project_id: projectId,
    section_id: null,
    parent_id: null,
    added_by_uid: USER,
    assigned_by_uid: null,
    responsible_uid: null,
    labels: [],
    deadline: null,
    duration: null,
    checked: false,
    is_deleted: false,
    added_at: `2026-02-0${n}T08:00:00.000000Z`,
    completed_at: null,
    updated_at: `2026-02-0${n}T08:30:00.000000Z`,
    due: null,
    priority: 1,
    child_order: n,
    content,
    description: '',
    note_count: 0,
    day_order: -1,
    is_collapsed: false,
    url: `https://app.todoist.com/app/task/${id}`,
    ...over,
  };
}

export const tasks = [
  task(1, INBOX, 'Water the synthetic plants', {
    due: {
      date: '2026-03-02',
      string: 'Mar 2',
      lang: 'en',
      is_recurring: false,
      timezone: null,
    },
    priority: 4,
  }),
  task(2, INBOX, 'Call the invented plumber', {
    due: {
      date: '2026-03-03',
      datetime: '2026-03-03T09:30:00Z',
      string: 'Mar 3 10:30',
      lang: 'en',
      is_recurring: false,
      timezone: 'Europe/Amsterdam',
    },
    priority: 3,
    description: 'Ask about the imaginary leak under the sink.',
  }),
  task(3, HOUSE, 'Paint the fictional fence', {
    priority: 2,
    labels: ['synthetic-label-outdoors'],
  }),
  task(4, HOUSE, 'Sort the pretend attic', {
    due: {
      date: '2026-03-20',
      string: 'every month',
      lang: 'en',
      is_recurring: true,
      timezone: null,
    },
    priority: 1,
  }),
  task(5, HOUSE, 'Return the made-up library books', { priority: 1 }),
];
