// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { Pacer, type Quota } from '../../../src/throttling/pacing.js';
import { declaredThrottling } from '../../../src/throttling/throttling.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

// Pacing against announced quotas (pieces.md K2), with an explicit clock.

const T = Date.parse('2026-01-01T00:00:00Z');

function pacer(quotas: Record<string, Quota>, fraction?: number): Pacer {
  return new Pacer(new Map(Object.entries(quotas)), fraction);
}

/** Takes `n` requests at `at`, one ms apart. */
function fill(p: Pacer, buckets: string[], n: number, at: number): void {
  for (let i = 0; i < n; i++) p.take(buckets, at + i);
}

describe('Pacer', () => {
  it('allows the fraction of requests per sliding window, then waits for the oldest to leave', () => {
    const p = pacer({ b: { requests: 10, seconds: 60, kind: 'sliding' } });
    fill(p, ['b'], 8, T);
    expect(p.delay(['b'], T + 10)).toBe(60_000 - 10);
    // After the first one leaves the window, there is room again.
    expect(p.delay(['b'], T + 60_000)).toBe(0);
  });

  it('paces unspecified windows, and fixed ones without an anchor, as sliding', () => {
    for (const kind of ['unspecified', 'fixed'] as const) {
      const p = pacer({ b: { requests: 10, seconds: 60, kind } });
      fill(p, ['b'], 8, T + 59_000);
      // Not at the next minute boundary: the phase is unknown.
      expect(p.delay(['b'], T + 59_010)).toBe(59_000 + 60_000 - 59_010);
    }
  });

  it('paces a fixed window with an anchor by its boundaries', () => {
    const p = pacer({
      b: { requests: 10, seconds: 60, kind: 'fixed', anchor: T },
    });
    fill(p, ['b'], 8, T + 59_000);
    expect(p.delay(['b'], T + 59_010)).toBe(990);
    // The next window counts afresh.
    expect(p.delay(['b'], T + 60_000)).toBe(0);
  });

  it('waits for the fullest of several buckets, and ignores buckets without a quota', () => {
    const p = pacer({
      a: { requests: 100, seconds: 60, kind: 'sliding' },
      b: { requests: 5, seconds: 10, kind: 'sliding' },
    });
    fill(p, ['a', 'b', 'unknown'], 4, T);
    expect(p.delay(['a'], T + 5)).toBe(0);
    expect(p.delay(['a', 'b'], T + 5)).toBe(10_000 - 5);
    expect(p.delay(['unknown'], T + 5)).toBe(0);
  });

  it('allows at least one request per window', () => {
    const p = pacer({ b: { requests: 1, seconds: 1, kind: 'sliding' } });
    expect(p.allowed({ requests: 1, seconds: 1, kind: 'sliding' })).toBe(1);
    expect(p.delay(['b'], T)).toBe(0);
    p.take(['b'], T);
    expect(p.delay(['b'], T)).toBe(1000);
  });

  it('takes a fraction from 0 (exclusive) to 1', () => {
    const quotas = {
      b: { requests: 10, seconds: 1, kind: 'sliding' as const },
    };
    for (const bad of [0, -0.5, 1.5, Number.NaN])
      expect(() => pacer(quotas, bad)).toThrow(/paceFraction/);
    const all = pacer(quotas, 1);
    fill(all, ['b'], 9, T);
    expect(all.delay(['b'], T + 9)).toBe(0);
  });
});

describe('declaredThrottling quotas', () => {
  it('reads the spec example: requests, window kind and anchor; no quota without requests', () => {
    const declaration = declaredThrottling({
      openapi: '3.0.3',
      info: { title: 't', version: '1' },
      paths: {},
      'x-throttling': {
        limits: {
          ip: {
            requests: 120,
            window: {
              seconds: 60,
              kind: 'fixed',
              anchor: '2026-01-01T00:00:00Z',
            },
            partitionBy: ['sourceIp'],
          },
          user: {
            requests: 1000,
            window: { seconds: 3600, kind: 'sliding' },
            partitionBy: ['user'],
          },
          session: {
            window: { seconds: 60, kind: 'unspecified' },
            partitionBy: ['sourceIp', 'session'],
          },
          odd: { requests: 5, window: { seconds: 10, kind: 'leaky' } },
          badAnchor: {
            requests: 5,
            window: { seconds: 10, kind: 'fixed', anchor: 'soon' },
          },
        },
        applies: ['ip', 'user'],
      },
    } as unknown as OpenApiDocument);
    expect(Object.fromEntries(declaration!.quotas)).toEqual({
      ip: { requests: 120, seconds: 60, kind: 'fixed', anchor: T },
      user: { requests: 1000, seconds: 3600, kind: 'sliding' },
      odd: { requests: 5, seconds: 10, kind: 'sliding' },
      badAnchor: { requests: 5, seconds: 10, kind: 'fixed' },
    });
  });
});
