/**
 * Todoist mock-proxy fixture, registered as `todoist` in
 * integrations/localthought/fixtures/index.mjs. Its data comes from one of
 * two sources, in this order:
 *
 *   api/            the recorded, redacted API v1 pages record.mjs writes
 *                   against a real account (#46). Not present yet.
 *   synthetic.mjs   SYNTHETIC rows hand-written from Todoist's API
 *                   documentation (read its header). Used until api/ exists.
 *
 * `recorded()` says which. document.yaml, the catalog document, is recorded
 * from the real proxy either way (record.mjs --document-only).
 *
 * Served, read-only like the real proxy's `data:read` catalog:
 *   GET /proxy/todoist/api/v1/projects[?cursor=page-<n>]
 *   GET /proxy/todoist/api/v1/tasks[?cursor=page-<n>][&project_id=<id>]
 *       — the ACTIVE tasks, as Todoist's /tasks lists only those: a task
 *         the `completeTask`, `deleteTask` or `removeTask` driver touched
 *         is left out.
 *   GET /proxy/todoist/api/v1/projects/<id>, /tasks/<id>
 *       — the row as it now stands: `checked: true` after completeTask,
 *         `is_deleted: true` after deleteTask, 404 after removeTask or for
 *         an unknown id.
 * Any other method is 403 (the real catalog allows GET only); any other path
 * 404. `limit` is ignored: pages hold PAGE_SIZE rows (the recorded page
 * size, or 3 for the synthetic rows, so five tasks span two pages).
 *
 * Test drivers (POST /fixture/todoist/<name> on the mock proxy, or the
 * instance's methods in-process) stand in for someone working in Todoist and
 * for Todoist failing. They are the fixture's own and claim nothing about
 * Todoist beyond what synthetic.mjs's header says:
 *   completeTask(id)   checks the task off: gone from /tasks, by id checked.
 *   reopenTask(id)     back in /tasks (also undoes deleteTask/removeTask).
 *   deleteTask(id)     gone from /tasks; by id with is_deleted: true.
 *   removeTask(id)     gone from /tasks; by id 404 (lost access, or deleted
 *                      for good: Todoist would not say which).
 *   failNext(count, status = 503, only = 'any' | 'list' | 'lookup')
 *                      the next `count` matching requests answer `status`.
 *   snapshot()         every task row, active or not.
 *
 * For the live-check kit's offline tests (issue-tracker/live/todoist/
 * fakeTodoist.ts), not the mock proxy: `todoistFixture({ blank: true })`
 * starts with no tasks, `createTask(fields)` and `updateTask(id, fields)` do
 * what `POST /tasks` and `POST /tasks/{id}` would. None is in `drivers`, so
 * none is reachable over the mock proxy, and the HTTP surface stays GET only.
 *
 * Lives in the issue-tracker plugin folder, whose lane names todoist.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as synthetic from './synthetic.mjs';

const api = new URL('./api/', import.meta.url);
const COLLECTIONS = ['projects', 'tasks'];
const SYNTHETIC_PAGE_SIZE = 3;

export const recorded = () => existsSync(new URL('meta.json', api));

function loadPages(collection) {
  const pages = [];

  for (let n = 1; ; n++) {
    const file = new URL(`GET__api__v1__${collection}__page-${n}.json`, api);
    if (!existsSync(file)) break;
    pages.push(JSON.parse(readFileSync(file, 'utf8')));
  }

  return pages;
}

/** The rows to start from and the page size, from api/ or synthetic.mjs. */
export function source() {
  if (!recorded())
    return {
      synthetic: true,
      pageSize: SYNTHETIC_PAGE_SIZE,
      projects: structuredClone(synthetic.projects),
      tasks: structuredClone(synthetic.tasks),
    };
  const pages = Object.fromEntries(COLLECTIONS.map(c => [c, loadPages(c)]));
  const rows = c => pages[c].flatMap(page => page.body.results);

  return {
    synthetic: false,
    pageSize: pages.tasks[0]?.body.results.length || SYNTHETIC_PAGE_SIZE,
    projects: rows('projects'),
    tasks: rows('tasks'),
  };
}

export function todoistFixture({ blank = false } = {}) {
  const { synthetic: isSynthetic, pageSize, projects, tasks } = source();
  if (blank) tasks.length = 0;
  let made = 0;
  const byId = new Map(tasks.map(t => [t.id, t]));
  /** Ids the `removeTask` driver made unreachable (404 by id). */
  const gone = new Set();
  const failures = [];

  const active = () =>
    tasks.filter(t => !t.checked && !t.is_deleted && !gone.has(t.id));

  const paged = (rows, cursor) => {
    const n = cursor ? Number(/^page-(\d+)$/.exec(cursor)?.[1]) : 1;
    if (!Number.isInteger(n) || n < 1)
      return { status: 400, body: { error: 'Invalid cursor' } };
    const start = (n - 1) * pageSize;
    if (start > 0 && start >= rows.length)
      return { status: 400, body: { error: 'Invalid cursor' } };
    const results = structuredClone(rows.slice(start, start + pageSize));

    return {
      status: 200,
      body: {
        results,
        next_cursor: start + pageSize < rows.length ? `page-${n + 1}` : null,
      },
    };
  };

  const must = id => {
    const row = byId.get(id);
    if (!row) throw new Error(`no task ${id}`);

    return row;
  };

  const pages = () => {
    const out = {};

    for (const [collection, rows] of [
      ['projects', projects],
      ['tasks', active()],
    ]) {
      out[collection] = [];
      let cursor;

      do {
        const page = paged(rows, cursor);
        out[collection].push(page);
        cursor = page.body.next_cursor;
      } while (cursor);
    }

    return out;
  };

  return {
    synthetic: isSynthetic,
    pageSize,
    /** The collections as the pages they are served in now (tests). */
    get pages() {
      return pages();
    },

    request(method, url) {
      const match = url.pathname.match(
        /^\/proxy\/todoist\/api\/v1\/(projects|tasks)(?:\/([^/]+))?$/,
      );
      if (!match) return { status: 404, body: {} };
      if (method !== 'GET') return { status: 403, body: {} };
      const [, collection, id] = match;
      const kind = id ? 'lookup' : 'list';
      const at = failures.findIndex(f => f.only === 'any' || f.only === kind);

      if (at !== -1) {
        const failure = failures[at];
        if (--failure.count <= 0) failures.splice(at, 1);

        return {
          status: failure.status,
          body: { error: `Synthetic failure (${failure.status})` },
        };
      }

      if (id) {
        const row =
          collection === 'tasks'
            ? gone.has(id)
              ? undefined
              : byId.get(id)
            : projects.find(p => p.id === id);

        return row
          ? { status: 200, body: structuredClone(row) }
          : { status: 404, body: {} };
      }

      const rows = collection === 'projects' ? projects : active();
      const projectId = url.searchParams.get('project_id');

      return paged(
        collection === 'tasks' && projectId
          ? rows.filter(t => t.project_id === projectId)
          : rows,
        url.searchParams.get('cursor'),
      );
    },

    createTask({
      content,
      project_id,
      description = '',
      priority = 1,
      due_date,
    }) {
      const id = `live-task-${++made}`;
      const row = {
        id,
        user_id: 'synthetic-user-1',
        project_id,
        section_id: null,
        parent_id: null,
        labels: [],
        checked: false,
        is_deleted: false,
        added_at: '2026-10-01T08:00:00.000000Z',
        completed_at: null,
        updated_at: '2026-10-01T08:00:00.000000Z',
        due: due_date
          ? {
              date: due_date,
              string: due_date,
              lang: 'en',
              is_recurring: false,
              timezone: null,
            }
          : null,
        priority,
        child_order: made,
        content,
        description,
        url: `https://app.todoist.com/app/task/${id}`,
      };
      tasks.push(row);
      byId.set(id, row);

      return structuredClone(row);
    },
    updateTask(id, fields) {
      const row = must(id);
      Object.assign(row, fields, { updated_at: '2026-10-01T09:00:00.000000Z' });

      return structuredClone(row);
    },

    // Drivers.
    completeTask(id) {
      const row = must(id);
      row.checked = true;
      row.completed_at = '2026-03-01T12:00:00.000000Z';
      row.updated_at = row.completed_at;

      return structuredClone(row);
    },
    reopenTask(id) {
      const row = must(id);
      row.checked = false;
      row.completed_at = null;
      row.is_deleted = false;
      gone.delete(id);

      return structuredClone(row);
    },
    deleteTask(id) {
      const row = must(id);
      row.is_deleted = true;

      return structuredClone(row);
    },
    removeTask(id) {
      must(id);
      gone.add(id);

      return { id, status: 404 };
    },
    failNext(count = 1, status = 503, only = 'any') {
      if (!['any', 'list', 'lookup'].includes(only))
        throw new Error(`failNext: only must be any, list or lookup`);
      failures.push({ count, status, only });

      return { failures: failures.map(f => ({ ...f })) };
    },
    snapshot() {
      return {
        tasks: structuredClone(tasks),
        unreachable: [...gone],
      };
    },
  };
}

export default {
  title: 'Todoist',
  // Served verbatim with a YAML content type, as the real proxy does.
  documentFile: new URL('./document.yaml', import.meta.url),
  create: todoistFixture,
  // For the drive app's e2e: someone completing, deleting or hiding a task
  // in Todoist, and Todoist failing.
  drivers: [
    'completeTask',
    'reopenTask',
    'deleteTask',
    'removeTask',
    'failNext',
    'snapshot',
  ],
};
