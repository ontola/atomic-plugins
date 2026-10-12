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
    expect(result.errors[0]).toMatch(/an earlier page returned/);
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

describe('the page size sent (review of #424)', () => {
  const sized = (): PaginationSchemeObject => ({
    type: 'pageNumber',
    autoDetect: false,
    request: {
      queryParameters: {
        page: { role: 'page' },
        per_page: { role: 'pageSize' },
      },
    },
    response: { shortPage: { size: 'request', assurance: 'documented' } },
  });
  const withSchema = (schema: Record<string, unknown>): OpenApiDocument => {
    const doc = document(sized());
    doc.paths['/team/{teamId}/task']!.get!.parameters = [
      { name: 'page', in: 'query' },
      { name: 'per_page', in: 'query', schema },
    ];
    return doc;
  };

  it('uses the parameter default when the caller passes none (readCollections, sync)', async () => {
    const sizes: string[] = [];
    const transport: Transport = (request) => {
      sizes.push(request.url.searchParams.get('per_page') ?? '');
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items: [{ id: 'a' }] }),
      });
    };
    const result = await readCollections(
      withSchema({ type: 'integer', default: 30 }),
      { transport, constants: { teamId: 'w1' } },
    );
    expect(result.errors).toEqual([]);
    expect(sizes).toEqual(['30']);
  });

  it('caps the page size at the documented maximum', async () => {
    const sizes: string[] = [];
    const transport: Transport = (request) => {
      sizes.push(request.url.searchParams.get('per_page') ?? '');
      const page = Number(request.url.searchParams.get('page'));
      const items =
        page < 3
          ? Array.from({ length: 50 }, (_, i) => ({ id: `${page}-${i}` }))
          : [];
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items }),
      });
    };
    const items = await paginate(withSchema({ type: 'integer', maximum: 50 }), {
      transport,
      path: '/team/{teamId}/task',
      pathParams: { teamId: 'w1' },
      pageSize: 500,
    });
    expect(new Set(sizes)).toEqual(new Set(['50']));
    expect(items).toHaveLength(100);
  });
});

describe('end signals and numbering (review of #415)', () => {
  const withFields = (
    assurance: 'documented' | 'assumed',
    fields: Record<string, string>,
  ): PaginationSchemeObject => {
    const scheme = zeroBased(assurance);
    scheme.response!.bodyFields = Object.fromEntries(
      Object.entries(fields).map(([name, role]) => [
        name,
        { role } as { role: 'totalPages' },
      ]),
    );
    return scheme;
  };
  const answering =
    (
      total: number,
      size: number,
      extra: (page: number) => Record<string, unknown>,
    ): { transport: Transport; pages: number[] } => {
      const pages: number[] = [];
      const transport: Transport = (request) => {
        const page = Number(request.url.searchParams.get('page'));
        pages.push(page);
        const items = Array.from(
          { length: Math.max(0, Math.min(size, total - page * size)) },
          (_, i) => ({ id: `t${page * size + i}` }),
        );
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ items, ...extra(page) }),
        });
      };
      return { transport, pages };
    };

  it('counts totalPages from start: pages 0, 1 and 2 of 3, complete whatever the assurance', async () => {
    const { transport, pages } = answering(300, 100, () => ({ pages: 3 }));
    const result = await read(withFields('assumed', { pages: 'totalPages' }), transport);
    expect(pages).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ items: 300, complete: true });
  });

  it('numbers currentPage like the page field', async () => {
    const scheme = withFields('assumed', {
      current: 'currentPage',
      pages: 'totalPages',
    });
    delete scheme.response!.shortPage;
    const { transport, pages } = answering(300, 100, (page) => ({
      current: page,
      pages: 3,
    }));
    const result = await read(scheme, transport);
    expect(pages).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ items: 300, complete: true });
  });

  it('treats a short page that the total contradicts as an error under documented', async () => {
    const { transport } = answering(150, 100, () => ({ total: 300 }));
    const documented = await read(
      withFields('documented', { total: 'totalCount' }),
      transport,
    );
    expect(documented.complete).toBe(false);
    expect(documented.errors[0]).toMatch(/says more pages follow/);
    const assumed = await read(
      withFields('assumed', { total: 'totalCount' }),
      transport,
    );
    expect(assumed).toMatchObject({ items: 150, complete: false, errors: [] });
    expect(assumed.notComplete).toMatch(/says more pages follow/);
  });

  it('takes a reported pageSize as the full size', async () => {
    const { transport, pages } = answering(120, 60, () => ({ limit: 60 }));
    const result = await read(
      withFields('documented', { limit: 'pageSize' }),
      transport,
    );
    expect(pages).toEqual([0, 1, 2]);
    expect(result).toMatchObject({ items: 120, complete: true });
  });

  it('ends with an error on an item any earlier page returned', async () => {
    let call = 0;
    const transport: Transport = () => {
      call += 1;
      const items =
        call === 1
          ? Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }))
          : call === 2
            ? Array.from({ length: 100 }, (_, i) => ({ id: `b${i}` }))
            : [{ id: 'a5' }];
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items }),
      });
    };
    const result = await read(zeroBased(), transport);
    expect(result.errors[0]).toMatch(/an earlier page returned/);
  });
});

describe('second review of #424', () => {
  it('takes a smaller page size sent as the full size', async () => {
    const scheme = zeroBased('documented');
    scheme.request!.queryParameters!['per_page'] = { role: 'pageSize' };
    const pages: string[] = [];
    const transport: Transport = (request) => {
      const page = Number(request.url.searchParams.get('page'));
      pages.push(String(page));
      const items = Array.from(
        { length: Math.max(0, Math.min(50, 250 - page * 50)) },
        (_, i) => ({ id: `t${page * 50 + i}` }),
      );
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items }),
      });
    };
    const items = await paginate(document(scheme), {
      transport,
      path: '/team/{teamId}/task',
      pathParams: { teamId: 'w1' },
      pageSize: 50,
    });
    expect(items).toHaveLength(250);
    expect(pages).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('caps the default page size at the maximum, through a $ref', async () => {
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
    const doc = document(scheme);
    doc.components!['parameters'] = {
      PerPage: {
        name: 'per_page',
        in: 'query',
        schema: { type: 'integer', default: 200, maximum: 100 },
      },
    };
    doc.paths['/team/{teamId}/task']!.get!.parameters = [
      { name: 'page', in: 'query' },
      { $ref: '#/components/parameters/PerPage' } as unknown as {
        name: string;
        in: 'query';
      },
    ];
    const sizes: string[] = [];
    const transport: Transport = (request) => {
      sizes.push(request.url.searchParams.get('per_page') ?? '');
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items: [{ id: 'a' }] }),
      });
    };
    const { walkPages, Budget } = await import('../../../src/read/pages.js');
    for await (const page of walkPages({
      document: doc,
      operation: doc.paths['/team/{teamId}/task']!.get!,
      budget: new Budget(transport),
      upstream: new URL('https://api.example.com/v2'),
      path: '/team/w1/task',
      method: 'GET',
      query: {},
      body: {},
      itemsField: 'items',
    }))
      expect(page.items).toHaveLength(1);
    expect(sizes).toEqual(['100']);
  });

  it('needs exactly one page field (rule 22)', () => {
    const scheme = zeroBased();
    scheme.request!.queryParameters!['p2'] = { role: 'page' };
    const doc = document(scheme);
    expect(() =>
      resolveEffectiveScheme(doc, doc.paths['/team/{teamId}/task']!.get!),
    ).toThrow(/exactly one request field with role page/);
  });
});

describe('third review of #424', () => {
  it('ignores a page size the scheme has no field to send', async () => {
    // size 100, no pageSize field, pageSize 50 passed: full pages are 100.
    const pages: string[] = [];
    const transport: Transport = (request) => {
      const page = Number(request.url.searchParams.get('page'));
      pages.push(String(page));
      const items = Array.from(
        { length: Math.max(0, Math.min(100, 250 - page * 100)) },
        (_, i) => ({ id: `t${page * 100 + i}` }),
      );
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify({ items }),
      });
    };
    const items = await paginate(document(zeroBased('documented')), {
      transport,
      path: '/team/{teamId}/task',
      pathParams: { teamId: 'w1' },
      pageSize: 50,
    });
    expect(items).toHaveLength(250);
    expect(pages).toEqual(['0', '1', '2']);
  });

  it('ignores a body pageSize field on a GET walk', async () => {
    // The page size field is a body field, and a GET sends no body: full
    // pages stay 100 although pageSize 50 is passed.
    const scheme: PaginationSchemeObject = {
      ...zeroBased('documented'),
      request: {
        queryParameters: { page: { role: 'page', start: 0 } },
        bodyFields: { limit: { role: 'pageSize' } },
      },
    };
    const { transport, pages } = provider(250, 100);
    const items = await paginate(document(scheme), {
      transport,
      path: '/team/{teamId}/task',
      pathParams: { teamId: 'w1' },
      pageSize: 50,
    });
    expect(items).toHaveLength(250);
    expect(pages).toEqual(['0', '1', '2']);
  });
});
