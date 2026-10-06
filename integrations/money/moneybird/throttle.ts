// @wc-ignore-file
/**
 * Moneybird's announced throttling, handled in front of the reader: 150
 * requests per 300 s per source IP (developer.moneybird.com, "Throttling";
 * `overlays/APIs/moneybird.com/v2-readonly/throttling-*-overlay.yaml`, whose
 * window algorithm is "unspecified"). The source IP is the integration
 * proxy's, shared by everyone who connects Moneybird through it, so no
 * client-side pacing can promise anything; it only keeps one import from
 * spending the whole quota at once. Two things here:
 *
 * - **Pacing.** A sliding window of the requests this wrapper sent: once
 *   `pace.requests` (120 by default, under the announced 150) went out
 *   within `pace.windowMs` (300 s), the next waits until the oldest leaves
 *   the window. A small sync never waits; the period-halving mutations read
 *   (`readFinancialMutations`, up to 200 requests) does.
 * - **429.** A `429 Too Many Requests` is retried after `Retry-After` when
 *   Moneybird sends one (seconds or an HTTP-date), else after an exponential
 *   backoff from `backoffMs` (2 s, doubling). One wait is capped at
 *   `maxWaitMs` (60 s): a longer `Retry-After` fails the read now, with the
 *   asked wait in the message, rather than hold the import for minutes; one
 *   request is retried at most `maxRetries` (5) times. The error is a
 *   `MoneybirdError` with status 429, so the card can name the next step.
 *
 * Every wait is reported through `onWait` (and its end through `onResume`),
 * so the view can say what it is waiting for. Nothing here is verified
 * against Moneybird itself: the behaviour is from its documentation and is
 * exercised with fake transports in `throttle.test.ts`.
 */
import { MoneybirdError, type MoneybirdGet } from './read.js';

/** What developer.moneybird.com announces, for documentation and tests. */
export const ANNOUNCED_LIMIT = { requests: 150, windowMs: 300_000 } as const;
/** The pacing budget this wrapper keeps under, per window. */
export const PACE = { requests: 120, windowMs: 300_000 } as const;
/** The longest single wait honoured, for `Retry-After` and the backoff. */
export const MAX_WAIT_MS = 60_000;
/** Retries of one request after 429 answers. */
export const MAX_RETRIES = 5;
/** The first backoff without a `Retry-After`; doubles per retry. */
export const BACKOFF_MS = 2_000;

export interface Wait {
  /** How long, in milliseconds. */
  ms: number;
  /** A 429 answer (`attempt` is the retry about to be made), or this wrapper's own pacing. */
  reason: 'rate-limited' | 'pacing';
  attempt?: number;
  /** The provider path waited for. */
  path: string;
}

export interface ThrottleOptions {
  /** `false` turns pacing off (tests of the 429 handling alone). */
  pace?: { requests: number; windowMs: number } | false;
  maxWaitMs?: number;
  maxRetries?: number;
  backoffMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onWait?: (wait: Wait) => void;
  onResume?: () => void;
}

const RETRY_AFTER_SECONDS = /^\s*\d+\s*$/;

/**
 * A `Retry-After` header as milliseconds from `now`: delay-seconds, or an
 * HTTP-date (never negative); `undefined` when absent or unreadable.
 */
export function retryAfterMs(
  header: string | undefined,
  now: number,
): number | undefined {
  if (header === undefined || header === '') return undefined;
  if (RETRY_AFTER_SECONDS.test(header)) return Number(header.trim()) * 1000;
  const at = Date.parse(header);

  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

const seconds = (ms: number) => `${Math.ceil(ms / 1000)} s`;

const defaultSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * `get`, paced under Moneybird's limit and retrying its 429 answers as the
 * header describes. One wrapper per sync, so every collection's requests
 * share the window.
 */
export function throttled(
  get: MoneybirdGet,
  {
    pace = PACE,
    maxWaitMs = MAX_WAIT_MS,
    maxRetries = MAX_RETRIES,
    backoffMs = BACKOFF_MS,
    now = Date.now,
    sleep = defaultSleep,
    onWait,
    onResume,
  }: ThrottleOptions = {},
): MoneybirdGet {
  /** When each request of the current window went out, oldest first. */
  const sent: number[] = [];

  const wait = async (w: Wait) => {
    onWait?.(w);
    await sleep(w.ms);
    onResume?.();
  };

  const paced = async (path: string) => {
    if (pace) {
      const at = now();
      while (sent.length && sent[0] <= at - pace.windowMs) sent.shift();

      if (sent.length >= pace.requests) {
        const ms = sent[0] + pace.windowMs - at;
        if (ms > 0) await wait({ ms, reason: 'pacing', path });
        const after = now();
        while (sent.length && sent[0] <= after - pace.windowMs) sent.shift();
      }

      sent.push(now());
    }

    return get(path);
  };

  return async path => {
    for (let attempt = 1; ; attempt++) {
      const response = await paced(path);
      if (response.status !== 429) return response;

      if (attempt > maxRetries)
        throw new MoneybirdError(
          `Moneybird kept limiting requests (429) after ${maxRetries} retries, so this import stopped. Wait a few minutes, then sync again.`,
          429,
        );
      const asked = retryAfterMs(response.headers?.['retry-after'], now());

      if (asked !== undefined && asked > maxWaitMs)
        throw new MoneybirdError(
          `Moneybird is limiting requests (429) and asks to wait ${seconds(asked)}, longer than this import waits (${seconds(maxWaitMs)}). Try again then.`,
          429,
        );
      const ms =
        asked ?? Math.min(backoffMs * 2 ** (attempt - 1), maxWaitMs);
      await wait({ ms, reason: 'rate-limited', attempt, path });
    }
  };
}
