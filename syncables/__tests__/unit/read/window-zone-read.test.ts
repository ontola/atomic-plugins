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

function document(
  options: { format?: string; zonedEnd?: boolean } = {},
): OpenApiDocument {
  const zone = {
    interpretation: 'wallClock',
    zone: { operationId: 'getUser', pointer: '/settings/timeZone' },
    suffix: 'Z',
  };
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
          parameters: [
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
              'x-filter': { field: '/start', operator: 'lt' },
              ...(options.zonedEnd === false ? {} : { 'x-time-zone': zone }),
            },
          ],
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
          request: {
            queryParameters: {
              start: { role: 'windowStart' },
              end: { role: 'windowEnd' },
            },
          },
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
    log.push(
      `entries ${request.url.searchParams.get('start')} ${request.url.searchParams.get('end')}`,
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
    expect(snapshot!.coverage).toEqual({
      parameters: {
        start: '2026-01-01T01:00:00Z..2026-01-01T01:00:10Z',
        end: '2026-01-01T01:00:00Z..2026-01-01T01:00:10Z',
      },
      zones: { start: 'Europe/Amsterdam', end: 'Europe/Amsterdam' },
      span: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-01T00:00:10.000Z' },
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
      span: { from: '2026-01-01T14:00:00.000Z', to: '2026-01-02T10:00:00.000Z' },
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
    const { transport } = server(['Europe/Amsterdam', 'Europe/London'], () => []);
    const result = await read(document(), transport);
    expect(result.collections[0]!.coverage).toMatchObject({
      span: null,
      reason: 'zoneChanged',
    });
  });

  it('sends a window field without x-time-zone unchanged next to one with it', async () => {
    const { transport, log } = server(['Europe/Amsterdam'], () => []);
    await read(document({ zonedEnd: false }), transport);
    expect(log[1]).toBe('entries 2026-01-01T01:00:00Z 2026-01-01T00:00:10Z');
  });
});
