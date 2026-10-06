// @wc-ignore-file
/**
 * `read.ts`'s rate-limit handling against fake transports: a 429 is waited
 * out when Todoist's `Retry-After` is short, at most twice per request, and
 * otherwise stops the read with when to try again; nothing loops without
 * bound. Also `parseRetryAfter`'s two header forms, and that a rate limit
 * during a by-id lookup stops the pass instead of marking the task
 * unconfirmed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_MS,
  lookupTasks,
  MAX_INLINE_RETRIES,
  MAX_INLINE_WAIT_MS,
  parseRetryAfter,
  rateLimited,
  readActiveTasks,
  TodoistRateLimited,
  type TodoistGet,
  type TodoistResponse,
} from './read.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const ok = (results: unknown[] = []): TodoistResponse => ({
  status: 200,
  body: { results, next_cursor: null },
});
const limited = (retryAfter?: string): TodoistResponse => ({
  status: 429,
  headers: retryAfter === undefined ? {} : { 'retry-after': retryAfter },
  body: { error: 'rate limited' },
});

/** A transport that answers from a script, recording calls and waits. */
function fake(script: TodoistResponse[]) {
  const calls: string[] = [];
  const waits: number[] = [];
  let clock = NOW;

  const get: TodoistGet = async path => {
    calls.push(path);
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

  return { get: wrapped, calls, waits, now: () => clock };
}

describe('parseRetryAfter', () => {
  it('reads delay-seconds and HTTP dates, never negative, else undefined', () => {
    expect(parseRetryAfter('3', NOW)).toBe(3000);
    expect(parseRetryAfter(' 0 ', NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(
      90_000,
    );
    expect(parseRetryAfter(new Date(NOW - 90_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfter('', NOW)).toBeUndefined();
    expect(parseRetryAfter('soon', NOW)).toBeUndefined();
    expect(parseRetryAfter('-5', NOW)).toBeUndefined();
  });
});

describe('rateLimited', () => {
  it('passes any other answer through, headers included', async () => {
    const { get, waits } = fake([
      { status: 503, body: {}, headers: { 'retry-after': '1' } },
    ]);
    expect(await get('/api/v1/tasks')).toEqual({
      status: 503,
      body: {},
      headers: { 'retry-after': '1' },
    });
    expect(waits).toEqual([]);
  });

  it('waits out a short Retry-After and retries the same request', async () => {
    const { get, calls, waits } = fake([limited('2'), ok([{ id: 'a' }])]);
    const response = await get('/api/v1/tasks?limit=200');
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      '/api/v1/tasks?limit=200',
      '/api/v1/tasks?limit=200',
    ]);
    expect(waits).toEqual([2000]);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const { get, waits } = fake([
      limited(new Date(NOW + 5000).toUTCString()),
      ok(),
    ]);
    await get('/api/v1/projects');
    expect(waits).toEqual([5000]);
  });

  it('gives up on a Retry-After longer than the inline cap, naming when to retry', async () => {
    const seconds = MAX_INLINE_WAIT_MS / 1000 + 1;
    const { get, calls, waits } = fake([limited(String(seconds))]);
    const error = await get('/api/v1/tasks').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TodoistRateLimited);
    const e = error as TodoistRateLimited;
    expect(e.status).toBe(429);
    expect(e.retryAt).toBe(NOW + seconds * 1000);
    expect(e.retryAfter).toBe(String(seconds));
    expect(e.message).toContain('rate-limiting');
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it('uses the default wait, and gives up, when a 429 has no usable Retry-After', async () => {
    expect(DEFAULT_RETRY_MS).toBeGreaterThan(MAX_INLINE_WAIT_MS);

    for (const header of [undefined, 'later']) {
      const { get } = fake([limited(header)]);
      const error = (await get('/api/v1/tasks').catch(
        (e: unknown) => e,
      )) as TodoistRateLimited;
      expect(error).toBeInstanceOf(TodoistRateLimited);
      expect(error.retryAt).toBe(NOW + DEFAULT_RETRY_MS);
    }
  });

  it('retries at most MAX_INLINE_RETRIES times for one request, then stops', async () => {
    const { get, calls, waits, now } = fake([
      limited('1'),
      limited('1'),
      limited('1'),
      limited('1'),
    ]);
    const error = (await get('/api/v1/tasks').catch(
      (e: unknown) => e,
    )) as TodoistRateLimited;
    expect(error).toBeInstanceOf(TodoistRateLimited);
    expect(calls).toHaveLength(MAX_INLINE_RETRIES + 1);
    expect(waits).toEqual(Array(MAX_INLINE_RETRIES).fill(1000));
    // The time to retry is counted from the last answer, not the first call.
    expect(error.retryAt).toBe(now() + 1000);
    expect(MAX_INLINE_RETRIES * MAX_INLINE_WAIT_MS).toBeLessThanOrEqual(20_000);
  });

  it('counts retries per request: a later page starts afresh', async () => {
    const page1 = {
      status: 200,
      body: { results: [{ id: 'a' }], next_cursor: 'c2' },
    };
    const { get, waits } = fake([
      limited('1'),
      limited('1'),
      page1,
      limited('1'),
      limited('1'),
      ok([{ id: 'b' }]),
    ]);
    const fetched = await readActiveTasks(get);
    expect(fetched.records.map(r => r.id)).toEqual(['a', 'b']);
    expect(fetched.errors).toBeUndefined();
    expect(waits).toEqual([1000, 1000, 1000, 1000]);
  });
});

describe('lookupTasks under a rate limit', () => {
  it('stops the pass instead of marking the task unconfirmed', async () => {
    const { get } = fake([
      { status: 200, body: { id: 't1', checked: true } },
      limited('600'),
    ]);
    await expect(lookupTasks(get, ['t1', 't2'])).rejects.toBeInstanceOf(
      TodoistRateLimited,
    );
  });

  it('still records a failed check as the error it was', async () => {
    const get: TodoistGet = async () => {
      throw new Error('host offline');
    };

    expect(await lookupTasks(get, ['t1'])).toEqual([
      { id: 't1', error: 'host offline' },
    ]);
  });

  it('treats a 429 that reached it unwrapped as a rate limit too', async () => {
    const get: TodoistGet = async () => limited('30');
    await expect(lookupTasks(get, ['t1'])).rejects.toBeInstanceOf(
      TodoistRateLimited,
    );
  });
});
