// @wc-ignore-file
/**
 * Read-only access to the three Google Tasks API v1 operations the app uses,
 * all `GET`: `/tasks/v1/users/@me/lists` (the person's task lists, paged by
 * `pageToken`), `/tasks/v1/lists/{tasklist}/tasks` (one list's tasks, with
 * `showCompleted=true` and `showHidden=true`, paged the same way) and
 * `/tasks/v1/lists/{tasklist}/tasks/{task}` (the by-id check of tasks.ts).
 * Nothing here writes to Google, and nothing here holds a credential: a
 * `GoogleGet` is the host's proxy relay (see `relayGet` in sync.ts).
 *
 * A read that stops early (the page cap) is reported as `partial`, which
 * tasks.ts treats as a partial read: it then draws no conclusion from any
 * task's absence. A page that fails outright throws instead, and the caller
 * writes nothing. Verified against the synthetic fixture only
 * (fixtures/google-tasks/), not against Google.
 *
 * Rate limiting (`rateLimited`): Google answers a quota overrun with 429, or
 * with 403 whose body names `rateLimitExceeded` or `userRateLimitExceeded`
 * (Tasks API quotas are per minute per user and per project). Either is
 * retried after a wait when that is short, at most `MAX_INLINE_RETRIES`
 * times per request; a longer wait, or one retry too many, throws
 * `GoogleRateLimited` with the time to try again, and the sync stops with
 * nothing written. The controller decides whether to retry then. The wait
 * is the larger of what `Retry-After` asked (the proxy relays that header;
 * `integration-proxy/src/proxy.rs` `upstream_response_headers`) and an
 * exponential backoff, clamped to a day; Google rarely sends the header, so
 * the default wait usually applies. The same pattern as the Todoist app's,
 * kept inside this folder.
 */
import type { JSONValue } from './store.js';
import { isRow, type Lookup, type Row, type TaskListEntry } from './tasks.js';

export const UPSTREAM = 'https://tasks.googleapis.com';
/** Google's documented maximum `maxResults` for both list operations. */
export const PAGE_SIZE = 100;
/** 50 pages of 100: past this a read is reported partial, not continued. */
export const MAX_PAGES = 50;
/** Absent tasks looked up by id in one pass; the rest stay unconfirmed until the next. */
export const MAX_LOOKUPS = 50;

export interface GoogleResponse {
  status: number;
  body: unknown;
  /** Lower-cased; the host relays `retry-after` among a few others. */
  headers?: Record<string, string>;
}

/** One GET of a provider path under UPSTREAM, with its query parameters. */
export type GoogleGet = (
  path: string,
  query?: Record<string, string>,
) => Promise<GoogleResponse>;

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Google rate-limited the read and it could not be waited out here.
 * `retryAt` is when to try again: `Retry-After` when Google sent one, the
 * backoff otherwise, whichever is later.
 */
export class GoogleRateLimited extends GoogleError {
  constructor(
    readonly what: string,
    readonly retryAt: number,
    status: number,
    /** The `Retry-After` header as relayed, for the technical detail. */
    readonly retryAfter?: string,
  ) {
    super(
      `Google Tasks is rate-limiting this app (${status} for ${what}).`,
      status,
    );
    this.name = 'GoogleRateLimited';
  }
}

/** The wait when a rate-limit answer carries no usable `Retry-After`. */
export const DEFAULT_RETRY_MS = 60_000;
/** Longest wait the read sits out itself before giving up. */
export const MAX_INLINE_WAIT_MS = 10_000;
/** Inline retries per request; past this the read gives up on that request. */
export const MAX_INLINE_RETRIES = 2;
/** The backoff for the first retry; it doubles per attempt. */
export const BACKOFF_BASE_MS = 1_000;
/** Longest wait a `Retry-After` can name here: a day. Anything longer is clamped. */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

/** RFC 9110 §5.6.7's IMF-fixdate: "Tue, 06 Oct 2026 12:00:00 GMT". */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));

/**
 * `Retry-After` is delay-seconds or an HTTP date (RFC 9110 §10.2.3). Only
 * those two shapes count (digits, or an IMF-fixdate): anything else is
 * `undefined`, and the caller uses `DEFAULT_RETRY_MS`. The wait in
 * milliseconds from `now`, never negative and never more than
 * `MAX_RETRY_AFTER_MS`.
 */
export function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return clamp(Number(text) * 1000);
  if (!IMF_FIXDATE.test(text)) return undefined;
  const at = Date.parse(text);

  return Number.isFinite(at) ? clamp(at - now) : undefined;
}

/** The reasons Google's 403 error body gives for a quota overrun. */
const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

/**
 * Whether an answer is Google saying "slow down": a 429, or a 403 whose
 * `error.errors[].reason` is a rate-limit reason (or whose `error.status`
 * is `RESOURCE_EXHAUSTED`). Any other 403 is a refusal, not a rate limit.
 */
export function isRateLimit(response: GoogleResponse): boolean {
  if (response.status === 429) return true;
  if (response.status !== 403 || !isRow(response.body)) return false;
  const error = response.body.error;
  if (!isRow(error)) return false;
  if (error.status === 'RESOURCE_EXHAUSTED') return true;

  return (
    Array.isArray(error.errors) &&
    error.errors.some(
      e => isRow(e) && RATE_LIMIT_REASONS.includes(e.reason as string),
    )
  );
}

/**
 * The wait before retry number `attempt` (0 for the first): what
 * `Retry-After` asked, or the default when it said nothing usable, but
 * never less than the exponential backoff, and never more than a day.
 */
export function retryWait(
  header: string | undefined,
  attempt: number,
  now: number,
): number {
  const asked = parseRetryAfter(header, now) ?? DEFAULT_RETRY_MS;

  return clamp(Math.max(asked, BACKOFF_BASE_MS * 2 ** attempt));
}

export interface RateLimitOptions {
  /** The clock, in milliseconds; tests pin it. */
  now?: () => number;
  /** The wait; tests replace it. Default: a timer. */
  sleep?: (ms: number) => Promise<void>;
  maxInlineWaitMs?: number;
  maxInlineRetries?: number;
}

const timerSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * `get`, retrying a rate-limited answer after `retryWait` when that is at
 * most `maxInlineWaitMs`, at most `maxInlineRetries` times for one request.
 * So one request waits at most `maxInlineRetries × maxInlineWaitMs` (20 s by
 * default) before `GoogleRateLimited` is thrown; there is no unbounded loop.
 * Any other answer, including an error, passes through unchanged.
 */
export function rateLimited(
  get: GoogleGet,
  {
    now = Date.now,
    sleep = timerSleep,
    maxInlineWaitMs = MAX_INLINE_WAIT_MS,
    maxInlineRetries = MAX_INLINE_RETRIES,
  }: RateLimitOptions = {},
): GoogleGet {
  return async (path, query) => {
    for (let attempt = 0; ; attempt++) {
      const response = await get(path, query);
      if (!isRateLimit(response)) return response;
      const header = response.headers?.['retry-after'];
      const at = now();
      const wait = retryWait(header, attempt, at);
      if (attempt >= maxInlineRetries || wait > maxInlineWaitMs)
        throw new GoogleRateLimited(path, at + wait, response.status, header);
      await sleep(wait);
    }
  };
}

export interface ReadOptions {
  pageSize?: number;
  maxPages?: number;
  /** The clock, for a rate limit that reached `page` unwrapped; tests pin it. */
  now?: () => number;
}

function page(
  response: GoogleResponse,
  what: string,
  now: () => number,
): { rows: Row[]; next: string | undefined } {
  // Normally waited out or thrown by `rateLimited` before it gets here.
  if (isRateLimit(response)) {
    const header = response.headers?.['retry-after'];
    const at = now();

    throw new GoogleRateLimited(
      what,
      at + retryWait(header, 0, at),
      response.status,
      header,
    );
  }

  if (response.status === 401 || response.status === 403)
    throw new GoogleError(
      `Google refused ${what} (${response.status}); reconnect Google Tasks.`,
      response.status,
    );
  if (response.status !== 200)
    throw new GoogleError(
      `Google Tasks answered ${response.status} for ${what}.`,
      response.status,
    );
  const body = response.body;
  if (!isRow(body)) throw new GoogleError(`Google sent no items for ${what}.`);
  // An empty list has no `items` at all.
  const items = body.items === undefined ? [] : body.items;
  if (!Array.isArray(items))
    throw new GoogleError(`Google sent no items for ${what}.`);
  const token = body.nextPageToken;

  return {
    rows: items.filter(isRow),
    next: typeof token === 'string' && token ? token : undefined,
  };
}

/**
 * Every row of a collection, all pages read before returning. Returns the
 * rows and, when the page cap stopped the read, why: the read is then
 * partial. A row seen twice (it moved between pages) is kept once, with its
 * last-read value. The query (filters and flags) stays fixed across pages,
 * as the pagination overlay for this API says it must.
 */
async function collection(
  get: GoogleGet,
  path: string,
  query: Record<string, string>,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES, now = Date.now }: ReadOptions,
): Promise<{ rows: Row[]; partial?: string }> {
  const byId = new Map<string, Row>();
  let token: string | undefined;

  for (let n = 1; ; n++) {
    if (n > maxPages)
      return {
        rows: [...byId.values()],
        partial: `Stopped reading ${path} after ${maxPages} pages of ${pageSize}; Google kept sending a next page.`,
      };
    const { rows, next } = page(
      await get(path, {
        ...query,
        maxResults: String(pageSize),
        ...(token ? { pageToken: token } : {}),
      }),
      `${path.split('/').pop()} page ${n}`,
      now,
    );
    for (const row of rows)
      if (typeof row.id === 'string' && row.id) byId.set(row.id, row);
    if (!next) return { rows: [...byId.values()] };
    token = next;
  }
}

/** The person's task lists, every page. */
export async function readTaskLists(
  get: GoogleGet,
  options: ReadOptions = {},
): Promise<{ lists: TaskListEntry[]; partial?: string }> {
  const { rows, partial } = await collection(
    get,
    '/tasks/v1/users/@me/lists',
    {},
    options,
  );

  return {
    lists: rows.flatMap(row =>
      typeof row.id === 'string' && row.id
        ? [
            {
              id: row.id,
              title: typeof row.title === 'string' ? row.title : '',
            },
          ]
        : [],
    ),
    ...(partial ? { partial } : {}),
  };
}

/** The fixed flags of every task read (see the header). */
export const TASK_QUERY = { showCompleted: 'true', showHidden: 'true' };

/** One task list's tasks, completed and hidden ones included, every page. */
export async function readTasks(
  get: GoogleGet,
  listId: string,
  options: ReadOptions = {},
): Promise<{ rows: Row[]; partial?: string }> {
  return collection(
    get,
    `/tasks/v1/lists/${encodeURIComponent(listId)}/tasks`,
    TASK_QUERY,
    options,
  );
}

/**
 * `GET /tasks/v1/lists/{list}/tasks/{id}` for each absent task, as tasks.ts's
 * `Lookup`s: the status and body as answered, or the error when the call
 * itself failed (which that module reads as `unconfirmed`). One at a time,
 * at most `MAX_LOOKUPS` per pass; a task past the cap gets no lookup and is
 * `unconfirmed` until a later pass. A rate limit is not a failed check: it
 * stops the whole pass (`GoogleRateLimited`), so no task is marked
 * `unconfirmed` for it and nothing is written.
 */
export async function lookupTasks(
  get: GoogleGet,
  refs: { id: string; listId: string }[],
  { maxLookups = MAX_LOOKUPS, now = Date.now } = {},
): Promise<Lookup[]> {
  const out: Lookup[] = [];

  for (const { id, listId } of refs.slice(0, maxLookups)) {
    try {
      const response = await get(
        `/tasks/v1/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(id)}`,
      );
      if (isRateLimit(response)) page(response, `task ${id}`, now);
      out.push({
        id,
        status: response.status,
        body: response.body as JSONValue,
      });
    } catch (error) {
      if (error instanceof GoogleRateLimited) throw error;
      out.push({
        id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return out;
}
