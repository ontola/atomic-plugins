// @wc-ignore-file
/**
 * Moneybird's announced throttling (150 requests per 300 s per source IP),
 * handled by `throttle.ts`, against fake transports and a fake clock: a 429
 * part-way through a paged read, `Retry-After` as seconds and as a date, the
 * cap on one wait and on the retries, the backoff without a header, and the
 * period-halving mutations read paced under the limit. Nothing here touches
 * Moneybird; its behaviour is as documented, not as observed.
 */
import { describe, expect, it } from 'vitest';
import {
  contacts,
  financialMutations,
  YEAR,
} from '../fixtures/moneybird/synthetic.mjs';
import { fakeStore } from './fakeStore.js';
import {
  readContacts,
  readFinancialMutations,
  MoneybirdError,
  type MoneybirdGet,
  type MoneybirdResponse,
} from './read.js';
import { relayGet } from './sync.js';
import {
  ANNOUNCED_LIMIT,
  BACKOFF_MS,
  MAX_RETRIES,
  MAX_WAIT_MS,
  PACE,
  retryAfterMs,
  throttled,
  type Wait,
} from './throttle.js';

const A = '100000000000000001';
const connection = { platform: 'moneybird', connectionId: 'c1' };

/** A clock the fake `sleep` advances, so no test waits for real. */
function clock(start = Date.UTC(2026, 9, 6, 12, 0, 0)) {
  let t = start;
  const slept: number[] = [];
  const waits: Wait[] = [];
  let resumed = 0;

  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    onWait: (w: Wait) => waits.push(w),
    onResume: () => resumed++,
    slept,
    waits,
    resumed: () => resumed,
  };
}

const ok = (body: unknown, headers: Record<string, string> = {}) =>
  ({ status: 200, headers, body }) satisfies MoneybirdResponse;
const tooMany = (headers: Record<string, string> = {}) =>
  ({
    status: 429,
    headers,
    body: { error: 'Too many requests' },
  }) satisfies MoneybirdResponse;

describe('Moneybird rate limits', () => {
  it('states the announced limit and paces under it', () => {
    expect(ANNOUNCED_LIMIT).toEqual({ requests: 150, windowMs: 300_000 });
    expect(PACE.windowMs).toBe(ANNOUNCED_LIMIT.windowMs);
    expect(PACE.requests).toBeLessThan(ANNOUNCED_LIMIT.requests);
  });

  it('reads Retry-After as delay-seconds or an IMF-fixdate only, never negative', () => {
    const now = Date.UTC(2026, 9, 6, 12, 0, 0);
    expect(retryAfterMs('7', now)).toBe(7_000);
    expect(retryAfterMs(' 0 ', now)).toBe(0);
    expect(retryAfterMs('Tue, 06 Oct 2026 12:00:30 GMT', now)).toBe(30_000);
    // A past date is 0, not negative.
    expect(retryAfterMs('Tue, 06 Oct 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMs(undefined, now)).toBeUndefined();
    expect(retryAfterMs('', now)).toBeUndefined();
    expect(retryAfterMs('soon', now)).toBeUndefined();
    // Junk that Date.parse would read as a date is refused.
    expect(retryAfterMs('-1', now)).toBeUndefined();
    expect(retryAfterMs('1.5', now)).toBeUndefined();
    expect(retryAfterMs('2026-10-06T12:00:30Z', now)).toBeUndefined();
  });

  it('never waits less than the backoff: a 0, past or junk Retry-After falls back to it', async () => {
    for (const header of ['0', 'Tue, 06 Oct 2026 11:00:00 GMT', '-1', '1.5']) {
      const c = clock();
      let calls = 0;
      const get = throttled(
        async () =>
          calls++ === 0 ? tooMany({ 'retry-after': header }) : ok([]),
        { ...c, pace: false },
      );
      expect((await get('/administrations.json')).status).toBe(200);
      expect(c.slept).toEqual([BACKOFF_MS]);
    }

    // A Retry-After above the backoff is honoured as is.
    const c = clock();
    let calls = 0;
    const get = throttled(
      async () => (calls++ === 0 ? tooMany({ 'retry-after': '5' }) : ok([])),
      { ...c, pace: false },
    );
    await get('/administrations.json');
    expect(c.slept).toEqual([5_000]);
  });

  it('retries a 429 part-way through a paged read and still returns every record', async () => {
    const c = clock();
    const store = fakeStore({ outage: false });
    const relay = relayGet(store.proxy!, connection);
    let limited = 0;

    const transport: MoneybirdGet = async path => {
      // The second page is refused once, with the header Moneybird documents.
      if (path.includes('page=2') && limited++ === 0)
        return tooMany({ 'retry-after': '3' });

      return relay(path);
    };

    const get = throttled(transport, { ...c, pace: false });
    const read = await readContacts(get, A);
    expect(read.map(x => x.id).sort()).toEqual(
      contacts[A].map(x => x.id).sort(),
    );
    expect(c.slept).toEqual([3_000]);
    expect(c.waits).toEqual([
      {
        ms: 3_000,
        reason: 'rate-limited',
        attempt: 1,
        path: expect.stringContaining('page=2'),
      },
    ]);
    expect(c.resumed()).toBe(1);
  });

  it('honours a Retry-After date relative to its own clock', async () => {
    const c = clock();
    let calls = 0;
    const get = throttled(
      async () =>
        calls++ === 0
          ? tooMany({ 'retry-after': 'Tue, 06 Oct 2026 12:00:45 GMT' })
          : ok([]),
      { ...c, pace: false },
    );
    expect((await get('/administrations.json')).status).toBe(200);
    expect(c.slept).toEqual([45_000]);
  });

  it('backs off exponentially without a Retry-After, capped per wait', async () => {
    const c = clock();
    let calls = 0;
    const get = throttled(async () => (calls++ < 5 ? tooMany() : ok([])), {
      ...c,
      pace: false,
      maxWaitMs: 10_000,
    });
    expect((await get('/administrations.json')).status).toBe(200);
    expect(calls).toBe(6);
    expect(c.slept).toEqual([2_000, 4_000, 8_000, 10_000, 10_000]);
    expect(BACKOFF_MS).toBe(2_000);
    expect(MAX_WAIT_MS).toBe(60_000);
  });

  it('fails now, without waiting, when Retry-After asks for more than the cap', async () => {
    const c = clock();
    let calls = 0;
    const get = throttled(
      async () => (calls++, tooMany({ 'retry-after': '300' })),
      { ...c, pace: false },
    );
    const error = await get('/administrations.json').catch(e => e);
    expect(error).toBeInstanceOf(MoneybirdError);
    expect(error.status).toBe(429);
    expect(error.message).toMatch(
      /asks to wait 300 s, longer than this import waits \(60 s\)/,
    );
    expect(calls).toBe(1);
    expect(c.slept).toEqual([]);
  });

  it('gives up after the retries, with status 429', async () => {
    const c = clock();
    let calls = 0;
    const get = throttled(
      async () => (calls++, tooMany({ 'retry-after': '1' })),
      {
        ...c,
        pace: false,
      },
    );
    const error = await get('/administrations.json').catch(e => e);
    expect(error).toBeInstanceOf(MoneybirdError);
    expect(error.status).toBe(429);
    expect(error.message).toMatch(
      /kept limiting requests \(429\) after 5 retries/,
    );
    expect(calls).toBe(MAX_RETRIES + 1);
    // Retry-After 1 s is under the backoff, which is the floor.
    expect(c.slept).toEqual([2_000, 4_000, 8_000, 16_000, 32_000]);
  });

  it('paces the period-halving mutations read under the limit, and a small read never waits', async () => {
    const c = clock();
    // The fixture answers at most 3 of its 6 mutations per window, so the
    // read halves the year down to days: dozens of requests.
    const store = fakeStore({ mutationCap: 3 });
    const relay = relayGet(store.proxy!, connection);
    const sent: number[] = [];

    const transport: MoneybirdGet = async path => {
      sent.push(c.now());

      return relay(path);
    };

    const pace = { requests: 5, windowMs: 300_000 };
    const get = throttled(transport, { ...c, pace });
    const read = await readFinancialMutations(get, A, { year: YEAR, cap: 3 });
    expect(read.map(m => m.id).sort()).toEqual(
      financialMutations[A].map(m => m.id).sort(),
    );
    expect(sent.length).toBeGreaterThan(pace.requests);

    // In any window, no more requests than the budget.
    for (let i = 0; i < sent.length; i++) {
      const inWindow = sent.filter(
        t => t > sent[i] - pace.windowMs && t <= sent[i],
      ).length;
      expect(inWindow).toBeLessThanOrEqual(pace.requests);
    }

    // The first `requests` went out at once; the next waited for the window
    // (the fake clock then jumps past it, so the following ones go at once
    // again: a sliding window, not a fixed interval).
    expect(c.waits.length).toBeGreaterThan(0);
    expect(c.waits.length).toBeLessThan(sent.length - pace.requests + 1);
    for (const w of c.waits) expect(w.reason).toBe('pacing');
    expect(c.resumed()).toBe(c.waits.length);

    // Five requests or fewer: no wait at all.
    const small = clock();
    const quick = throttled(relay, { ...small, pace });
    await readContacts(quick, A);
    expect(small.slept).toEqual([]);
  });
});
