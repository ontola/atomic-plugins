// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  readCollections,
  type ApiClientOptions,
  type MissingRecord,
  type OpenApiDocument,
  type PresenceChange,
  type Transport,
} from '../../../src/browser.js';

// Deletion Feeds 0.3.0-draft §4.5 list tombstones beyond held updates (#504
// review): a record without writes that a read returns as a list tombstone
// is deleted (source `list`, no request), kept marked under retainDeleted,
// settles a kept mark, does not count against maxMissingRecordChecks; a
// tombstone of a read that is not complete still fails a held update; an
// object returned twice in one read (as a member and a tombstone, or across
// pages) fails the read, and its tombstones are not evidence. Documents and
// data are invented.

/**
 * Tasks paged by page number (two per page, a `total` field), with
 * `deleted: true` list tombstones, an item GET, a PATCH and a DELETE. A short page
 * ends the read without an error, not complete (`assurance: observed`).
 */
function tasks(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Tasks with list tombstones', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/task': {
        get: {
          parameters: [{ name: 'page', in: 'query' }],
          'x-pagination': [{ scheme: 'pages' }],
          responses: { '200': { description: 'A page of tasks' } },
        },
      },
      '/task/{taskId}': {
        get: { responses: { '200': { description: 'One task' } } },
        patch: { responses: { '200': { description: 'Updated' } } },
        delete: { responses: { '204': { description: 'Deleted' } } },
      },
    },
    components: {
      paginationSchemes: {
        pages: {
          type: 'pageNumber',
          autoDetect: false,
          request: { queryParameters: { page: { role: 'page', start: 0 } } },
          response: {
            bodyFields: { total: { role: 'totalCount' } },
            shortPage: { size: 2, assurance: 'observed' },
          },
        },
      },
      crudResources: {
        task: {
          identity: {
            urlTemplate: '/task/{taskId}',
            bindings: { taskId: { field: 'id' } },
          },
          collections: {
            tasks: {
              urlTemplate: '/task',
              envelope: { itemsField: 'items' },
              'x-list-tombstone': { field: 'deleted', values: [true] },
            },
          },
        },
      },
    },
  } as OpenApiDocument;
}

type Task = Record<string, unknown>;

/**
 * A server answering `pages[n]` for page n, with `total` when given (two
 * full pages and a total of 4 end a read completely). An item GET answers
 * `itemStatus`; a PATCH answers 503, so an update stays queued.
 */
function server(): {
  transport: Transport;
  set: (pages: Task[][], total?: number) => void;
  itemStatus: number;
  requests: string[];
} {
  let current: Task[][] = [];
  let total: number | undefined;
  const fake = {
    itemStatus: 503,
    requests: [] as string[],
    set: (pages: Task[][], t?: number): void => {
      current = pages;
      total = t;
    },
    transport: ((request) => {
      fake.requests.push(
        `${request.method} ${request.url.pathname}${request.url.search}`,
      );
      if (request.url.pathname !== '/v2/task')
        return Promise.resolve({
          status: request.method === 'PATCH' ? 503 : fake.itemStatus,
          headers: {},
          body: JSON.stringify({ message: 'busy' }),
        });
      const page = Number(request.url.searchParams.get('page') ?? '0');
      const items = current[page] ?? [];
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(
          total === undefined ? { items } : { items, total },
        ),
      });
    }) as Transport,
  };
  return fake;
}

const a: Task = { id: 'a', title: 'A' };
const b: Task = { id: 'b', title: 'B' };
const c: Task = { id: 'c', title: 'C' };
const d: Task = { id: 'd', title: 'D' };
const gone = (task: Task): Task => ({ id: task['id'], deleted: true });

/** A complete read of four items over two pages. */
const complete = (items: Task[]): [Task[][], number] => [
  [items.slice(0, 2), items.slice(2, 4)],
  4,
];

function client(
  fake: ReturnType<typeof server>,
  extra: Partial<ApiClientOptions> = {},
): {
  client: ReturnType<typeof createApiClient>;
  told: PresenceChange[];
  reports: MissingRecord[];
} {
  const told: PresenceChange[] = [];
  const reports: MissingRecord[] = [];
  return {
    told,
    reports,
    client: createApiClient(tasks(), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      onPresence: (changes) => {
        told.push(...changes);
      },
      onMissingRecord: (r) => reports.push(r),
      ...extra,
    }),
  };
}

const itemReads = (requests: string[]): string[] =>
  requests.filter((r) => r.startsWith('GET /v2/task/'));

const ids = async (c: ReturnType<typeof createApiClient>): Promise<string[]> =>
  (await c.list('tasks')).map((t) => String(t['id'])).sort();

describe('a list tombstone of a record without writes', () => {
  it("is told as deleted, source 'list', and removed, without a request", async () => {
    const fake = server();
    const { client: c1, told } = client(fake);
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    fake.set(...complete([a, b, c, gone(d)]));
    fake.requests.length = 0;
    const result = await c1.sync();
    expect(told).toEqual([
      expect.objectContaining({
        id: 'd',
        presence: 'deleted',
        source: 'list',
        pruned: true,
      }),
    ]);
    expect(result.presence).toMatchObject([{ id: 'd', presence: 'deleted' }]);
    expect(await ids(c1)).toEqual(['a', 'b', 'c']);
    expect(itemReads(fake.requests)).toEqual([]);
  });

  it('is kept, marked deleted, under retainDeleted, and present again after a restore', async () => {
    const fake = server();
    const { client: c1 } = client(fake, { retainDeleted: true });
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    fake.set(...complete([a, b, c, gone(d)]));
    await c1.sync();
    expect(c1.presence()).toMatchObject([
      { id: 'd', presence: 'deleted', source: 'list', record: d },
    ]);
    expect(await ids(c1)).toEqual(['a', 'b', 'c', 'd']);
    fake.set(...complete([a, b, c, { ...d, title: 'D, restored' }]));
    await c1.sync();
    expect(c1.presence()).toEqual([]);
    expect((await c1.get('tasks', 'd'))?.['title']).toBe('D, restored');
  });

  it("keeps the mark's source 'list' across a restart", async () => {
    const fake = server();
    const storage = new InMemoryStorageAdapter();
    const { client: c1 } = client(fake, { retainDeleted: true, storage });
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    fake.set(...complete([a, b, c, gone(d)]));
    await c1.sync();
    const { client: c2 } = client(fake, { retainDeleted: true, storage });
    await c2.ready();
    expect(c2.presence()).toMatchObject([
      { id: 'd', presence: 'deleted', source: 'list' },
    ]);
  });

  it('settles an unconfirmed mark as deleted without a request', async () => {
    const fake = server();
    const { client: c1, told } = client(fake, { missingRecordChecks: 'all' });
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    // d vanishes; its check answers 503: unknown, kept unconfirmed.
    fake.set([[a, b], [c]], 3);
    await c1.sync();
    expect(c1.presence()).toMatchObject([{ id: 'd', presence: 'unconfirmed' }]);
    fake.set(...complete([a, b, c, gone(d)]));
    fake.requests.length = 0;
    told.length = 0;
    await c1.sync();
    expect(itemReads(fake.requests)).toEqual([]);
    expect(c1.presence()).toEqual([]);
    expect(told).toMatchObject([
      { id: 'd', presence: 'deleted', source: 'list' },
    ]);
    expect(await ids(c1)).toEqual(['a', 'b', 'c']);
  });

  it('does not count against maxMissingRecordChecks', async () => {
    const fake = server();
    const { client: c1 } = client(fake, {
      missingRecordChecks: 'all',
      maxMissingRecordChecks: 0,
      retainDeleted: true,
    });
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    // c vanishes (no check: the limit is 0), d is a list tombstone.
    fake.set([[a, b], [gone(d)]], 3);
    fake.requests.length = 0;
    await c1.sync();
    expect(itemReads(fake.requests)).toEqual([]);
    expect(c1.presence()).toMatchObject([
      {
        id: 'c',
        presence: 'unconfirmed',
        detail: expect.stringMatching(/maxMissingRecordChecks/),
      },
      { id: 'd', presence: 'deleted', source: 'list' },
    ]);
  });
});

describe('a list tombstone of a read that is not complete', () => {
  it('fails a held update as deleted; only a complete read removes the record', async () => {
    const fake = server();
    const { client: c1, reports } = client(fake);
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    await c1.update('tasks', 'd', { title: 'D2' });
    await vi.waitFor(() => expect(c1.pendingWrites()[0]?.attempts).toBe(1));
    // A short page ends the read without an error: not complete.
    fake.set([[a, gone(d)], [c]]);
    fake.requests.length = 0;
    const result = await c1.sync();
    expect(result.incomplete).toHaveLength(1);
    expect(reports).toMatchObject([
      { id: 'd', evidence: 'deleted', source: 'list' },
    ]);
    expect(c1.pendingWrites()).toMatchObject([
      { id: 'd', state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(itemReads(fake.requests)).toEqual([]);
    expect(fake.requests.filter((r) => r.startsWith('PATCH'))).toEqual([]);
    // Still in the local copy: an incomplete read removes nothing.
    expect(await ids(c1)).toContain('d');
  });
});

describe('a held delete of a record a read returns as a list tombstone', () => {
  it.each([
    [
      'a complete read',
      (): [Task[][], number | undefined] => complete([a, b, c, gone(d)]),
    ],
    [
      'a read that is not complete',
      (): [Task[][], number | undefined] => [[[a, gone(d)], [c]], undefined],
    ],
  ])(
    'is released and sent after %s, and its 404 settles it',
    async (_label, pages) => {
      const fake = server();
      const { client: c1, reports } = client(fake);
      fake.set(...complete([a, b, c, d]));
      await c1.sync();
      // The DELETE answers 503: queued between retries.
      fake.itemStatus = 503;
      await c1.remove('tasks', 'd');
      await vi.waitFor(() => expect(c1.pendingWrites()[0]?.attempts).toBe(1));
      fake.itemStatus = 404;
      fake.set(...pages());
      fake.requests.length = 0;
      await c1.sync();
      await vi.waitFor(() => expect(c1.pendingWrites()).toEqual([]));
      expect(reports).toMatchObject([
        { id: 'd', evidence: 'deleted', source: 'list' },
      ]);
      // Sent, not failed; no GET of the record.
      expect(fake.requests.filter((r) => r.startsWith('DELETE'))).toEqual([
        'DELETE /v2/task/d',
      ]);
      expect(itemReads(fake.requests)).toEqual([]);
    },
  );
});

describe('an object returned twice in one read', () => {
  it('fails the read, as a member and a tombstone across pages, and reports no tombstones', async () => {
    const fake = server();
    fake.set(
      [
        [a, gone(b)],
        [b, c],
      ],
      4,
    );
    const result = await readCollections(tasks(), {
      transport: fake.transport,
    });
    const [snapshot] = result.collections;
    expect(snapshot!.complete).toBe(false);
    // The page walk's own guard (Pagination Schemes §4.3.2).
    expect(snapshot!.error).toMatch(/earlier page returned/);
    expect(snapshot!.tombstones).toEqual([]);
  });

  it('fails the read as a member and a tombstone on one page', async () => {
    const fake = server();
    fake.set(
      [
        [gone(b), b],
        [c, d],
      ],
      4,
    );
    const result = await readCollections(tasks(), {
      transport: fake.transport,
    });
    const [snapshot] = result.collections;
    expect(snapshot!.error).toMatch(/repeated record identity/);
    expect(snapshot!.tombstones).toEqual([]);
    expect(snapshot!.complete).toBe(false);
  });

  it('fails the read as two tombstones too', async () => {
    const fake = server();
    fake.set(
      [
        [a, gone(b)],
        [gone(b), c],
      ],
      4,
    );
    const result = await readCollections(tasks(), {
      transport: fake.transport,
    });
    expect(result.collections[0]!.error).toMatch(/earlier page returned/);
  });

  it('fails no held update and removes nothing', async () => {
    const fake = server();
    const { client: c1, reports } = client(fake);
    fake.set(...complete([a, b, c, d]));
    await c1.sync();
    await c1.update('tasks', 'b', { title: 'B2' });
    await vi.waitFor(() => expect(c1.pendingWrites()[0]?.attempts).toBe(1));
    // Restored between pages: a tombstone on page 0, a member on page 1.
    fake.set(
      [
        [a, gone(b)],
        [b, c],
      ],
      4,
    );
    await expect(c1.sync()).rejects.toThrow(/earlier page returned/);
    expect(reports).toEqual([]);
    expect(c1.pendingWrites()).toMatchObject([{ id: 'b', state: 'pending' }]);
    expect(await ids(c1)).toEqual(['a', 'b', 'c', 'd']);
  });
});
