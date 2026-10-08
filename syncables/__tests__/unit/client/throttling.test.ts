// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  defaultWriteFailureClass,
  paginate,
  prepareDocument,
  readCollections,
  type ApiClientOptions,
  type AuthBlock,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
  type WriteFailure,
} from '../../../src/browser.js';
import {
  githubThrottling,
  googleThrottling,
  moneybirdThrottling,
  responseSignals,
  throttledPets,
} from '../../fixtures/throttling.js';
import { petsDocument } from '../../fixtures/pets.js';

// Throttling 0.2.0-draft in the client: the document's x-throttling decides
// which responses are rate-limit refusals (a matching signal, or a 429) and
// the earliest retry time, for writes and for reads. Transports and data
// are invented; the declarations are the spec's three provider snippets
// and its synthetic example.

const json = (
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): TransportResponse => ({
  status,
  headers,
  body: value === undefined ? '' : JSON.stringify(value),
});

const doc = (throttling?: unknown): OpenApiDocument =>
  prepareDocument(
    throttling === undefined
      ? { ...petsDocument, servers: [{ url: 'https://provider.example/api' }] }
      : throttledPets(throttling),
  );

const settle = (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const rex = { id: '1', name: 'Rex' };
const tom = { id: '2', name: 'Tom' };

type Answer = TransportResponse | undefined;

/**
 * A fake provider: GET answers the list, writes are answered by `behave`
 * (`undefined` applies them). Every write request is recorded.
 */
function provider(
  behave: (r: TransportRequest, n: number) => Answer,
  options: { list?: (r: TransportRequest, n: number) => Answer } = {},
): {
  writes: TransportRequest[];
  reads: number;
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const writes: TransportRequest[] = [];
  const state: {
    writes: TransportRequest[];
    reads: number;
    transport: (r: TransportRequest) => Promise<TransportResponse>;
  } = {
    writes,
    reads: 0,
    transport: async (r: TransportRequest): Promise<TransportResponse> => {
      if (r.method === 'GET') {
        state.reads += 1;
        return options.list?.(r, state.reads) ?? json([rex, tom]);
      }
      writes.push(r);
      return (
        behave(r, writes.length) ?? json({ ...JSON.parse(r.body ?? '{}') })
      );
    },
  };
  return state;
}

/** Epoch seconds `seconds` from now, as a header value. */
const epochIn = (seconds: number): string =>
  String(Math.floor(Date.now() / 1000) + seconds);

async function client(
  document: OpenApiDocument,
  fake: ReturnType<typeof provider>,
  options: ApiClientOptions = {},
): Promise<ReturnType<typeof createApiClient>> {
  const c = createApiClient(document, {
    transport: fake.transport,
    retry: { baseDelayMs: 10, maxDelayMs: 20 },
    ...options,
  });
  await c.sync();
  return c;
}

describe('writes under declared signals (GitHub-shaped)', () => {
  it('retries a 403 with x-ratelimit-remaining: 0 no earlier than the reset, instead of blocking', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ message: 'API rate limit exceeded' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': epochIn(60),
          })
        : undefined,
    );
    const c = await client(doc(githubThrottling), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await settle(60);
    expect(fake.writes).toHaveLength(1);
    expect(c.pendingWrites()).toMatchObject([
      { state: 'pending', attempts: 1, lastStatus: 403 },
    ]);
    expect(c.authBlocked()).toBeUndefined();
  });

  it('waits the minimum delay for a secondary-limit message without headers', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ message: 'You have exceeded a secondary rate limit.' }, 403)
        : undefined,
    );
    const c = await client(doc(githubThrottling), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await settle(60);
    expect(fake.writes).toHaveLength(1);
    expect(c.pendingWrites()).toMatchObject([
      { state: 'pending', attempts: 1 },
    ]);
  });

  it('blocks on a 403 that matches no signal: with signals declared, only a match or a 429 is throttling', async () => {
    const blocks: AuthBlock[] = [];
    const fake = provider(() =>
      json({ message: 'Resource not accessible by integration' }, 403, {
        'x-ratelimit-remaining': '4999',
      }),
    );
    const c = await client(doc(githubThrottling), fake, {
      onAuthBlocked: (b) => blocks.push(b),
    });
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ state: 'blocked' }]),
    );
    expect(blocks).toHaveLength(1);
  });

  it('retries a 403 with Retry-After after that delay (the throttled signal), not before', async () => {
    const times: number[] = [];
    const fake = provider((_r, n) => {
      times.push(Date.now());
      return n === 1
        ? json({ message: 'slow down' }, 403, { 'retry-after': '1' })
        : undefined;
    });
    const c = await client(doc(githubThrottling), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 3000,
    });
    expect(fake.writes).toHaveLength(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
  });

  it('gives up instead of retrying earlier when the API asks to wait longer than retry.maxRetryAfterMs', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ message: 'API rate limit exceeded' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': epochIn(3600),
          })
        : undefined,
    );
    const c = await client(doc(githubThrottling), fake, {
      retry: { baseDelayMs: 10, maxRetryAfterMs: 1000 },
    });
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          attempts: 1,
          lastStatus: 403,
          lastError: expect.stringMatching(
            /asks to wait until .*longer than retry.maxRetryAfterMs \(1000 ms\)/,
          ),
        },
      ]),
    );
    await settle();
    expect(fake.writes).toHaveLength(1);
    // The app can queue it again, but the quotaExhausted answer named no
    // bucket, so every write is held until the reset: still not sent.
    await c.resolveWrite('/pets', '1', { action: 'retry' });
    await settle(60);
    expect(c.pendingWrites()).toMatchObject([
      { id: '1', state: 'pending', attempts: 0 },
    ]);
    expect(fake.writes).toHaveLength(1);
  });

  it('does not make a create uncertain when a declared signal says the 5xx was a refusal', async () => {
    const fake = provider((r, n) =>
      n === 1
        ? json({ message: 'overloaded' }, 500, { 'retry-after': '0' })
        : json({ id: 'srv-1', ...JSON.parse(r.body ?? '{}') }, 201),
    );
    const c = await client(
      doc({
        signals: [
          {
            status: [500],
            header: { name: 'retry-after', present: true },
            meaning: 'throttled',
          },
        ],
      }),
      fake,
    );
    await c.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(fake.writes).toHaveLength(2);
    // Without the signal, the same 500 is uncertain.
    const plain = provider(() => json({ message: 'overloaded' }, 500));
    const p = await client(doc(), plain);
    await p.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(p.pendingWrites()).toMatchObject([{ state: 'uncertain' }]),
    );
  });
});

describe('writes under the Google and Moneybird snippets', () => {
  it("retries a 403 whose body carries Google's rate-limit reason, and blocks on another reason", async () => {
    const body = (reason: string): unknown => ({
      error: { errors: [{ domain: 'usageLimits', reason }], code: 403 },
    });
    const throttledFake = provider((_r, n) =>
      n === 1 ? json(body('userRateLimitExceeded'), 403) : undefined,
    );
    const c = await client(doc(googleThrottling), throttledFake);
    await c.update('/pets', '1', { name: 'Rex II' });
    // No time in the response: the client's own backoff.
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(throttledFake.writes).toHaveLength(2);

    const refusedFake = provider(() =>
      json(body('insufficientPermissions'), 403),
    );
    const d = await client(doc(googleThrottling), refusedFake);
    await d.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(d.pendingWrites()).toMatchObject([{ state: 'blocked' }]),
    );
  });

  it("holds every write of the exhausted bucket for Moneybird's window when a 429 carries no Retry-After", async () => {
    const fake = provider((_r, n) =>
      n === 1 ? json({ error: 'Too many requests' }, 429) : undefined,
    );
    const c = await client(doc(moneybirdThrottling), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    // Another record's write counts against the same bucket: not sent.
    await c.update('/pets', '2', { name: 'Tom II' });
    await settle(60);
    expect(fake.writes).toHaveLength(1);
    expect(c.pendingWrites()).toMatchObject([
      { id: '1', state: 'pending', attempts: 1, lastStatus: 429 },
      { id: '2', state: 'pending', attempts: 0 },
    ]);
  });

  it("retries Moneybird's 429 after its Retry-After, and the paused bucket resumes with it", async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ error: 'Too many requests' }, 429, { 'Retry-After': '1' })
        : undefined,
    );
    const c = await client(doc(moneybirdThrottling), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await c.update('/pets', '2', { name: 'Tom II' });
    await settle(100);
    expect(fake.writes).toHaveLength(1);
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 3000,
    });
    expect(fake.writes.map((w) => w.url.pathname)).toEqual([
      '/api/pets/1',
      '/api/pets/1',
      '/api/pets/2',
    ]);
  });
});

describe('without signals, the 403 heuristic stays', () => {
  it('retries a 403 with x-ratelimit-remaining: 0 or Retry-After, and blocks on another 403', () => {
    const failure = (
      headers: Record<string, string>,
      signalsDeclared?: boolean,
    ): WriteFailure => ({
      type: 'update',
      method: 'PUT',
      status: 403,
      headers,
      body: '',
      resource: '/pets',
      id: '1',
      afterRenewal: false,
      ...(signalsDeclared === undefined ? {} : { signalsDeclared }),
    });
    expect(
      defaultWriteFailureClass(failure({ 'x-ratelimit-remaining': '0' })),
    ).toBe('retry');
    expect(defaultWriteFailureClass(failure({ 'retry-after': '5' }))).toBe(
      'retry',
    );
    expect(defaultWriteFailureClass(failure({}))).toBe('auth');
    // With signals declared and no verdict, the heuristic is off.
    expect(
      defaultWriteFailureClass(failure({ 'x-ratelimit-remaining': '0' }, true)),
    ).toBe('auth');
    // A verdict makes any status retryable.
    expect(
      defaultWriteFailureClass({
        ...failure({}, true),
        status: 403,
        throttling: { meaning: 'throttled' },
      }),
    ).toBe('retry');
  });

  it('a 429 without any declaration still waits the standard Retry-After', async () => {
    const times: number[] = [];
    const fake = provider((_r, n) => {
      times.push(Date.now());
      return n === 1
        ? json({ error: 'slow down' }, 429, { 'retry-after': '1' })
        : undefined;
    });
    const c = await client(doc(), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 3000,
    });
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
  });

  it('a 403 with Retry-After on a plain document is retried, as before', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ error: 'slow down' }, 403, { 'retry-after': '0' })
        : undefined,
    );
    const c = await client(doc(), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(fake.writes).toHaveLength(2);
    expect(c.authBlocked()).toBeUndefined();
  });
});

describe('reads under declared signals', () => {
  const headers = (): Record<string, string> => ({
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': epochIn(2),
  });

  it('waits until the reset and retries a 403 the signals call quotaExhausted, through the injected sleep', async () => {
    const slept: number[] = [];
    const fake = provider(() => undefined, {
      list: (_r, n) =>
        n === 1 ? json({ message: 'rate limited' }, 403, headers()) : undefined,
    });
    const result = await readCollections(doc(githubThrottling), {
      transport: fake.transport,
      legacy: {},
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(result.collections[0]).toMatchObject({ complete: true });
    expect(fake.reads).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(900);
    expect(slept[0]).toBeLessThanOrEqual(2000);
  });

  it('stops the read when the earliest retry time is past its deadline', async () => {
    const fake = provider(() => undefined, {
      list: () =>
        json({ message: 'rate limited' }, 403, {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': epochIn(3600),
        }),
    });
    const result = await readCollections(doc(githubThrottling), {
      transport: fake.transport,
      legacy: {},
      limits: { timeoutMs: 1000 },
    });
    expect(result.collections[0]).toMatchObject({
      complete: false,
      error: 'API retry delay exceeds the remaining read time',
    });
    expect(fake.reads).toBe(1);
  });

  it('returns a 403 that matches no signal to the read as before, and a throttled answer without a time', async () => {
    const fake = provider(() => undefined, {
      list: () => json({ message: 'no access' }, 403),
    });
    const refused = await readCollections(doc(githubThrottling), {
      transport: fake.transport,
      legacy: {},
    });
    expect(refused.collections[0]).toMatchObject({
      complete: false,
      error: expect.stringMatching(/responded 403/),
    });
    expect(fake.reads).toBe(1);
    const noTime = provider(() => undefined, {
      list: () => json({ message: 'secondary rate limit' }, 429),
    });
    const throttled = await readCollections(doc(), {
      transport: noTime.transport,
      legacy: {},
    });
    expect(throttled.collections[0]).toMatchObject({
      complete: false,
      error: expect.stringMatching(/responded 429/),
    });
    expect(noTime.reads).toBe(1);
  });

  it('runs the spec example through paginate: a 403 quotaExhausted on the list is waited out', async () => {
    const slept: number[] = [];
    let calls = 0;
    const items = await paginate(responseSignals, {
      transport: async () => {
        calls += 1;
        return calls === 1
          ? json({ message: 'rate limited' }, 403, headers())
          : json([{ id: 'r1' }]);
      },
      path: '/records',
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(items).toEqual([{ id: 'r1' }]);
    expect(calls).toBe(2);
    expect(slept).toHaveLength(1);
  });
});
