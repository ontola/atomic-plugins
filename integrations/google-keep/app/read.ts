// @wc-ignore-file
/**
 * The four Google Keep API v1 operations the app uses, and nothing else:
 *
 * - `GET /v1/notes`, every page (`pageToken`/`nextPageToken`), with Keep's
 *   default filter, which leaves out trashed notes;
 * - `GET /v1/notes/{id}`, the by-id check of a note that left the list;
 * - `POST /v1/notes`, a new note (a row made here, or the replacement of a
 *   note whose row was edited: the API has no update);
 * - `DELETE /v1/notes/{id}`, the old note of such a replacement. Keep's
 *   delete is permanent, and only a replacement calls it.
 *
 * No credential is held here: a `KeepCall` is the host's proxy relay (see
 * `relayCall` in sync.ts). A list read that stops at the page cap is
 * reported as `partial`, from which notes.ts draws no conclusion about any
 * note's absence. A page that fails outright throws, and the pass writes
 * nothing.
 *
 * Rate limiting is the Google Tasks app's (`../../google-tasks/app/read.ts`),
 * copied into this folder: a 429, or a 403 naming `rateLimitExceeded` or
 * `userRateLimitExceeded` (or `RESOURCE_EXHAUSTED`), is retried after a
 * short wait at most `MAX_INLINE_RETRIES` times; a longer wait throws
 * `GoogleRateLimited` with when to try again. Retrying a rate-limited
 * `POST` or `DELETE` is safe: Google refused it, so it was not applied.
 */
import { isRow, noteId, type Lookup, type Row } from './notes.js';
import type { JSONValue } from './store.js';

export const UPSTREAM = 'https://keep.googleapis.com';
export const PAGE_SIZE = 100;
/** 50 pages of 100: past this a read is reported partial, not continued. */
export const MAX_PAGES = 50;
/** Absent notes looked up by id in one pass; the rest stay unconfirmed until the next. */
export const MAX_LOOKUPS = 50;

export interface GoogleResponse {
  status: number;
  body: unknown;
  /** Lower-cased; the host relays `retry-after` among a few others. */
  headers?: Record<string, string>;
}

export type Method = 'GET' | 'POST' | 'DELETE';

/** One call of a provider path under UPSTREAM. */
export type KeepCall = (
  method: Method,
  path: string,
  options?: { query?: Record<string, string>; body?: Row },
) => Promise<GoogleResponse>;

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Google rate-limited a call and it could not be waited out here. */
export class GoogleRateLimited extends GoogleError {
  constructor(
    readonly what: string,
    readonly retryAt: number,
    status: number,
    readonly retryAfter?: string,
  ) {
    super(
      `Google Keep is rate-limiting this app (${status} for ${what}).`,
      status,
    );
    this.name = 'GoogleRateLimited';
  }
}

export const DEFAULT_RETRY_MS = 60_000;
export const MAX_INLINE_WAIT_MS = 10_000;
export const MAX_INLINE_RETRIES = 2;
export const BACKOFF_BASE_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

const clamp = (ms: number) => Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));

/** `Retry-After` as delay-seconds or an IMF-fixdate (RFC 9110 §10.2.3), in ms from `now`. */
export function parseRetryAfter(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) return undefined;
  const t = value.trim();
  if (/^\d+$/.test(t)) return clamp(Number(t) * 1000);
  if (!IMF_FIXDATE.test(t)) return undefined;
  const at = Date.parse(t);

  return Number.isFinite(at) ? clamp(at - now) : undefined;
}

const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded'];

/** Whether an answer is Google saying "slow down". */
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

/** The wait before retry `attempt`: what was asked, never less than the backoff. */
export function retryWait(
  header: string | undefined,
  attempt: number,
  now: number,
): number {
  const asked = parseRetryAfter(header, now) ?? DEFAULT_RETRY_MS;

  return clamp(Math.max(asked, BACKOFF_BASE_MS * 2 ** attempt));
}

export interface RateLimitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxInlineWaitMs?: number;
  maxInlineRetries?: number;
}

const timerSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/** `call`, with a rate-limited answer waited out when that is short; bounded. */
export function rateLimited(
  call: KeepCall,
  {
    now = Date.now,
    sleep = timerSleep,
    maxInlineWaitMs = MAX_INLINE_WAIT_MS,
    maxInlineRetries = MAX_INLINE_RETRIES,
  }: RateLimitOptions = {},
): KeepCall {
  return async (method, path, options) => {
    for (let attempt = 0; ; attempt++) {
      const response = await call(method, path, options);
      if (!isRateLimit(response)) return response;
      const header = response.headers?.['retry-after'];
      const at = now();
      const wait = retryWait(header, attempt, at);
      if (attempt >= maxInlineRetries || wait > maxInlineWaitMs)
        throw new GoogleRateLimited(
          `${method} ${path}`,
          at + wait,
          response.status,
          header,
        );
      await sleep(wait);
    }
  };
}

/** Throws the error an answer that is not `ok` stands for. */
function refuse(response: GoogleResponse, what: string, now: () => number) {
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
      `Google refused ${what} (${response.status}); reconnect Google Keep.`,
      response.status,
    );
  throw new GoogleError(
    `Google Keep answered ${response.status} for ${what}.`,
    response.status,
  );
}

export interface ReadOptions {
  pageSize?: number;
  maxPages?: number;
  now?: () => number;
}

/**
 * Every note the list returns (trashed ones are left out by Keep's default
 * filter), all pages read before returning. A note seen twice is kept once,
 * with its last-read value. `partial` says why the read stopped early.
 */
export async function readNotes(
  call: KeepCall,
  { pageSize = PAGE_SIZE, maxPages = MAX_PAGES, now = Date.now }: ReadOptions = {},
): Promise<{ notes: Row[]; partial?: string }> {
  const byId = new Map<string, Row>();
  let token: string | undefined;

  for (let n = 1; ; n++) {
    if (n > maxPages)
      return {
        notes: [...byId.values()],
        partial: `Stopped reading notes after ${maxPages} pages of ${pageSize}; Google kept sending a next page.`,
      };
    const response = await call('GET', '/v1/notes', {
      query: {
        pageSize: String(pageSize),
        ...(token ? { pageToken: token } : {}),
      },
    });
    if (response.status !== 200) refuse(response, `notes page ${n}`, now);
    const body = response.body;
    if (!isRow(body))
      throw new GoogleError(`Google sent no notes for page ${n}.`);
    // An account with no notes gets no `notes` field at all.
    const notes = body.notes === undefined ? [] : body.notes;
    if (!Array.isArray(notes))
      throw new GoogleError(`Google sent no notes for page ${n}.`);
    for (const note of notes.filter(isRow)) {
      const id = noteId(note);
      if (id) byId.set(id, note);
    }
    const next = body.nextPageToken;
    if (typeof next !== 'string' || !next) return { notes: [...byId.values()] };
    token = next;
  }
}

/** `/v1/notes/<id>` for a resource name `notes/<id>`, the id escaped. */
export const notePath = (id: string) =>
  `/v1/notes/${encodeURIComponent(id.replace(/^notes\//, ''))}`;

/**
 * `GET /v1/notes/{id}` for each absent note, at most `maxLookups`, as
 * notes.ts's `Lookup`s. A rate limit stops the pass instead.
 */
export async function lookupNotes(
  call: KeepCall,
  ids: string[],
  { maxLookups = MAX_LOOKUPS, now = Date.now } = {},
): Promise<Lookup[]> {
  const out: Lookup[] = [];

  for (const id of ids.slice(0, maxLookups)) {
    try {
      const response = await call('GET', notePath(id));
      if (isRateLimit(response)) refuse(response, `note ${id}`, now);
      out.push({ id, status: response.status, body: response.body as JSONValue });
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

/** `POST /v1/notes`: the note Keep made, with its resource name. */
export async function createNote(
  call: KeepCall,
  note: Row,
  now: () => number = Date.now,
): Promise<Row> {
  const response = await call('POST', '/v1/notes', { body: note });
  if (response.status !== 200) refuse(response, 'creating a note', now);
  const body = response.body;
  if (!isRow(body) || !noteId(body))
    throw new GoogleError('Google created a note but sent no name for it.');

  return body;
}

/** `DELETE /v1/notes/{id}`. A 404 counts as done: the note is gone either way. */
export async function deleteNote(
  call: KeepCall,
  id: string,
  now: () => number = Date.now,
): Promise<void> {
  const response = await call('DELETE', notePath(id));
  if (response.status === 200 || response.status === 204 || response.status === 404)
    return;
  refuse(response, `deleting ${id}`, now);
}
