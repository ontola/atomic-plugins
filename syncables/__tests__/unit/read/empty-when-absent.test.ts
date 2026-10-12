// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  paginate,
  readCollections,
  validatePaginationScheme,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
} from '../../../src/browser.js';

// Pagination Schemes 0.7.0 §4.4.2: an Envelope Object's emptyWhenAbsent. A
// provider that leaves an empty array out (the Protocol Buffers JSON
// mapping does; Google's Tasks API is shaped so) answers an empty list
// without `items`. Invented lists and tasks.

const tasksScheme = (emptyWhenAbsent?: boolean): PaginationSchemeObject => ({
  type: 'pageToken',
  autoDetect: false,
  request: { queryParameters: { pageToken: { role: 'cursor' } } },
  response: {
    envelope: {
      itemsField: 'items',
      ...(emptyWhenAbsent === undefined ? {} : { emptyWhenAbsent }),
    },
    bodyFields: { nextPageToken: { role: 'nextCursor' } },
  },
});

function document(
  scheme: PaginationSchemeObject,
  collectionEnvelope?: Record<string, unknown>,
): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Empty lists', version: '1.0.0' },
    servers: [{ url: 'https://tasks.example.com/tasks/v1' }],
    paths: {
      '/lists/{tasklist}/tasks': {
        get: {
          parameters: [
            { name: 'tasklist', in: 'path', required: true },
            { name: 'pageToken', in: 'query' },
          ],
          'x-pagination': [{ scheme: 'tasks' }],
          responses: { '200': { description: 'Tasks' } },
        },
      },
      '/lists/{tasklist}/tasks/{task}': {
        get: { responses: { '200': { description: 'One task' } } },
      },
    },
    components: {
      paginationSchemes: { tasks: scheme },
      crudResources: {
        task: {
          identity: {
            urlTemplate: '/lists/{tasklist}/tasks/{task}',
            bindings: { task: { field: 'id' } },
          },
          collections: {
            tasks: {
              urlTemplate: '/lists/{tasklist}/tasks',
              ...(collectionEnvelope ? { envelope: collectionEnvelope } : {}),
            },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

/** Answers the pages in turn, as bodies. */
function provider(pages: unknown[]): Transport {
  let call = 0;
  return () => {
    const body = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(body),
    });
  };
}

const read = async (
  doc: OpenApiDocument,
  pages: unknown[],
): Promise<{ complete: boolean; items: number; errors: string[] }> => {
  const result = await readCollections(doc, {
    transport: provider(pages),
    constants: { tasklist: 'l1' },
  });
  const [snapshot] = result.collections;
  return {
    complete: snapshot!.complete,
    items: snapshot!.items.length,
    errors: result.errors,
  };
};

const EMPTY = { kind: 'tasks#tasks', etag: '"e1"' };

describe('emptyWhenAbsent on the scheme envelope', () => {
  it('reads a list without items as empty and complete', async () => {
    expect(await read(document(tasksScheme(true)), [EMPTY])).toEqual({
      complete: true,
      items: 0,
      errors: [],
    });
  });

  it('ends on a later page without items', async () => {
    const pages = [{ items: [{ id: 't1' }], nextPageToken: 'p2' }, EMPTY];
    expect(await read(document(tasksScheme(true)), pages)).toMatchObject({
      complete: true,
      items: 1,
    });
  });

  it('still fails the read without the declaration', async () => {
    for (const scheme of [tasksScheme(), tasksScheme(false)]) {
      const result = await read(document(scheme), [EMPTY]);
      expect(result.complete).toBe(false);
      expect(result.errors.join()).toMatch(/No items array at items/);
    }
  });

  it('still fails on a present value that is not an array', async () => {
    for (const body of [
      { items: null },
      { items: {} },
      { items: 'none' },
      ['t1'],
    ]) {
      const result = await read(document(tasksScheme(true)), [body]);
      expect(result.complete).toBe(false);
      expect(result.errors.join()).toMatch(/No items array at items/);
    }
  });

  it('reads a dot-path as absent only where an object lacks the next segment', async () => {
    const scheme = tasksScheme(true);
    scheme.response!.envelope!.itemsField = 'data.items';
    expect((await read(document(scheme), [{}])).items).toBe(0);
    expect((await read(document(scheme), [{ data: {} }])).items).toBe(0);
    for (const body of [{ data: null }, { data: [] }, { data: 'x' }]) {
      expect((await read(document(scheme), [body])).complete).toBe(false);
    }
  });

  it('is honoured by paginate', async () => {
    const items = await paginate(document(tasksScheme(true)), {
      transport: provider([EMPTY]),
      path: '/lists/{tasklist}/tasks',
      pathParams: { tasklist: 'l1' },
    });
    expect(items).toEqual([]);
  });
});

describe('emptyWhenAbsent on a Collection Object envelope', () => {
  it('takes the collection envelope, which wins over the scheme one', async () => {
    const scheme = tasksScheme();
    delete scheme.response!.envelope;
    expect(
      await read(
        document(scheme, { itemsField: 'items', emptyWhenAbsent: true }),
        [EMPTY],
      ),
    ).toEqual({ complete: true, items: 0, errors: [] });
    const strict = await read(document(scheme, { itemsField: 'items' }), [
      EMPTY,
    ]);
    expect(strict.complete).toBe(false);
  });

  it('is ignored on a body-root envelope', async () => {
    const scheme = tasksScheme();
    delete scheme.response!.envelope;
    const result = await read(
      document(scheme, { itemsField: null, emptyWhenAbsent: true }),
      [EMPTY],
    );
    expect(result.complete).toBe(false);
  });
});

describe('emptyWhenAbsent in ApiClient.paginate', () => {
  it('takes the matching collection envelope with its emptyWhenAbsent', async () => {
    const scheme = tasksScheme();
    delete scheme.response!.envelope;
    const client = createApiClient(
      document(scheme, { itemsField: 'items', emptyWhenAbsent: true }),
      { transport: provider([EMPTY]) },
    );
    expect(
      await client.paginate('/lists/{tasklist}/tasks', {
        pathParams: { tasklist: 'l1' },
      }),
    ).toEqual([]);
  });
});

describe('validation (rule 23)', () => {
  it('accepts a boolean with a non-empty itemsField only', () => {
    expect(validatePaginationScheme('tasks', tasksScheme(true))).toEqual([]);
    const bad = (envelope: Record<string, unknown>): string[] =>
      validatePaginationScheme('tasks', {
        ...tasksScheme(),
        response: { envelope } as PaginationSchemeObject['response'] & object,
      });
    expect(bad({ itemsField: 'items', emptyWhenAbsent: 'yes' })).toEqual([
      expect.stringMatching(/emptyWhenAbsent must be a boolean/),
    ]);
    for (const envelope of [
      { emptyWhenAbsent: true },
      { itemsField: null, emptyWhenAbsent: true },
      { itemsField: '', emptyWhenAbsent: false },
    ])
      expect(bad(envelope)).toEqual([expect.stringMatching(/rule 23/)]);
  });
});
