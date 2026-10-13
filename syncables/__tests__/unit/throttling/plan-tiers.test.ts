// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  classifyThrottling,
  createApiClient,
  declaredThrottling,
  prepareDocument,
  selectTier,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';

import { throttledPets } from '../../fixtures/throttling.js';

// Throttling 0.5.0 plan tiers: a Limit Object's `tiers`, read through the
// tier the consumer is configured for, else the most restrictive (the
// spec's `select_tier`), on the spec's Clockify example
// (examples/plan-tiers.yaml). The tier fills the bucket's window and quota,
// so pacing and a quotaExhausted fallback use it. Transports are invented.

const window = (seconds: number): Record<string, unknown> => ({
  seconds,
  kind: 'unspecified',
});

/** The spec's Clockify limit: one bucket, per workspace, four tiers. */
function clockify(
  tiers: unknown = [
    { name: 'FREE', requests: 30, window: window(3600) },
    { name: 'TRIAL', requests: 20, window: window(1) },
    { name: 'BASIC STANDARD PRO', requests: 20, window: window(1) },
    { name: 'ENTERPRISE', requests: 50, window: window(1) },
  ],
): Record<string, unknown> {
  return {
    limits: {
      workspace: {
        partitionBy: ['account'],
        description: 'Counted per workspace for requests with an API key.',
        tiers,
      },
    },
    applies: ['workspace'],
  };
}

const doc = (throttling: unknown): OpenApiDocument =>
  prepareDocument(throttledPets(throttling));

describe('selectTier (select_tier)', () => {
  const tiers = clockify()['limits'] as Record<string, Record<string, unknown>>;
  const declared = tiers['workspace']!['tiers'];

  it('takes the configured tier by its exact name', () => {
    expect(selectTier(declared, 'ENTERPRISE')).toMatchObject({
      name: 'ENTERPRISE',
      requests: 50,
    });
    expect(selectTier(declared, 'BASIC STANDARD PRO')).toMatchObject({
      requests: 20,
      window: { seconds: 1 },
    });
  });

  it('takes the most restrictive tier without one, or with a name not among them', () => {
    for (const configured of [undefined, 'PRO', 'enterprise'])
      expect(selectTier(declared, configured)?.name).toBe('FREE');
  });

  it('breaks a tie in rate by the longer window', () => {
    expect(
      selectTier([
        { name: 'short', requests: 10, window: window(60) },
        { name: 'long', requests: 20, window: window(120) },
      ])?.name,
    ).toBe('long');
    expect(
      selectTier([
        { name: 'long', requests: 20, window: window(120) },
        { name: 'short', requests: 10, window: window(60) },
      ])?.name,
    ).toBe('long');
  });

  it.each([
    ['an empty list', []],
    ['not a list', { name: 'FREE' }],
    [
      'a tier without requests',
      [
        { name: 'A', window: window(60) },
        { name: 'B', requests: 1, window: window(1) },
      ],
    ],
    [
      'a duplicate name',
      [
        { name: 'A', requests: 1, window: window(60) },
        { name: 'A', requests: 2, window: window(60) },
      ],
    ],
    ['an empty name', [{ name: '', requests: 1, window: window(60) }]],
    ['a window without seconds', [{ name: 'A', requests: 1, window: {} }]],
    [
      'a fractional request count',
      [{ name: 'A', requests: 1.5, window: window(60) }],
    ],
  ])(
    'reads nothing from %s: the strictest tier cannot be known',
    (_label, tiers) => {
      expect(selectTier(tiers, 'A')).toBeUndefined();
    },
  );
});

describe('declaredThrottling with plan tiers', () => {
  it('reads the most restrictive tier without configuration', () => {
    const declaration = declaredThrottling(doc(clockify()))!;
    expect(declaration.tiers.get('workspace')).toBe('FREE');
    expect(declaration.windows.get('workspace')).toBe(3600);
    expect(declaration.quotas.get('workspace')).toMatchObject({
      requests: 30,
      seconds: 3600,
      kind: 'unspecified',
    });
  });

  it('reads the configured tier', () => {
    const declaration = declaredThrottling(doc(clockify()), {
      workspace: 'ENTERPRISE',
    })!;
    expect(declaration.tiers.get('workspace')).toBe('ENTERPRISE');
    expect(declaration.windows.get('workspace')).toBe(1);
    expect(declaration.quotas.get('workspace')).toMatchObject({
      requests: 50,
      seconds: 1,
    });
  });

  it('leaves out a limit whose tiers do not all parse', () => {
    const declaration = declaredThrottling(
      doc(
        clockify([
          { name: 'FREE', requests: 30, window: window(3600) },
          { name: 'X' },
        ]),
      ),
    )!;
    expect(declaration.windows.has('workspace')).toBe(false);
    expect(declaration.quotas.has('workspace')).toBe(false);
    expect(declaration.tiers.has('workspace')).toBe(false);
  });

  it('reads a limit with tiers through them, whatever requests and window it also carries', () => {
    const throttling = clockify();
    const limit = (
      throttling['limits'] as Record<string, Record<string, unknown>>
    )['workspace']!;
    limit['requests'] = 1000;
    limit['window'] = window(1);
    expect(
      declaredThrottling(doc(throttling))!.quotas.get('workspace'),
    ).toMatchObject({
      requests: 30,
      seconds: 3600,
    });
  });

  it('leaves a plain limit as before', () => {
    const declaration = declaredThrottling(
      doc({
        limits: { api: { requests: 100, window: window(60) } },
        applies: ['api'],
      }),
      { api: 'ENTERPRISE' },
    )!;
    expect(declaration.tiers.size).toBe(0);
    expect(declaration.quotas.get('api')).toMatchObject({
      requests: 100,
      seconds: 60,
    });
  });

  it("falls back to the tier's window on a quotaExhausted answer", () => {
    const throttling = {
      ...clockify(),
      signals: [
        { status: [429], meaning: 'quotaExhausted', bucket: 'workspace' },
      ],
    };
    const receivedAt = Date.parse('2026-10-13T00:00:00Z');
    const verdict = (tiers?: Record<string, string>): number | undefined =>
      classifyThrottling(declaredThrottling(doc(throttling), tiers), {
        status: 429,
        headers: {},
        receivedAt,
      })?.retryAt;
    expect(verdict()).toBe(receivedAt + 3_600_000);
    expect(verdict({ workspace: 'TRIAL' })).toBe(receivedAt + 1_000);
  });
});

describe('the client paces by the tier in force', () => {
  function provider(): {
    sent: number;
    transport: (r: TransportRequest) => Promise<TransportResponse>;
  } {
    const fake = {
      sent: 0,
      transport: async (): Promise<TransportResponse> => {
        fake.sent += 1;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify([{ id: '1', name: 'Rex' }]),
        };
      },
    };
    return fake;
  }

  it('waits after the most restrictive tier’s share, and not before the configured one’s', async () => {
    // Two tiers: 2 per minute (strictest) and 100 per minute. At 0.8 that
    // is one request per minute, or 80.
    const throttling = clockify([
      { name: 'small', requests: 2, window: window(60) },
      { name: 'large', requests: 100, window: window(60) },
    ]);
    const slept: number[] = [];
    const strict = provider();
    const c1 = createApiClient(doc(throttling), {
      transport: strict.transport,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await c1.sync();
    await c1.sync();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(59_000);

    const roomy = provider();
    const waited: number[] = [];
    const c2 = createApiClient(doc(throttling), {
      transport: roomy.transport,
      throttlingTiers: { workspace: 'large' },
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    for (let i = 0; i < 5; i++) await c2.sync();
    expect(waited).toEqual([]);
    expect(roomy.sent).toBe(5);
  });
});
