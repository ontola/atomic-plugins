// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  coveredSpan,
  createApiClient,
  instantsOf,
  readCollections,
  wallClockParam,
  type OpenApiDocument,
  type QuerySelection,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';

// Filtering 0.2.0-draft `x-time-zone` (pieces.md K12, time-zone half). The
// conversions mirror `WallClockTests` in
// openapi-extensions/spec/filtering/test_validate.py; the reads use the
// shape of that folder's examples/wall-clock-zone.yaml with a CRUD
// Causality resource added. Documents, zones' users and entries are
// invented.

const AMS = 'Europe/Amsterdam';
const iso = (utc: string): string => new Date(`${utc}Z`).toISOString();

describe('wall-clock conversion (validate.py WallClockTests)', () => {
  it('writes the wall-clock digits with the suffix', () => {
    expect(wallClockParam('2026-01-15T09:30:00Z', AMS)).toBe(
      '2026-01-15T10:30:00Z',
    );
    expect(wallClockParam('2026-07-15T09:30:00Z', AMS)).toBe(
      '2026-07-15T11:30:00Z',
    );
    expect(
      wallClockParam('2026-07-15T09:30:00Z', 'America/New_York', '+00:00'),
    ).toBe('2026-07-15T05:30:00+00:00');
    expect(
      wallClockParam('2026-07-15T09:30:00Z', 'Pacific/Kiritimati', ''),
    ).toBe('2026-07-15T23:30:00');
    // An offset instant, and whole seconds (truncated).
    expect(wallClockParam('2026-01-15T10:30:00.900+01:00', AMS)).toBe(
      '2026-01-15T10:30:00Z',
    );
    // Unknown zone: the UTC digits.
    expect(wallClockParam('2026-01-15T09:30:00Z', null)).toBe(
      '2026-01-15T09:30:00Z',
    );
  });

  it('refuses a value without a Z or an offset', () => {
    expect(() => wallClockParam('2026-01-15T09:30:00', AMS)).toThrow(
      /not an instant/,
    );
  });

  it('covers ordinary bounds exactly, whatever ambiguous says', () => {
    const span = {
      from: iso('2025-12-31T23:00:00'),
      to: iso('2026-01-31T23:00:00'),
    };
    expect(
      coveredSpan('2026-01-01T00:00:00', '2026-02-01T00:00:00', AMS),
    ).toEqual(span);
    for (const ambiguous of ['earlier', 'later'] as const)
      expect(
        coveredSpan(
          '2026-01-01T00:00:00',
          '2026-02-01T00:00:00',
          AMS,
          ambiguous,
        ),
      ).toEqual(span);
  });

  it('reads a repeated hour by offset', () => {
    const wall = '2026-10-25T02:30:00';
    expect(instantsOf(wall, AMS)).toEqual({
      earlier: new Date(iso('2026-10-25T00:30:00')),
      later: new Date(iso('2026-10-25T01:30:00')),
    });
    const after = '2026-11-01T00:00:00';
    const before = '2026-10-01T00:00:00';
    expect(coveredSpan(wall, after, AMS)?.from).toBe(
      iso('2026-10-25T01:30:00'),
    );
    expect(coveredSpan(before, wall, AMS)?.to).toBe(iso('2026-10-25T00:30:00'));
    expect(coveredSpan(wall, after, AMS, 'earlier')?.from).toBe(
      iso('2026-10-25T00:30:00'),
    );
    expect(coveredSpan(wall, after, AMS, 'later')?.from).toBe(
      iso('2026-10-25T01:30:00'),
    );
  });

  it('reads a skipped hour by offset', () => {
    const wall = '2026-03-29T02:30:00';
    expect(instantsOf(wall, AMS)).toEqual({
      earlier: new Date(iso('2026-03-29T01:30:00')),
      later: new Date(iso('2026-03-29T00:30:00')),
    });
    const after = '2026-04-01T00:00:00';
    const before = '2026-03-01T00:00:00';
    expect(coveredSpan(wall, after, AMS, 'earlier')?.from).toBe(
      iso('2026-03-29T01:30:00'),
    );
    expect(coveredSpan(wall, after, AMS, 'later')?.from).toBe(
      iso('2026-03-29T00:30:00'),
    );
    expect(coveredSpan(before, wall, AMS, 'earlier')?.to).toBe(
      iso('2026-03-29T01:30:00'),
    );
    expect(coveredSpan(before, wall, AMS, 'later')?.to).toBe(
      iso('2026-03-29T00:30:00'),
    );
    expect(coveredSpan(wall, after, AMS)?.from).toBe(
      iso('2026-03-29T01:30:00'),
    );
    expect(coveredSpan(before, wall, AMS)?.to).toBe(iso('2026-03-29T00:30:00'));
  });

  it('is not fooled by a change a day away', () => {
    // The day before the repeated hour: one instant only.
    const instants = instantsOf('2026-10-24T12:00:00', AMS);
    expect(instants.earlier).toEqual(instants.later);
    expect(instants.earlier.toISOString()).toBe(iso('2026-10-24T10:00:00'));
  });

  it('narrows each bound by 14 hours when the zone is unknown', () => {
    expect(
      coveredSpan('2026-01-10T00:00:00', '2026-01-20T00:00:00', null),
    ).toEqual({
      from: iso('2026-01-10T14:00:00'),
      to: iso('2026-01-19T10:00:00'),
    });
  });

  it('covers nothing with an unknown zone and a window of 28 hours or less', () => {
    expect(
      coveredSpan('2026-01-10T00:00:00', '2026-01-11T03:59:59', null),
    ).toBeNull();
    expect(
      coveredSpan('2026-01-10T00:00:00', '2026-01-11T04:00:00', null),
    ).toBeNull();
    expect(
      coveredSpan('2026-01-10T00:00:00', '2026-01-11T04:00:01', null),
    ).not.toBeNull();
  });
});

const ENTRIES = '/workspaces/{workspaceId}/users/{userId}/entries';

/**
 * examples/wall-clock-zone.yaml with a CRUD Causality resource for the
 * entries. `zone` replaces the zone source of both bounds.
 */
function document(
  zone: Record<string, unknown> = {
    operationId: 'getCurrentUser',
    pointer: '/settings/timeZone',
  },
  extra: Record<string, unknown> = {},
): OpenApiDocument {
  const bound = (name: string, operator: string): Record<string, unknown> => ({
    name,
    in: 'query',
    schema: { type: 'string', format: 'date-time' },
    'x-filter': { field: '/timeInterval/start', operator },
    'x-time-zone': { interpretation: 'wallClock', zone, suffix: 'Z', ...extra },
  });
  return {
    openapi: '3.0.3',
    info: { title: 'Illustrative wall-clock list bounds', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v1' }],
    paths: {
      '/user': {
        get: {
          operationId: 'getCurrentUser',
          responses: { '200': { description: 'The user' } },
        },
      },
      '/workspaces/{workspaceId}/settings': {
        get: {
          operationId: 'getWorkspaceSettings',
          parameters: [
            {
              name: 'workspaceId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Settings' } },
        },
      },
      '/needs-a-key': {
        get: {
          operationId: 'needsAKey',
          parameters: [
            {
              name: 'key',
              in: 'query',
              required: true,
              schema: { type: 'string' },
            },
          ],
          responses: { '200': { description: 'Settings' } },
        },
      },
      [ENTRIES]: {
        get: {
          parameters: [
            {
              name: 'workspaceId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            {
              name: 'userId',
              in: 'path',
              required: true,
              schema: { type: 'string' },
            },
            { $ref: '#/components/parameters/Start' },
            { $ref: '#/components/parameters/End' },
          ],
          responses: { '200': { description: 'Entries in [start, end)' } },
        },
      },
      [`${ENTRIES}/{entryId}`]: {
        get: { responses: { '200': { description: 'An entry' } } },
      },
    },
    components: {
      parameters: { Start: bound('start', 'gte'), End: bound('end', 'lt') },
      crudResources: {
        entry: {
          identity: {
            urlTemplate: `${ENTRIES}/{entryId}`,
            bindings: { entryId: { field: 'id' } },
          },
          collections: { entries: { urlTemplate: ENTRIES } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const window = (start: string, end: string): QuerySelection => ({
  query_overrides: [{ path: ENTRIES, values: { start, end } }],
});

/**
 * A provider whose `GET /user` answers `zones` in turn (the last one
 * again once they run out; a number is a status) and whose entries list
 * answers one entry. Records every request.
 */
function provider(zones: (string | number)[]): {
  requests: TransportRequest[];
  transport: Transport;
} {
  const requests: TransportRequest[] = [];
  let at = 0;
  const transport: Transport = async (request) => {
    requests.push(request);
    const path = request.url.pathname;
    if (path.endsWith('/user') || path.endsWith('/settings')) {
      const zone = zones[Math.min(at, zones.length - 1)];
      at += 1;
      if (typeof zone === 'number')
        return { status: zone, headers: {}, body: '{}' };
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ id: 'u1', settings: { timeZone: zone } }),
      };
    }
    return {
      status: 200,
      headers: {},
      body: JSON.stringify([
        { id: 'e1', timeInterval: { start: '2026-01-15T09:00:00Z' } },
      ]),
    };
  };
  return { requests, transport };
}

const constants = { workspaceId: 'w1', userId: 'u1' };

async function read(
  zones: (string | number)[],
  selection: QuerySelection,
  doc = document(),
): Promise<{
  snapshot: Awaited<ReturnType<typeof readCollections>>['collections'][0];
  requests: TransportRequest[];
}> {
  const fake = provider(zones);
  const result = await readCollections(doc, {
    transport: fake.transport,
    constants,
    selection,
  });
  expect(result.errors).toEqual([]);
  return { snapshot: result.collections[0]!, requests: fake.requests };
}

const listed = (requests: TransportRequest[]): URL | undefined =>
  requests.find((r) => r.url.pathname.endsWith('/entries'))?.url;

describe('x-time-zone in a collection read', () => {
  it('reads the zone, sends the wall-clock digits plus the suffix, and records the span', async () => {
    const { snapshot, requests } = await read(
      [AMS],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    );
    const url = listed(requests)!;
    expect(url.searchParams.get('start')).toBe('2026-01-01T01:00:00Z');
    expect(url.searchParams.get('end')).toBe('2026-02-01T01:00:00Z');
    // Once before the list and once after it.
    expect(requests.map((r) => r.url.pathname)).toEqual([
      '/v1/user',
      '/v1/workspaces/w1/users/u1/entries',
      '/v1/user',
    ]);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.coverage).toEqual({
      parameters: {
        start: '2026-01-01T01:00:00Z',
        end: '2026-02-01T01:00:00Z',
      },
      instants: {
        start: iso('2026-01-01T00:00:00'),
        end: iso('2026-02-01T00:00:00'),
      },
      zones: { start: AMS, end: AMS },
      spans: [
        {
          field: '/timeInterval/start',
          from: iso('2026-01-01T00:00:00'),
          fromInclusive: true,
          to: iso('2026-02-01T00:00:00'),
          toInclusive: false,
        },
      ],
    });
  });

  it('reads the zone once per read for every request', async () => {
    const doc = document();
    const parent = doc.components!['crudResources'] as Record<string, unknown>;
    // Two users: one entries read each, under one zone read.
    parent['user'] = {
      identity: {
        urlTemplate: '/workspaces/{workspaceId}/users/{userId}',
        bindings: { userId: { field: 'id' } },
      },
      collections: {
        users: { urlTemplate: '/workspaces/{workspaceId}/users' },
      },
    };
    doc.paths['/workspaces/{workspaceId}/users'] = {
      get: { responses: { '200': { description: 'Users' } } },
    };
    doc.paths['/workspaces/{workspaceId}/users/{userId}'] = {
      get: { responses: { '200': { description: 'A user' } } },
    };
    const fake = provider([AMS]);
    const transport: Transport = async (request) =>
      request.url.pathname.endsWith('/users')
        ? (fake.requests.push(request),
          {
            status: 200,
            headers: {},
            body: JSON.stringify([{ id: 'u1' }, { id: 'u2' }]),
          })
        : fake.transport(request);
    const result = await readCollections(doc, {
      transport,
      constants: { workspaceId: 'w1' },
      selection: window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    });
    expect(result.errors).toEqual([]);
    expect(
      fake.requests.filter((r) => r.url.pathname === '/v1/user'),
    ).toHaveLength(2);
    const entries = result.collections.filter(
      (c) => c.collection.name === 'entries',
    );
    expect(entries).toHaveLength(2);
    for (const snapshot of entries)
      expect(snapshot.coverage?.spans).toEqual([
        {
          field: '/timeInterval/start',
          from: iso('2026-01-01T00:00:00'),
          fromInclusive: true,
          to: iso('2026-02-01T00:00:00'),
          toInclusive: false,
        },
      ]);
  });

  it('discards the span when the zone changed during the read', async () => {
    const { snapshot } = await read(
      [AMS, 'America/New_York'],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.coverage).toMatchObject({
      zones: { start: AMS, end: AMS },
      spans: null,
      reason: 'zoneChanged',
    });
  });

  it('discards the span when the zone cannot be read again', async () => {
    const { snapshot } = await read(
      [AMS, 503],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    );
    expect(snapshot.coverage).toMatchObject({
      spans: null,
      reason: 'zoneChanged',
    });
  });

  for (const [label, zones] of [
    ['an error status', [404]],
    ['a value that is not an IANA name', ['+01:00']],
    ['an unknown name', ['Mars/Olympus_Mons']],
    ['no value at the pointer', [{} as unknown as string]],
  ] as const)
    it(`sends UTC digits and narrows by 14 hours for ${label}`, async () => {
      const { snapshot, requests } = await read(
        [...zones],
        window('2026-01-10T00:00:00Z', '2026-01-20T00:00:00Z'),
      );
      expect(listed(requests)!.searchParams.get('start')).toBe(
        '2026-01-10T00:00:00Z',
      );
      expect(snapshot.coverage).toEqual({
        parameters: {
          start: '2026-01-10T00:00:00Z',
          end: '2026-01-20T00:00:00Z',
        },
        instants: {
          start: iso('2026-01-10T00:00:00'),
          end: iso('2026-01-20T00:00:00'),
        },
        zones: { start: null, end: null },
        spans: [
          {
            field: '/timeInterval/start',
            from: iso('2026-01-10T14:00:00'),
            fromInclusive: true,
            to: iso('2026-01-19T10:00:00'),
            toInclusive: false,
          },
        ],
      });
      // An unread zone is not read again after the list.
      expect(
        requests.filter((r) => r.url.pathname === '/v1/user'),
      ).toHaveLength(1);
    });

  it('covers nothing with an unknown zone and a one-day window', async () => {
    const { snapshot } = await read(
      [404],
      window('2026-01-10T00:00:00Z', '2026-01-11T00:00:00Z'),
    );
    expect(snapshot.complete).toBe(true);
    expect(snapshot.coverage).toMatchObject({ spans: null, reason: 'empty' });
  });

  it('binds the zone operation’s path parameters from the request', async () => {
    const { requests, snapshot } = await read(
      [AMS],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      document({
        operationId: 'getWorkspaceSettings',
        pointer: '/settings/timeZone',
      }),
    );
    expect(requests[0]!.url.pathname).toBe('/v1/workspaces/w1/settings');
    expect(snapshot.coverage?.zones).toEqual({ start: AMS, end: AMS });
  });

  it('treats a zone operation that needs a parameter the request lacks as unreadable', async () => {
    const { requests, snapshot } = await read(
      [AMS],
      window('2026-01-10T00:00:00Z', '2026-01-20T00:00:00Z'),
      document({ operationId: 'needsAKey', pointer: '/settings/timeZone' }),
    );
    expect(requests.map((r) => r.url.pathname)).toEqual([
      '/v1/workspaces/w1/users/u1/entries',
    ]);
    expect(snapshot.coverage?.zones).toEqual({ start: null, end: null });
  });

  it('uses a fixed zone name without a request, and its ambiguous offset', async () => {
    const { requests, snapshot } = await read(
      [],
      // 00:30Z is 02:30 in the repeated hour.
      window('2026-10-25T00:30:00Z', '2026-11-01T00:00:00Z'),
      document({ name: AMS }, { ambiguous: 'earlier' }),
    );
    expect(requests).toHaveLength(1);
    expect(listed(requests)!.searchParams.get('start')).toBe(
      '2026-10-25T02:30:00Z',
    );
    expect(snapshot.coverage?.spans?.[0]?.from).toBe(iso('2026-10-25T00:30:00'));
    // unspecified: the later instant for a lower bound.
    const plain = await read(
      [],
      window('2026-10-25T00:30:00Z', '2026-11-01T00:00:00Z'),
      document({ name: AMS }),
    );
    expect(plain.snapshot.coverage?.spans?.[0]?.from).toBe(
      iso('2026-10-25T01:30:00'),
    );
  });

  it('records no coverage without values, and refuses a value that is not an instant', async () => {
    const none = await read([AMS], { query_overrides: [] });
    expect(none.snapshot.coverage).toBeUndefined();
    expect(none.requests).toHaveLength(1);
    const fake = provider([AMS]);
    const result = await readCollections(document(), {
      transport: fake.transport,
      constants,
      selection: window('2026-01-01T00:00:00', '2026-02-01T00:00:00Z'),
    });
    expect(result.collections[0]!.complete).toBe(false);
    expect(result.errors[0]).toMatch(/not an instant/);
  });

  it('records noRangePredicate for a bound without a range x-filter', async () => {
    const doc = document();
    const start = (
      doc.components!['parameters'] as Record<string, Record<string, unknown>>
    )['Start']!;
    delete start['x-filter'];
    const { snapshot } = await read(
      [AMS],
      window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      doc,
    );
    expect(snapshot.coverage).toMatchObject({
      spans: null,
      reason: 'noRangePredicate',
    });
  });

  it('reports the coverage from a client sync', async () => {
    const fake = provider([AMS]);
    const client = createApiClient(document(), {
      transport: fake.transport,
      constants,
      selection: window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
    });
    const result = await client.sync();
    expect(result.coverage).toEqual([
      {
        collection: 'entries',
        context: constants,
        parameters: {
          start: '2026-01-01T01:00:00Z',
          end: '2026-02-01T01:00:00Z',
        },
        instants: {
          start: iso('2026-01-01T00:00:00'),
          end: iso('2026-02-01T00:00:00'),
        },
        zones: { start: AMS, end: AMS },
        spans: [
          {
            field: '/timeInterval/start',
            from: iso('2026-01-01T00:00:00'),
            fromInclusive: true,
            to: iso('2026-02-01T00:00:00'),
            toInclusive: false,
          },
        ],
      },
    ]);
  });

  it('gives one span per x-filter field, never merging bounds of different fields', async () => {
    const doc = document();
    const params = doc.components!['parameters'] as Record<
      string,
      Record<string, unknown>
    >;
    // `end` bounds another field, exclusively, and a third parameter bounds
    // the first field again, inclusively from above.
    params['End']!['x-filter'] = { field: '/updatedAt', operator: 'lt' };
    params['Until'] = {
      ...structuredClone(params['Start']!),
      name: 'until',
      'x-filter': { field: '/timeInterval/start', operator: 'lte' },
    };
    (
      doc.paths[ENTRIES]!.get!.parameters as unknown as Record<string, string>[]
    ).push({ $ref: '#/components/parameters/Until' });
    const { snapshot } = await read([AMS], {
      query_overrides: [
        {
          path: ENTRIES,
          values: {
            start: '2026-01-01T00:00:00Z',
            end: '2025-06-01T00:00:00Z',
            until: '2026-02-01T00:00:00Z',
          },
        },
      ],
    }, doc);
    // `end` is before `start`, but bounds another field: not empty.
    expect(snapshot.coverage?.spans).toEqual([
      {
        field: '/timeInterval/start',
        from: iso('2026-01-01T00:00:00'),
        fromInclusive: true,
        to: iso('2026-02-01T00:00:00'),
        toInclusive: true,
      },
      {
        field: '/updatedAt',
        to: iso('2025-06-01T00:00:00'),
        toInclusive: false,
      },
    ]);
  });

  it('reads no zone in probe mode', async () => {
    const fake = provider([AMS]);
    await readCollections(document(), {
      transport: fake.transport,
      constants,
      selection: window('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
      probe: true,
    });
    expect(fake.requests.map((r) => r.url.pathname)).toEqual([
      '/v1/workspaces/w1/users/u1/entries',
    ]);
  });

  // #428 review: the other query parameters of the same request.
  /** document() with extra query parameters on the entries list. */
  function withParameters(
    extra: Record<string, unknown>[],
    fixed?: Record<string, string>,
  ): OpenApiDocument {
    const doc = document();
    (
      doc.paths[ENTRIES]!.get!.parameters as unknown as Record<
        string,
        unknown
      >[]
    ).push(...extra);
    if (fixed) {
      const resources = doc.components!['crudResources'] as Record<
        string,
        { collections: Record<string, Record<string, unknown>> }
      >;
      resources['entry']!.collections['entries']!['listQuery'] = fixed;
    }
    return doc;
  }
  const query = (
    name: string,
    filter?: Record<string, unknown>,
  ): Record<string, unknown> => ({
    name,
    in: 'query',
    schema: { type: 'string' },
    ...(filter ? { 'x-filter': filter } : {}),
  });
  const values = (extra: Record<string, string>): QuerySelection => ({
    query_overrides: [
      {
        path: ENTRIES,
        values: {
          start: '2026-01-01T00:00:00Z',
          end: '2026-02-01T00:00:00Z',
          ...extra,
        },
      },
    ],
  });
  const reviewProbe = withParameters([
    query('updatedAfter', { field: '/updatedAt', operator: 'gte' }),
    query('project', { field: '/projectId', operator: 'eq' }),
    query('startUtc', { field: '/timeInterval/start', operator: 'gte' }),
    query('hydrated'),
  ]);

  it('adds a range parameter without x-time-zone as a span of its own field', async () => {
    const { snapshot } = await read(
      [AMS],
      values({ updatedAfter: '2026-01-15T12:00:00+01:00' }),
      reviewProbe,
    );
    expect(snapshot.coverage?.instants).toMatchObject({
      updatedAfter: iso('2026-01-15T11:00:00'),
    });
    expect(snapshot.coverage?.spans).toEqual([
      {
        field: '/timeInterval/start',
        from: iso('2026-01-01T00:00:00'),
        fromInclusive: true,
        to: iso('2026-02-01T00:00:00'),
        toInclusive: false,
      },
      {
        field: '/updatedAt',
        from: iso('2026-01-15T11:00:00'),
        fromInclusive: true,
      },
    ]);
  });

  for (const [label, extra] of [
    ['an equality x-filter', { project: 'p1' }],
    ['a parameter without x-filter', { hydrated: 'true' }],
    ['a range bound that is not an instant', { startUtc: 'yesterday' }],
    [
      'all three of the review probe',
      {
        updatedAfter: '2026-01-15T00:00:00Z',
        project: 'p1',
        startUtc: '2026-01-05T00:00:00Z',
      },
    ],
  ] as const)
    it(`covers nothing known with ${label} (otherFilters)`, async () => {
      const { snapshot, requests } = await read(
        [AMS],
        values(extra),
        reviewProbe,
      );
      // The request is still sent with the values.
      expect(listed(requests)!.searchParams.get('start')).toBe(
        '2026-01-01T01:00:00Z',
      );
      expect(snapshot.coverage).toMatchObject({
        spans: null,
        reason: 'otherFilters',
      });
    });

  it('does not count the collection’s own fixed listQuery value as a narrowing', async () => {
    const { snapshot } = await read(
      [AMS],
      values({}),
      withParameters([query('hydrated')], { hydrated: 'true' }),
    );
    expect(snapshot.coverage?.spans).toHaveLength(1);
    expect(snapshot.coverage).not.toHaveProperty('reason');
  });

  it('keeps the tighter of two lower bounds on one field, zoned or not', async () => {
    const { snapshot } = await read(
      [AMS],
      values({ startUtc: '2026-01-05T00:00:00Z' }),
      reviewProbe,
    );
    expect(snapshot.coverage?.spans).toEqual([
      {
        field: '/timeInterval/start',
        from: iso('2026-01-05T00:00:00'),
        fromInclusive: true,
        to: iso('2026-02-01T00:00:00'),
        toInclusive: false,
      },
    ]);
    // A looser one does not widen it.
    const looser = await read(
      [AMS],
      values({ startUtc: '2025-12-01T00:00:00Z' }),
      reviewProbe,
    );
    expect(looser.snapshot.coverage?.spans?.[0]?.from).toBe(
      iso('2026-01-01T00:00:00'),
    );
  });

  it('takes the excluded end when two bounds meet at the same instant', async () => {
    const doc = withParameters([
      query('after', { field: '/timeInterval/start', operator: 'gt' }),
      query('until', { field: '/timeInterval/start', operator: 'lte' }),
    ]);
    const { snapshot } = await read(
      [AMS],
      values({
        // start (gte, zoned) is 2026-01-01T00:00:00Z: the same instant.
        after: '2026-01-01T01:00:00+01:00',
        // end (lt, zoned) is 2026-02-01T00:00:00Z: the same instant.
        until: '2026-02-01T00:00:00Z',
      }),
      doc,
    );
    expect(snapshot.coverage?.spans).toEqual([
      {
        field: '/timeInterval/start',
        from: iso('2026-01-01T00:00:00'),
        fromInclusive: false,
        to: iso('2026-02-01T00:00:00'),
        toInclusive: false,
      },
    ]);
  });

  // #428 re-review: which paging fields do not count, and fixed bounds.
  /** withParameters() plus a pagination scheme applied to the list. */
  function paged(
    queryParameters: Record<string, { role: string }>,
  ): OpenApiDocument {
    const doc = withParameters(
      Object.keys(queryParameters).map((name) => query(name)),
    );
    (doc.components as Record<string, unknown>)['paginationSchemes'] = {
      paged: { type: 'pageNumber', request: { queryParameters } },
    };
    doc.paths[ENTRIES]!.get!['x-pagination'] = [{ scheme: 'paged' }];
    return doc;
  }

  it('does not count the page size the selection sets', async () => {
    const { snapshot } = await read(
      [AMS],
      values({ size: '50' }),
      paged({ page: { role: 'page' }, size: { role: 'pageSize' } }),
    );
    expect(snapshot.coverage?.spans).toHaveLength(1);
    expect(snapshot.coverage).not.toHaveProperty('reason');
  });

  it('counts a page token the selection sets as another filter', async () => {
    const doc = withParameters([query('token')]);
    (doc.components as Record<string, unknown>)['paginationSchemes'] = {
      tokens: {
        type: 'pageToken',
        request: { queryParameters: { token: { role: 'pageToken' } } },
        response: { bodyFields: { next: { role: 'nextPageToken' } } },
      },
    };
    doc.paths[ENTRIES]!.get!['x-pagination'] = [{ scheme: 'tokens' }];
    const { snapshot } = await read([AMS], values({ token: 'abc' }), doc);
    expect(snapshot.coverage).toMatchObject({
      spans: null,
      reason: 'otherFilters',
    });
  });

  it('adds a fixed range bound without a zone to its field’s span', async () => {
    const { snapshot } = await read(
      [AMS],
      values({}),
      withParameters(
        [query('updatedAfter', { field: '/updatedAt', operator: 'gt' })],
        { updatedAfter: '2025-12-01T00:00:00Z' },
      ),
    );
    expect(snapshot.coverage).not.toHaveProperty('reason');
    expect(snapshot.coverage?.spans).toEqual([
      {
        field: '/timeInterval/start',
        from: iso('2026-01-01T00:00:00'),
        fromInclusive: true,
        to: iso('2026-02-01T00:00:00'),
        toInclusive: false,
      },
      {
        field: '/updatedAt',
        from: iso('2025-12-01T00:00:00'),
        fromInclusive: false,
      },
    ]);
  });
});
