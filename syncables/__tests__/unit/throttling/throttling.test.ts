// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  classifyThrottling,
  declaredThrottling,
  headerTime,
  operationBuckets,
  type OpenApiDocument,
  type ThrottlingVerdict,
} from '../../../src/browser.js';
import { responseSignals } from '../../fixtures/throttling.js';

// Throttling 0.2.0-draft: `headers`, `signals` and the earliest retry time.
// The cases mirror `ClassifyTests` in
// `openapi-extensions/spec/throttling/test_validate.py`, on the spec's
// synthetic example document. Times are milliseconds here, seconds there.

/** The spec tests' NOW: the `Date` header of its HTTP-date case. */
const NOW = Date.parse('Fri, 15 Jan 2027 08:00:00 GMT');
const s = (seconds: number): number => NOW + seconds * 1000;
const epoch = (seconds: number): string => String(NOW / 1000 + seconds);

const declaration = declaredThrottling(responseSignals);

function classify(
  status: number,
  headers: Record<string, string> = {},
  body?: unknown,
  document: OpenApiDocument = responseSignals,
): ThrottlingVerdict | undefined {
  const verdict = classifyThrottling(declaredThrottling(document), {
    status,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    receivedAt: NOW,
  });
  if (verdict) delete verdict.signal;
  return verdict;
}

/** `responseSignals` with its signals replaced (or removed with `undefined`). */
function withSignals(signals: unknown): OpenApiDocument {
  const doc = structuredClone(responseSignals);
  const root = doc['x-throttling'] as Record<string, unknown>;
  if (signals === undefined) delete root['signals'];
  else root['signals'] = signals;
  return doc;
}

describe('classifyThrottling, after the spec tests', () => {
  it('primary limit waits for reset', () => {
    expect(
      classify(403, {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': epoch(900),
      }),
    ).toEqual({ meaning: 'quotaExhausted', bucket: 'core', retryAt: s(900) });
  });

  it('retry-after and reset take the later', () => {
    const headers = {
      'x-ratelimit-remaining': '0',
      'retry-after': '120',
    };
    expect(
      classify(429, { ...headers, 'x-ratelimit-reset': epoch(30) })?.retryAt,
    ).toBe(s(120));
    expect(
      classify(429, { ...headers, 'x-ratelimit-reset': epoch(300) })?.retryAt,
    ).toBe(s(300));
  });

  it('reset is ignored while requests remain', () => {
    expect(
      classify(403, {
        'x-ratelimit-remaining': '17',
        'x-ratelimit-reset': epoch(900),
        'retry-after': '5',
      }),
    ).toEqual({ meaning: 'throttled', retryAt: s(5) });
  });

  it('an HTTP-date is measured against the Date header', () => {
    expect(
      classify(429, {
        'retry-after': 'Fri, 15 Jan 2027 08:01:00 GMT',
        date: 'Fri, 15 Jan 2027 08:00:00 GMT',
      })?.retryAt,
    ).toBe(s(60));
  });

  it('an unparseable header is ignored, not guessed', () => {
    expect(classify(429, { 'retry-after': 'soon' })).toEqual({
      meaning: 'throttled',
    });
  });

  it("finds Google's reason inside the error array", () => {
    const body = {
      error: {
        errors: [
          { domain: 'global', reason: 'other' },
          { domain: 'usageLimits', reason: 'userRateLimitExceeded' },
        ],
        code: 403,
      },
    };
    expect(classify(403, {}, body)?.meaning).toBe('throttled');
    body.error.errors[1]!.reason = 'insufficientPermissions';
    expect(classify(403, {}, body)).toBeUndefined();
  });

  it('matches the secondary-limit message case-insensitively, with the minimum delay', () => {
    expect(
      classify(
        403,
        {},
        {
          message: 'You have exceeded a Secondary Rate Limit. Please wait.',
        },
      ),
    ).toEqual({ meaning: 'throttled', retryAt: s(60) });
    expect(
      classify(403, {}, { message: 'Resource not accessible by integration' }),
    ).toBeUndefined();
    expect(
      classifyThrottling(declaration, {
        status: 403,
        headers: {},
        body: 'not json',
        receivedAt: NOW,
      }),
    ).toBeUndefined();
  });

  it('a 403 without a matching signal is not throttling, nor a 401 with Retry-After', () => {
    expect(classify(403, { 'x-ratelimit-remaining': '4999' })).toBeUndefined();
    expect(classify(401, { 'retry-after': '5' })).toBeUndefined();
  });

  it('a 429 is always throttling: with other signals, without signals, and the standard Retry-After counts', () => {
    const only403 = withSignals([{ status: [403], meaning: 'throttled' }]);
    expect(classify(429, {}, undefined, only403)?.meaning).toBe('throttled');
    const none = withSignals(undefined);
    expect(
      classify(429, { 'Retry-After': '7' }, undefined, none)?.retryAt,
    ).toBe(s(7));
    expect(
      classify(403, { 'Retry-After': '7' }, undefined, none),
    ).toBeUndefined();
    // No x-throttling at all: a 429 is still throttling, Retry-After still a time.
    expect(
      classifyThrottling(undefined, {
        status: 429,
        headers: { 'retry-after': '7' },
        receivedAt: NOW,
      }),
    ).toEqual({ meaning: 'throttled', retryAt: s(7) });
    expect(
      classifyThrottling(undefined, {
        status: 403,
        headers: {},
        receivedAt: NOW,
      }),
    ).toBeUndefined();
  });

  it('a wrong Date header never makes the retry earlier', () => {
    const headers = {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': epoch(900),
      date: 'Fri, 01 Jan 2100 00:00:00 GMT',
    };
    expect(classify(403, headers)?.retryAt).toBe(s(900));
    // A server clock 100 s behind ours moves the reset later, never earlier.
    headers.date = 'Fri, 15 Jan 2027 07:58:20 GMT';
    expect(classify(403, headers)?.retryAt).toBe(s(1000));
  });

  it('ignores huge and malformed numbers: the bucket window is then the floor', () => {
    for (const value of ['9'.repeat(5000), '-5', '5.5', '1e3', ''])
      expect(
        classify(429, {
          'retry-after': value,
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': value,
        }),
      ).toEqual({
        meaning: 'quotaExhausted',
        bucket: 'core',
        retryAt: s(3600),
      });
  });

  it('reads an obsolete HTTP-date without a zone as GMT', () => {
    expect(
      classify(429, { 'retry-after': 'Fri Jan 15 08:02:00 2027' })?.retryAt,
    ).toBe(s(120));
  });

  it('uses the window as the floor for quotaExhausted without times', () => {
    const doc = withSignals([
      { status: [429], meaning: 'quotaExhausted', bucket: 'core' },
    ]);
    expect(classify(429, {}, undefined, doc)?.retryAt).toBe(s(3600));
    expect(classify(429, { 'retry-after': '5' }, undefined, doc)?.retryAt).toBe(
      s(5),
    );
  });

  it('strips header values, and matches header names in any case', () => {
    expect(classify(403, { 'x-ratelimit-remaining': ' 0 ' })?.meaning).toBe(
      'quotaExhausted',
    );
    expect(classify(403, { 'X-RATELIMIT-REMAINING': '0' })?.meaning).toBe(
      'quotaExhausted',
    );
  });

  it('lets the first matching signal win', () => {
    // Remaining 0 and Retry-After: the quotaExhausted signal comes first.
    expect(
      classify(403, { 'x-ratelimit-remaining': '0', 'retry-after': '10' })
        ?.meaning,
    ).toBe('quotaExhausted');
  });

  it('reports the matching signal on the verdict', () => {
    const verdict = classifyThrottling(declaration, {
      status: 403,
      headers: { 'retry-after': '10' },
      receivedAt: NOW,
    });
    expect(verdict?.signal).toMatchObject({
      header: { name: 'retry-after', present: true },
    });
  });
});

describe('headerTime', () => {
  it('reads each unit, and refuses the others', () => {
    expect(headerTime('120', 'deltaSeconds', NOW)).toBe(s(120));
    expect(headerTime(epoch(5), 'epochSeconds', NOW)).toBe(s(5));
    expect(headerTime('Fri, 15 Jan 2027 08:00:30 GMT', 'httpDate', NOW)).toBe(
      s(30),
    );
    expect(headerTime('30', 'deltaSecondsOrHttpDate', NOW)).toBe(s(30));
    expect(
      headerTime(
        'Fri, 15 Jan 2027 08:00:30 GMT',
        'deltaSecondsOrHttpDate',
        NOW,
      ),
    ).toBe(s(30));
    expect(
      headerTime('Fri, 15 Jan 2027 08:00:30 GMT', 'deltaSeconds', NOW),
    ).toBe(undefined);
    expect(headerTime('120', 'httpDate', NOW)).toBeUndefined();
    expect(headerTime('120', 'epochSeconds', NOW)).toBe(120_000);
  });

  it('takes the later of the two clocks for an absolute time', () => {
    const date = 'Fri, 15 Jan 2027 07:59:00 GMT'; // the server is 60 s behind
    expect(headerTime(epoch(100), 'epochSeconds', NOW, date)).toBe(s(160));
    expect(
      headerTime(
        epoch(100),
        'epochSeconds',
        NOW,
        'Fri, 15 Jan 2027 08:05:00 GMT',
      ),
    ).toBe(s(100));
    expect(headerTime(epoch(100), 'epochSeconds', NOW, 'yesterday')).toBe(
      s(100),
    );
  });
});

describe('declaredThrottling', () => {
  it('reads the example: windows, applies, header roles by lower-cased name, signals in order', () => {
    expect(declaration).toMatchObject({
      windows: new Map([['core', 3600]]),
      applies: ['core'],
    });
    expect([...declaration!.headers.keys()]).toEqual([
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-used',
      'x-ratelimit-reset',
      'retry-after',
    ]);
    expect(declaration!.signals).toHaveLength(4);
  });

  it('returns undefined without x-throttling, and no signals when none are declared', () => {
    expect(declaredThrottling({ openapi: '3.0.3', paths: {} } as never)).toBe(
      undefined,
    );
    expect(declaredThrottling(withSignals(undefined))?.signals).toBeUndefined();
  });

  it('drops a header entry that does not parse, and the whole signals array when one object does not', () => {
    const doc = structuredClone(responseSignals);
    const root = doc['x-throttling'] as Record<string, unknown>;
    root['headers'] = {
      'x-ratelimit-reset': { role: 'reset' }, // a timed role needs a unit
      'x-ratelimit-limit': { role: 'limit', unit: 'deltaSeconds' }, // a unit on a counter
      'x-ratelimit-used': { role: 'count' }, // an unknown role
      'retry-after': { role: 'retryAfter', unit: 'deltaSeconds' },
      'Retry-After': { role: 'remaining' }, // a name already taken (case-insensitive)
    };
    root['signals'] = [
      { status: [429], meaning: 'throttled' },
      {
        status: [403],
        header: { name: 'x', equals: '1', present: true },
        meaning: 'throttled',
      },
    ];
    const parsed = declaredThrottling(doc)!;
    expect([...parsed.headers.entries()]).toEqual([
      ['retry-after', { role: 'retryAfter', unit: 'deltaSeconds' }],
    ]);
    expect(parsed.signals).toBeUndefined();
    // Without signals a 403 is not throttling, a 429 still is.
    expect(
      classify(403, { 'retry-after': '5' }, undefined, doc),
    ).toBeUndefined();
    expect(classify(429, {}, undefined, doc)?.meaning).toBe('throttled');
  });

  it("selects an operation's own x-throttling buckets, else the root's applies", () => {
    expect(operationBuckets(declaration!, { responses: {} })).toEqual(['core']);
    expect(
      operationBuckets(declaration!, {
        responses: {},
        'x-throttling': ['core', 'exports'],
      }),
    ).toEqual(['core', 'exports']);
    expect(
      operationBuckets(declaration!, { responses: {}, 'x-throttling': [] }),
    ).toEqual([]);
    expect(operationBuckets(declaration!, undefined)).toEqual(['core']);
  });
});
