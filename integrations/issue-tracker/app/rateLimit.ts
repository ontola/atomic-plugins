// @wc-ignore-file
/**
 * GitHub's rate limits, as the relay shows them to this app, and the
 * bounded waiting that keeps a pass from hammering GitHub or losing a write.
 *
 * GitHub signals a limit two ways (docs.github.com, "Rate limits for the
 * REST API"): the primary limit as 403 or 429 with `x-ratelimit-remaining:
 * 0` and `x-ratelimit-reset` (an epoch second, up to an hour away), and a
 * secondary limit as 403 or 429 with a `retry-after` header (seconds) or,
 * without one, a message asking to wait a minute. Neither `x-ratelimit-*`
 * header reaches this app today: the integration proxy forwards only
 * `content-type`, `link`, `retry-after`, `etag`, `x-total-count` and
 * `x-next-page` (`integration-proxy/src/proxy.rs`
 * `upstream_response_headers`), and the host's frame client then relays
 * only `link`, `retry-after`, `etag` and `content-type` (`view-client.js`
 * `PROXY_HEADERS` at the pin). So a primary-limit 403 is known by the
 * body's `message` alone, a secondary one by `retry-after` or its message,
 * and a 429 always counts. The `x-ratelimit-*` reading below is for a proxy
 * and host that forward them.
 *
 * What happens then (`throughRateLimits`):
 * - a short wait (at most `INLINE_MAX_MS`) is slept out and the same
 *   request is repeated, at most `MAX_INLINE_RETRIES` times, each wait at
 *   least `MIN_WAIT_MS` doubled per attempt, so a header that says 0 never
 *   makes a tight loop;
 * - a longer wait, or the retries used up, throws a `RateLimitError` with
 *   `notSent: true` and `until`. For a write, `proxyTransport` then drops
 *   its journal entry (GitHub refused the request, so nothing was applied),
 *   the Bridge keeps the operation planned in its snapshot, and the next
 *   pass sends it again. The controller shows "GitHub is rate-limiting;
 *   retrying at HH:MM" and `main.ts` retries the pass at `until`. A write is
 *   never resent as "uncertain" and never dropped.
 *
 * Kept inside this plugin: Michiel approved the shared card only, not a
 * shared fetch wrapper. Calendar, Notion and Clockify classify a 429 the
 * same way (`retry-after` as seconds or an HTTP date, a default wait) and
 * leave the retry to the person or a timer; this module adds the inline
 * wait and the write safety the GitHub journal needs.
 */

/** The relayed answer `rateLimitOf` reads: status, a few headers, the body. */
export interface Answer {
  status: number;
  /** Lower-cased, as the host relays them. */
  headers?: Record<string, string>;
  body?: unknown;
}

export interface RateLimit {
  status: number;
  /** When GitHub says to try again (epoch ms), capped at `MAX_WAIT_MS`. */
  until: number;
  /** Where `until` came from. */
  source: 'retry-after' | 'x-ratelimit-reset' | 'default';
  /** A secondary (abuse) limit rather than the hourly primary one. */
  secondary: boolean;
}

/** GitHub's own words, when it sends no header to go by. */
export const DEFAULT_WAIT_MS = 60_000;
/** The longest wait the app sleeps out inside a pass. */
export const INLINE_MAX_MS = 20_000;
/** Repeats of one request inside a pass, after the first try. */
export const MAX_INLINE_RETRIES = 2;
/** Never shorter than this, whatever the header says; doubled per retry. */
export const MIN_WAIT_MS = 1_000;
/** Never later than this: a wrong clock on either side cannot park the app. */
export const MAX_WAIT_MS = 60 * 60_000;

const SECONDARY_MESSAGE = /secondary rate limit|abuse detection/i;
const LIMIT_MESSAGE = /rate limit/i;

const messageOf = (body: unknown): string | undefined => {
  if (typeof body === 'string') {
    try {
      return messageOf(JSON.parse(body));
    } catch {
      return body;
    }
  }

  const message = (body as { message?: unknown } | null)?.message;

  return typeof message === 'string' ? message : undefined;
};

/** RFC 9110 IMF-fixdate: `Mon, 06 Oct 2026 12:01:30 GMT`. */
const IMF_FIXDATE =
  /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `retry-after` as milliseconds from `now`: delay-seconds (digits only) or
 * an IMF-fixdate (RFC 9110 §10.2.3), nothing else.
 */
export function retryAfterMs(
  header: string | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (!IMF_FIXDATE.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);

  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

/** `x-ratelimit-reset` (epoch seconds) as milliseconds from `now`. */
export function resetMs(
  header: string | undefined,
  now: number,
): number | undefined {
  if (!header || !/^\d+$/.test(header.trim())) return undefined;

  return Math.max(0, Number(header.trim()) * 1000 - now);
}

/** The rate limit this answer signals, or undefined for any other answer. */
export function rateLimitOf(
  answer: Answer,
  now: number,
): RateLimit | undefined {
  const { status } = answer;
  if (status !== 429 && status !== 403) return undefined;
  const headers = answer.headers ?? {};
  const retryAfter = retryAfterMs(headers['retry-after'], now);
  const reset = resetMs(headers['x-ratelimit-reset'], now);
  const exhausted = headers['x-ratelimit-remaining']?.trim() === '0';
  const message = messageOf(answer.body) ?? '';
  const limited =
    status === 429 ||
    retryAfter !== undefined ||
    exhausted ||
    LIMIT_MESSAGE.test(message);
  if (!limited) return undefined;

  const [wait, source]: [number, RateLimit['source']] =
    retryAfter !== undefined
      ? [retryAfter, 'retry-after']
      : reset !== undefined
        ? [reset, 'x-ratelimit-reset']
        : [DEFAULT_WAIT_MS, 'default'];

  return {
    status,
    until: now + Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, wait)),
    source,
    secondary:
      SECONDARY_MESSAGE.test(message) ||
      (retryAfter !== undefined && !exhausted),
  };
}

/** `14:05`, in the person's locale. */
export const clock = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * Thrown when a request cannot be repeated inside the pass. `notSent` is
 * `proxyTransport`'s contract: the request was refused, so a write's
 * journal entry is dropped and the write is planned again next pass.
 */
export class RateLimitError extends Error {
  readonly notSent = true as const;

  constructor(readonly rateLimit: RateLimit) {
    super(
      `GitHub is rate-limiting requests (HTTP ${rateLimit.status}); try again at ${clock(rateLimit.until)}.`,
    );
    this.name = 'RateLimitError';
  }
}

export const isRateLimitError = (error: unknown): error is RateLimitError =>
  error instanceof Error &&
  typeof (error as { rateLimit?: { until?: unknown } }).rateLimit?.until ===
    'number';

export interface RateLimitOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Told of each limit as it is hit, and `undefined` once a request got
   * through after one, so the view can say "retrying at HH:MM" while the
   * pass waits.
   */
  onLimit?: (limit: RateLimit | undefined) => void;
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Makes `call` once, and again after a short rate-limit wait (bounded as
 * above); throws `RateLimitError` instead of a longer wait. Anything that
 * is not a rate limit is returned or rethrown as it is.
 */
export async function throughRateLimits<T extends Answer>(
  call: () => Promise<T>,
  options: RateLimitOptions = {},
): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  let limited = false;

  for (let attempt = 0; ; attempt++) {
    const answer = await call();
    const limit = rateLimitOf(answer, now());

    if (!limit) {
      if (limited) options.onLimit?.(undefined);

      return answer;
    }

    limited = true;
    options.onLimit?.(limit);
    const asked = limit.until - now();
    const floor = MIN_WAIT_MS * 2 ** attempt;
    const ms = Math.max(asked, floor);
    if (attempt >= MAX_INLINE_RETRIES || ms > INLINE_MAX_MS)
      throw new RateLimitError(limit);
    await sleep(ms);
  }
}
