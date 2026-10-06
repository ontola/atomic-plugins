// @wc-ignore-file
/**
 * `retry.ts`: when the view retries a sync by itself, without timers.
 */
import { describe, expect, it } from 'vitest';
import type { ViewState } from './controller.js';
import {
  climbed,
  freshLadder,
  planRetry,
  RATE_RETRY_FIRST,
  RETRY_FIRST,
  RETRY_MAX,
} from './retry.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;

const ready = (
  over: Partial<Extract<ViewState, { kind: 'ready' }>> = {},
): ViewState => ({
  kind: 'ready',
  connectionId: 'c1',
  repository: 'o/r',
  ...over,
});

const limited = (until: number, over = {}) =>
  ready({
    problem: { kind: 'rate-limited', message: 'HTTP 429', until },
    failedAt: NOW,
    ...over,
  });

describe('the automatic retry', () => {
  it('a transient failure: the 4-minute ladder, kept while armed', () => {
    const failed = ready({ problem: { kind: 'failed', message: '502' } });
    expect(planRetry(failed, false, freshLadder(), NOW)).toEqual({
      kind: 'arm',
      at: NOW + RETRY_FIRST * 1000,
      limited: false,
    });
    expect(planRetry(failed, true, freshLadder(), NOW)).toEqual({
      kind: 'keep',
    });
    expect(climbed(freshLadder(), false).failed).toBe(2 * RETRY_FIRST);
    let ladder = freshLadder();
    for (let i = 0; i < 10; i++) ladder = climbed(ladder, false);
    expect(ladder.failed).toBe(RETRY_MAX);
  });

  it('a rate limit: at GitHub’s time, never sooner than 60 s, never later than an hour', () => {
    expect(planRetry(limited(NOW + 35 * MIN), false, freshLadder(), NOW)).toEqual(
      { kind: 'arm', at: NOW + 35 * MIN, limited: true },
    );
    expect(planRetry(limited(NOW + 5_000), false, freshLadder(), NOW)).toEqual({
      kind: 'arm',
      at: NOW + RATE_RETRY_FIRST * 1000,
      limited: true,
    });
    expect(
      planRetry(limited(NOW + 3 * 60 * MIN), false, freshLadder(), NOW),
    ).toEqual({ kind: 'arm', at: NOW + RETRY_MAX * 1000, limited: true });
  });

  it('two limits in a row: the second replaces the timer at its own time, and nothing is armed while the pass runs', () => {
    let ladder = freshLadder();
    // First limit, 30 min away: armed for then.
    const first = planRetry(limited(NOW + 30 * MIN), false, ladder, NOW);
    expect(first).toEqual({ kind: 'arm', at: NOW + 30 * MIN, limited: true });
    // The timer fires and the pass starts: the stale problem is still on the
    // state while busy. Nothing is scheduled (that was the 120 s bug).
    ladder = climbed(ladder, true);
    const fired = NOW + 30 * MIN;
    expect(
      planRetry(limited(NOW + 30 * MIN, { busy: 'syncing' }), false, ladder, fired),
    ).toEqual({ kind: 'keep' });
    // The pass ends rate-limited again, 45 min further: the plan is for that
    // time, whether or not something was armed meanwhile.
    const second = limited(fired + 45 * MIN, { failedAt: fired + 2_000 });
    expect(planRetry(second, true, ladder, fired + 2_000)).toEqual({
      kind: 'arm',
      at: fired + 45 * MIN,
      limited: true,
    });
    // A limit that names no useful time climbs the ladder instead: 120 s now.
    expect(planRetry(limited(fired + 1_000), true, ladder, fired)).toEqual({
      kind: 'arm',
      at: fired + 2 * RATE_RETRY_FIRST * 1000,
      limited: true,
    });
  });

  it('a settled state clears the timer; a clean one resets the ladders', () => {
    expect(planRetry(ready(), true, freshLadder(), NOW)).toEqual({
      kind: 'clear',
      reset: true,
    });
    expect(
      planRetry(
        ready({
          problem: { kind: 'paused', message: 'x', reason: 'uncertain' },
        }),
        true,
        freshLadder(),
        NOW,
      ),
    ).toEqual({ kind: 'clear', reset: false });
    expect(planRetry({ kind: 'not-connected' }, true, freshLadder(), NOW)).toEqual(
      { kind: 'clear', reset: false },
    );
    // Busy without a problem: leave it alone until the pass ends.
    expect(planRetry(ready({ busy: 'sending' }), false, freshLadder(), NOW)).toEqual(
      { kind: 'keep' },
    );
  });
});
