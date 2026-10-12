// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  readCollections,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';

// readCollections wires PageWalk.windowValue to the zone reader: a
// rangeWindow read (Pagination Schemes 0.5.0) whose window fields name
// x-time-zone parameters (Filtering 0.2.0-draft), shaped like Clockify's
// time entries. Invented users, zones and entries.

const ZONE = {
  interpretation: 'wallClock',
  zone: { operationId: 'getUser', pointer: '/settings/timeZone' },
  suffix: 'Z',
};

function document(
  options: {
    format?: string;
    zonedEnd?: boolean;
    endFilter?: boolean;
    windowRange?: boolean;
  } = {},
): OpenApiDocument {
  const zone = ZONE;
  const parameters = options.windowRange
    ? [
        {
          name: 'range',
          in: 'query',
          schema: { type: 'string' },
          'x-time-zone': zone,
        },
      ]
    : [
        {
          name: 'start',
          in: 'query',
          schema: { type: 'string', format: 'date-time' },
          'x-filter': { field: '/start', operator: 'gte' },
          'x-time-zone': zone,
        },
        {
          name: 'end',
          in: 'query',
          schema: { type: 'string', format: 'date-time' },
          ...(options.endFilter === false
            ? {}
            : { 'x-filter': { field: '/start', operator: 'lt' } }),
          ...(options.zonedEnd === false ? {} : { 'x-time-zone': zone }),
        },
      ];
  const queryParameters = options.windowRange
    ? { range: { role: 'windowRange', template: '{start}..{end}' } }
    : { start: { role: 'windowStart' }, end: { role: 'windowEnd' } };
  return {
    openapi: '3.0.3',
    info: { title: 'Zoned windows', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/user': {
        get: {
          operationId: 'getUser',
          responses: { '200': { description: 'The user' } },
        },
      },
      '/entries': {
        get: {
          parameters,
          'x-pagination': [{ scheme: 'windows' }],
          responses: { '200': { description: 'Entries' } },
        },
      },
      '/entries/{id}': {
        get: { responses: { '200': { description: 'One entry' } } },
      },
    },
    components: {
      paginationSchemes: {
        windows: {
          type: 'rangeWindow',
          autoDetect: false,
          window: {
            unit: options.format === 'date' ? 'day' : 'second',
            format: options.format ?? 'dateTime',
            bounds: 'halfOpen',
            cap: 2,
          },
          request: { queryParameters },
        },
      },
      crudResources: {
        entry: {
          identity: {
            urlTemplate: '/entries/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: { entries: { urlTemplate: '/entries' } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

/** Answers /user with the zones in turn (null: 404) and /entries by call. */
function server(
  zones: (string | null)[],
  entries: (call: number) => unknown[],
): { transport: Transport; log: string[] } {
  const log: string[] = [];
  let users = 0;
  let calls = 0;
  const transport: Transport = (request) => {
    if (request.url.pathname === '/v1/user') {
      const zone = zones[Math.min(users, zones.length - 1)];
      users += 1;
      log.push('user');
      return Promise.resolve(
        zone === null
          ? { status: 404, headers: {}, body: '{}' }
          : {
              status: 200,
              headers: {},
              body: JSON.stringify({ settings: { timeZone: zone } }),
            },
      );
    }
    calls += 1;
    const params = request.url.searchParams;
    log.push(
      params.has('range')
        ? `entries ${params.get('range')}`
        : `entries ${params.get('start')} ${params.get('end')}`,
    );
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(entries(calls)),
    });
  };
  return { transport, log };
}

const RANGE = { start: '2026-01-01T00:00:00Z', end: '2026-01-01T00:00:10Z' };

async function read(
  doc: OpenApiDocument,
  transport: Transport,
): Promise<Awaited<ReturnType<typeof readCollections>>> {
  return readCollections(doc, {
    transport,
    constants: {},
    ranges: () => RANGE,
  });
}

describe('range windows over x-time-zone parameters', () => {
  it('sends every window in the zone, with one zone read before and one after', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], (call) =>
      call === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: `c${call}` }],
    );
    const result = await read(document(), transport);
    expect(result.errors).toEqual([]);
    expect(log).toEqual([
      'user',
      'entries 2026-01-01T01:00:00Z 2026-01-01T01:00:10Z',
      'entries 2026-01-01T01:00:00Z 2026-01-01T01:00:05Z',
      'entries 2026-01-01T01:00:05Z 2026-01-01T01:00:10Z',
      'user',
    ]);
    const [snapshot] = result.collections;
    expect(snapshot!.complete).toBe(false);
    // What the windows asked for together: the outer range, per x-filter
    // field, kept but marked incomplete (a windowed read is never complete).
    expect(snapshot!.coverage).toEqual({
      parameters: {
        start: '2026-01-01T01:00:00Z',
        end: '2026-01-01T01:00:10Z',
      },
      instants: {
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T00:00:10.000Z',
      },
      zones: { start: 'Europe/Amsterdam', end: 'Europe/Amsterdam' },
      spans: [
        {
          field: '/start',
          from: '2026-01-01T00:00:00.000Z',
          fromInclusive: true,
          to: '2026-01-01T00:00:10.000Z',
          toInclusive: false,
        },
      ],
      reason: 'incomplete',
    });
  });

  it('sends UTC digits for an unknown zone and narrows only the outer ends', async () => {
    const { transport, log } = server([null], () => []);
    const result = await readCollections(document(), {
      transport,
      constants: {},
      ranges: () => ({
        start: '2026-01-01T00:00:00Z',
        end: '2026-01-03T00:00:00Z',
      }),
    });
    expect(log[1]).toBe('entries 2026-01-01T00:00:00Z 2026-01-03T00:00:00Z');
    expect(result.collections[0]!.coverage).toMatchObject({
      zones: { start: null, end: null },
      spans: [
        {
          field: '/start',
          from: '2026-01-01T14:00:00.000Z',
          to: '2026-01-02T10:00:00.000Z',
        },
      ],
      reason: 'incomplete',
    });
  });

  it('refuses a window format other than dateTime on an x-time-zone parameter', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    const result = await readCollections(document({ format: 'date' }), {
      transport,
      constants: {},
      ranges: () => ({ start: '2026-01-01', end: '2026-01-31' }),
    });
    expect(result.errors[0]).toMatch(/needs format dateTime/);
    expect(log.filter((l) => l.startsWith('entries'))).toEqual([]);
  });

  it('reports zoneChanged when the zone differs after the read', async () => {
    const { transport } = server(
      ['Europe/Amsterdam', 'Europe/London'],
      () => [],
    );
    const result = await read(document(), transport);
    expect(result.collections[0]!.coverage).toMatchObject({
      spans: null,
      reason: 'zoneChanged',
    });
  });

  it('sends a window field without x-time-zone unchanged next to one with it', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    await read(document({ zonedEnd: false }), transport);
    expect(log[1]).toBe('entries 2026-01-01T01:00:00Z 2026-01-01T00:00:10Z');
  });

  it('gives a windowed read that failed no spans', async () => {
    // Every answer is full (cap 2): the one-second windows cannot be split.
    const { transport } = server(['Europe/Amsterdam'], (call) => [
      { id: `a${call}` },
      { id: `b${call}` },
    ]);
    const result = await read(document(), transport);
    expect(result.errors[0]).toMatch(/is too narrow to split/);
    expect(result.collections[0]!.coverage).toMatchObject({
      spans: null,
      reason: 'incomplete',
    });
  });

  it('counts another narrowing query value against the windows too', async () => {
    const doc = document();
    const entries = doc.paths['/entries']!.get!;
    entries.parameters = [
      ...(entries.parameters ?? []),
      { name: 'project', in: 'query', schema: { type: 'string' } },
    ];
    const { transport } = server(['Europe/Amsterdam'], () => []);
    const result = await readCollections(doc, {
      transport,
      constants: {},
      ranges: () => RANGE,
      selection: {
        query_overrides: [{ path: '/entries', values: { project: 'p1' } }],
      },
    });
    expect(result.collections[0]!.coverage).toMatchObject({
      spans: null,
      reason: 'otherFilters',
    });
  });

  it('sends a zoned windowRange parameter as wall-clock digits and gives noRangePredicate', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    const result = await read(document({ windowRange: true }), transport);
    expect(result.errors).toEqual([]);
    expect(log).toEqual([
      'user',
      'entries 2026-01-01T01:00:00Z..2026-01-01T01:00:10Z',
      'user',
    ]);
    expect(result.collections[0]!.coverage).toEqual({
      parameters: { range: '2026-01-01T01:00:00Z..2026-01-01T01:00:10Z' },
      instants: { range: '2026-01-01T00:00:00.000Z/2026-01-01T00:00:10.000Z' },
      zones: { range: 'Europe/Amsterdam' },
      spans: null,
      reason: 'noRangePredicate',
    });
  });

  it('counts a window field without x-time-zone or x-filter as another filter', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    const result = await read(
      document({ zonedEnd: false, endFilter: false }),
      transport,
    );
    expect(log[1]).toBe('entries 2026-01-01T01:00:00Z 2026-01-01T00:00:10Z');
    expect(result.collections[0]!.coverage).toMatchObject({
      parameters: { start: '2026-01-01T01:00:00Z' },
      spans: null,
      reason: 'otherFilters',
    });
  });

  it('sends the windows in order across the end of summer time', async () => {
    // Amsterdam 2026-10-25: 03:00 at +02:00 (01:00Z) becomes 02:00 at
    // +01:00, so 02:00..03:00 local is repeated. The range is 00:00..03:00
    // local; the first answer is full, so it splits at 00:00Z (02:00 local,
    // the first time).
    const { transport, log } = server(['Europe/Amsterdam'], (call) =>
      call === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: `c${call}` }],
    );
    const result = await readCollections(document(), {
      transport,
      constants: {},
      ranges: () => ({
        start: '2026-10-24T22:00:00Z',
        end: '2026-10-25T02:00:00Z',
      }),
    });
    expect(result.errors).toEqual([]);
    expect(log).toEqual([
      'user',
      'entries 2026-10-25T00:00:00Z 2026-10-25T03:00:00Z',
      'entries 2026-10-25T00:00:00Z 2026-10-25T02:00:00Z',
      'entries 2026-10-25T02:00:00Z 2026-10-25T03:00:00Z',
      'user',
    ]);
    expect(result.collections[0]!.coverage).toMatchObject({
      spans: [
        {
          field: '/start',
          from: '2026-10-24T22:00:00.000Z',
          to: '2026-10-25T02:00:00.000Z',
        },
      ],
      reason: 'incomplete',
    });
  });

  it('records the later instant for an outer start in the repeated hour', async () => {
    // 00:30Z is 02:30 at +02:00; 02:30 local also means 01:30Z (+01:00).
    // With ambiguous unspecified a lower bound covers from the later one
    // (Filtering x-time-zone, step 3).
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    const result = await readCollections(document(), {
      transport,
      constants: {},
      ranges: () => ({
        start: '2026-10-25T00:30:00Z',
        end: '2026-10-25T02:00:00Z',
      }),
    });
    expect(log[1]).toBe('entries 2026-10-25T02:30:00Z 2026-10-25T03:00:00Z');
    expect(result.collections[0]!.coverage).toMatchObject({
      instants: {
        start: '2026-10-25T00:30:00.000Z',
        end: '2026-10-25T02:00:00.000Z',
      },
      spans: [
        {
          field: '/start',
          from: '2026-10-25T01:30:00.000Z',
          fromInclusive: true,
          to: '2026-10-25T02:00:00.000Z',
          toInclusive: false,
        },
      ],
      reason: 'incomplete',
    });
  });
});

describe('x-time-zone coverage of a read that is not by windows', () => {
  /** pageNumber pages of size 2 whose short-page end is only observed. */
  function shortPages(): OpenApiDocument {
    return {
      openapi: '3.0.3',
      info: { title: 'Zoned short pages', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com/v1' }],
      paths: {
        '/user': {
          get: {
            operationId: 'getUser',
            responses: { '200': { description: 'The user' } },
          },
        },
        '/entries': {
          get: {
            parameters: [
              { name: 'page', in: 'query' },
              {
                name: 'since',
                in: 'query',
                schema: { type: 'string', format: 'date-time' },
                'x-filter': { field: '/start', operator: 'gte' },
                'x-time-zone': ZONE,
              },
            ],
            'x-pagination': [{ scheme: 'pages' }],
            responses: { '200': { description: 'Entries' } },
          },
        },
        '/entries/{id}': {
          get: { responses: { '200': { description: 'One entry' } } },
        },
      },
      components: {
        paginationSchemes: {
          pages: {
            type: 'pageNumber',
            autoDetect: false,
            request: { queryParameters: { page: { role: 'page' } } },
            response: { shortPage: { size: 2, assurance: 'observed' } },
          },
        },
        crudResources: {
          entry: {
            identity: {
              urlTemplate: '/entries/{id}',
              bindings: { id: { field: 'id' } },
            },
            collections: { entries: { urlTemplate: '/entries' } },
          },
        },
      },
    } as unknown as OpenApiDocument;
  }

  it('gives a read ended by an observed short page no spans', async () => {
    const { transport } = server(['Europe/Amsterdam'], (call) =>
      call === 1 ? [{ id: 'a' }, { id: 'b' }] : [{ id: 'c' }],
    );
    const result = await readCollections(shortPages(), {
      transport,
      constants: {},
      selection: {
        query_overrides: [
          { path: '/entries', values: { since: '2026-01-01T00:00:00Z' } },
        ],
      },
    });
    expect(result.errors).toEqual([]);
    const [snapshot] = result.collections;
    expect(snapshot!.complete).toBe(false);
    expect(snapshot!.notComplete).toMatch(/short page/);
    expect(snapshot!.coverage).toMatchObject({
      parameters: { since: '2026-01-01T01:00:00Z' },
      spans: null,
      reason: 'incomplete',
    });
  });
});
