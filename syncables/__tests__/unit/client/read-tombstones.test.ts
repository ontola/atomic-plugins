// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type ApiClient,
  type ApiClientOptions,
  type MissingRecord,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportResponse,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// #328: a resource whose item read answers 2xx for a deleted record, with a
// marker (draft Deletion Feeds extension, x-read-tombstone). The GET of a
// record a complete refresh no longer returns then gives `deleted`, not
// `filtered`. The provider below is invented, shaped like a calendar whose
// deleted events stay readable with `status: cancelled`; it is not a
// recording of any real API.

const OUTBOX = 'syncables:outbox';

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
  private ns(resource: string): Map<string, Record<string, unknown>> {
    let ns = this.data.get(resource);
    if (!ns) this.data.set(resource, (ns = new Map()));
    return ns;
  }
  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.ns(resource).values()].map((v) => structuredClone(v));
  }
  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.ns(resource).set(id, structuredClone(value));
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
  crash(): CrashableStorage {
    const copy = new CrashableStorage();
    for (const [name, records] of this.data)
      copy.data.set(name, new Map(structuredClone([...records])));
    return copy;
  }
  outbox(): Record<string, unknown> | undefined {
    return this.data.get(OUTBOX)?.get('outbox');
  }
}

/** Per record, every failed write is older than every queued one (#313). */
function expectFailedOlder(storage: CrashableStorage): void {
  const outbox = storage.outbox() as
    | {
        records: {
          id: string;
          failed: { seq?: number }[];
          queue: { seq?: number }[];
        }[];
      }
    | undefined;
  for (const record of outbox?.records ?? []) {
    const failed = record.failed.map((w) => w.seq ?? -1);
    const queued = record.queue.map((w) => w.seq ?? Infinity);
    if (failed.length && queued.length)
      expect(Math.max(...failed), `record ${record.id}`).toBeLessThan(
        Math.min(...queued),
      );
  }
}

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

type Pet = Record<string, unknown>;

const CANCELLED = { field: 'status', values: ['cancelled'] };

const FEED = {
  operationId: 'listPetChanges',
  envelope: { itemsField: 'changes' },
  cursor: { parameter: 'since', responseField: 'next' },
  tombstone: CANCELLED,
};

/**
 * The pets fixture as a CRUD Causality document. `marker` is declared as
 * `x-read-tombstone` at `placement`: the CRUD Resource Object, the item
 * GET operation, or (not a placement the extension defines) the
 * collection. `operationMarker` adds one on the item GET as well. `feed`
 * declares the deletion feed at `GET /pet-changes`.
 */
function tombstoneDocument(
  options: {
    marker?: unknown;
    placement?: 'resource' | 'operation' | 'collection';
    operationMarker?: unknown;
    method?: 'put' | 'patch';
    feed?: boolean;
    completeness?: unknown;
  } = {},
): OpenApiDocument {
  const marker = 'marker' in options ? options.marker : CANCELLED;
  const placement = options.placement ?? 'resource';
  const doc = prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
    components: {
      ...petsDocument.components,
      crudResources: {
        pet: {
          identity: {
            urlTemplate: '/pets/{petId}',
            bindings: { petId: { field: 'id' } },
          },
          ...(marker !== undefined && placement === 'resource'
            ? { 'x-read-tombstone': marker }
            : {}),
          collections: {
            pets: {
              urlTemplate: '/pets',
              ...(marker !== undefined && placement === 'collection'
                ? { 'x-read-tombstone': marker }
                : {}),
              ...(options.feed ? { 'x-deletion-feed': FEED } : {}),
              ...(options.completeness
                ? { 'x-completeness': options.completeness }
                : {}),
            },
          },
        },
      },
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  if (marker !== undefined && placement === 'operation')
    item.get!['x-read-tombstone'] = marker;
  if (options.operationMarker !== undefined)
    item.get!['x-read-tombstone'] = options.operationMarker;
  if (options.method === 'patch') {
    item.patch = item.put!;
    delete item.put;
  }
  if (options.feed)
    doc.paths['/pet-changes'] = {
      get: {
        operationId: 'listPetChanges',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Changes since the cursor' } },
      },
    };
  return doc;
}

/**
 * A fake provider. `cancel` deletes a pet the way the invented calendar
 * does: the list stops returning it, its GET answers 200 with
 * `{ id, status: 'cancelled' }`, and the change feed logs that. `restore`
 * undoes it. Writes answer 503 while `blocked` is set, and hang while
 * `hang` is. `requests` lists every read in order: `list`, `feed`, `get <id>`.
 */
function provider(initial: Pet[]): {
  pets: Map<string, Pet>;
  cancelled: Set<string>;
  hidden: Set<string>;
  log: Record<string, unknown>[];
  itemGets: string[];
  requests: string[];
  writes: { method: string; body: unknown }[];
  blocked: boolean;
  hang: boolean;
  cancel: (id: string) => void;
  restore: (id: string) => void;
  item?: (id: string) => TransportResponse | undefined;
  transport: Transport;
} {
  const transport: Transport = async (r) => {
    const [, , collection, rawId] = r.url.pathname.split('/');
    const id = decodeURIComponent(rawId ?? '');
    if (collection === 'pet-changes') {
      fake.requests.push('feed');
      const since = r.url.searchParams.get('since');
      const from = since === null ? fake.log.length : Number(since.slice(1));
      return response({
        changes: fake.log.slice(from),
        next: `c${fake.log.length}`,
      });
    }
    if (r.method === 'GET' && id) {
      fake.itemGets.push(id);
      fake.requests.push(`get ${id}`);
      const answer = fake.item?.(id);
      if (answer) return answer;
      const pet = fake.pets.get(id);
      if (!pet) return response({ error: 'not found' }, 404);
      return fake.cancelled.has(id)
        ? response({ id, status: 'cancelled' })
        : response(pet);
    }
    if (r.method === 'GET') {
      fake.requests.push('list');
      return response(
        [...fake.pets.values()].filter(
          (p) =>
            !fake.cancelled.has(String(p['id'])) &&
            !fake.hidden.has(String(p['id'])),
        ),
      );
    }
    fake.writes.push({
      method: r.method,
      body: JSON.parse(r.body ?? 'null'),
    });
    if (fake.hang) return new Promise<TransportResponse>(() => undefined);
    if (fake.blocked) return response({ error: 'invented' }, 503);
    const current = fake.pets.get(id);
    if (!current) return response({ error: 'not found' }, 404);
    const pet = {
      ...(r.method === 'PATCH' ? current : {}),
      ...JSON.parse(r.body ?? '{}'),
      id,
    };
    fake.pets.set(id, pet);
    return response(pet);
  };
  const fake: ReturnType<typeof provider> = {
    pets: new Map(initial.map((p) => [String(p['id']), p])),
    cancelled: new Set(),
    hidden: new Set(),
    log: [],
    itemGets: [],
    requests: [],
    writes: [],
    blocked: true,
    hang: false,
    cancel: (id): void => {
      fake.cancelled.add(id);
      fake.log.push({ id, status: 'cancelled' });
    },
    restore: (id): void => {
      fake.cancelled.delete(id);
      fake.log.push({ id, status: 'confirmed' });
    },
    transport,
  };
  return fake;
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const rex = { id: '1', name: 'Rex', tag: 'dog', status: 'confirmed' };
const tom = { id: '2', name: 'Tom', tag: 'cat', status: 'confirmed' };

/**
 * A client that synced rex and tom, then queued `edits` updates of rex.
 * Writes answer 503 (`fake.blocked`), so the first edit is between retries
 * (unsent, not in flight) and the others wait behind it. Returns before
 * the next sync, with the recorded reads and writes cleared.
 */
async function edited(
  options: {
    doc?: OpenApiDocument;
    client?: ApiClientOptions;
    edits?: number;
    retryMs?: number;
  } = {},
): Promise<{
  client: ApiClient;
  storage: CrashableStorage;
  fake: ReturnType<typeof provider>;
}> {
  const fake = provider([rex, tom]);
  const storage = new CrashableStorage();
  const client = createApiClient(options.doc ?? tombstoneDocument(), {
    ...options.client,
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: options.retryMs ?? 60_000 },
  });
  await client.sync();
  for (let i = 0; i < (options.edits ?? 1); i++)
    await client.update('/pets', '1', { name: `Rex ${i + 2}` });
  await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
  await settle(5);
  fake.writes.length = 0;
  fake.requests.length = 0;
  fake.itemGets.length = 0;
  return { client, storage, fake };
}

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

describe('read tombstones: the GET of a missing record', () => {
  for (const method of ['put', 'patch'] as const)
    for (const placement of ['resource', 'operation'] as const)
      it(`fails every held ${method.toUpperCase()} update when the GET answers 2xx with the marker (declared on the ${placement === 'resource' ? 'CRUD Resource Object' : 'item GET operation'})`, async () => {
        const reports: MissingRecord[] = [];
        const { client, storage, fake } = await edited({
          doc: tombstoneDocument({ placement, method }),
          client: { onMissingRecord: (r) => reports.push(r) },
          edits: 2,
        });
        fake.cancel('1');
        await client.sync();
        expectFailedOlder(storage);
        expect(fake.requests).toEqual(['list', 'get 1']);
        expect(client.pendingWrites()).toMatchObject([
          {
            state: 'failed',
            missingRecord: 'deleted',
            lastStatus: 200,
            lastError: expect.stringMatching(
              /deleted at the provider \(GET \/api\/pets\/1 answered 200 with a tombstone: status is "cancelled"\)/,
            ),
          },
          { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
        ]);
        expect(reports).toEqual([
          {
            resource: 'pets',
            id: '1',
            evidence: 'deleted',
            source: 'read',
            status: 200,
          },
        ]);
        await settle();
        expect(fake.writes).toEqual([]);
        // Nothing is deleted locally: the edits stay visible.
        expect(await client.get('/pets', '1')).toMatchObject({
          name: 'Rex 3',
        });
      });

  for (const method of ['put', 'patch'] as const)
    it(`keeps a ${method.toUpperCase()} update on the returned record when the GET answers 2xx without the marker (filtered)`, async () => {
      const reports: MissingRecord[] = [];
      const { client, fake } = await edited({
        doc: tombstoneDocument({ method }),
        client: { onMissingRecord: (r) => reports.push(r) },
        retryMs: 300,
      });
      fake.hidden.add('1');
      await client.sync();
      expect(reports).toMatchObject([
        { evidence: 'filtered', source: 'read', status: 200, record: rex },
      ]);
      expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
      fake.blocked = false;
      await idle(client);
      expect(fake.writes.at(-1)).toEqual({
        method: method.toUpperCase(),
        body: { ...rex, name: 'Rex 2' },
      });
    });

  it('fails the update as unknown when a body with the marker is about another record', async () => {
    const { client, fake } = await edited();
    fake.hidden.add('1');
    fake.item = (): TransportResponse =>
      response({ id: '2', status: 'cancelled' });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      {
        state: 'failed',
        missingRecord: 'unknown',
        lastStatus: 200,
        lastError: expect.stringMatching(/answered 200 without the record/),
      },
    ]);
  });

  it('compares the marker by JSON type and value', async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({ marker: { field: 'deleted', values: [true] } }),
    });
    fake.hidden.add('1');
    // The string "true" is not the boolean true: filtered.
    fake.item = (): TransportResponse => response({ ...rex, deleted: 'true' });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
  });

  it('reads the marker at a dot-path', async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({
        marker: { field: 'meta.state', values: ['gone'] },
      }),
    });
    fake.hidden.add('1');
    fake.item = (): TransportResponse =>
      response({ id: '1', meta: { state: 'gone' } });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  for (const [label, marker] of [
    ['no values', { field: 'status', values: [] }],
    ['no field', { values: ['cancelled'] }],
    ['an object value', { field: 'status', values: [{}] }],
    ['a list instead of an object', ['cancelled']],
  ] as const)
    it(`ignores a declaration with ${label}: the GET's 2xx is filtered`, async () => {
      const { client, fake } = await edited({
        doc: tombstoneDocument({ marker }),
      });
      fake.cancel('1');
      await client.sync();
      expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
    });

  it('ignores a declaration on a Collection Object: the item read belongs to the resource', async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({ placement: 'collection' }),
    });
    fake.cancel('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
  });

  it("uses the CRUD Resource Object's declaration over the item GET operation's", async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({
        operationMarker: { field: 'status', values: ['deleted'] },
      }),
    });
    fake.hidden.add('1');
    fake.item = (): TransportResponse =>
      response({ id: '1', status: 'deleted' });
    await client.sync();
    // Not a tombstone under the resource's marker (`cancelled`): filtered.
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
  });

  it("falls back to the item GET operation's declaration when the CRUD Resource Object's does not parse", async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({
        marker: { field: 'status', values: [] },
        operationMarker: CANCELLED,
      }),
    });
    fake.cancel('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
    await settle();
    expect(fake.writes).toEqual([]);
  });

  it('reads the declaration on the item GET of a legacy document without crudResources', async () => {
    const doc = prepareDocument({
      ...petsDocument,
      servers: [{ url: 'https://provider.example/api' }],
    });
    doc.paths['/pets/{petId}']!.get!['x-read-tombstone'] = CANCELLED;
    const { client, fake } = await edited({ doc });
    fake.cancel('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  it("reports a record without writes as deleted with missingRecordChecks 'all'", async () => {
    const reports: MissingRecord[] = [];
    const fake = provider([rex, tom]);
    const client = createApiClient(tombstoneDocument(), {
      transport: fake.transport,
      missingRecordChecks: 'all',
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    fake.cancel('2');
    await client.sync();
    expect(reports).toEqual([
      {
        resource: 'pets',
        id: '2',
        evidence: 'deleted',
        source: 'read',
        status: 200,
      },
    ]);
  });
});

describe('read tombstones: invariants', () => {
  it('does not check, and so does not fail, updates behind one in flight', async () => {
    const fake = provider([rex, tom]);
    fake.blocked = false;
    fake.hang = true;
    const storage = new CrashableStorage();
    const client = createApiClient(tombstoneDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    await client.update('/pets', '1', { name: 'Rex 2' });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await client.update('/pets', '1', { name: 'Rex 3' });
    fake.cancel('1');
    await client.sync();
    expectFailedOlder(storage);
    // The head is in flight: no GET, nothing failed, the second is held.
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'pending' },
      { state: 'pending', awaitingRefresh: true },
    ]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
  });

  it('keeps the update held, unchecked, when the budget is spent before the GET', async () => {
    const { client, fake } = await edited({
      client: { limits: { maxRequests: 1 } },
    });
    fake.cancel('1');
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'pending', awaitingRefresh: true },
    ]);
  });

  it('does not store the read tombstone: a new update is held and the next sync reads the record again', async () => {
    const { client, storage, fake } = await edited();
    fake.cancel('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(storage.outbox()?.['feedTombstones'] ?? []).toEqual([]);
    // The provider restores the record, but the list still leaves it out.
    fake.restore('1');
    fake.hidden.add('1');
    await client.update('/pets', '1', { tag: 'wolf' });
    expectFailedOlder(storage);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed' },
      { state: 'pending', awaitingRefresh: true },
    ]);
    fake.blocked = false;
    await client.sync();
    expect(fake.itemGets).toEqual(['1', '1']);
    expectFailedOlder(storage);
    // filtered: the new update is sent on the returned record; the failed
    // one stays failed until resolveWrite.
    await vi.waitFor(() =>
      expect(fake.writes.at(-1)).toEqual({
        method: 'PUT',
        body: { ...rex, tag: 'wolf' },
      }),
    );
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });
});

describe('read tombstones: restarts', () => {
  it('stores and restores missingRecord and the GET status on a failed update', async () => {
    const { client, storage, fake } = await edited({ edits: 2 });
    fake.cancel('1');
    await client.sync();
    const restarted = createApiClient(tombstoneDocument(), {
      storage: storage.crash(),
      transport: provider([tom]).transport,
    });
    await restarted.ready();
    expect(restarted.pendingWrites()).toMatchObject([
      {
        state: 'failed',
        missingRecord: 'deleted',
        lastStatus: 200,
        lastError: expect.stringMatching(/with a tombstone/),
      },
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  it('fails restored updates of a record whose GET answers with the marker, keeping failed writes older', async () => {
    const { storage } = await edited({ edits: 2 });
    await settle();
    // Stopped before the sync: both edits are in the outbox, unsent.
    const crashed = storage.crash();
    const second = provider([rex, tom]);
    second.cancel('1');
    const restarted = createApiClient(tombstoneDocument(), {
      storage: crashed,
      transport: second.transport,
    });
    await restarted.ready();
    await restarted.update('/pets', '1', { tag: 'wolf' });
    await restarted.sync();
    expectFailedOlder(crashed);
    expect(second.itemGets).toEqual(['1']);
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
    await settle();
    expect(second.writes).toEqual([]);
  });
});

describe('read tombstones: precedence', () => {
  it('uses x-completeness absent: deleted first, without a GET', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      doc: tombstoneDocument({ completeness: { absent: 'deleted' } }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.cancel('1');
    await client.sync();
    expect(fake.itemGets).toEqual([]);
    expect(reports).toMatchObject([
      { evidence: 'deleted', source: 'declaration' },
    ]);
  });

  it("reads the record under absent: 'removed', and the marker decides", async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({ completeness: { absent: 'removed' } }),
    });
    fake.cancel('1');
    await client.sync();
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  it("decides on the GET's tombstone before this sync's feed read, which still runs", async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      doc: tombstoneDocument({ feed: true }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.cancel('1');
    await client.sync();
    expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
    // Reported once, from the GET; the feed's tombstone adds no report.
    expect(reports).toEqual([
      {
        resource: 'pets',
        id: '1',
        evidence: 'deleted',
        source: 'read',
        status: 200,
      },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  it("with a feed, keeps the feed's tombstone for the failed record, and the next check uses it before any GET", async () => {
    const reports: MissingRecord[] = [];
    const { client, storage, fake } = await edited({
      doc: tombstoneDocument({ feed: true }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.cancel('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
    // Stored by the feed read, not by the GET: its failed write is unsettled.
    expect(storage.outbox()).toMatchObject({
      feedTombstones: [{ resource: 'pets', context: {}, tombstones: ['1'] }],
    });
    await client.update('/pets', '1', { tag: 'wolf' });
    fake.requests.length = 0;
    await client.sync();
    expectFailedOlder(storage);
    expect(fake.requests).toEqual(['list', 'feed']);
    expect(reports.at(-1)).toEqual({
      resource: 'pets',
      id: '1',
      evidence: 'deleted',
      source: 'feed',
    });
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  it("decides on the GET's tombstone even when this sync's feed read has a later restore", async () => {
    const { client, fake } = await edited({
      doc: tombstoneDocument({ feed: true }),
    });
    fake.cancel('1');
    // The GET sees it cancelled; the provider restores it right after, so
    // the feed read that follows ends with a restore.
    fake.item = (id): TransportResponse => {
      const answer = response({ id, status: 'cancelled' });
      fake.restore(id);
      fake.hidden.add(id);
      return answer;
    };
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 200 },
    ]);
  });

  it('uses a tombstone stored from an earlier feed read before the GET', async () => {
    const reports: MissingRecord[] = [];
    const { client, storage, fake } = await edited({
      doc: tombstoneDocument({ feed: true }),
      client: { onMissingRecord: (r) => reports.push(r) },
      edits: 2,
    });
    // Rex is cancelled between this sync's list read and its feed read:
    // the list returns it, the feed reports it, and the tombstone is kept.
    let cancelOnce = true;
    const restarted = createApiClient(tombstoneDocument({ feed: true }), {
      storage: storage.crash(),
      transport: async (r) => {
        const answer = await fake.transport(r);
        if (
          cancelOnce &&
          r.method === 'GET' &&
          r.url.pathname.endsWith('/pets')
        ) {
          cancelOnce = false;
          fake.cancel('1');
        }
        return answer;
      },
      retry: { baseDelayMs: 60_000 },
      onMissingRecord: (r) => reports.push(r),
    });
    void client;
    await restarted.ready();
    await restarted.sync();
    expect(storage.outbox()).toBeDefined();
    await settle();
    fake.requests.length = 0;
    await restarted.sync();
    // No GET: the stored feed tombstone decides.
    expect(fake.requests).toEqual(['list', 'feed']);
    expect(reports).toEqual([
      { resource: 'pets', id: '1', evidence: 'deleted', source: 'feed' },
    ]);
    expect(restarted.pendingWrites()[0]).toMatchObject({
      state: 'failed',
      missingRecord: 'deleted',
    });
    expect(restarted.pendingWrites()[0]).not.toHaveProperty('lastStatus');
  });
});
