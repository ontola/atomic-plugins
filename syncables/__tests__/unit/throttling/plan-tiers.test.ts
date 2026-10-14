// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  classifyThrottling,
  createApiClient,
  declaredThrottling,
  fallbackWindow,
  limitsInForce,
  Pacer,
  parseTiers,
  prepareDocument,
  type OpenApiDocument,
  type TransportResponse,
} from '../../../src/browser.js';

import { throttledPets } from '../../fixtures/throttling.js';

// Throttling 0.5.0 plan tiers (#548): a Limit Object's `tiers`, each naming
// the provider's `plans`. A consumer configured with the account's plan
// keeps within that plan's tier; without one, or with a plan no tier names,
// within every tier at once, each counted separately over the same
// requests (the spec's `limits_in_force`). The window a time-less
// quotaExhausted falls back to is the plan's tier's, else the longest
// (`fallback_window`). On the spec's Clockify example
// (examples/plan-tiers.yaml); transports are invented.

const window = (seconds: number): Record<string, unknown> => ({
  seconds,
  kind: 'unspecified',
});

const clockifyTiers = [
  { plans: ['FREE'], requests: 30, window: window(3600) },
  {
    plans: ['TRIAL', 'BASIC', 'STANDARD', 'PRO'],
    requests: 20,
    window: window(1),
  },
  { plans: ['ENTERPRISE'], requests: 50, window: window(1) },
];

function throttling(tiers: unknown = clockifyTiers): Record<string, unknown> {
  return {
    limits: {
      workspace: {
        partitionBy: ['account'],
        description: 'Counted per workspace for requests with an API key.',
        tiers,
      },
    },
    applies: ['workspace'],
    signals: [
      { status: [429], meaning: 'quotaExhausted', bucket: 'workspace' },
    ],
  };
}

const doc = (declared: unknown = throttling()): OpenApiDocument =>
  prepareDocument(throttledPets(declared));

describe('limitsInForce and fallbackWindow (limits_in_force, fallback_window)', () => {
  const tiers = parseTiers(clockifyTiers)!;

  it('keeps to the tier that names the plan', () => {
    expect(limitsInForce(tiers, 'PRO')).toEqual([
      { requests: 20, seconds: 1, kind: 'unspecified' },
    ]);
    expect(fallbackWindow(tiers, 'PRO')).toBe(1);
    expect(fallbackWindow(tiers, 'FREE')).toBe(3600);
  });

  it.each([
    ['no plan', undefined],
    ['a plan no tier names', 'GOLD'],
    ['a plan in another case', 'pro'],
  ])('keeps to every tier with %s', (_label, plan) => {
    expect(limitsInForce(tiers, plan).map((q) => q.requests)).toEqual([
      30, 20, 50,
    ]);
    expect(fallbackWindow(tiers, plan)).toBe(3600);
  });

  it.each([
    ['an empty list', []],
    ['not a list', { plans: ['FREE'] }],
    ['a tier without plans', [{ requests: 1, window: window(1) }]],
    ['empty plans', [{ plans: [], requests: 1, window: window(1) }]],
    ['an empty plan name', [{ plans: [''], requests: 1, window: window(1) }]],
    [
      'a plan in two tiers',
      [
        { plans: ['A'], requests: 1, window: window(1) },
        { plans: ['A', 'B'], requests: 2, window: window(60) },
      ],
    ],
    ['a tier without requests', [{ plans: ['A'], window: window(1) }]],
    [
      'a fractional request count',
      [{ plans: ['A'], requests: 1.5, window: window(1) }],
    ],
    ['a window without seconds', [{ plans: ['A'], requests: 1, window: {} }]],
  ])('reads nothing from %s: the binding tier cannot be known', (_l, tiers) => {
    expect(parseTiers(tiers)).toBeUndefined();
  });
});

describe('declaredThrottling with plan tiers', () => {
  it('without a plan: every tier in tieredQuotas, the longest window', () => {
    const declaration = declaredThrottling(doc())!;
    expect(declaration.quotas.has('workspace')).toBe(false);
    expect(
      declaration
        .tieredQuotas!.get('workspace')
        ?.map((q) => [q.requests, q.seconds]),
    ).toEqual([
      [30, 3600],
      [20, 1],
      [50, 1],
    ]);
    expect(declaration.windows.get('workspace')).toBe(3600);
  });

  it('with a plan: its tier, as a plain limit', () => {
    const declaration = declaredThrottling(doc(), 'ENTERPRISE')!;
    expect(declaration.tieredQuotas!.size).toBe(0);
    expect(declaration.quotas.get('workspace')).toMatchObject({
      requests: 50,
      seconds: 1,
    });
    expect(declaration.windows.get('workspace')).toBe(1);
  });

  it('leaves out a limit whose tiers do not all parse', () => {
    const declaration = declaredThrottling(
      doc(throttling([...clockifyTiers, { plans: ['X'] }])),
    )!;
    expect(declaration.windows.has('workspace')).toBe(false);
    expect(declaration.quotas.has('workspace')).toBe(false);
    expect(declaration.tieredQuotas!.has('workspace')).toBe(false);
  });

  it('leaves a plain limit as before, whatever the plan', () => {
    const declaration = declaredThrottling(
      doc({
        limits: { api: { requests: 100, window: window(60) } },
        applies: ['api'],
      }),
      'ENTERPRISE',
    )!;
    expect(declaration.tieredQuotas!.size).toBe(0);
    expect(declaration.quotas.get('api')).toMatchObject({
      requests: 100,
      seconds: 60,
    });
  });

  it("falls back to the plan's tier's window, else the longest, on a time-less quotaExhausted", () => {
    const receivedAt = Date.parse('2026-10-13T00:00:00Z');
    const retryAt = (plan?: string): number | undefined =>
      classifyThrottling(declaredThrottling(doc(), plan), {
        status: 429,
        headers: {},
        receivedAt,
      })?.retryAt;
    expect(retryAt()).toBe(receivedAt + 3_600_000);
    expect(retryAt('TRIAL')).toBe(receivedAt + 1_000);
  });
});

describe('pacing without a plan keeps within every tier at once', () => {
  // 30 per hour and 2 per second: at a fraction of 0.8, 24 per hour and 1
  // per second. The hourly tier alone (the lower average rate) would allow
  // a burst of 24 in one second, which the per-second tier refuses.
  const tiers = parseTiers([
    { plans: ['FREE'], requests: 30, window: window(3600) },
    { plans: ['PRO'], requests: 2, window: window(1) },
  ])!;

  it('refuses the burst the long-window tier alone would allow', () => {
    const pacer = new Pacer(
      new Map(),
      0.8,
      new Map([['workspace', limitsInForce(tiers)]]),
    );
    pacer.take(['workspace'], 0);
    // The hourly tier has room for 23 more; the per-second one has none.
    expect(pacer.delay(['workspace'], 0)).toBe(1000);
    const longOnly = new Pacer(
      new Map([['workspace', limitsInForce(tiers, 'FREE')[0]!]]),
    );
    longOnly.take(['workspace'], 0);
    expect(longOnly.delay(['workspace'], 0)).toBe(0);
  });

  it('and the average the short tier alone would exceed', () => {
    const pacer = new Pacer(
      new Map(),
      0.8,
      new Map([['workspace', limitsInForce(tiers)]]),
    );
    // One a second, as the per-second tier allows: the 25th in the hour
    // waits for the first to leave the hourly window.
    for (let i = 0; i < 24; i++) {
      expect(pacer.delay(['workspace'], i * 1000)).toBe(0);
      pacer.take(['workspace'], i * 1000);
    }
    expect(pacer.delay(['workspace'], 24_000)).toBe(3_600_000 - 24_000);
  });

  it('through the client: a second read waits a second without a plan, and not with the plan of a roomy tier', async () => {
    const declared = throttling([
      { plans: ['FREE'], requests: 30, window: window(3600) },
      { plans: ['PRO'], requests: 2, window: window(1) },
      { plans: ['ENTERPRISE'], requests: 100, window: window(1) },
    ]);
    const transport = async (): Promise<TransportResponse> => ({
      status: 200,
      headers: {},
      body: JSON.stringify([{ id: '1', name: 'Rex' }]),
    });
    const slept: number[] = [];
    const strict = createApiClient(doc(declared), {
      transport,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await strict.sync();
    await strict.sync();
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(900);
    expect(slept[0]).toBeLessThanOrEqual(1000);

    const waited: number[] = [];
    const roomy = createApiClient(doc(declared), {
      transport,
      throttlingPlan: 'ENTERPRISE',
      sleep: async (ms) => {
        waited.push(ms);
      },
    });
    for (let i = 0; i < 5; i++) await roomy.sync();
    expect(waited).toEqual([]);
  });
});
