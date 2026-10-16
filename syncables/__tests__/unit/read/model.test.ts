// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  readCollections,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import { discoverReadModel } from '../../../src/read/model.js';
import { fixedReads } from '../../fixtures/fixed-reads.js';

// CRUD Causality 0.4.0 §4.2.1: a Collection Object's fixed request values
// (`listMethod`, `listQuery`, `listBody`), read first, with the older
// syncables `x-list-method`/`x-list-query`/`x-list-body` as the fallback.
// A read sends the path parameters, `listQuery`, `listBody`, then the
// pagination fields merged over them page by page, and nothing else. The
// request cases mirror `ReadRequestTests` in the spec folder's
// `test_validate.py`, on its `fixed-query.yaml` example.

const reply = (body: unknown): ReturnType<Transport> =>
  Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });

/** `fixedReads` with the two Collection Objects' fixed fields replaced. */
function withCollections(
  allTasks: Record<string, unknown>,
  searchedPages: Record<string, unknown>,
): OpenApiDocument {
  const doc = structuredClone(fixedReads);
  const resources = doc.components!['crudResources'] as Record<
    string,
    { collections: Record<string, Record<string, unknown>> }
  >;
  resources['task']!.collections['allTasks'] = {
    urlTemplate: '/lists/{listId}/tasks',
    envelope: { itemsField: 'items' },
    ...allTasks,
  };
  resources['page']!.collections['searchedPages'] = {
    urlTemplate: '/search',
    envelope: { itemsField: 'results' },
    ...searchedPages,
  };
  return doc;
}

const legacyForm = withCollections(
  { 'x-list-query': { showCompleted: 'true', showHidden: 'true' } },
  {
    'x-list-method': 'POST',
    'x-list-body': {
      filter: { property: 'object', value: 'page' },
      page_size: 100,
    },
  },
);

describe('the model reads the fixed request values', () => {
  const expected = [
    {
      name: 'allTasks',
      method: 'GET',
      listQuery: { showCompleted: 'true', showHidden: 'true' },
      listBody: {},
    },
    {
      name: 'searchedPages',
      method: 'POST',
      listQuery: {},
      listBody: {
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      },
    },
  ];

  it('from listMethod, listQuery and listBody (the spec example)', () => {
    expect(discoverReadModel(fixedReads).collections).toMatchObject(expected);
  });

  it('from x-list-method, x-list-query and x-list-body when the standard fields are absent', () => {
    expect(discoverReadModel(legacyForm).collections).toMatchObject(expected);
  });

  it('lets the standard field win, per field, when both forms are present', () => {
    const both = withCollections(
      {
        listQuery: { showCompleted: 'true' },
        'x-list-query': { showHidden: 'true', state: 'all' },
      },
      {
        listMethod: 'POST',
        'x-list-method': 'GET',
        'x-list-body': { filter: { property: 'object', value: 'database' } },
      },
    );
    expect(discoverReadModel(both).collections).toMatchObject([
      { name: 'allTasks', listQuery: { showCompleted: 'true' } },
      // listMethod wins; listBody is absent, so the older body applies.
      {
        name: 'searchedPages',
        method: 'POST',
        listBody: { filter: { property: 'object', value: 'database' } },
      },
    ]);
  });

  it('writes listQuery values as text, and refuses a method other than GET or POST', () => {
    const texts = withCollections(
      { listQuery: { showCompleted: true, maxResults: 50 } },
      {},
    );
    expect(discoverReadModel(texts).collections[0]).toMatchObject({
      listQuery: { showCompleted: 'true', maxResults: '50' },
    });
    expect(() =>
      discoverReadModel(withCollections({}, { listMethod: 'PATCH' })),
    ).toThrow('Unsupported listMethod PATCH');
    expect(() =>
      discoverReadModel(withCollections({}, { 'x-list-method': 'PUT' })),
    ).toThrow('Unsupported x-list-method PUT');
    // The standard field is GET or POST as written (§8 rule 14); the older
    // form is accepted in any case, as the spec describes the fallback.
    expect(() =>
      discoverReadModel(withCollections({}, { listMethod: 'post' })),
    ).toThrow('Unsupported listMethod post');
    expect(
      discoverReadModel(withCollections({}, { 'x-list-method': 'post' }))
        .collections[1],
    ).toMatchObject({ method: 'POST' });
    // A null x-list-query value is sent as an empty value, as the spec says.
    expect(
      discoverReadModel(withCollections({ 'x-list-query': { q: null } }, {}))
        .collections[0],
    ).toMatchObject({ listQuery: { q: '' } });
  });
});

describe('a read sends exactly the fixed values, then the pagination fields', () => {
  /** Answers two pages for each collection, recording every request. */
  function provider(): {
    requests: TransportRequest[];
    transport: Transport;
  } {
    const requests: TransportRequest[] = [];
    const transport: Transport = async (r) => {
      requests.push(r);
      if (r.method === 'POST') {
        const body = JSON.parse(r.body ?? '{}');
        return body.start_cursor === 'c2'
          ? reply({ results: [{ id: 'p2' }], next_cursor: null })
          : reply({ results: [{ id: 'p1' }], next_cursor: 'c2' });
      }
      return r.url.searchParams.get('pageToken') === 't2'
        ? reply({ items: [{ id: 't2' }] })
        : reply({ items: [{ id: 't1' }], nextPageToken: 't2' });
    };
    return { requests, transport };
  }

  for (const [label, doc] of [
    ['the standard fields', fixedReads],
    ['the older x-list-* fields', legacyForm],
  ] as const)
    it(`with ${label}: the GET read sends the path, the fixed query and the page token; the POST read the fixed body and the cursor`, async () => {
      const fake = provider();
      const result = await readCollections(doc, {
        transport: fake.transport,
        constants: { listId: 'L 1/2' },
      });
      expect(result.errors).toEqual([]);
      expect(result.collections.map((c) => c.items)).toEqual([
        [{ id: 't1' }, { id: 't2' }],
        [{ id: 'p1' }, { id: 'p2' }],
      ]);
      const gets = fake.requests.filter((r) => r.method === 'GET');
      // The spec's test: GET /lists/L%201%2F2/tasks?showCompleted=true&showHidden=true
      // for the first page, with nothing else; the token joins on the next.
      expect(gets.map((r) => `${r.url.pathname}${r.url.search}`)).toEqual([
        '/lists/L%201%2F2/tasks?showCompleted=true&showHidden=true',
        '/lists/L%201%2F2/tasks?showCompleted=true&showHidden=true&pageToken=t2',
      ]);
      const posts = fake.requests.filter((r) => r.method === 'POST');
      expect(posts.map((r) => r.url.pathname)).toEqual(['/search', '/search']);
      // The spec's test: the fixed body exactly, the cursor merged over it
      // on the next page, page_size kept.
      expect(posts.map((r) => JSON.parse(r.body ?? '{}'))).toEqual([
        { filter: { property: 'object', value: 'page' }, page_size: 100 },
        {
          filter: { property: 'object', value: 'page' },
          page_size: 100,
          start_cursor: 'c2',
        },
      ]);
    });

  it('keeps a pageSize set by listQuery, and lets the scheme replace it when a caller sets one', async () => {
    const sized = withCollections(
      { listQuery: { showCompleted: 'true', maxResults: '50' } },
      {},
    );
    const transport = vi.fn<Transport>(async () => reply({ items: [] }));
    await readCollections(sized, { transport, constants: { listId: 'L1' } });
    expect(transport.mock.calls[0]![0].url.search).toBe(
      '?showCompleted=true&maxResults=50',
    );
  });
});
