// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type ApiClientOptions,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
} from '../../../src/browser.js';

// Which kept unavailable records a sync reads again (Collection
// Completeness §4.3): not ones with held writes, whose failed write says
// what became of them; oldest-checked first, so maxMissingRecordChecks
// does not read the same one every sync; and only after every collection's
// unconfirmed and newly missing records, so they never take those checks.
// Invented document and data.

type Row = Record<string, unknown>;

/** Collections `/pets` and `/owners`, each with an item GET and a PATCH. */
function document(): OpenApiDocument {
  const completeness = { absent: 'removed', notFound: 'unavailable' };
  const resource = (name: string, param: string): Record<string, unknown> => ({
    identity: {
      urlTemplate: `/${name}/{${param}}`,
      bindings: { [param]: { field: 'id' } },
    },
    collections: {
      [name]: { urlTemplate: `/${name}`, 'x-completeness': completeness },
    },
  });
  const item = {
    get: { responses: { '200': { description: 'One' } } },
    patch: {
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '200': { description: 'Updated' } },
      'x-crud': { action: 'update', mode: 'merge' },
    },
  };
  return {
    openapi: '3.0.3',
    info: { title: 'Pets', version: '1.0.0' },
    servers: [{ url: 'https://pets.example/api' }],
    paths: {
      '/pets': { get: { responses: { '200': { description: 'Pets' } } } },
      '/pets/{petId}': item,
      '/owners': {
        get: { responses: { '200': { description: 'Owners' } } },
      },
      '/owners/{ownerId}': item,
    },
    components: {
      crudResources: {
        pet: resource('pets', 'petId'),
        owner: resource('owners', 'ownerId'),
      },
    },
  } as unknown as OpenApiDocument;
}

/**
 * Lists the rows not `hidden` (keys `<collection>/<id>`); an item GET
 * answers `item[key]`, else the row; every write answers 503.
 */
function server(rows: Record<string, Row[]>): {
  rows: Record<string, Map<string, Row>>;
  hidden: Set<string>;
  item: Record<string, number>;
  gets: string[];
  transport: Transport;
} {
  const fake = {
    rows: Object.fromEntries(
      Object.entries(rows).map(([name, list]) => [
        name,
        new Map(list.map((row) => [String(row['id']), { ...row }])),
      ]),
    ),
    hidden: new Set<string>(),
    item: {} as Record<string, number>,
    gets: [] as string[],
    transport: (async (request) => {
      const [, , collection = '', id] = request.url.pathname.split('/');
      if (request.method !== 'GET')
        return { status: 503, headers: {}, body: '{}' };
      const all = fake.rows[collection] ?? new Map<string, Row>();
      if (!id)
        return {
          status: 200,
          headers: {},
          body: JSON.stringify(
            [...all.values()].filter(
              (row) => !fake.hidden.has(`${collection}/${String(row['id'])}`),
            ),
          ),
        };
      const key = `${collection}/${id}`;
      fake.gets.push(key);
      const status = fake.item[key] ?? 200;
      return {
        status,
        headers: {},
        body: JSON.stringify(status === 200 ? all.get(id) : { error: 'x' }),
      };
    }) as Transport,
  };
  return fake;
}

function client(
  fake: ReturnType<typeof server>,
  options: ApiClientOptions = {},
): { client: ReturnType<typeof createApiClient>; told: PresenceChange[] } {
  const told: PresenceChange[] = [];
  return {
    told,
    client: createApiClient(document(), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      onPresence: (changes) => {
        told.push(...changes);
      },
      ...options,
    }),
  };
}

const marks = (c: ReturnType<typeof createApiClient>): string[][] =>
  c
    .presence()
    .map((m) => [m.collection, m.id, m.presence])
    .sort();

describe('a kept unavailable record with held writes', () => {
  it.each([
    ['an unchanged read', false],
    ['a read with other changes', true],
  ])(
    'is not read again by %s: its failed write still says unavailable',
    async (_label, changeOthers) => {
      const fake = server({
        pets: [
          { id: '1', name: 'Rex' },
          { id: '2', name: 'Tom' },
        ],
      });
      const { client: c, told } = client(fake);
      await c.sync();
      // The update waits behind a 503; then Tom leaves the list and its
      // GET answers 404: the update fails, the record is kept unavailable.
      await c.update('/pets', '2', { name: 'Tommy' });
      await vi.waitFor(() => expect(c.pendingWrites()[0]?.attempts).toBe(1));
      fake.hidden.add('pets/2');
      fake.item['pets/2'] = 404;
      await c.sync();
      expect(c.pendingWrites()).toMatchObject([
        { id: '2', state: 'failed', missingRecord: 'unavailable' },
      ]);
      expect(marks(c)).toEqual([['pets', '2', 'unavailable']]);
      // Access is back, but the failed write holds the record: no GET,
      // no `present`, the mark and the failed write agree.
      fake.item['pets/2'] = 200;
      if (changeOthers)
        (fake.rows['pets'] as Map<string, Row>).set('1', {
          id: '1',
          name: 'Rex II',
        });
      fake.gets.length = 0;
      told.length = 0;
      await c.sync();
      expect(fake.gets).toEqual([]);
      expect(told).toEqual([]);
      expect(marks(c)).toEqual([['pets', '2', 'unavailable']]);
      expect(c.pendingWrites()).toMatchObject([
        { id: '2', state: 'failed', missingRecord: 'unavailable' },
      ]);
    },
  );
});

describe('kept unavailable records under maxMissingRecordChecks', () => {
  it('are read again in turn, oldest-checked first, also across a restart', async () => {
    const fake = server({
      pets: [
        { id: '1', name: 'Rex' },
        { id: '2', name: 'Tom' },
        { id: '3', name: 'Kit' },
      ],
    });
    const storage = new InMemoryStorageAdapter();
    const first = client(fake, { storage }).client;
    await first.sync();
    for (const id of ['1', '2', '3']) {
      fake.hidden.add(`pets/${id}`);
      fake.item[`pets/${id}`] = 404;
    }
    await first.sync();
    expect(marks(first).map((m) => m[2])).toEqual([
      'unavailable',
      'unavailable',
      'unavailable',
    ]);
    // Each still answers 404 and so stays where it is in the set; with one
    // check a sync, each is read in turn, never the same one twice running.
    let c = client(fake, { storage, maxMissingRecordChecks: 1 }).client;
    await c.ready();
    const order: string[] = [];
    for (let sync = 0; sync < 6; sync += 1) {
      if (sync === 3) {
        // A restart keeps when each was last checked.
        c = client(fake, { storage, maxMissingRecordChecks: 1 }).client;
        await c.ready();
      }
      fake.gets.length = 0;
      await c.sync();
      expect(fake.gets).toHaveLength(1);
      order.push(fake.gets[0] as string);
    }
    expect(order.slice(0, 3).sort()).toEqual(['pets/1', 'pets/2', 'pets/3']);
    expect(order.slice(3)).toEqual(order.slice(0, 3));
  });

  it('wait for the checks of records other collections newly lack', async () => {
    const fake = server({
      pets: [
        { id: '1', name: 'Rex' },
        { id: '2', name: 'Tom' },
      ],
      owners: [{ id: '7', name: 'Ann' }],
    });
    const { client: c } = client(fake, { maxMissingRecordChecks: 1 });
    await c.sync();
    fake.hidden.add('pets/2');
    fake.item['pets/2'] = 404;
    await c.sync();
    expect(marks(c)).toEqual([['pets', '2', 'unavailable']]);
    // Ann leaves the owners list, which is read after the pets: her check
    // comes first, and takes the one check this sync may make.
    fake.hidden.add('owners/7');
    fake.item['owners/7'] = 410;
    fake.gets.length = 0;
    await c.sync();
    expect(fake.gets).toEqual(['owners/7']);
    // Then the pet's turn comes again.
    fake.gets.length = 0;
    await c.sync();
    expect(fake.gets).toEqual(['pets/2']);
  });
});
