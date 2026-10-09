// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  type OpenApiDocument,
  type Transport,
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
