// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type OpenApiDocument,
  type Transport,
  type TransportResponse,
} from '../../../src/browser.js';

// sync() and reads that end without an error but are not complete: a read by
// range windows (Pagination Schemes 0.5.0 §4.6.4) or one ended by a short
// page whose end is not documented (0.6.0 §4.4.5). Their records are added
// or updated; nothing is removed or concluded about the records they do not
// return, and the result names them. Documents and data are invented.

/** A short-page document: `size` 2, `assurance` observed, and a `total` field. */
function shortPages(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Short pages', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/team/{teamId}/task': {
        get: {
          parameters: [{ name: 'page', in: 'query' }],
          'x-pagination': [{ scheme: 'pages' }],
          responses: { '200': { description: 'A page of tasks' } },
        },
      },
      '/task/{taskId}': {
        get: { responses: { '200': { description: 'One task' } } },
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
              urlTemplate: '/team/{teamId}/task',
              envelope: { itemsField: 'items' },
            },
          },
        },
      },
    },
  } as OpenApiDocument;
}

/**
 * Answers one page per `page` number from `pages`, each with `total` when
 * given: two full pages and a total of 4 end the read on the total
 * (complete); a short page ends it on the short page (not complete).
 */
function server(): {
  transport: Transport;
  set: (pages: Record<string, unknown>[][], total?: number) => void;
  requests: string[];
} {
  let current: Record<string, unknown>[][] = [];
  let total: number | undefined;
  const requests: string[] = [];
  const transport: Transport = (request) => {
    requests.push(`${request.method} ${request.url.pathname}${request.url.search}`);
    const page = Number(request.url.searchParams.get('page') ?? '0');
    const items = current[page] ?? [];
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(total === undefined ? { items } : { items, total }),
    });
  };
  return {
    transport,
    requests,
    set: (pages, t): void => {
      current = pages;
      total = t;
    },
  };
}

const ids = (records: Record<string, unknown>[]): string[] =>
  records.map((r) => String(r['id'])).sort();

describe('sync() with a read that is not complete', () => {
  it('adds and updates the records it returns, and reports the collection', async () => {
    const { transport, set } = server();
    const client = createApiClient(shortPages(), {
      transport,
      constants: { teamId: 'w1' },
    });
    set([[{ id: 'a', title: 'A' }]]);
    const result = await client.sync();
    expect(result.changed).toEqual(['tasks']);
    expect(result.incomplete).toEqual([
      {
        collection: 'tasks',
        context: { teamId: 'w1' },
        reason: expect.stringMatching(/observed, not documented/),
      },
    ]);
    expect(ids(await client.list('tasks'))).toEqual(['a']);

    set([[{ id: 'a', title: 'A2' }]]);
    await client.sync();
    expect((await client.get('tasks', 'a'))?.['title']).toBe('A2');
  });

  it('removes nothing that it does not return', async () => {
    const { transport, set } = server();
    const client = createApiClient(shortPages(), {
      transport,
      constants: { teamId: 'w1' },
    });
    set([[{ id: 'a' }]]);
    await client.sync();
    set([[{ id: 'b' }]]);
    const result = await client.sync();
    expect(result.incomplete).toHaveLength(1);
    expect(ids(await client.list('tasks'))).toEqual(['a', 'b']);
  });

  it('reports nothing for a complete read, which still prunes afterwards', async () => {
    const { transport, set } = server();
    const client = createApiClient(shortPages(), {
      transport,
      constants: { teamId: 'w1' },
    });
    // Complete: two full pages, ended by the total.
    set([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'd' }]], 4);
    expect((await client.sync()).incomplete).toEqual([]);
    // Not complete: a short page adds e.
    set([[{ id: 'e' }]]);
    await client.sync();
    expect(ids(await client.list('tasks'))).toEqual(['a', 'b', 'c', 'd', 'e']);
    // The same complete read as the first one: e, which it lacks, goes.
    set([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'd' }]], 4);
    const result = await client.sync();
    expect(result.incomplete).toEqual([]);
    expect(ids(await client.list('tasks'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('checks no record it does not return', async () => {
    const { transport, set, requests } = server();
    const client = createApiClient(shortPages(), {
      transport,
      constants: { teamId: 'w1' },
    });
    set([[{ id: 'a' }]]);
    await client.sync();
    set([[]]);
    requests.length = 0;
    await client.sync();
    // Only the list read: no item GET of the absent record.
    expect(requests).toEqual(['GET /v2/team/w1/task?page=0']);
    expect(ids(await client.list('tasks'))).toEqual(['a']);
  });

  it('reads a rangeWindow collection over the range it is given', async () => {
    const document: OpenApiDocument = {
      openapi: '3.0.3',
      info: { title: 'Windows', version: '1.0.0' },
      servers: [{ url: 'https://api.example.com/v2' }],
      paths: {
        '/ledgers/{ledgerId}/transactions': {
          get: {
            parameters: [{ name: 'filter', in: 'query' }],
            'x-pagination': [{ scheme: 'periodWindows' }],
            responses: { '200': { description: 'Transactions' } },
          },
        },
        '/ledgers/{ledgerId}/transactions/{id}': {
          get: { responses: { '200': { description: 'One' } } },
        },
      },
      components: {
        paginationSchemes: {
          periodWindows: {
            type: 'rangeWindow',
            autoDetect: false,
            window: { unit: 'day', format: 'basicDate', bounds: 'closed', cap: 100 },
            request: {
              queryParameters: {
                filter: { role: 'windowRange', template: 'period:{start}..{end}' },
              },
            },
          },
        },
        crudResources: {
          transaction: {
            identity: {
              urlTemplate: '/ledgers/{ledgerId}/transactions/{id}',
              bindings: { id: { field: 'id' } },
            },
            collections: {
              transactions: { urlTemplate: '/ledgers/{ledgerId}/transactions' },
            },
          },
        },
      },
    } as OpenApiDocument;
    const filters: string[] = [];
    const client = createApiClient(document, {
      transport: (request) => {
        filters.push(request.url.searchParams.get('filter') ?? '');
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify([{ id: 'm1', amount: '1.00' }]),
        });
      },
      constants: { ledgerId: 'l1' },
      ranges: () => ({ start: '20260101', end: '20261231' }),
    });
    const result = await client.sync();
    expect(filters).toEqual(['period:20260101..20261231']);
    expect(result.incomplete[0]?.reason).toMatch(/range windows/);
    expect(ids(await client.list('transactions'))).toEqual(['m1']);
  });
});

describe('an incomplete read and the marks a complete read leaves (review of #431)', () => {
  /** shortPages() plus a PUT on a task and, optionally, a deletion feed. */
  function writable(feed: boolean): OpenApiDocument {
    const doc = shortPages();
    doc.paths['/task/{taskId}']!.put = {
      requestBody: {
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      responses: { '200': { description: 'The task' } },
    };
    if (feed) {
      doc.paths['/team/{teamId}/task-changes'] = {
        get: {
          operationId: 'listTaskChanges',
          responses: { '200': { description: 'Changes' } },
        },
      };
      (
        doc.components!['crudResources'] as Record<
          string,
          { collections: Record<string, Record<string, unknown>> }
        >
      )['task']!.collections['tasks']!['x-deletion-feed'] = {
        operationId: 'listTaskChanges',
        envelope: { itemsField: 'changes' },
        tombstone: { field: 'state', values: ['deleted'] },
      };
    }
    return doc;
  }

  /** Pages for the list, a changes answer for the feed, 503 for task GETs. */
  function provider(): {
    transport: Transport;
    set: (pages: Record<string, unknown>[][], total?: number) => void;
    changes: Record<string, unknown>[];
    puts: () => number;
    gate: { open: () => void };
  } {
    let pages: Record<string, unknown>[][] = [];
    let total: number | undefined;
    let puts = 0;
    const changes: Record<string, unknown>[] = [];
    let open!: () => void;
    const gated = new Promise<void>((resolve) => (open = resolve));
    const transport: Transport = async (request) => {
      const path = request.url.pathname;
      const json = (body: unknown, status = 200): TransportResponse => ({
        status,
        headers: {},
        body: JSON.stringify(body),
      });
      if (path === '/v2/team/w1/task') {
        const page = Number(request.url.searchParams.get('page') ?? '0');
        const items = pages[page] ?? [];
        return json(total === undefined ? { items } : { items, total });
      }
      if (path === '/v2/team/w1/task-changes') return json({ changes });
      if (request.method === 'PUT') {
        puts += 1;
        if (puts === 1) await gated;
        return json({ error: 'invented' }, 503);
      }
      return json({ error: 'invented' }, 503);
    };
    return {
      transport,
      set: (p, t): void => {
        pages = p;
        total = t;
      },
      changes,
      puts: () => puts,
      gate: { open: () => open() },
    };
  }

  const four = [
    [{ id: 'a' }, { id: 'b' }],
    [{ id: 'c' }, { id: 'd' }],
  ];
  const withoutA = [
    [{ id: 'b' }, { id: 'c' }],
    [{ id: 'd' }, { id: 'e' }],
  ];

  it('clears holdIfQueued on an in-flight update whose record it returns', async () => {
    const fake = provider();
    const client = createApiClient(writable(false), {
      transport: fake.transport,
      constants: { teamId: 'w1' },
      retry: { baseDelayMs: 20, maxAttempts: 2 },
    });
    fake.set(four, 4);
    await client.sync();
    await client.update('tasks', 'a', { title: 'A2' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    // A complete read lacks a while its update is in flight: marked for holding.
    fake.set(withoutA, 4);
    await client.sync();
    // An incomplete read returns a: the mark goes, as a complete read does.
    fake.set([[{ id: 'a' }]]);
    expect((await client.sync()).incomplete).toHaveLength(1);
    fake.gate.open();
    // The 503 is retried after the backoff instead of being held for a refresh.
    await vi.waitFor(() => expect(fake.puts()).toBe(2), { timeout: 2000 });
  });

  it('drops a stored feed tombstone for a record it returns', async () => {
    const storage = new InMemoryStorageAdapter();
    const fake = provider();
    fake.gate.open();
    const client = createApiClient(writable(true), {
      storage,
      transport: fake.transport,
      constants: { teamId: 'w1' },
      retry: { baseDelayMs: 60_000 },
    });
    fake.set(four, 4);
    await client.sync();
    await client.update('tasks', 'a', { title: 'A2' });
    await vi.waitFor(() => expect(fake.puts()).toBe(1));
    // A complete read lacks a; its GET is undecided; the feed's tombstone
    // fails the update and is kept for the next sync.
    fake.changes.push({ id: 'a', state: 'deleted' });
    fake.set(withoutA, 4);
    await client.sync();
    const tombstones = async (): Promise<unknown> =>
      (
        (await storage.get('syncables:outbox', 'outbox')) as
          | { feedTombstones?: { tombstones: string[] }[] }
          | undefined
      )?.feedTombstones?.flatMap((entry) => entry.tombstones) ?? [];
    expect(await tombstones()).toEqual(['a']);
    // An incomplete read returns a: the stored tombstone is stale.
    fake.set([[{ id: 'a' }]]);
    await client.sync();
    expect(await tombstones()).toEqual([]);
  });
});
