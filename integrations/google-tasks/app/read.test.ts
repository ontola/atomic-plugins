// @wc-ignore-file
/**
 * `read.ts`'s rate-limit handling against fake transports and a fake clock:
 * a 429, or a 403 naming a rate-limit reason, is waited out when the wait is
 * short, at most twice per request, and otherwise stops the read with when
 * to try again; nothing loops without bound, and no write follows. Also
 * `parseRetryAfter`'s two header forms, the backoff rule, the fixed flags of
 * every task read, and that a rate limit during a by-id lookup stops the
 * pass instead of marking the task unconfirmed.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKOFF_BASE_MS,
  DEFAULT_RETRY_MS,
  GoogleError,
  GoogleRateLimited,
  type GoogleGet,
  type GoogleResponse,
  isRateLimit,
  lookupTasks,
  MAX_INLINE_RETRIES,
  MAX_INLINE_WAIT_MS,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  rateLimited,
  readTaskLists,
  readTasks,
  retryWait,
} from './read.js';
import { RATE_LIMIT_403 } from './fakeStore.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ok = (items?: unknown[], nextPageToken?: string): GoogleResponse => ({
  status: 200,
  body: {
    kind: 'tasks#tasks',
    ...(items ? { items } : {}),
    ...(nextPageToken ? { nextPageToken } : {}),
  },
});
const limited = (retryAfter?: string, status = 429): GoogleResponse => ({
  status,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  body: status === 403 ? RATE_LIMIT_403 : { error: { code: 429 } },
});

/** A transport that answers from a script, recording calls and waits. */
function fake(script: GoogleResponse[]) {
  const calls: { path: string; query?: Record<string, string> }[] = [];
  const waits: number[] = [];
  let clock = NOW;

  const get: GoogleGet = async (path, query) => {
    calls.push({ path, ...(query ? { query } : {}) });
    const next = script.shift();
    if (!next) throw new Error(`unscripted call ${calls.length}: ${path}`);

    return next;
  };

  const wrapped = rateLimited(get, {
    now: () => clock,
    sleep: async ms => {
      waits.push(ms);
      clock += ms;
    },
  });

  return { get: wrapped, raw: get, calls, waits, now: () => clock };
}

describe('parseRetryAfter', () => {
  it('reads delay-seconds and IMF-fixdates, never negative, clamped to a day, else undefined', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(
      90_000,
    );
    expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter('9'.repeat(30), NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(
      parseRetryAfter(
        new Date(NOW + 40 * MAX_RETRY_AFTER_MS).toUTCString(),
        NOW,
      ),
    ).toBe(MAX_RETRY_AFTER_MS);
    for (const junk of [
      undefined,
      '',
      'soon',
      '-5',
      '1.5',
      new Date(NOW + 5000).toISOString(),
      'Tuesday, 06-Oct-26 12:00:05 GMT',
      'Tue Oct  6 12:00:05 2026',
    ])
      expect(parseRetryAfter(junk, NOW)).toBeUndefined();
  });
});

describe('isRateLimit', () => {
  it('is a 429, or a 403 with a rate-limit reason or RESOURCE_EXHAUSTED, and nothing else', () => {
    expect(isRateLimit(limited())).toBe(true);
    expect(isRateLimit(limited(undefined, 403))).toBe(true);
    expect(
      isRateLimit({
        status: 403,
        body: { error: { errors: [{ reason: 'rateLimitExceeded' }] } },
      }),
    ).toBe(true);
    expect(
      isRateLimit({
        status: 403,
        body: { error: { status: 'RESOURCE_EXHAUSTED' } },
      }),
    ).toBe(true);
    expect(
      isRateLimit({
        status: 403,
        body: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
      }),
    ).toBe(false);
    expect(isRateLimit({ status: 403, body: 'Forbidden' })).toBe(false);
    expect(isRateLimit({ status: 503, body: {} })).toBe(false);
  });
});

describe('retryWait', () => {
  it('is the larger of Retry-After (or the default) and the doubling backoff, clamped', () => {
    expect(retryWait('1', 0, NOW)).toBe(BACKOFF_BASE_MS);
    expect(retryWait('1', 1, NOW)).toBe(2 * BACKOFF_BASE_MS);
    expect(retryWait('5', 1, NOW)).toBe(5000);
    expect(retryWait(undefined, 0, NOW)).toBe(DEFAULT_RETRY_MS);
    expect(retryWait('later', 3, NOW)).toBe(DEFAULT_RETRY_MS);
    expect(retryWait('1', 40, NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(DEFAULT_RETRY_MS).toBeGreaterThan(MAX_INLINE_WAIT_MS);
  });
});

describe('rateLimited', () => {
  it('passes any other answer through, headers included', async () => {
    const { get, waits } = fake([
      { status: 503, body: {}, headers: { 'retry-after': '1' } },
    ]);
    expect(await get('/tasks/v1/users/@me/lists')).toEqual({
      status: 503,
      body: {},
      headers: { 'retry-after': '1' },
    });
    expect(waits).toEqual([]);
  });

  it('waits out a short Retry-After and retries the same request, query included', async () => {
    const { get, calls, waits } = fake([limited('2'), ok([{ id: 'a' }])]);
    const response = await get('/tasks/v1/lists/l/tasks', { pageToken: 'p2' });
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { path: '/tasks/v1/lists/l/tasks', query: { pageToken: 'p2' } },
      { path: '/tasks/v1/lists/l/tasks', query: { pageToken: 'p2' } },
    ]);
    expect(waits).toEqual([2000]);
  });

  it('treats a 403 rate-limit body like a 429, and reports its status', async () => {
    const { get, waits } = fake([limited('3', 403), ok()]);
    await get('/tasks/v1/users/@me/lists');
    expect(waits).toEqual([3000]);

    const { get: again } = fake([limited(undefined, 403)]);
    const error = (await again('/tasks/v1/users/@me/lists').catch(
      (e: unknown) => e,
    )) as GoogleRateLimited;
    expect(error).toBeInstanceOf(GoogleRateLimited);
    expect(error.status).toBe(403);
    expect(error.retryAt).toBe(NOW + DEFAULT_RETRY_MS);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const { get, waits } = fake([
      limited(new Date(NOW + 5000).toUTCString()),
      ok(),
    ]);
    await get('/tasks/v1/users/@me/lists');
    expect(waits).toEqual([5000]);
  });

  it('gives up on a wait longer than the inline cap, naming when to retry', async () => {
    const seconds = MAX_INLINE_WAIT_MS / 1000 + 1;
    const { get, calls, waits } = fake([limited(String(seconds))]);
    const error = await get('/tasks/v1/users/@me/lists').catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GoogleRateLimited);
    const e = error as GoogleRateLimited;
    expect(e.status).toBe(429);
    expect(e.retryAt).toBe(NOW + seconds * 1000);
    expect(e.retryAfter).toBe(String(seconds));
    expect(e.message).toContain('rate-limiting');
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('uses the default wait, and gives up, when a rate limit has no usable Retry-After', async () => {
    for (const header of [undefined, 'later']) {
      const { get } = fake([limited(header)]);
      const error = (await get('/tasks/v1/users/@me/lists').catch(
        (e: unknown) => e,
      )) as GoogleRateLimited;
      expect(error).toBeInstanceOf(GoogleRateLimited);
      expect(error.retryAt).toBe(NOW + DEFAULT_RETRY_MS);
    }
  });

  it('retries at most MAX_INLINE_RETRIES times for one request, backing off, then stops', async () => {
    const { get, calls, waits, now } = fake([
      limited('1'),
      limited('1'),
      limited('1'),
      limited('1'),
    ]);
    const error = (await get('/tasks/v1/users/@me/lists').catch(
      (e: unknown) => e,
    )) as GoogleRateLimited;
    expect(error).toBeInstanceOf(GoogleRateLimited);
    expect(calls).toHaveLength(MAX_INLINE_RETRIES + 1);
    // Retry-After asked 1 s each time; the backoff makes the second wait 2 s.
    expect(waits).toEqual([1000, 2000]);
    // The time to retry is counted from the last answer, not the first call.
    expect(error.retryAt).toBe(now() + 4000);
    expect(MAX_INLINE_RETRIES * MAX_INLINE_WAIT_MS).toBeLessThanOrEqual(20_000);
  });

  it('counts retries per request: a later page starts afresh', async () => {
    const { get, waits } = fake([
      limited('1'),
      limited('1'),
      ok([{ id: 'a' }], 'p2'),
      limited('1'),
      limited('1'),
      ok([{ id: 'b' }]),
    ]);
    const { rows, partial } = await readTasks(get, 'l');
    expect(rows.map(r => r.id)).toEqual(['a', 'b']);
    expect(partial).toBeUndefined();
    expect(waits).toEqual([1000, 2000, 1000, 2000]);
  });
});

describe('readTaskLists and readTasks', () => {
  it('page through with pageToken, keep the flags fixed, and read an empty list as no items', async () => {
    const { get, calls } = fake([
      {
        status: 200,
        body: {
          items: [{ id: 'l1', title: 'A' }, { id: 'l2' }, { title: 'no id' }],
          nextPageToken: 'p2',
        },
      },
      { status: 200, body: { items: [{ id: 'l3', title: 'C' }] } },
      { status: 200, body: { kind: 'tasks#tasks' } },
    ]);
    expect(await readTaskLists(get)).toEqual({
      lists: [
        { id: 'l1', title: 'A' },
        { id: 'l2', title: '' },
        { id: 'l3', title: 'C' },
      ],
    });
    expect(await readTasks(get, 'l1')).toEqual({ rows: [] });
    expect(calls).toEqual([
      { path: '/tasks/v1/users/@me/lists', query: { maxResults: '100' } },
      {
        path: '/tasks/v1/users/@me/lists',
        query: { maxResults: '100', pageToken: 'p2' },
      },
      {
        path: '/tasks/v1/lists/l1/tasks',
        query: { showCompleted: 'true', showHidden: 'true', maxResults: '100' },
      },
    ]);
  });

  it('reports a read past the page cap as partial, and refusals and other statuses as errors', async () => {
    const { get } = fake([ok([{ id: 'a' }], 'p2'), ok([{ id: 'b' }], 'p3')]);
    const { rows, partial } = await readTasks(get, 'l', { maxPages: 2 });
    expect(rows).toHaveLength(2);
    expect(partial).toContain('after 2 pages');

    const refused = fake([{ status: 401, body: {} }]);
    await expect(readTaskLists(refused.get)).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof GoogleError &&
        e.status === 401 &&
        /reconnect Google Tasks/.test(e.message),
    );
    const forbidden = fake([
      {
        status: 403,
        body: { error: { errors: [{ reason: 'insufficientPermissions' }] } },
      },
    ]);
    await expect(readTaskLists(forbidden.get)).rejects.toThrow('refused');
    const down = fake([{ status: 503, body: {} }]);
    await expect(readTaskLists(down.get)).rejects.toThrow('answered 503');
    const odd = fake([{ status: 200, body: { items: 'nope' } }]);
    await expect(readTaskLists(odd.get)).rejects.toThrow('no items');
  });
});

describe('lookupTasks', () => {
  it('stops the pass on a rate limit instead of marking the task unconfirmed', async () => {
    const { get } = fake([
      { status: 200, body: { id: 't1', status: 'completed' } },
      limited('600'),
    ]);
    await expect(
      lookupTasks(get, [
        { id: 't1', listId: 'l' },
        { id: 't2', listId: 'l' },
      ]),
    ).rejects.toBeInstanceOf(GoogleRateLimited);
  });

  it('records a failed check as the error it was, and caps the checks per pass', async () => {
    const get: GoogleGet = async () => {
      throw new Error('host offline');
    };

    expect(await lookupTasks(get, [{ id: 't1', listId: 'l' }])).toEqual([
      { id: 't1', error: 'host offline' },
    ]);

    const { raw, calls } = fake([ok(), ok(), ok()]);
    const refs = ['a', 'b', 'c'].map(id => ({ id, listId: 'l' }));
    expect(await lookupTasks(raw, refs, { maxLookups: 2 })).toHaveLength(2);
    expect(calls.map(c => c.path)).toEqual([
      '/tasks/v1/lists/l/tasks/a',
      '/tasks/v1/lists/l/tasks/b',
    ]);
  });

  it('treats a rate limit that reached it unwrapped as one too, timed from the pinned clock', async () => {
    const get: GoogleGet = async () => limited('30');
    const error = (await lookupTasks(get, [{ id: 't1', listId: 'l' }], {
      now: () => NOW,
    }).catch((e: unknown) => e)) as GoogleRateLimited;
    expect(error).toBeInstanceOf(GoogleRateLimited);
    expect(error.retryAt).toBe(NOW + 30_000);
  });
});
