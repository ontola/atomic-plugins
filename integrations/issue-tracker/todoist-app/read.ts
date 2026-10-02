// @wc-ignore-file
/**
 * Read-only access to the three Todoist API v1 operations the app uses, all
 * `GET` and all allowed by the proxy's `data:read` Todoist catalog:
 * `/api/v1/projects`, `/api/v1/tasks` (active tasks, paged by cursor) and
 * `/api/v1/tasks/{task_id}` (the by-id check of ../todoist.ts). Nothing here
 * writes to Todoist, and nothing here holds a credential: a `TodoistGet` is
 * the host's proxy relay (see `relayGet` in sync.ts).
 *
 * The result is the `FetchedPlatform` shape ../todoist.ts consumes. A read
 * that stops early (the page cap) is reported in `errors`, which that module
 * treats as a partial read: it then draws no conclusion from any task's
 * absence. A page that fails outright throws instead, and the caller writes
 * nothing. Verified against the synthetic fixture only (fixtures/todoist/),
 * not against Todoist (#46).
 */
import { Datatype } from '../../../browser/lib/src/index.js';
import type { JSONValue } from '../../../browser/lib/src/value.js';
import type {
  FetchedPlatform,
  FetchedRecord,
} from '../../localthought/schema.js';
import { TODOIST_PLATFORM, type TodoistLookup } from '../todoist.js';

export const UPSTREAM = 'https://api.todoist.com/api/v1';
/** Todoist's documented maximum `limit`. */
export const PAGE_SIZE = 200;
/** 50 pages of 200: past this the read is reported partial, not continued. */
export const MAX_PAGES = 50;

export interface TodoistResponse {
  status: number;
  body: unknown;
}

/** One GET of a provider path under UPSTREAM, e.g. `/api/v1/tasks?limit=200`. */
export type TodoistGet = (path: string) => Promise<TodoistResponse>;

export class TodoistError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type Row = Record<string, JSONValue>;

const isRow = (value: unknown): value is Row =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function page(response: TodoistResponse, what: string) {
  if (response.status === 401 || response.status === 403)
    throw new TodoistError(
      `Todoist refused ${what} (${response.status}); reconnect Todoist.`,
      response.status,
    );
  if (response.status !== 200)
    throw new TodoistError(
      `Todoist answered ${response.status} for ${what}.`,
      response.status,
    );
  const body = response.body;
  if (!isRow(body) || !Array.isArray(body.results))
    throw new TodoistError(`Todoist sent no results for ${what}.`);
  const cursor = body.next_cursor;

  return {
    rows: body.results.filter(isRow),
    next: typeof cursor === 'string' && cursor ? cursor : undefined,
  };
}

/**
 * Every row of a collection, all pages read before returning. Returns the
 * rows and, when the page cap stopped the read, why: the read is then
 * partial. A row seen twice (it moved between pages) is kept once, with its
 * last-read value.
 */
async function collection(
  get: TodoistGet,
  path: string,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {},
): Promise<{ rows: Row[]; partial?: string }> {
  const byId = new Map<string, Row>();
  let cursor: string | undefined;

  for (let n = 1; ; n++) {
    if (n > maxPages)
      return {
        rows: [...byId.values()],
        partial: `Stopped reading ${path} after ${maxPages} pages of ${pageSize}; Todoist kept sending a next page.`,
      };
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) query.set('cursor', cursor);
    const { rows, next } = page(
      await get(`${path}?${query}`),
      `${path.split('/').pop()} page ${n}`,
    );
    for (const row of rows)
      if (typeof row.id === 'string' && row.id) byId.set(row.id, row);
    if (!next) return { rows: [...byId.values()] };
    cursor = next;
  }
}

/** Project id -> name, for the row's project column. */
export async function readProjects(
  get: TodoistGet,
  options?: { pageSize?: number; maxPages?: number },
): Promise<Map<string, string>> {
  const { rows } = await collection(get, '/api/v1/projects', options);

  return new Map(
    rows.flatMap(row =>
      typeof row.id === 'string' && typeof row.name === 'string'
        ? [[row.id, row.name]]
        : [],
    ),
  );
}

/**
 * The active tasks as a `FetchedPlatform` for ../todoist.ts: one `task`
 * class term (what `todoistProjection` keys on) and one record per task,
 * with the provider's fields as its values. `errors` is set when the read
 * was partial.
 */
export async function readActiveTasks(
  get: TodoistGet,
  options?: { pageSize?: number; maxPages?: number },
): Promise<FetchedPlatform> {
  const { rows, partial } = await collection(get, '/api/v1/tasks', options);
  const records: FetchedRecord[] = rows.map(row => ({
    resource: 'task',
    namespace: TODOIST_PLATFORM,
    id: row.id as string,
    name: row.id as string,
    values: row,
  }));

  return {
    platform: TODOIST_PLATFORM,
    ontology: {
      description: 'Todoist API v1, as the proxy serves it (read-only).',
      terms: [
        {
          path: 'urn:atomic:todoist:task',
          kind: 'class',
          shortname: 'task',
          description: 'An active task in the connected Todoist account.',
          datatype: Datatype.STRING,
          requires: [],
          recommends: [],
        },
      ],
    },
    records,
    ...(partial ? { errors: [partial] } : {}),
  };
}

/**
 * `GET /api/v1/tasks/{id}` for each absent task, as ../todoist.ts's
 * `TodoistLookup`s: the status and body as answered, or the error when the
 * call itself failed (which that module reads as `unconfirmed`). One at a
 * time; there are rarely more than a few.
 */
export async function lookupTasks(
  get: TodoistGet,
  ids: string[],
): Promise<TodoistLookup[]> {
  const out: TodoistLookup[] = [];

  for (const id of ids) {
    try {
      const response = await get(`/api/v1/tasks/${encodeURIComponent(id)}`);
      out.push({
        id,
        status: response.status,
        body: response.body as JSONValue,
      });
    } catch (error) {
      out.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}
