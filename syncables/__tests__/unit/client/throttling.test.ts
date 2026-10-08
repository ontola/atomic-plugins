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
  type StorageAdapter,
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

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
  private ns(resource: string): Map<string, Record<string, unknown>> {
    let ns = this.data.get(resource);
    if (!ns) this.data.set(resource, (ns = new Map()));
    return ns;
  }
  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.ns(resource).values()].map((v) => structuredClone(v));
  }
  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.ns(resource).set(id, structuredClone(value));
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
  crash(): CrashableStorage {
    const copy = new CrashableStorage();
    for (const [name, records] of this.data)
      copy.data.set(name, new Map(structuredClone([...records])));
    return copy;
  }
  outbox(): Record<string, unknown> | undefined {
    return this.data.get('syncables:outbox')?.get('outbox');
  }
}

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
    // The app can queue it again, but the write keeps its stored notBefore
    // and the quotaExhausted answer paused every write until the reset: it
    // fails again at once, with a lastError saying why, not sent early.
    await c.resolveWrite('/pets', '1', { action: 'retry' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        {
          id: '1',
          state: 'failed',
          lastError: expect.stringMatching(/^Held until .* not sent$/),
        },
      ]),
    );
    expect(fake.writes).toHaveLength(1);
  });

  it('keeps the earliest retry time across a restart: the restored write is not sent before it', async () => {
    const storage = new CrashableStorage();
    const fake = provider((_r, n) =>
      n === 1
        ? json({ message: 'API rate limit exceeded' }, 403, {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': epochIn(60),
          })
        : undefined,
    );
    const first = await client(doc(githubThrottling), fake, { storage });
    await first.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await settle(5);
    const outbox = storage.outbox() as {
      records: { queue: { notBefore?: number }[] }[];
      throttlingPauses?: { bucket: string | null; until: number }[];
    };
    expect(outbox.records[0]!.queue[0]!.notBefore).toBeGreaterThan(
      Date.now() + 50_000,
    );
    // The GitHub snippet's signal names no bucket: every write is paused.
    expect(outbox.throttlingPauses).toEqual([
      { bucket: null, until: expect.any(Number) },
    ]);
    // The pause names no bucket, so the restored client's read waits for it
    // too; the fake sleep lets the sync go ahead here.
    const restarted = createApiClient(doc(githubThrottling), {
      transport: fake.transport,
      storage: storage.crash(),
      retry: { baseDelayMs: 10 },
      sleep: async () => {},
    });
    await restarted.ready();
    await restarted.sync();
    await settle(80);
    // Not resent at once, as a restored write otherwise is.
    expect(fake.writes).toHaveLength(1);
    expect(restarted.pendingWrites()).toMatchObject([
      { id: '1', state: 'pending', attempts: 1 },
    ]);
    // Released by the refresh; held by its stored time, not by a refresh.
    expect(restarted.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
  });

  it('pauses the bucket until its own backoff when a quotaExhausted answer carries no time and no window', async () => {
    const fake = provider((_r, n) =>
      n === 1 ? json({ error: 'quota' }, 429) : undefined,
    );
    const c = await client(
      doc({ signals: [{ status: [429], meaning: 'quotaExhausted' }] }),
      fake,
      { retry: { baseDelayMs: 300, maxDelayMs: 300 } },
    );
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await c.update('/pets', '2', { name: 'Tom II' });
    await settle(100);
    // Held with the throttled write, for its backoff.
    expect(fake.writes).toHaveLength(1);
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 2000,
    });
    expect(fake.writes).toHaveLength(3);
  });

  it('fails other writes held by an exhausted bucket past retry.maxRetryAfterMs, with a lastError', async () => {
    const fake = provider((_r, n) =>
      n === 1 ? json({ error: 'Too many requests' }, 429) : undefined,
    );
    const c = await client(doc(moneybirdThrottling), fake, {
      retry: { baseDelayMs: 10, maxRetryAfterMs: 1000 },
    });
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ id: '1', state: 'failed' }]),
    );
    // The window (300 s) is the pause; another record's write cannot wait.
    await c.update('/pets', '2', { name: 'Tom II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        { id: '1', state: 'failed' },
        {
          id: '2',
          state: 'failed',
          attempts: 0,
          lastError: expect.stringMatching(
            /^Held until .* exhausted, longer than retry.maxRetryAfterMs \(1000 ms\); not sent$/,
          ),
        },
      ]),
    );
    expect(fake.writes).toHaveLength(1);
  });

  it('makes a create answered by a 5xx uncertain even when a declared signal matches it: a 5xx may follow partial processing', async () => {
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
    // "Not applied" is only an inference (Throttling spec, "Throttling
    // signals"): the create is uncertain and not resent, as without the signal.
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain', attempts: 1, lastStatus: 500 },
      ]),
    );
    await settle();
    expect(fake.writes).toHaveLength(1);
  });
});

describe('reads and the exhausted buckets they share with writes', () => {
  it("waits for a bucket a write's quotaExhausted answer exhausted, through the injected sleep, and a read's quotaExhausted answer pauses writes", async () => {
    const slept: number[] = [];
    let listAnswer: TransportResponse | undefined;
    const fake = provider(
      (_r, n) =>
        n === 1 ? json({ error: 'Too many requests' }, 429) : undefined,
      { list: () => listAnswer },
    );
    const c = await client(doc(moneybirdThrottling), fake, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    // A write exhausts the one bucket for the window (300 s, no Retry-After).
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    // The next read waits out the pause (here: through the fake sleep).
    await c.sync();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(290_000);
    expect(slept[0]).toBeLessThanOrEqual(300_000);
    expect(fake.reads).toBe(2);
  });

  it("a read's quotaExhausted answer pauses writes on the bucket, and a pause past the read's time stops the read", async () => {
    let listAnswer: TransportResponse | undefined = json(
      { error: 'Too many requests' },
      429,
      { 'Retry-After': '120' },
    );
    const fake = provider(() => undefined, { list: () => listAnswer });
    const c = createApiClient(doc(moneybirdThrottling), {
      transport: fake.transport,
      retry: { baseDelayMs: 10 },
      limits: { timeoutMs: 1000, maxRetries: 0 },
    });
    // The read's 429 is returned (no retries left) and pauses the bucket.
    await expect(c.sync()).rejects.toThrow(/responded 429/);
    listAnswer = undefined;
    await c.update('/pets', '1', { name: 'Rex II' });
    await settle(60);
    expect(fake.writes).toHaveLength(0);
    expect(c.pendingWrites()).toMatchObject([{ id: '1', state: 'pending' }]);
    // A read cannot wait 120 s within a 1 s budget: it stops with an error.
    await expect(c.sync()).rejects.toThrow(
      /holds this request until .* longer than the read's remaining time/,
    );
  });

  it("a read's quotaExhausted answer with no time pauses the bucket until the base backoff, as a write's does", async () => {
    let listAnswer: TransportResponse | undefined = json(
      { error: 'Too many requests' },
      429,
    );
    const fake = provider(() => undefined, { list: () => listAnswer });
    const c = createApiClient(
      doc({ signals: [{ status: [429], meaning: 'quotaExhausted' }] }),
      {
        transport: fake.transport,
        retry: { baseDelayMs: 300, maxDelayMs: 300 },
        limits: { maxRetries: 0 },
      },
    );
    await expect(c.sync()).rejects.toThrow(/responded 429/);
    listAnswer = undefined;
    await c.update('/pets', '1', { name: 'Rex II' });
    await settle(100);
    expect(fake.writes).toHaveLength(0);
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 2000,
    });
    expect(fake.writes).toHaveLength(1);
  });
});

describe('the earliest retry time holds a write whatever path its class takes (#391 review)', () => {
  const throttledSignal = {
    signals: [
      {
        status: [500, 429, 422],
        header: { name: 'retry-after', present: true },
        meaning: 'throttled',
      },
    ],
  };

  it('an uncertain create keeps the time: resolveWrite retry does not re-POST before it', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ message: 'overloaded' }, 500, { 'retry-after': '60' })
        : json({ id: 'srv-1', ...JSON.parse(_r.body ?? '{}') }, 201),
    );
    const c = await client(doc(throttledSignal), fake);
    const created = await c.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ state: 'uncertain' }]),
    );
    await c.resolveWrite('/pets', String(created['id']), { action: 'retry' });
    await settle(80);
    expect(fake.writes).toHaveLength(1);
    // Queued again (an uncertain create keeps its attempt count), held by
    // its stored time.
    expect(c.pendingWrites()).toMatchObject([
      { type: 'create', state: 'pending' },
    ]);
  });

  it('a blocked write keeps the time: authRenewed() does not resend it before it', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ error: 'slow down' }, 429, { 'retry-after': '60' })
        : undefined,
    );
    const c = await client(doc(throttledSignal), fake, {
      // A classifier that calls the throttled answer a refused credential.
      classifyWriteFailure: (f) => (f.status === 429 ? 'auth' : 'retry'),
    });
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ state: 'blocked' }]),
    );
    await c.authRenewed();
    await settle(80);
    expect(fake.writes).toHaveLength(1);
    expect(c.pendingWrites()).toMatchObject([{ state: 'pending' }]);
  });

  it('a failed write keeps the time: resolveWrite retry waits for it', async () => {
    const fake = provider((_r, n) =>
      n === 1
        ? json({ error: 'refused' }, 422, { 'retry-after': '60' })
        : undefined,
    );
    const c = await client(doc(throttledSignal), fake, {
      classifyWriteFailure: (f) => (f.status === 422 ? 'permanent' : 'retry'),
    });
    await c.update('/pets', '1', { name: 'Rex II' });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ state: 'failed' }]),
    );
    await c.resolveWrite('/pets', '1', { action: 'retry' });
    await settle(80);
    expect(fake.writes).toHaveLength(1);
    expect(c.pendingWrites()).toMatchObject([
      { state: 'pending', attempts: 0 },
    ]);
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
    // Once the pause lifts, the throttled write's retry and the held write
    // go out in either order.
    expect(fake.writes[0]!.url.pathname).toBe('/api/pets/1');
    expect(
      fake.writes
        .slice(1)
        .map((w) => w.url.pathname)
        .sort(),
    ).toEqual(['/api/pets/1', '/api/pets/2']);
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
