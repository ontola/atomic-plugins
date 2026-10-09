// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  WindowReadError,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
} from '../../../src/browser.js';
import { Budget, walkPages } from '../../../src/read/pages.js';

// PageWalk.windowValue: a rangeWindow read whose window parameter the API
// reads as wall-clock time in a zone (Filtering 0.2.0-draft x-time-zone,
// Clockify's start/end). Bounds are split as instants; only the values sent
// are converted. Invented data; the zone conversion here stands in for the
// one readCollections supplies.

const AMSTERDAM = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Amsterdam',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** A UTC `…Z` bound as Amsterdam wall-clock digits with a `Z`, as Clockify wants. */
function wallClock(bound: string): string {
  const parts = Object.fromEntries(
    AMSTERDAM.formatToParts(new Date(bound)).map((p) => [p.type, p.value]),
  );
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}Z`;
}

function document(scheme: PaginationSchemeObject): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Zoned windows', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/entries': {
        get: {
          parameters: [
            { name: 'start', in: 'query' },
            { name: 'end', in: 'query' },
            { name: 'span', in: 'query' },
          ],
          'x-pagination': [{ scheme: 'windows' }],
          responses: { '200': { description: 'Entries' } },
        },
      },
    },
    components: { paginationSchemes: { windows: scheme } },
  } as OpenApiDocument;
}

const pair = (cap: number): PaginationSchemeObject => ({
  type: 'rangeWindow',
  autoDetect: false,
  window: { unit: 'second', format: 'dateTime', bounds: 'halfOpen', cap },
  request: {
    queryParameters: {
      start: { role: 'windowStart' },
      end: { role: 'windowEnd' },
    },
  },
});

async function walk(
  scheme: PaginationSchemeObject,
  range: { start: string; end: string },
  answer: (query: URLSearchParams) => unknown[],
  windowValue?: (parameter: string, bound: string) => string,
): Promise<{ queries: URLSearchParams[]; items: unknown[] }> {
  const queries: URLSearchParams[] = [];
  const transport: Transport = (request) => {
    queries.push(request.url.searchParams);
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(answer(request.url.searchParams)),
    });
  };
  const doc = document(scheme);
  const items: unknown[] = [];
  for await (const page of walkPages({
    document: doc,
    operation: doc.paths['/entries']!.get!,
    budget: new Budget(transport),
    upstream: new URL('https://api.example.com/v1'),
    path: '/entries',
    method: 'GET',
    query: {},
    body: {},
    range,
    ...(windowValue ? { windowValue } : {}),
  }))
    items.push(...page.items);
  return { queries, items };
}

const JANUARY = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:10Z' };

describe('PageWalk.windowValue', () => {
  it('converts each window bound, and each half of a full window', async () => {
    let calls = 0;
    const { queries } = await walk(
      pair(2),
      JANUARY,
      () => {
        calls += 1;
        return calls === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: `c${calls}` }];
      },
      (_, bound) => wallClock(bound),
    );
    expect(queries.map((q) => [q.get('start'), q.get('end')])).toEqual([
      ['2026-01-01T01:00:00Z', '2026-01-01T01:00:10Z'],
      ['2026-01-01T01:00:00Z', '2026-01-01T01:00:05Z'],
      // Adjacent windows send the same digits at their shared bound.
      ['2026-01-01T01:00:05Z', '2026-01-01T01:00:10Z'],
    ]);
  });

  it('leaves a parameter the hook does not convert as it is', async () => {
    const { queries } = await walk(pair(10), JANUARY, () => [], (name, bound) =>
      name === 'start' ? wallClock(bound) : bound,
    );
    expect([queries[0]!.get('start'), queries[0]!.get('end')]).toEqual([
      '2026-01-01T01:00:00Z',
      '2026-01-01T00:00:10Z',
    ]);
  });

  it('converts each bound before a windowRange template is filled', async () => {
    const scheme: PaginationSchemeObject = {
      ...pair(10),
      request: {
        queryParameters: {
          span: { role: 'windowRange', template: '{start}/{end}' },
        },
      },
    };
    const { queries } = await walk(scheme, JANUARY, () => [], (_, bound) =>
      wallClock(bound),
    );
    expect(queries[0]!.get('span')).toBe(
      '2026-01-01T01:00:00Z/2026-01-01T01:00:10Z',
    );
  });

  it('ends with WindowReadError for a window inside a repeated hour', async () => {
    // Amsterdam, 2026-10-25: 00:40Z is 02:40 (CEST), 01:20Z is 02:20 (CET).
    await expect(
      walk(
        pair(10),
        { start: '2026-10-25T00:40:00Z', end: '2026-10-25T01:20:00Z' },
        () => [],
        (_, bound) => wallClock(bound),
      ),
    ).rejects.toThrow(WindowReadError);
  });

  it('splits and converts a range across the skipped hour', async () => {
    let calls = 0;
    const { queries } = await walk(
      pair(2),
      { start: '2026-03-29T00:00:00Z', end: '2026-03-29T02:00:00Z' },
      () => {
        calls += 1;
        return calls === 1 ? [{ id: 'a' }, { id: 'b' }] : [];
      },
      (_, bound) => wallClock(bound),
    );
    expect(queries.map((q) => [q.get('start'), q.get('end')])).toEqual([
      ['2026-03-29T01:00:00Z', '2026-03-29T04:00:00Z'],
      ['2026-03-29T01:00:00Z', '2026-03-29T03:00:00Z'],
      ['2026-03-29T03:00:00Z', '2026-03-29T04:00:00Z'],
    ]);
  });

  it('sends the bounds unchanged without a hook', async () => {
    const { queries } = await walk(pair(10), JANUARY, () => []);
    expect([queries[0]!.get('start'), queries[0]!.get('end')]).toEqual([
      JANUARY.start,
      JANUARY.end,
    ]);
  });
});
