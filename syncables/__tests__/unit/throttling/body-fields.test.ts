// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  classifyThrottling,
  declaredThrottling,
  type OpenApiDocument,
  type ThrottlingVerdict,
} from '../../../src/browser.js';
import {
  bodyFieldsExample,
  todoistThrottling,
} from '../../fixtures/throttling.js';

// Throttling 0.3.0-draft `bodyFields`: the cases mirror `BodyFieldTests`
// and `BodyFieldFollowUpTests` in
// `openapi-extensions/spec/throttling/test_validate.py` (with #463's
// follow-up rules), and `overlays/tests/test_todoist_throttling.py` for the
// held Todoist overlay. Times are milliseconds here, seconds there.

const NOW = Date.parse('Fri, 15 Jan 2027 08:00:00 GMT');
const s = (seconds: number): number => NOW + seconds * 1000;

/** A document with only this root `x-throttling`. */
const withThrottling = (throttling: unknown): OpenApiDocument =>
  ({ openapi: '3.0.3', paths: {}, 'x-throttling': throttling }) as never;

/** The spec tests' `BodyFieldTests.document()`. */
const document = (): OpenApiDocument =>
  withThrottling({
    bodyFields: {
      'error_extra.retry_after': { role: 'retryAfter', unit: 'deltaSeconds' },
    },
  });

/** The spec's body-fields example, with a `minDelaySeconds` when given. */
const example = (minDelay?: number): OpenApiDocument => {
  const doc = structuredClone(bodyFieldsExample);
  if (minDelay !== undefined)
    (
      (doc['x-throttling'] as Record<string, unknown>)['signals'] as Record<
        string,
        unknown
      >[]
    )[0]!['minDelaySeconds'] = minDelay;
  return doc;
};

function classify(
  doc: OpenApiDocument,
  status: number,
  headers: Record<string, string>,
  body: unknown,
): ThrottlingVerdict | undefined {
  const verdict = classifyThrottling(declaredThrottling(doc), {
    status,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    receivedAt: NOW,
  });
  if (verdict) delete verdict.signal;
  return verdict;
}

describe('bodyFields (BodyFieldTests)', () => {
  it('reads the declaration, and leaves out an entry that does not parse', () => {
    expect([...declaredThrottling(document())!.bodyFields.keys()]).toEqual([
      'error_extra.retry_after',
    ]);
    const mixed = declaredThrottling(
      withThrottling({
        bodyFields: {
          'error_extra.retry_after': {
            role: 'retryAfter',
            unit: 'deltaSeconds',
          },
          other: { role: 'retryAfter', unit: 'deltaSeconds' }, // role taken
          noUnit: { role: 'reset' },
          wait: { role: 'wait', unit: 'deltaSeconds' },
          // Body paths are case-sensitive: another name, another role.
          'Error_extra.limit': { role: 'limit' },
        },
      }),
    )!;
    expect([...mixed.bodyFields.keys()]).toEqual([
      'error_extra.retry_after',
      'Error_extra.limit',
    ]);
  });

  it('test_retry_after_from_the_body', () => {
    const body: {
      error: string;
      http_code: number;
      error_extra: Record<string, unknown>;
    } = {
      error: 'Too many requests',
      http_code: 429,
      error_extra: { retry_after: 3, event_id: 'x' },
    };
    expect(classify(document(), 429, {}, body)).toEqual({
      meaning: 'throttled',
      retryAt: s(3),
    });
    // A string digit sequence parses too; booleans, floats and objects do not.
    body.error_extra['retry_after'] = '7';
    expect(classify(document(), 429, {}, body)!.retryAt).toBe(s(7));
    for (const value of [true, 3.5, { s: 3 }, null]) {
      body.error_extra['retry_after'] = value;
      expect(classify(document(), 429, {}, body)!.retryAt).toBeUndefined();
    }
    // A non-throttling response's body field says nothing.
    body.error_extra['retry_after'] = 3;
    expect(classify(document(), 404, {}, body)).toBeUndefined();
  });

  it('test_header_and_body_for_one_role', () => {
    const both = withThrottling({
      headers: {
        'Retry-After': { role: 'retryAfter', unit: 'deltaSecondsOrHttpDate' },
      },
      bodyFields: {
        'error_extra.retry_after': {
          role: 'retryAfter',
          unit: 'deltaSeconds',
        },
      },
    });
    const body = { error_extra: { retry_after: 3 } };
    // The later time.
    expect(classify(both, 429, { 'Retry-After': '10' }, body)!.retryAt).toBe(
      s(10),
    );
    expect(classify(both, 429, { 'Retry-After': '1' }, body)!.retryAt).toBe(
      s(3),
    );
    // remaining: either value at 0 means exhausted.
    const remaining = withThrottling({
      headers: {
        'X-Remaining': { role: 'remaining' },
        'X-Reset': { role: 'reset', unit: 'deltaSeconds' },
      },
      bodyFields: { remaining: { role: 'remaining' } },
    });
    const h = (r: string): Record<string, string> => ({
      'X-Remaining': r,
      'X-Reset': '60',
    });
    expect(classify(remaining, 429, h('5'), { remaining: 0 })!.retryAt).toBe(
      s(60),
    );
    expect(
      classify(remaining, 429, h('5'), { remaining: 2 })!.retryAt,
    ).toBeUndefined();
    expect(classify(remaining, 429, h('x'), { remaining: 0 })!.retryAt).toBe(
      s(60),
    );
  });
});

describe('bodyFields follow-up rules (BodyFieldFollowUpTests, #463)', () => {
  it('test_example_is_valid: the example declares one body field and one signal', () => {
    const declaration = declaredThrottling(example())!;
    expect([...declaration.bodyFields.keys()]).toEqual([
      'error_extra.retry_after',
    ]);
    expect(declaration.signals).toHaveLength(1);
  });

  it.each(['a..b', '.a', 'a.'])(
    'test_invalid_dot_paths: %s is left out',
    (path) => {
      const declaration = declaredThrottling(
        withThrottling({
          bodyFields: { [path]: { role: 'retryAfter', unit: 'deltaSeconds' } },
          signals: [{ status: [429], meaning: 'throttled' }],
        }),
      )!;
      expect(declaration.bodyFields.size).toBe(0);
    },
  );

  it('matches a dot-path literally: a name holding a dot cannot be addressed', () => {
    const doc = example();
    expect(
      classify(doc, 429, {}, { 'error_extra.retry_after': 3 })!.retryAt,
    ).toBeUndefined();
    expect(
      classify(doc, 429, {}, { error_extra: { retry_after: 3 } })!.retryAt,
    ).toBe(s(3));
  });

  it.each([
    [' 3 ', s(3)],
    [3.0, s(3)],
    [3.5, undefined],
    [-1.0, undefined],
    ['', undefined],
  ] as [unknown, number | undefined][])(
    'test_text_forms: %j',
    (value, expected) => {
      const body = { error_extra: { retry_after: value } };
      expect(classify(example(), 429, {}, body)!.retryAt).toBe(expected);
    },
  );

  it('test_a_zero_body_wait_does_not_suppress_the_fallback', () => {
    const zero = { error_extra: { retry_after: 0 } };
    expect(classify(example(30), 429, {}, zero)!.retryAt).toBe(s(30));
    expect(classify(example(), 429, {}, zero)!.retryAt).toBeUndefined();
    // A positive body wait shorter than minDelaySeconds is used as it is:
    // a fallback, not a floor.
    const five = { error_extra: { retry_after: 5 } };
    expect(classify(example(30), 429, {}, five)!.retryAt).toBe(s(5));
  });

  it('a header that gives no wait still counts: only a body field of no wait is absent', () => {
    const both = withThrottling({
      headers: { 'X-Wait': { role: 'retryAfter', unit: 'deltaSeconds' } },
      signals: [{ status: [429], meaning: 'throttled', minDelaySeconds: 30 }],
    });
    expect(classify(both, 429, { 'X-Wait': '0' }, undefined)!.retryAt).toBe(
      s(0),
    );
  });
});

describe('the held Todoist overlay (test_todoist_throttling.py)', () => {
  const todoist = withThrottling(todoistThrottling);

  it('test_429_with_documented_error_body', () => {
    const body: { error_extra: Record<string, unknown> } & Record<
      string,
      unknown
    > = {
      error: 'Too many requests',
      error_code: 429,
      error_tag: 'TOO_MANY_REQUESTS',
      http_code: 429,
      error_extra: { retry_after: 3, event_id: 'x' },
    };
    expect(classify(todoist, 429, {}, body)).toEqual({
      meaning: 'throttled',
      retryAt: s(3),
    });
    delete body.error_extra['retry_after'];
    // The consumer's own backoff.
    expect(classify(todoist, 429, {}, body)!.retryAt).toBeUndefined();
    body.error_extra['retry_after'] = 0;
    // A zero body wait counts as absent.
    expect(classify(todoist, 429, {}, body)!.retryAt).toBeUndefined();
  });

  it('test_retry_after_on_other_errors_is_not_throttling', () => {
    // The documented 404 example carries retry_after too; it is not a rate limit.
    const body = {
      error: 'Task not found',
      error_code: 478,
      error_extra: { event_id: 'x', retry_after: 3 },
      error_tag: 'NOT_FOUND',
      http_code: 404,
    };
    expect(classify(todoist, 404, {}, body)).toBeUndefined();
    expect(classify(todoist, 403, {}, body)).toBeUndefined();
  });

  it('a body that is not JSON gives no body value', () => {
    const verdict = classifyThrottling(declaredThrottling(todoist), {
      status: 429,
      headers: {},
      body: 'Too many requests',
      receivedAt: NOW,
    });
    expect(verdict?.retryAt).toBeUndefined();
  });
});

describe('number bounds and stripped characters (Throttling follow-up)', () => {
  const MAX = Number.MAX_SAFE_INTEGER; // 2^53 − 1

  // Raw JSON text, as a provider sends it: a literal above 2^53 − 1 loses
  // precision when parsed and must not be read as a nearby integer.
  it.each([
    ['1e21', '1e21'],
    ['1e21 written out', '1000000000000000000000'],
    ['2^53', '9007199254740992'],
    ['an integral float above 2^53 − 1', '9007199254740993.0'],
  ])('a body integer above 2^53 − 1 does not parse: %s', (_label, text) => {
    const verdict = classifyThrottling(declaredThrottling(example()), {
      status: 429,
      headers: {},
      body: `{"error_extra":{"retry_after":${text}}}`,
      receivedAt: NOW,
    });
    expect(verdict!.retryAt).toBeUndefined();
  });

  it('2^53 − 1 in the body parses', () => {
    const body = { error_extra: { retry_after: MAX } };
    expect(classify(example(), 429, {}, body)!.retryAt).toBe(NOW + MAX * 1000);
  });

  it.each([
    ['a space, tab, CR and LF', ' \t3\r\n', s(3)],
    ['a no-break space (U+00A0)', ' 3', undefined],
    ['a trailing U+00A0', '3 ', undefined],
    ['an em space (U+2003)', '3 ', undefined],
    ['a byte-order mark (U+FEFF)', '﻿3', undefined],
  ] as [string, string, number | undefined][])(
    'strips only space, tab, CR and LF from a body string: %s',
    (_label, value, expected) => {
      const body = { error_extra: { retry_after: value } };
      expect(classify(example(), 429, {}, body)!.retryAt).toBe(expected);
    },
  );
});
