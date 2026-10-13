// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  moneybirdThrottling,
  throttledPets,
} from '../../fixtures/throttling.js';

// Pacing under the quotas x-throttling announces (pieces.md K2), in the
// client: reads wait through the injected sleep within their time limit,
// writes are held without failing or counting an attempt, requests are
// counted when sent, and an operation whose selection leaves a bucket out
// is not paced by it. Transports and data are invented.

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

/** One bucket of `requests` per `seconds`, sliding, applied to every operation. */
function quota(requests: number, seconds: number): Record<string, unknown> {
  return {
    limits: {
      api: { requests, window: { seconds, kind: 'sliding' } },
      unpublished: { window: { seconds: 1, kind: 'unspecified' } },
    },
    applies: ['api'],
  };
}

function doc(
  throttling: unknown,
  put?: (operation: Record<string, unknown>) => void,
): OpenApiDocument {
  const document = prepareDocument(throttledPets(throttling));
  put?.(document.paths['/pets/{petId}']!.put as Record<string, unknown>);
  return document;
}

/** A provider that lists Rex and Tom and records each request and its time. */
function provider(): {
  sent: { method: string; at: number }[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const fake = {
    sent: [] as { method: string; at: number }[],
    transport: async (r: TransportRequest): Promise<TransportResponse> => {
      fake.sent.push({ method: r.method, at: Date.now() });
      if (r.method === 'GET')
        return json([
          { id: '1', name: 'Rex' },
          { id: '2', name: 'Tom' },
        ]);
      return json(JSON.parse(r.body ?? '{}'));
    },
  };
  return fake;
}

async function client(
  document: OpenApiDocument,
  fake: ReturnType<typeof provider>,
  options: ApiClientOptions = {},
): Promise<ApiClient> {
  const c = createApiClient(document, {
    transport: fake.transport,
    retry: { baseDelayMs: 10, maxDelayMs: 20 },
    ...options,
  });
  await c.sync();
  return c;
}

const settle = (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe('pacing reads', () => {
  it('waits through the injected sleep once the window holds the fraction of requests', async () => {
    const slept: number[] = [];
    const fake = provider();
    // 3 × 0.8 = 2 requests per minute.
    const c = await client(doc(quota(3, 60)), fake, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await c.sync();
    expect(slept).toEqual([]);
    await c.sync();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(59_000);
    expect(slept[0]).toBeLessThanOrEqual(60_000);
    expect(fake.sent).toHaveLength(3);
  });

  it("stops a read whose wait is past the read's time, before the request", async () => {
    const fake = provider();
    const c = await client(doc(quota(1, 60)), fake, {
      limits: { timeoutMs: 1000 },
    });
    await expect(c.sync()).rejects.toThrow(
      /Pacing under the API's announced rate limit holds this request/,
    );
    expect(fake.sent).toHaveLength(1);
  });

  it('paces at the Moneybird default of 120 of 150 per 300 s', async () => {
    const slept: number[] = [];
    const fake = provider();
    const c = await client(doc(moneybirdThrottling), fake, {
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    for (let i = 1; i < 120; i++) await c.sync();
    expect(slept).toEqual([]);
    await c.sync();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(290_000);
  });

  it('is off with pace: false, and with a paceFraction of 1 sends every announced request', async () => {
    const off = provider();
    const slept: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      slept.push(ms);
    };
    const a = await client(doc(quota(1, 60)), off, { pace: false, sleep });
    await a.sync();
    await a.sync();
    const full = provider();
    const b = await client(doc(quota(3, 60)), full, {
      paceFraction: 1,
      sleep,
    });
    await b.sync();
    await b.sync();
    expect(slept).toEqual([]);
    expect(() =>
      createApiClient(doc(quota(3, 60)), {
        transport: full.transport,
        paceFraction: 0,
      }),
    ).toThrow(/paceFraction/);
  });
});

describe('pacing writes', () => {
  it('holds a write like notBefore, without failing it or counting an attempt', async () => {
    const fake = provider();
    // One request per second; the sync's read took this second's.
    const c = await client(doc(quota(1, 1)), fake, {
      // Pacing alone must not fail a write held longer than this.
      retry: { baseDelayMs: 10, maxDelayMs: 20, maxRetryAfterMs: 5 },
    });
    const read = fake.sent[0]!.at;
    await c.update('/pets', '1', { name: 'Rex II' });
    await settle();
    expect(c.pendingWrites()).toEqual([
      expect.objectContaining({ state: 'pending', attempts: 0 }),
    ]);
    expect(c.pendingWrites()[0]).not.toHaveProperty('lastError');
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 3000,
    });
    const put = fake.sent.find((s) => s.method === 'PUT')!;
    expect(put.at - read).toBeGreaterThanOrEqual(990);
  });

  it('counts a request when it is sent, so concurrent drains do not overshoot', async () => {
    const fake = provider();
    const c = await client(doc(quota(1, 1)), fake);
    await c.update('/pets', '1', { name: 'Rex II' });
    await c.update('/pets', '2', { name: 'Tom II' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]), {
      timeout: 5000,
    });
    const times = fake.sent.map((s) => s.at);
    expect(times).toHaveLength(3);
    // Each request a second after the one before: never two in a window.
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(990);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(990);
  });

  it('does not pace an operation whose x-throttling selection leaves the bucket out', async () => {
    for (const own of [[], ['unpublished']]) {
      const fake = provider();
      const c = await client(
        doc(quota(1, 60), (put) => (put['x-throttling'] = own)),
        fake,
      );
      await c.update('/pets', '1', { name: 'Rex II' });
      await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
      expect(fake.sent.map((s) => s.method)).toEqual(['GET', 'PUT']);
    }
  });
});
