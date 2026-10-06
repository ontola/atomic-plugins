/**
 * Google Tasks mock-proxy fixture, registered as `google-tasks` in
 * integrations/localthought/fixtures/index.mjs. Its data is SYNTHETIC
 * (synthetic.mjs, hand-written from the Tasks API v1 reference; read its
 * header): there is no recording yet.
 *
 * Served, read-only like the catalog the real proxy composes for this
 * platform (overlays/catalog/2026-10-06-google-tasks.json, `tasks.readonly`):
 *   GET /proxy/google-tasks/tasks/v1/users/@me/lists[?pageToken=page-<n>]
 *   GET /proxy/google-tasks/tasks/v1/lists/<list>/tasks[?pageToken=…]
 *       [&showCompleted=…][&showHidden=…][&showDeleted=…]
 *       — the list's tasks, filtered as Google documents the flags:
 *         completed tasks shown by default, hidden and deleted ones only
 *         when asked. A task the `completeTask` driver touched is completed
 *         AND hidden (as the reference says Google's own apps leave it);
 *         `deleteTask` makes it deleted; `removeTask` makes it unreachable.
 *   GET /proxy/google-tasks/tasks/v1/lists/<list>/tasks/<id>
 *       — the task as it now stands, whatever the flags: 404 after
 *         removeTask, for an unknown id, or for the wrong list.
 * Any other method is 403 (the catalog's scope is read-only); any other
 * path 404. `maxResults` is ignored: pages hold PAGE_SIZE rows (3, so the
 * five tasks of the first list span two pages). An empty page has no
 * `items`, as Google's does.
 *
 * Test drivers (POST /fixture/google-tasks/<name> on the mock proxy, or the
 * instance's methods in-process) stand in for someone working in Google
 * Tasks and for Google failing. They are the fixture's own and claim nothing
 * about Google beyond what synthetic.mjs's header says:
 *   completeTask(id)   status completed, a completed time, hidden: true.
 *   reopenTask(id)     needsAction again, not hidden; also undoes
 *                      deleteTask and removeTask.
 *   deleteTask(id)     deleted: true: gone from the list, by id it says so.
 *   removeTask(id)     gone from the list; by id 404 (deleted for good,
 *                      moved out of reach, or access lost: Google would not
 *                      say which).
 *   renameTask(id, title)  a title edit made in Google.
 *   failNext(count, status = 503, only = 'any' | 'lists' | 'tasks' | 'lookup')
 *                      the next `count` matching requests answer `status`
 *                      (403 answers with Google's rateLimitExceeded body).
 *   snapshot()         every task row, present or not.
 *
 * Lives in the google-tasks plugin folder, whose lane names the platform.
 */
import * as synthetic from './synthetic.mjs';

export const PAGE_SIZE = 3;

/**
 * The catalog document the mock serves at /catalog/google-tasks.yaml: the
 * three operations the app uses, the pagination scheme of the published
 * overlay, and an OAuth scheme with the read-only scope, so the mock's
 * consent page treats it as an OAuth platform (no API key). Not the
 * composed document the real proxy serves; that is the pinned OAD plus the
 * overlays the dated catalog lists.
 */
export const document = {
  openapi: '3.0.3',
  info: { title: 'Synthetic Google Tasks', version: 'v1' },
  servers: [{ url: 'https://tasks.googleapis.com/' }],
  paths: {
    '/tasks/v1/users/@me/lists': {
      get: {
        operationId: 'tasks.tasklists.list',
        parameters: ['maxResults', 'pageToken'].map(name => ({
          name,
          in: 'query',
          schema: { type: 'string' },
        })),
        'x-pagination': [{ scheme: 'forwardPages' }],
        security: [
          { googleOffline: ['https://www.googleapis.com/auth/tasks.readonly'] },
        ],
        responses: { 200: { description: 'Task lists' } },
      },
    },
    '/tasks/v1/lists/{tasklist}/tasks': {
      get: {
        operationId: 'tasks.tasks.list',
        parameters: [
          {
            name: 'tasklist',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          ...[
            'maxResults',
            'pageToken',
            'showCompleted',
            'showHidden',
            'showDeleted',
          ].map(name => ({ name, in: 'query', schema: { type: 'string' } })),
        ],
        'x-pagination': [{ scheme: 'forwardPages' }],
        security: [
          { googleOffline: ['https://www.googleapis.com/auth/tasks.readonly'] },
        ],
        responses: { 200: { description: 'Tasks' } },
      },
    },
    '/tasks/v1/lists/{tasklist}/tasks/{task}': {
      get: {
        operationId: 'tasks.tasks.get',
        parameters: ['tasklist', 'task'].map(name => ({
          name,
          in: 'path',
          required: true,
          schema: { type: 'string' },
        })),
        security: [
          { googleOffline: ['https://www.googleapis.com/auth/tasks.readonly'] },
        ],
        responses: { 200: { description: 'Task' } },
      },
    },
  },
  components: {
    securitySchemes: {
      googleOffline: {
        type: 'oauth2',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              'https://www.googleapis.com/auth/tasks.readonly':
                'View your tasks',
            },
          },
        },
      },
    },
    paginationSchemes: {
      forwardPages: {
        type: 'pageToken',
        request: { queryParameters: { pageToken: { role: 'cursor' } } },
        response: { bodyFields: { nextPageToken: { role: 'nextCursor' } } },
      },
    },
  },
};

const flag = (params, name, fallback) => {
  const value = params.get(name);

  return value === null ? fallback : value === 'true';
};

export function googleTasksFixture() {
  const lists = structuredClone(synthetic.lists);
  const tasks = structuredClone(synthetic.tasks);
  const byId = new Map(tasks.map(t => [t.id, t]));
  /** Ids the `removeTask` driver made unreachable (404 by id). */
  const gone = new Set();
  const failures = [];

  /** The task as Google sends it: the fixture's `listId` is not a field. */
  const wire = ({ listId: _listId, ...task }) => structuredClone(task);

  const paged = (rows, cursor, kind) => {
    const n = cursor ? Number(/^page-(\d+)$/.exec(cursor)?.[1]) : 1;
    if (!Number.isInteger(n) || n < 1)
      return {
        status: 400,
        body: { error: { code: 400, message: 'Invalid pageToken' } },
      };
    const start = (n - 1) * PAGE_SIZE;
    if (start > 0 && start >= rows.length)
      return {
        status: 400,
        body: { error: { code: 400, message: 'Invalid pageToken' } },
      };
    const items = rows.slice(start, start + PAGE_SIZE);
    const body = { kind, etag: `"synthetic-page-${n}"` };
    if (items.length) body.items = items;
    if (start + PAGE_SIZE < rows.length) body.nextPageToken = `page-${n + 1}`;

    return { status: 200, body };
  };

  const must = id => {
    const row = byId.get(id);
    if (!row) throw new Error(`no task ${id}`);

    return row;
  };

  const failure = kind => {
    const at = failures.findIndex(f => f.only === 'any' || f.only === kind);
    if (at === -1) return undefined;
    const found = failures[at];
    if (--found.count <= 0) failures.splice(at, 1);
    const body =
      found.status === 403
        ? {
            error: {
              code: 403,
              message: 'Rate Limit Exceeded',
              errors: [
                {
                  message: 'Rate Limit Exceeded',
                  domain: 'usageLimits',
                  reason: 'rateLimitExceeded',
                },
              ],
            },
          }
        : {
            error: {
              code: found.status,
              message: `Synthetic failure (${found.status})`,
            },
          };

    return { status: found.status, body };
  };

  return {
    synthetic: true,
    pageSize: PAGE_SIZE,

    request(method, url) {
      const match = url.pathname.match(
        /^\/proxy\/google-tasks\/tasks\/v1\/(?:users\/@me\/lists|lists\/([^/]+)\/tasks(?:\/([^/]+))?)$/,
      );
      if (!match) return { status: 404, body: {} };
      if (method !== 'GET')
        return {
          status: 403,
          body: {
            error: { code: 403, message: 'Insufficient Permission' },
          },
        };
      const [, listId, taskId] = match;
      const kind =
        listId === undefined
          ? 'lists'
          : taskId === undefined
            ? 'tasks'
            : 'lookup';
      const failed = failure(kind);
      if (failed) return failed;

      if (kind === 'lists')
        return paged(
          structuredClone(lists),
          url.searchParams.get('pageToken'),
          'tasks#taskLists',
        );

      if (!lists.some(l => l.id === listId))
        return {
          status: 404,
          body: { error: { code: 404, message: 'Not Found' } },
        };

      if (kind === 'lookup') {
        const row = gone.has(taskId) ? undefined : byId.get(taskId);

        return row && row.listId === listId
          ? { status: 200, body: wire(row) }
          : {
              status: 404,
              body: { error: { code: 404, message: 'Not Found' } },
            };
      }

      const p = url.searchParams;
      const showCompleted = flag(p, 'showCompleted', true);
      const showHidden = flag(p, 'showHidden', false);
      const showDeleted = flag(p, 'showDeleted', false);
      const rows = tasks
        .filter(
          t =>
            t.listId === listId &&
            !gone.has(t.id) &&
            (showCompleted || t.status !== 'completed') &&
            (showHidden || !t.hidden) &&
            (showDeleted || !t.deleted),
        )
        .map(wire);

      return paged(rows, p.get('pageToken'), 'tasks#tasks');
    },

    // Drivers.
    completeTask(id) {
      const row = must(id);
      row.status = 'completed';
      row.completed = '2026-03-01T12:00:00.000Z';
      row.hidden = true;
      row.updated = row.completed;

      return wire(row);
    },
    reopenTask(id) {
      const row = must(id);
      row.status = 'needsAction';
      delete row.completed;
      delete row.hidden;
      delete row.deleted;
      gone.delete(id);

      return wire(row);
    },
    deleteTask(id) {
      const row = must(id);
      row.deleted = true;
      row.updated = '2026-03-01T12:30:00.000Z';

      return wire(row);
    },
    removeTask(id) {
      must(id);
      gone.add(id);

      return { id, status: 404 };
    },
    renameTask(id, title) {
      const row = must(id);
      row.title = title;
      row.updated = '2026-03-01T13:00:00.000Z';

      return wire(row);
    },
    failNext(count = 1, status = 503, only = 'any') {
      if (!['any', 'lists', 'tasks', 'lookup'].includes(only))
        throw new Error('failNext: only must be any, lists, tasks or lookup');
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
  title: 'Google Tasks',
  document,
  create: googleTasksFixture,
  // For the drive app's e2e: someone completing, deleting, hiding or
  // renaming a task in Google Tasks, and Google failing.
  drivers: [
    'completeTask',
    'reopenTask',
    'deleteTask',
    'removeTask',
    'renameTask',
    'failNext',
    'snapshot',
  ],
};
