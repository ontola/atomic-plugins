// @wc-ignore-file
/**
 * When `main.ts` retries a sync by itself, as a pure decision so it can be
 * tested without timers.
 *
 * - A transient failure (`failed`): 4 min, then 8, up to once an hour,
 *   while the view is open. An armed timer is kept.
 * - GitHub rate-limiting (`rate-limited`, `rateLimit.ts`): at GitHub's
 *   `until`, never sooner than 60 s after the failure, doubled per
 *   consecutive rate-limited failure, up to an hour. A pass that ends
 *   rate-limited always replaces the armed timer with one at the fresh
 *   `until`, so a second limit is never retried on a stale time.
 * - While a pass runs, nothing is scheduled or cleared: the state still
 *   carries the previous problem, and the pass's own end decides.
 * - Any other settled state clears the timer; a clean one resets both
 *   ladders.
 */
import type { ViewState } from './controller.js';

export const RETRY_FIRST = 4 * 60;
export const RETRY_MAX = 60 * 60;
export const RATE_RETRY_FIRST = 60;

export interface Ladder {
  /** Seconds the next transient-failure retry waits. */
  failed: number;
  /** Seconds a rate-limited retry waits at least. */
  limited: number;
}

export const freshLadder = (): Ladder => ({
  failed: RETRY_FIRST,
  limited: RATE_RETRY_FIRST,
});

export type Plan =
  /** Leave the armed timer (or none) as it is. */
  | { kind: 'keep' }
  /** Clear any armed timer; `reset` also resets both ladders. */
  | { kind: 'clear'; reset: boolean }
  /** Arm a timer for `at` (epoch ms), replacing the armed one. */
  | { kind: 'arm'; at: number; limited: boolean };

export function planRetry(
  state: ViewState,
  armed: boolean,
  ladder: Ladder,
  now: number,
): Plan {
  if (state.kind !== 'ready') return { kind: 'clear', reset: false };
  if (state.busy) return { kind: 'keep' };
  const problem = state.problem;

  if (problem?.kind === 'rate-limited') {
    const asked = Math.ceil((problem.until - now) / 1000);
    const delay = Math.min(RETRY_MAX, Math.max(ladder.limited, asked));

    return { kind: 'arm', at: now + delay * 1000, limited: true };
  }

  if (problem?.kind === 'failed')
    return armed
      ? { kind: 'keep' }
      : { kind: 'arm', at: now + ladder.failed * 1000, limited: false };

  return { kind: 'clear', reset: !problem };
}

/** The ladder after a timer armed with `limited` has fired. */
export const climbed = (ladder: Ladder, limited: boolean): Ladder =>
  limited
    ? { ...ladder, limited: Math.min(RETRY_MAX, ladder.limited * 2) }
    : { ...ladder, failed: Math.min(RETRY_MAX, ladder.failed * 2) };
