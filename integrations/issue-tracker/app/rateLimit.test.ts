// @wc-ignore-file
/**
 * GitHub's rate limits as the relay shows them (`rateLimit.ts`), with fake
 * transports: what counts as a limit, how long to wait, the inline retry
 * and its bounds, and that a journalled write survives one.
 */
import { describe, expect, it } from 'vitest';
import { proxyTransport } from '../devonian/github-issues/proxy.mjs';
import {
  DEFAULT_WAIT_MS,
  INLINE_MAX_MS,
  MAX_INLINE_RETRIES,
  MAX_WAIT_MS,
  MIN_WAIT_MS,
  RateLimitError,
  isRateLimitError,
  rateLimitOf,
  retryAfterMs,
  throughRateLimits,
  type Answer,
} from './rateLimit.js';
import { relayDispatch } from './transport.js';
import { fakeStore } from './fakeStore.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ok: Answer = { status: 200, headers: {}, body: [] };

/** A transport that answers from a script, recording each call. */
function scripted(answers: Answer[]) {
  const calls: number[] = [];
  const slept: number[] = [];
  let clock = NOW;

  const call = async () => {
    calls.push(clock);
    const next = answers.shift();
    if (!next) throw new Error('script exhausted');

    return next;
  };

  const options = {
    now: () => clock,
    sleep: async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
  };

  return { call, calls, slept, options, time: () => clock };
}

describe('what counts as a GitHub rate limit', () => {
  it('a 429, always, with retry-after as the wait', () => {
    const limit = rateLimitOf(
      { status: 429, headers: { 'retry-after': '30' }, body: '' },
      NOW,
    );
    expect(limit).toMatchObject({
      status: 429,
      until: NOW + 30_000,
      source: 'retry-after',
      secondary: true,
    });
  });

  it('a 403 with the primary limit exhausted, waiting for its reset', () => {
    const reset = Math.floor(NOW / 1000) + 1800;
    const limit = rateLimitOf(
      {
        status: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(reset),
        },
        body: { message: 'API rate limit exceeded for user ID 1.' },
      },
      NOW,
    );
    expect(limit).toMatchObject({
      status: 403,
      until: NOW + 1800_000,
      source: 'x-ratelimit-reset',
      secondary: false,
    });
  });

  it('a secondary-limit 403 by its retry-after header, or by its message alone', () => {
    expect(
      rateLimitOf(
        { status: 403, headers: { 'retry-after': '60' }, body: {} },
        NOW,
      ),
    ).toMatchObject({ until: NOW + 60_000, secondary: true });
    // The host relays only link, retry-after, etag and content-type, so a
    // secondary limit without retry-after is known by GitHub's words only.
    expect(
      rateLimitOf(
        {
          status: 403,
          headers: {},
          body: JSON.stringify({
            message:
              'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
          }),
        },
        NOW,
      ),
    ).toMatchObject({
      until: NOW + DEFAULT_WAIT_MS,
      source: 'default',
      secondary: true,
    });
  });

  it('is not any other 403, nor another status', () => {
    expect(
      rateLimitOf(
        {
          status: 403,
          headers: {},
          body: { message: 'Resource not accessible by integration' },
        },
        NOW,
      ),
    ).toBeUndefined();
    expect(
      rateLimitOf(
        { status: 503, headers: { 'retry-after': '5' }, body: '' },
        NOW,
      ),
    ).toBeUndefined();
    expect(rateLimitOf({ status: 404, body: {} }, NOW)).toBeUndefined();
  });

  it('reads retry-after as seconds or an HTTP date, and never waits less than a second or more than an hour', () => {
    expect(retryAfterMs('120', NOW)).toBe(120_000);
    // An IMF-fixdate (`toUTCString` writes one); nothing else is a date.
    expect(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(
      90_000,
    );
    expect(retryAfterMs('Mon, 06 Oct 2026 11:00:00 GMT', NOW)).toBe(0);
    expect(retryAfterMs('soon', NOW)).toBeUndefined();
    expect(retryAfterMs('2026-10-06T12:01:30Z', NOW)).toBeUndefined();
    expect(retryAfterMs('90.5', NOW)).toBeUndefined();
    expect(retryAfterMs('-5', NOW)).toBeUndefined();
    expect(
      rateLimitOf({ status: 429, headers: { 'retry-after': '0' } }, NOW)!.until,
    ).toBe(NOW + MIN_WAIT_MS);
    expect(
      rateLimitOf(
        {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 10 * 3600),
          },
        },
        NOW,
      )!.until,
    ).toBe(NOW + MAX_WAIT_MS);
  });
});

describe('waiting a limit out', () => {
  it('sleeps a short retry-after, then repeats the request once more', async () => {
    const t = scripted([{ status: 429, headers: { 'retry-after': '5' } }, ok]);
    const limits: (number | undefined)[] = [];
    const answer = await throughRateLimits(t.call, {
      ...t.options,
      onLimit: l => limits.push(l?.until),
    });
    expect(answer).toBe(ok);
    expect(t.slept).toEqual([5_000]);
    expect(t.calls).toHaveLength(2);
    // Told of the limit, then that the request got through.
    expect(limits).toEqual([NOW + 5_000, undefined]);
  });

  it('waits at least a second, doubled per retry, when the header says now', async () => {
    const t = scripted([
      { status: 429, headers: { 'retry-after': '0' } },
      { status: 429, headers: { 'retry-after': '0' } },
      ok,
    ]);
    await throughRateLimits(t.call, t.options);
    expect(t.slept).toEqual([MIN_WAIT_MS, MIN_WAIT_MS * 2]);
  });

  it('gives up with a not-sent error instead of a long wait', async () => {
    const t = scripted([
      {
        status: 429,
        headers: { 'retry-after': String(INLINE_MAX_MS / 1000 + 1) },
      },
      ok,
    ]);
    const error = await throughRateLimits(t.call, t.options).catch(e => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(isRateLimitError(error)).toBe(true);
    expect(error).toMatchObject({
      notSent: true,
      rateLimit: { until: NOW + INLINE_MAX_MS + 1000 },
    });
    expect(error.message).toMatch(
      /^GitHub is rate-limiting requests \(HTTP 429\); try again at \d{1,2}:\d\d( [AP]M)?\.$/,
    );
    expect(t.slept).toEqual([]);
    expect(t.calls).toHaveLength(1);
  });

  it('never loops: after the inline retries it stops, however short the waits', async () => {
    const t = scripted(
      Array.from({ length: 10 }, () => ({
        status: 429,
        headers: { 'retry-after': '1' },
      })),
    );
    await expect(throughRateLimits(t.call, t.options)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(t.calls).toHaveLength(MAX_INLINE_RETRIES + 1);
    expect(t.slept).toHaveLength(MAX_INLINE_RETRIES);
  });

  it('passes every other answer and error through untouched', async () => {
    const notFound: Answer = { status: 404, body: { message: 'Not Found' } };
    const t = scripted([notFound]);
    expect(await throughRateLimits(t.call, t.options)).toBe(notFound);
    await expect(
      throughRateLimits(async () => {
        throw new Error('offline');
      }, t.options),
    ).rejects.toThrow('offline');
  });
});

describe('through the relay, with the write journal', () => {
  const sleeps = (log: number[]) => async (ms: number) => {
    log.push(ms);
  };

  it('repeats a read the relay answered 429 and returns the page', async () => {
    const store = fakeStore();
    const slept: number[] = [];
    store.rateLimit = {
      status: 429,
      headers: { 'retry-after': '2' },
      remaining: 1,
    };
    const dispatch = relayDispatch(store.proxy!, 'c1', {
      sleep: sleeps(slept),
    });
    const receipt = await dispatch('/repos/atomic-fixture/tracker/issues', {
      method: 'GET',
    });
    expect(receipt.status).toBe(200);
    expect(slept).toEqual([2_000]);
    expect(store.calls).toHaveLength(2);
  });

  it('a write refused by a long limit is not left uncertain: the journal entry goes, and the next pass sends it', async () => {
    const store = fakeStore();
    const journal: Record<string, { signature?: string; receipt?: unknown }> =
      {};
    let saves = 0;
    const transport = proxyTransport({
      repository: 'atomic-fixture/tracker',
      journal,
      save: async () => {
        saves++;
      },
      dispatch: relayDispatch(store.proxy!, 'c1', { sleep: sleeps([]) }),
    });
    store.rateLimit = {
      status: 403,
      headers: { 'retry-after': '3600' },
      remaining: 1,
      writesOnly: true,
      message: 'You have exceeded a secondary rate limit.',
    };
    const issue = { title: 'Survives a rate limit', body: 'kept' };

    const error = await transport('create_issue', issue, 'op-1').catch(e => e);
    expect(isRateLimitError(error)).toBe(true);
    expect(error.rateLimit.until).toBeGreaterThan(Date.now() + 3500_000);
    // GitHub refused the request, so nothing was written and nothing is
    // uncertain: the journal forgot it, after writing the entry and its removal.
    expect(journal['op-1']).toBeUndefined();
    expect(saves).toBe(2);
    expect(
      store.github
        .snapshot('atomic-fixture/tracker')
        .issues.some((i: { title: string }) => i.title === issue.title),
    ).toBe(false);

    // The next pass sends the same operation again, as a first attempt.
    const receipt = (await transport('create_issue', issue, 'op-1')) as {
      status: number;
    };
    expect(receipt.status).toBe(201);
    expect(journal['op-1']).toMatchObject({ receipt: { status: 201 } });
    expect(
      store.github
        .snapshot('atomic-fixture/tracker')
        .issues.filter((i: { title: string }) => i.title === issue.title),
    ).toHaveLength(1);
  });

  it('a write answered 429 briefly is sent once, after the wait', async () => {
    const store = fakeStore();
    const journal: Record<string, unknown> = {};
    const slept: number[] = [];
    const transport = proxyTransport({
      repository: 'atomic-fixture/tracker',
      journal,
      save: async () => {},
      dispatch: relayDispatch(store.proxy!, 'c1', { sleep: sleeps(slept) }),
    });
    store.rateLimit = {
      status: 429,
      headers: { 'retry-after': '10' },
      remaining: 1,
      writesOnly: true,
    };
    const receipt = (await transport(
      'create_issue',
      { title: 'Once', body: '' },
      'op-2',
    )) as { status: number };
    expect(receipt.status).toBe(201);
    expect(slept).toEqual([10_000]);
    expect(
      store.github
        .snapshot('atomic-fixture/tracker')
        .issues.filter((i: { title: string }) => i.title === 'Once'),
    ).toHaveLength(1);
  });
});
