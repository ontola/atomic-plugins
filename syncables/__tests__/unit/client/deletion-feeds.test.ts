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

// #325: a collection's declared deletion feed (draft Deletion Feeds
// extension, x-deletion-feed) is read once per sync, at its end, after the
// GETs of records a complete refresh no longer returns, from a cursor kept
// in the outbox. Its tombstones decide what those GETs left undecided, and
// are kept for the next sync. Transports and data are invented.

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

const FEED = {
  operationId: 'listPetChanges',
  envelope: { itemsField: 'changes' },
  cursor: { parameter: 'since', responseField: 'next', expiredStatuses: [410] },
  tombstone: { field: 'state', values: ['deleted'] },
};

/**
 * The pets fixture as a CRUD Causality document with a change feed at
 * `GET /pet-changes?since=<cursor>` answering `{ changes, next }`.
 */
function feedDocument(
  options: {
    feed?: unknown;
    onOperation?: boolean;
    completeness?: unknown;
  } = {},
): OpenApiDocument {
  const feed = 'feed' in options ? options.feed : FEED;
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
          collections: {
            pets: {
              urlTemplate: '/pets',
              ...(feed !== undefined && !options.onOperation
                ? { 'x-deletion-feed': feed }
                : {}),
              ...(options.completeness
                ? { 'x-completeness': options.completeness }
                : {}),
            },
          },
        },
      },
    },
  });
  doc.paths['/pet-changes'] = {
    get: {
      operationId: 'listPetChanges',
      parameters: [{ name: 'since', in: 'query', schema: { type: 'string' } }],
      responses: { '200': { description: 'Changes since the cursor' } },
    },
  };
  if (feed !== undefined && options.onOperation)
    doc.paths['/pets']!.get!['x-deletion-feed'] = feed;
  return doc;
}

/**
 * A fake provider with a change log. `remove` deletes a pet and logs a
 * tombstone; `hidden` takes it out of the list only. The feed returns the
 * changes after the cursor (none without one) and the newest cursor, `c<n>`.
 * `feed` may answer a feed read itself, `item` a GET of one pet. `requests`
 * lists every read in order: `list`, `feed`, `get <id>`.
 */
function provider(
  initial: Pet[],
  hooks: {
    item?: (id: string) => TransportResponse | undefined;
    feed?: (since: string | null) => TransportResponse | undefined;
    write?: () => TransportResponse | undefined;
  } = {},
): {
  pets: Map<string, Pet>;
  hidden: Set<string>;
  log: Record<string, unknown>[];
  itemGets: string[];
  feedReads: (string | null)[];
  requests: string[];
  writes: string[];
  remove: (id: string) => void;
  lastFeedUrl?: URL;
  transport: Transport;
} {
  const pets = new Map(initial.map((p) => [String(p['id']), p]));
  const hidden = new Set<string>();
  const log: Record<string, unknown>[] = [];
  const itemGets: string[] = [];
  const feedReads: (string | null)[] = [];
  const requests: string[] = [];
  const writes: string[] = [];
  const transport: Transport = async (r) => {
    const [, , collection, rawId] = r.url.pathname.split('/');
    const id = decodeURIComponent(rawId ?? '');
    if (collection === 'pet-changes') {
      const since = r.url.searchParams.get('since');
      feedReads.push(since);
      requests.push('feed');
      result.lastFeedUrl = r.url;
      const answer = hooks.feed?.(since);
      if (answer) return answer;
      const from = since === null ? log.length : Number(since.slice(1));
      return response({ changes: log.slice(from), next: `c${log.length}` });
    }
    if (r.method === 'GET' && id) {
      itemGets.push(id);
      requests.push(`get ${id}`);
      const answer = hooks.item?.(id);
      if (answer) return answer;
      const pet = pets.get(id);
      return pet ? response(pet) : response({ error: 'not found' }, 404);
    }
    if (r.method === 'GET') {
      requests.push('list');
      return response(
        [...pets.values()].filter((p) => !hidden.has(String(p['id']))),
      );
    }
    writes.push(`${r.method} ${r.url.pathname}`);
    const answer = hooks.write?.();
    if (answer) return answer;
    const current = pets.get(id);
    if (!current) return response({ error: 'not found' }, 404);
    const pet = { ...JSON.parse(r.body ?? '{}'), id };
    pets.set(id, pet);
    return response(pet);
  };
  const result: ReturnType<typeof provider> = {
    pets,
    hidden,
    log,
    itemGets,
    feedReads,
    requests,
    writes,
    remove: (id): void => {
      pets.delete(id);
      log.push({ id, state: 'deleted' });
    },
    transport,
  };
  return result;
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const rex = { id: '1', name: 'Rex', tag: 'dog' };
const tom = { id: '2', name: 'Tom', tag: 'cat' };

const unavailable = (): TransportResponse =>
  response({ error: 'invented' }, 503);

/** Writes answer 503; with `undecided`, so do GETs of one pet (`unknown`). */
function heldProvider(
  options: { undecided?: boolean } = {},
): ReturnType<typeof provider> {
  return provider([rex, tom], {
    write: unavailable,
    ...(options.undecided ? { item: unavailable } : {}),
  });
}

/**
 * A client that synced rex and tom (one feed read, no cursor yet), then
 * queued `edits` updates of each pet in `ids`. Writes answer 503, so the
 * first edit of each is between retries (unsent, not in flight).
 */
async function edited(
  options: {
    doc?: OpenApiDocument;
    fake?: ReturnType<typeof provider>;
    client?: ApiClientOptions;
    storage?: CrashableStorage;
    ids?: string[];
    edits?: number;
  } = {},
): Promise<{
  client: ApiClient;
  storage: CrashableStorage;
  fake: ReturnType<typeof provider>;
}> {
  const fake = options.fake ?? heldProvider();
  const storage = options.storage ?? new CrashableStorage();
  const client = createApiClient(options.doc ?? feedDocument(), {
    ...options.client,
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: 60_000 },
  });
  await client.sync();
  const ids = options.ids ?? ['1'];
  for (const id of ids)
    for (let i = 0; i < (options.edits ?? 1); i++)
      await client.update('/pets', id, { name: `Edit ${i + 2}` });
  await vi.waitFor(() =>
    expect(
      client
        .pendingWrites()
        .filter((w) => w.attempts === 1)
        .map((w) => w.id),
    ).toEqual(ids),
  );
  await settle(5);
  fake.writes.length = 0;
  fake.requests.length = 0;
  return { client, storage, fake };
}

describe('deletion feeds: a tombstone', () => {
  for (const onOperation of [false, true])
    it(`fails every held update of a record whose GET was undecided and that the feed reports deleted (declared on the ${onOperation ? 'list operation' : 'collection'})`, async () => {
      const reports: MissingRecord[] = [];
      const { client, storage, fake } = await edited({
        doc: feedDocument({ onOperation }),
        fake: heldProvider({ undecided: true }),
        client: { onMissingRecord: (r) => reports.push(r) },
        edits: 2,
      });
      expect(fake.feedReads).toEqual([null]);
      fake.remove('1');
      await client.sync();
      expectFailedOlder(storage);
      // The feed is read last, after the GET.
      expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
      expect(fake.feedReads).toEqual([null, 'c0']);
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'deleted',
          lastError: expect.stringMatching(
            /deleted at the provider \(the deletion feed listPetChanges reports it deleted\)/,
          ),
        },
        { state: 'failed', missingRecord: 'deleted' },
      ]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('lastStatus');
      expect(reports).toEqual([
        { resource: 'pets', id: '1', evidence: 'deleted', source: 'feed' },
      ]);
      await settle();
      expect(fake.writes).toEqual([]);
      // Nothing is deleted locally: the edits stay visible.
      expect(await client.get('/pets', '1')).toMatchObject({ name: 'Edit 3' });
    });

  it('uses the feed for a record whose GET the budget did not cover (a 429 handed back)', async () => {
    const fake = provider([rex, tom], {
      write: unavailable,
      item: () => response({ error: 'slow down' }, 429),
    });
    const { client, storage } = await edited({ fake });
    fake.remove('1');
    await client.sync();
    expectFailedOlder(storage);
    expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  it('fails an undecided record as unknown when its last feed item is not a tombstone (restored)', async () => {
    const { client, fake } = await edited({
      fake: heldProvider({ undecided: true }),
    });
    fake.log.push({ id: '1', state: 'deleted' }, { id: '1', state: 'active' });
    fake.hidden.add('1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unknown', lastStatus: 503 },
    ]);
  });

  it('treats every item as a tombstone when the declaration has no tombstone field', async () => {
    const { client, fake } = await edited({
      doc: feedDocument({ feed: { ...FEED, tombstone: undefined } }),
      fake: heldProvider({ undecided: true }),
    });
    fake.pets.delete('1');
    fake.log.push({ id: '1' });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  it('finds the record by idField in an event log', async () => {
    const { client, fake } = await edited({
      doc: feedDocument({
        feed: {
          ...FEED,
          idField: 'resource.gid',
          tombstone: { field: 'action', values: ['deleted'] },
        },
      }),
      fake: heldProvider({ undecided: true }),
    });
    fake.pets.delete('1');
    fake.log.push({ action: 'deleted', resource: { gid: '1' } });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  it("reports a record without writes from the feed with missingRecordChecks 'all'", async () => {
    const reports: MissingRecord[] = [];
    const fake = provider([rex, tom], { item: unavailable });
    const client = createApiClient(feedDocument(), {
      transport: fake.transport,
      missingRecordChecks: 'all',
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    fake.remove('2');
    await client.sync();
    expect(fake.itemGets).toEqual(['2']);
    expect(reports).toEqual([
      { resource: 'pets', id: '2', evidence: 'deleted', source: 'feed' },
    ]);
  });
});

describe('deletion feeds: stored tombstones', () => {
  it('keeps a tombstone for a record with writes, and uses it before the GET in the next sync, also after a restart', async () => {
    const { storage, fake } = await edited({ edits: 2 });
    const first = createApiClient(feedDocument(), {
      storage,
      transport: async (r) => {
        const answer = await fake.transport(r);
        // Deleted between the list read and the feed read.
        if (r.url.pathname.endsWith('/pets') && r.method === 'GET')
          fake.remove('1');
        return answer;
      },
      retry: { baseDelayMs: 60_000 },
    });
    await first.ready();
    await first.sync();
    expect(fake.requests).toEqual(['list', 'feed']);
    expect(storage.outbox()).toMatchObject({
      feedTombstones: [{ resource: 'pets', context: {}, tombstones: ['1'] }],
    });
    fake.requests.length = 0;
    const crashed = storage.crash();
    const reports: MissingRecord[] = [];
    const restarted = createApiClient(feedDocument(), {
      storage: crashed,
      transport: fake.transport,
      onMissingRecord: (r) => reports.push(r),
    });
    await restarted.sync();
    expectFailedOlder(crashed);
    // The stored tombstone decides; no GET.
    expect(fake.requests).toEqual(['list', 'feed']);
    expect(reports).toMatchObject([
      { id: '1', evidence: 'deleted', source: 'feed' },
    ]);
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
      { state: 'failed', missingRecord: 'deleted' },
    ]);
  });

  it('drops a stored tombstone when a read returns the record', async () => {
    const storage = new CrashableStorage();
    await storage.put(OUTBOX, 'outbox', {
      version: 1,
      records: [],
      rebuild: [],
      unrestorable: [],
      feedTombstones: [{ resource: 'pets', context: {}, tombstones: ['1'] }],
    });
    const fake = heldProvider();
    const { client } = await edited({ fake, storage });
    expect(storage.outbox()).not.toHaveProperty('feedTombstones');
    fake.hidden.add('1');
    await client.sync();
    // Read with a GET (filtered), not failed on the stale tombstone.
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
  });

  it('does not store tombstones of records without unsettled writes', async () => {
    const storage = new CrashableStorage();
    const fake = provider([rex, tom]);
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    fake.remove('2');
    await client.sync();
    expect(storage.outbox()).not.toHaveProperty('feedTombstones');
  });
});

describe('deletion feeds: no tombstone, no feed', () => {
  it('lets the GET decide, before the feed read', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.hidden.add('1');
    // A tombstone in this sync's feed does not override the GET's answer.
    fake.log.push({ id: '1', state: 'deleted' });
    await client.sync();
    expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
    expect(reports).toMatchObject([
      { id: '1', evidence: 'filtered', source: 'read', status: 200 },
    ]);
    // Released on the returned record, to be sent at its next retry.
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
  });

  it('reads no feed and GETs the record when the document declares none', async () => {
    const { client, fake } = await edited({
      doc: feedDocument({ feed: undefined }),
    });
    fake.remove('1');
    await client.sync();
    expect(fake.feedReads).toEqual([]);
    expect(fake.itemGets).toEqual(['1']);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 404 },
    ]);
  });

  for (const [label, feed] of [
    ['an operationId the document lacks', { ...FEED, operationId: 'nope' }],
    [
      'tombstone values that are not a list',
      { ...FEED, tombstone: { field: 'state', values: 'deleted' } },
    ],
    [
      'a cursor without responseField',
      { ...FEED, cursor: { parameter: 'since' } },
    ],
  ] as const)
    it(`ignores a declaration with ${label}`, async () => {
      const { client, fake } = await edited({ doc: feedDocument({ feed }) });
      fake.remove('1');
      await client.sync();
      expect(fake.feedReads).toEqual([]);
      expect(fake.itemGets).toEqual(['1']);
    });
});

describe('deletion feeds: the cursor', () => {
  it('advances once per sync and is stored in the outbox', async () => {
    const storage = new CrashableStorage();
    const fake = provider([rex, tom]);
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    fake.log.push({ id: '9', state: 'active' });
    await client.sync();
    fake.log.push({ id: '9', state: 'active' }, { id: '9', state: 'active' });
    await client.sync();
    expect(fake.feedReads).toEqual([null, 'c0', 'c1']);
    expect(storage.outbox()).toMatchObject({
      feedCursors: [
        {
          resource: 'pets',
          context: {},
          operation: 'listPetChanges',
          cursor: 'c3',
        },
      ],
    });
  });

  it('survives a restart: the next client reads from the stored cursor and finds the tombstone', async () => {
    const fake = heldProvider({ undecided: true });
    const { storage } = await edited({ fake, edits: 2 });
    // Stopped after the first sync; rex is deleted meanwhile.
    fake.remove('1');
    const crashed = storage.crash();
    const restarted = createApiClient(feedDocument(), {
      storage: crashed,
      transport: fake.transport,
    });
    await restarted.ready();
    await restarted.sync();
    expectFailedOlder(crashed);
    expect(fake.feedReads).toEqual([null, 'c0']);
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(crashed.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c1' }],
    });
  });

  it('stores the outbox only when the cursor changes', async () => {
    const storage = new CrashableStorage();
    let puts = 0;
    const put = storage.put.bind(storage);
    storage.put = async (resource, id, value): Promise<void> => {
      if (resource === OUTBOX) puts += 1;
      await put(resource, id, value);
    };
    const fake = provider([rex, tom]);
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    expect(puts).toBe(1);
    await client.sync();
    expect(fake.feedReads).toEqual([null, 'c0']);
    expect(puts).toBe(1);
    fake.log.push({ id: '9', state: 'active' });
    await client.sync();
    expect(puts).toBe(2);
  });

  it('does not send a stored cursor of another feed operation', async () => {
    const storage = new CrashableStorage();
    await storage.put(OUTBOX, 'outbox', {
      version: 1,
      records: [],
      rebuild: [],
      unrestorable: [],
      feedCursors: [
        { resource: 'pets', context: {}, operation: 'older', cursor: 'x7' },
      ],
    });
    const fake = provider([rex]);
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    expect(fake.feedReads).toEqual([null]);
    expect(storage.outbox()).toMatchObject({
      feedCursors: [{ operation: 'listPetChanges', cursor: 'c0' }],
    });
  });

  it('keeps stored feed state of a collection the document lacks, unchanged', async () => {
    const storage = new CrashableStorage();
    const cursor = {
      resource: 'gone',
      context: {},
      operation: 'listGone',
      cursor: 'g1',
    };
    const tombstones = { resource: 'gone', context: {}, tombstones: ['5'] };
    await storage.put(OUTBOX, 'outbox', {
      version: 1,
      records: [],
      rebuild: [],
      unrestorable: [],
      feedCursors: [cursor],
      feedTombstones: [tombstones],
    });
    const client = createApiClient(feedDocument(), {
      storage,
      transport: provider([rex]).transport,
    });
    await client.sync();
    const outbox = storage.outbox() as {
      unrestorable: unknown[];
      feedCursors: unknown[];
    };
    expect(outbox.unrestorable).toHaveLength(2);
    expect(outbox.unrestorable).toEqual(
      expect.arrayContaining([cursor, tombstones]),
    );
    expect(outbox.feedCursors).toHaveLength(1);
  });

  it("reads no feed with missingRecordChecks 'none'", async () => {
    const { client, fake } = await edited({
      client: { missingRecordChecks: 'none' },
    });
    fake.remove('1');
    await client.sync();
    expect(fake.feedReads).toEqual([]);
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unknown' },
    ]);
  });
});

describe('deletion feeds: pages', () => {
  it('follows every page of a paginated feed and takes the cursor from the last one', async () => {
    const doc = feedDocument();
    doc.components!.paginationSchemes = {
      token: {
        type: 'pageToken',
        request: { queryParameters: { page: { role: 'cursor' } } },
        response: { bodyFields: { more: { role: 'nextCursor' } } },
      },
    };
    doc.paths['/pet-changes']!.get!['x-pagination'] = [{ scheme: 'token' }];
    const pages: string[] = [];
    const fake = provider([rex, tom], {
      write: unavailable,
      item: unavailable,
      feed: (since) => {
        if (since === null) return undefined;
        const url = fake.lastFeedUrl as URL;
        const page = url.searchParams.get('page') ?? '1';
        pages.push(page);
        // The tombstone is on page 2; only the last page has `next`.
        return page === '1'
          ? response({ changes: [{ id: '2', state: 'active' }], more: '2' })
          : response({
              changes: [{ id: '1', state: 'deleted' }],
              more: null,
              next: 'c7',
            });
      },
    });
    const { client, storage } = await edited({ doc, fake });
    fake.pets.delete('1');
    await client.sync();
    expect(pages).toEqual(['1', '2']);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(storage.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c7' }],
    });
  });
});

describe('deletion feeds: the read budget', () => {
  it('does not starve the GETs of other collections (#327 review B1)', async () => {
    // Two collections, each with a feed and a held update of a record the
    // list filters out; four requests: two lists and two GETs.
    const doc = feedDocument();
    const components = doc.components as Record<string, unknown>;
    const resources = components['crudResources'] as Record<string, unknown>;
    resources['cat'] = {
      identity: {
        urlTemplate: '/cats/{catId}',
        bindings: { catId: { field: 'id' } },
      },
      collections: {
        cats: {
          urlTemplate: '/cats',
          'x-deletion-feed': { ...FEED, operationId: 'listCatChanges' },
        },
      },
    };
    doc.paths['/cats'] = doc.paths['/pets']!;
    doc.paths['/cats/{catId}'] = doc.paths['/pets/{petId}']!;
    doc.paths['/cat-changes'] = {
      get: {
        operationId: 'listCatChanges',
        responses: { '200': { description: 'Changes since the cursor' } },
      },
    };
    let hide = false;
    const requests: string[] = [];
    const transport: Transport = async (r) => {
      const [, , collection, id] = r.url.pathname.split('/');
      const pet =
        collection === 'cats' || collection === 'cat-changes' ? tom : rex;
      requests.push(`${r.method} ${collection}${id ? `/${id}` : ''}`);
      if (r.method !== 'GET') return unavailable();
      if (collection?.endsWith('-changes'))
        return response({ changes: [], next: 'c0' });
      if (id) return response(pet);
      return response(hide ? [] : [pet]);
    };
    const client = createApiClient(doc, {
      transport,
      limits: { maxRequests: 4 },
      retry: { baseDelayMs: 60_000 },
    });
    await client.sync();
    await client.update('pets', '1', { name: 'Rex 2' });
    await client.update('cats', '2', { name: 'Tom 2' });
    await vi.waitFor(() =>
      expect(client.pendingWrites().map((w) => w.attempts)).toEqual([1, 1]),
    );
    hide = true;
    requests.length = 0;
    for (let i = 0; i < 3; i++) {
      await client.sync();
      expect(client.pendingWrites()).toMatchObject([
        { state: 'pending' },
        { state: 'pending' },
      ]);
    }
    // Every sync GETs both records; the feeds get no request.
    expect(requests.filter((r) => /^GET (pets|cats)\/\d/.test(r))).toEqual([
      'GET pets/1',
      'GET cats/2',
      'GET pets/1',
      'GET cats/2',
      'GET pets/1',
      'GET cats/2',
    ]);
    expect(requests.filter((r) => r.includes('-changes'))).toEqual([]);
  });

  it('never holds an update forever when every sync is a new client whose feed would take the budget (#327 review B2)', async () => {
    const fake = heldProvider();
    const { storage } = await edited({ fake });
    fake.hidden.add('1');
    for (let round = 0; round < 8; round++) {
      // A page open: a new client on the same storage, list plus one GET.
      const client = createApiClient(feedDocument(), {
        storage,
        transport: fake.transport,
        limits: { maxRequests: 2 },
        retry: { baseDelayMs: 60_000 },
      });
      await client.sync();
      expectFailedOlder(storage);
      // Found by the GET: released, to be sent (the provider answers 503).
      expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
    }
    expect(fake.itemGets).toHaveLength(8);
  });

  it('counts the feed against the sync-wide maxRecords: over it, the read is incomplete and the cursor kept', async () => {
    // After the removal the list returns 1 record and the feed 2: 3 over
    // a limit of 2, which the feed alone would not exceed.
    const { client, storage, fake } = await edited({
      fake: heldProvider({ undecided: true }),
      client: { limits: { maxRecords: 2 } },
    });
    fake.remove('1');
    fake.log.push({ id: '8', state: 'active' });
    await client.sync();
    expect(fake.feedReads).toEqual([null, 'c0']);
    // No tombstone used: the GET's unknown stands.
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unknown', lastStatus: 503 },
    ]);
    expect(storage.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c0' }],
    });
  });

  it('keeps the updates held and the cursor unchanged when the budget is spent before the GET and the feed read', async () => {
    const { storage, fake } = await edited();
    fake.remove('1');
    // A client on the same storage whose budget covers the list only.
    const crashed = storage.crash();
    const client = createApiClient(feedDocument(), {
      storage: crashed,
      transport: fake.transport,
      limits: { maxRequests: 1 },
    });
    await client.sync();
    expect(fake.feedReads).toEqual([null]);
    expect(fake.itemGets).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'pending', awaitingRefresh: true },
    ]);
    expect(crashed.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c0' }],
    });
  });
});

describe('deletion feeds: a malformed or refused feed', () => {
  const cases: [string, TransportResponse][] = [
    ['a body that is not JSON', { status: 200, headers: {}, body: '<html>' }],
    ['no items array', response({ changes: 'none', next: 'c9' })],
    ['no cursor', response({ changes: [{ id: '1', state: 'deleted' }] })],
    ['an object cursor', response({ changes: [], next: { at: 1 } })],
    ['a 500', response({ error: 'invented' }, 500)],
  ];
  for (const [label, answer] of cases)
    it(`ignores a feed read with ${label}: no tombstone, cursor unchanged`, async () => {
      let broken = false;
      const fake = provider([rex, tom], {
        write: unavailable,
        item: unavailable,
        feed: () => (broken ? answer : undefined),
      });
      const { client, storage } = await edited({ fake });
      broken = true;
      fake.remove('1');
      await client.sync();
      expect(fake.itemGets).toEqual(['1']);
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'unknown', lastStatus: 503 },
      ]);
      expect(storage.outbox()).toMatchObject({
        feedCursors: [{ cursor: 'c0' }],
      });
      broken = false;
      await client.sync();
      expect(fake.feedReads).toEqual([null, 'c0', 'c0']);
    });

  it('takes the cursor from the body of an expired status', async () => {
    const fake = provider([rex], {
      feed: (since) =>
        since === 'c0' ? response({ next: 'c5' }, 410) : undefined,
    });
    const storage = new CrashableStorage();
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    await client.sync();
    expect(storage.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c5' }],
    });
    fake.log.push(...Array.from({ length: 5 }, () => ({ id: '9' })));
    await client.sync();
    expect(fake.feedReads).toEqual([null, 'c0', 'c5']);
  });

  it('drops the cursor on an expired status without one, and reads without it next', async () => {
    const fake = provider([rex], {
      feed: (since) =>
        since === 'c0' ? response({ error: 'expired' }, 410) : undefined,
    });
    const storage = new CrashableStorage();
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    await client.sync();
    expect(storage.outbox()).not.toHaveProperty('feedCursors');
    await client.sync();
    expect(fake.feedReads).toEqual([null, 'c0', null]);
  });

  it('keeps the cursor on a status the declaration does not list as expired', async () => {
    const fake = provider([rex], {
      feed: (since) =>
        since === 'c0' ? response({ next: 'c5' }, 412) : undefined,
    });
    const storage = new CrashableStorage();
    const client = createApiClient(feedDocument(), {
      storage,
      transport: fake.transport,
    });
    await client.sync();
    await client.sync();
    expect(storage.outbox()).toMatchObject({
      feedCursors: [{ cursor: 'c0' }],
    });
  });
});

describe('deletion feeds: precedence', () => {
  it('uses x-completeness absent: deleted first, and reads no feed', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      doc: feedDocument({ completeness: { absent: 'deleted' } }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    expect(fake.feedReads).toEqual([]);
    fake.remove('1');
    await client.sync();
    expect(fake.feedReads).toEqual([]);
    expect(fake.itemGets).toEqual([]);
    expect(reports).toMatchObject([{ id: '1', source: 'declaration' }]);
  });

  it("uses a tombstone after an undecided GET under absent: 'removed'", async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      doc: feedDocument({ completeness: { absent: 'removed' } }),
      fake: heldProvider({ undecided: true }),
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.remove('1');
    await client.sync();
    expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
    expect(reports).toMatchObject([
      { id: '1', evidence: 'deleted', source: 'feed' },
    ]);
  });

  it('lets a GET that answers 404 decide before the feed', async () => {
    const reports: MissingRecord[] = [];
    const { client, fake } = await edited({
      client: { onMissingRecord: (r) => reports.push(r) },
    });
    fake.remove('1');
    await client.sync();
    expect(fake.requests).toEqual(['list', 'get 1', 'feed']);
    expect(reports).toEqual([
      {
        resource: 'pets',
        id: '1',
        evidence: 'deleted',
        source: 'read',
        status: 404,
      },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 404 },
    ]);
  });
});
