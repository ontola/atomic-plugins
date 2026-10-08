// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  paginate,
  PageReadError,
  PaginationSchemeError,
  readCollections,
  resolveEffectiveScheme,
  validatePaginationScheme,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
} from '../../../src/browser.js';
import { buildQuery } from '../../../src/pagination/request-builder.js';

// Pagination Schemes 0.6.0: `start` on a page field (§4.3.1) and the Short
// Page Object (§4.4.5). The documents are shaped like the spec's
// examples/short-page.yaml: ClickUp's zero-based task pages with no
// continuation signal (assurance assumed), and a page size the client sends
// whose short page the provider documents. Fixture data only.

const zeroBased = (
  assurance: 'documented' | 'observed' | 'assumed' = 'assumed',
): PaginationSchemeObject => ({
  type: 'pageNumber',
  autoDetect: false,
  request: { queryParameters: { page: { role: 'page', start: 0 } } },
  response: { shortPage: { size: 100, assurance } },
});

function document(scheme: PaginationSchemeObject): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Short pages', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/team/{teamId}/task': {
        get: {
          parameters: [
            { name: 'page', in: 'query' },
            { name: 'per_page', in: 'query' },
          ],
          'x-pagination': [{ scheme: 'pages' }],
          responses: { '200': { description: 'At most one page of tasks' } },
        },
      },
      '/task/{taskId}': {
        get: { responses: { '200': { description: 'One task' } } },
      },
    },
    components: {
      paginationSchemes: { pages: scheme },
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

/** `total` tasks in pages of `size`, numbered from `first`; `{ items }` bodies (ClickUp's is `tasks`). */
function provider(
  total: number,
  size: number,
  first = 0,
): { transport: Transport; pages: string[] } {
  const pages: string[] = [];
  const transport: Transport = (request) => {
    const page = request.url.searchParams.get('page') ?? '';
    pages.push(page);
    const n = Number(page) - first;
    const tasks = Array.from(
      { length: Math.max(0, Math.min(size, total - n * size)) },
      (_, i) => ({ id: `t${n * size + i}` }),
    );
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify({ items: tasks }),
    });
  };
  return { transport, pages };
}

const read = async (
  scheme: PaginationSchemeObject,
  transport: Transport,
): Promise<{
  complete: boolean;
  items: number;
  notComplete?: string;
  errors: string[];
}> => {
  const result = await readCollections(document(scheme), {
    transport,
    constants: { teamId: 'w1' },
  });
  const [snapshot] = result.collections;
  return {
    complete: snapshot!.complete,
    items: snapshot!.items.length,
    ...(snapshot!.notComplete ? { notComplete: snapshot!.notComplete } : {}),
    errors: result.errors,
  };
};

describe('start (§4.3.1)', () => {
  it('asks for the first page with start, and adds 1', async () => {
    expect(buildQuery(zeroBased(), {})).toEqual({ page: '0' });
    const { transport, pages } = provider(250, 100);
    await read(zeroBased(), transport);
    expect(pages).toEqual(['0', '1', '2']);
  });

  it('keeps 1 as the default', () => {
    const scheme = zeroBased();
    delete scheme.request!.queryParameters!['page']!.start;
    expect(buildQuery(scheme, {})).toEqual({ page: '1' });
  });
});

describe('short pages (§4.4.5)', () => {
  it('end the list; with assurance assumed the read is not complete', async () => {
    const { transport } = provider(250, 100);
    const result = await read(zeroBased('assumed'), transport);
    expect(result).toMatchObject({ items: 250, complete: false, errors: [] });
    expect(result.notComplete).toMatch(/assumed, not documented/);
  });

  it('observed is not complete either; only documented is', async () => {
    for (const [assurance, complete] of [
      ['observed', false],
      ['documented', true],
    ] as const) {
      const { transport } = provider(250, 100);
      expect((await read(zeroBased(assurance), transport)).complete).toBe(
        complete,
      );
    }
  });

  it('need one more, empty, page after a full last page', async () => {
    const { transport, pages } = provider(200, 100);
    const result = await read(zeroBased('documented'), transport);
    expect(pages).toEqual(['0', '1', '2']);
    expect(result).toMatchObject({ items: 200, complete: true });
  });

  it('take the page size the client sends with size request', async () => {
    const scheme: PaginationSchemeObject = {
      type: 'pageNumber',
      autoDetect: false,
      request: {
        queryParameters: {
          page: { role: 'page' },
          per_page: { role: 'pageSize' },
        },
      },
      response: { shortPage: { size: 'request', assurance: 'documented' } },
    };
    const { transport, pages } = provider(120, 50, 1);
    const items = await paginate(document(scheme), {
      transport,
      path: '/team/{teamId}/task',
      pathParams: { teamId: 'w1' },
      pageSize: 50,
    });
    expect(items).toHaveLength(120);
    expect(pages).toEqual(['1', '2', '3']);
    await expect(
      paginate(document(scheme), {
        transport,
        path: '/team/{teamId}/task',
        pathParams: { teamId: 'w1' },
      }),
    ).rejects.toThrow(/pass pageSize/);
  });

  it('end the read with an error on an oversized page', async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: Array.from({ length: 101 }, (_, i) => ({ id: `t${i}` })),
        }),
      });
    const result = await read(zeroBased(), transport);
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toMatch(/more than the declared 100/);
    await expect(
      paginate(document(zeroBased()), {
        transport,
        path: '/team/{teamId}/task',
        pathParams: { teamId: 'w1' },
      }),
    ).rejects.toThrow(PageReadError);
  });

  it('end the read with an error when a server ignores the page', async () => {
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({
          items: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}` })),
        }),
      });
    const result = await read(zeroBased(), transport);
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toMatch(/repeats the page before it/);
  });

  it('give way to another declared end signal on a full page', async () => {
    const scheme = zeroBased('assumed');
    scheme.response!.bodyFields = { total: { role: 'totalCount' } };
    const pages: string[] = [];
    const transport: Transport = (request) => {
      pages.push(request.url.searchParams.get('page') ?? '');
      const tasks = Array.from({ length: 100 }, (_, i) => ({
        id: `p${pages.length}-${i}`,
      }));
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items: tasks, total: 200 }),
      });
    };
    const result = await read(scheme, transport);
    expect(pages).toEqual(['0', '1']);
    expect(result).toMatchObject({ items: 200, complete: true });
  });
});

describe('validation (§9 rules 19–22)', () => {
  const errors = (scheme: unknown): string[] =>
    validatePaginationScheme('s', scheme as PaginationSchemeObject);

  it('accepts the spec examples', () => {
    expect(errors(zeroBased())).toEqual([]);
  });

  it('checks start (rule 19)', () => {
    const negative = zeroBased();
    negative.request!.queryParameters!['page']!.start = -1;
    expect(errors(negative).join()).toMatch(/at least 0/);
    const misplaced = zeroBased();
    misplaced.request!.queryParameters!['size'] = {
      role: 'pageSize',
      start: 0,
    };
    expect(errors(misplaced).join()).toMatch(/only on a page field/);
  });

  it('checks the Short Page Object (rules 20, 21)', () => {
    for (const shortPage of [
      { size: 0, assurance: 'assumed' },
      { size: '100', assurance: 'assumed' },
      { size: 100, assurance: 'likely' },
      { size: 100 },
      { size: 100, assurance: 'assumed', extra: true },
      { size: 'request', assurance: 'assumed' },
    ]) {
      expect(
        errors({ ...zeroBased(), response: { shortPage } }),
      ).not.toEqual([]);
    }
    expect(
      errors({ ...zeroBased(), type: 'pageToken' }).join(),
    ).toMatch(/only on a pageNumber scheme/);
  });

  it('needs a page field where it is applied (rule 22)', () => {
    const scheme = zeroBased();
    scheme.request = {
      queryParameters: { page: { role: 'x-page' as 'page' } },
    };
    const doc = document(scheme);
    expect(() =>
      resolveEffectiveScheme(doc, doc.paths['/team/{teamId}/task']!.get!),
    ).toThrow(PaginationSchemeError);
  });
});
