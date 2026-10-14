// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type ApiClientOptions,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
} from '../../../src/browser.js';

// A record kept `unavailable` (Collection Completeness §4.3) without writes
// is read again where the collection makes checks: after the unconfirmed
// ones, within maxMissingRecordChecks. A 2xx takes it back, a 404 keeps it
// (nothing told again), and an answer the document concludes deleted
// removes it. Invented document and data.

type Row = Record<string, unknown>;

function document(completeness: Record<string, string>): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: 'https://pets.example/api' }],
    paths: {
      '/pets': { get: { responses: { '200': { description: 'Pets' } } } },
      '/pets/{petId}': {
        get: { responses: { '200': { description: 'A pet' } } },
      },
    },
    components: {
      crudResources: {
        pet: {
          identity: {
            urlTemplate: '/pets/{petId}',
            bindings: { petId: { field: 'id' } },
          },
          collections: {
            pets: { urlTemplate: '/pets', 'x-completeness': completeness },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const rex: Row = { id: '1', name: 'Rex' };
const tom: Row = { id: '2', name: 'Tom' };

/** Lists the pets not `hidden`; an item GET answers `item[id]`, else the pet. */
function server(): {
  hidden: Set<string>;
  item: Record<string, number>;
  gets: string[];
  transport: Transport;
} {
  const pets = new Map([rex, tom].map((p) => [String(p['id']), p]));
  const fake = {
    hidden: new Set<string>(),
    item: {} as Record<string, number>,
    gets: [] as string[],
    transport: (async (request) => {
      const id = request.url.pathname.split('/')[3];
      if (!id)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            [...pets.values()].filter((p) => !fake.hidden.has(String(p['id']))),
          ),
        };
      fake.gets.push(id);
      const status = fake.item[id] ?? 200;
      return {
        status,
        headers: {},
        body: JSON.stringify(status === 200 ? pets.get(id) : { error: 'x' }),
      };
    }) as Transport,
  };
  return fake;
}

function client(
  doc: OpenApiDocument,
  fake: ReturnType<typeof server>,
  options: ApiClientOptions = {},
): { client: ReturnType<typeof createApiClient>; told: PresenceChange[] } {
  const told: PresenceChange[] = [];
  return {
    told,
    client: createApiClient(doc, {
      transport: fake.transport,
      onPresence: (changes) => {
        told.push(...changes);
      },
      ...options,
    }),
  };
}

const ids = async (c: ReturnType<typeof createApiClient>): Promise<string[]> =>
  (await c.list('pets')).map((r) => String(r['id'])).sort();

describe('a kept unavailable record is read again', () => {
  it.each([
    [
      "missingRecordChecks 'all'",
      { notFound: 'unavailable' },
      { missingRecordChecks: 'all' as const },
    ],
    [
      'absent: removed under the default checks',
      { absent: 'removed', notFound: 'unavailable' },
      {},
    ],
  ])(
    'under %s: kept while it answers 404, settled once it answers 2xx',
    async (_l, completeness, options) => {
      const fake = server();
      const { client: c, told } = client(document(completeness), fake, options);
      await c.sync();
      fake.hidden.add('2');
      fake.item['2'] = 404;
      await c.sync();
      expect(c.presence()).toMatchObject([
        { id: '2', presence: 'unavailable' },
      ]);
      expect(await ids(c)).toEqual(['1', '2']);
      // Still 404: read again, still kept, nothing told again.
      fake.gets.length = 0;
      told.length = 0;
      await c.sync();
      expect(fake.gets).toEqual(['2']);
      expect(c.presence()).toMatchObject([
        { id: '2', presence: 'unavailable' },
      ]);
      expect(told).toEqual([]);
      // Access is back: the GET answers 2xx while the list still lacks it.
      // The record exists, outside this collection: it leaves the copy, as
      // any record a complete read lacks and its GET shows filtered.
      fake.item['2'] = 200;
      fake.gets.length = 0;
      await c.sync();
      expect(fake.gets).toEqual(['2']);
      expect(c.presence()).toEqual([]);
      expect(told).toMatchObject([{ id: '2', presence: 'removed' }]);
      expect(await ids(c)).toEqual(['1']);
      // A read that returns it again takes it back, as before.
      fake.hidden.delete('2');
      await c.sync();
      expect(await c.get('pets', '2')).toEqual(tom);
    },
  );

  it('is removed once an answer concludes it deleted (a 410 under gone: deleted)', async () => {
    const fake = server();
    const { client: c, told } = client(
      document({ notFound: 'unavailable', gone: 'deleted' }),
      fake,
      { missingRecordChecks: 'all' },
    );
    await c.sync();
    fake.hidden.add('2');
    fake.item['2'] = 404;
    await c.sync();
    expect(c.presence()).toMatchObject([{ id: '2', presence: 'unavailable' }]);
    fake.item['2'] = 410;
    told.length = 0;
    await c.sync();
    expect(c.presence()).toEqual([]);
    expect(await ids(c)).toEqual(['1']);
    expect(told).toMatchObject([{ id: '2', presence: 'deleted' }]);
  });

  it('is not read where the collection makes no checks', async () => {
    const fake = server();
    const storage = new InMemoryStorageAdapter();
    const first = client(document({ notFound: 'unavailable' }), fake, {
      missingRecordChecks: 'all',
      storage,
    }).client;
    await first.sync();
    fake.hidden.add('2');
    fake.item['2'] = 404;
    await first.sync();
    const second = client(document({ notFound: 'unavailable' }), fake, {
      missingRecordChecks: 'none',
      storage,
    }).client;
    await second.ready();
    fake.gets.length = 0;
    fake.item['2'] = 200;
    await second.sync();
    expect(fake.gets).toEqual([]);
    expect(second.presence()).toMatchObject([
      { id: '2', presence: 'unavailable' },
    ]);
  });

  it('comes after the unconfirmed records within maxMissingRecordChecks', async () => {
    const fake = server();
    const { client: c } = client(
      document({ absent: 'removed', notFound: 'unavailable' }),
      fake,
      { maxMissingRecordChecks: 1 },
    );
    await c.sync();
    // Tom becomes unavailable (404).
    fake.hidden.add('2');
    fake.item['2'] = 404;
    await c.sync();
    // Rex vanishes too, and its check cannot be answered (503): unconfirmed.
    fake.hidden.add('1');
    fake.item['1'] = 503;
    fake.gets.length = 0;
    await c.sync();
    expect(fake.gets).toEqual(['1']);
    expect(
      c
        .presence()
        .map((m) => [m.id, m.presence])
        .sort(),
    ).toEqual([
      ['1', 'unconfirmed'],
      ['2', 'unavailable'],
    ]);
    // The next sync takes the unconfirmed one first again; only it fits.
    fake.gets.length = 0;
    await c.sync();
    expect(fake.gets).toEqual(['1']);
  });
});
