// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  readCollections,
  responseIncomplete,
  validatePaginationScheme,
  type IncompleteObject,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
} from '../../../src/browser.js';

// Pagination Schemes 0.8.0 §4.4.6: the Incomplete Object. Notion's query
// pages through up to 10,000 results; past that has_more is false and every
// page carries request_status type incomplete. Invented rows.

const MARKER: IncompleteObject = {
  field: 'request_status.type',
  equals: 'incomplete',
};

const scheme = (incomplete?: IncompleteObject): PaginationSchemeObject => ({
  type: 'pageToken',
  autoDetect: false,
  request: { queryParameters: { start_cursor: { role: 'cursor' } } },
  response: {
    envelope: { itemsField: 'results' },
    bodyFields: { next_cursor: { role: 'nextCursor' } },
    ...(incomplete ? { incomplete } : {}),
  },
});

function document(s: PaginationSchemeObject): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Capped rows', version: '1.0.0' },
    servers: [{ url: 'https://rows.example.com/v1' }],
    paths: {
      '/rows': {
        get: {
          parameters: [{ name: 'start_cursor', in: 'query' }],
          'x-pagination': [{ scheme: 'capped' }],
          responses: { '200': { description: 'Rows' } },
        },
      },
      '/rows/{row}': {
        get: { responses: { '200': { description: 'One row' } } },
      },
    },
    components: {
      paginationSchemes: { capped: s },
      crudResources: {
        row: {
          identity: {
            urlTemplate: '/rows/{row}',
            bindings: { row: { field: 'id' } },
          },
          collections: { rows: { urlTemplate: '/rows' } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

function provider(pages: unknown[]): { transport: Transport; calls: number } {
  const state = {
    calls: 0,
    transport: (() => {
      const body = pages[Math.min(state.calls, pages.length - 1)];
      state.calls += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(body),
      });
    }) as Transport,
  };
  return state;
}

const capped = {
  type: 'incomplete',
  incomplete_reason: 'query_result_limit_reached',
};
const PAGES = [
  {
    results: [{ id: 'r1' }],
    next_cursor: 'c2',
    has_more: true,
    request_status: capped,
  },
  {
    results: [{ id: 'r2' }],
    next_cursor: null,
    has_more: false,
    request_status: capped,
  },
];

async function read(
  s: PaginationSchemeObject,
  pages: unknown[],
): Promise<{
  snapshot: {
    items: Record<string, unknown>[];
    complete: boolean;
    notComplete?: string;
  };
  calls: number;
  errors: string[];
}> {
  const fake = provider(pages);
  const result = await readCollections(document(s), {
    transport: fake.transport,
  });
  const [snapshot] = result.collections;
  return { snapshot: snapshot!, calls: fake.calls, errors: result.errors };
}

describe('incomplete (Pagination Schemes 0.8.0)', () => {
  it('reads every page of a marked result, and the read is not complete', async () => {
    const { snapshot, calls, errors } = await read(scheme(MARKER), PAGES);
    expect(calls).toBe(2);
    expect(snapshot.items.map((r) => r['id'])).toEqual(['r1', 'r2']);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.notComplete).toMatch(/§4\.4\.6/);
    expect(errors).toEqual([]);
  });

  it('is complete when no page is marked, and without the declaration', async () => {
    const unmarked = PAGES.map((p) => ({
      ...p,
      request_status: { type: 'complete' },
    }));
    expect((await read(scheme(MARKER), unmarked)).snapshot.complete).toBe(true);
    const bare = PAGES.map((p) => {
      const copy: Record<string, unknown> = { ...p };
      delete copy['request_status'];
      return copy;
    });
    expect((await read(scheme(MARKER), bare)).snapshot.complete).toBe(true);
    // A 0.7.1 reader (no incomplete) takes the capped read as complete.
    expect((await read(scheme(), PAGES)).snapshot.complete).toBe(true);
  });

  it('one marked page is enough', async () => {
    const pages = [
      { ...PAGES[0], request_status: { type: 'complete' } },
      PAGES[1],
    ];
    expect((await read(scheme(MARKER), pages)).snapshot.complete).toBe(false);
  });

  it('matches by JSON equality', () => {
    const numeric: IncompleteObject = { field: 'capped', in: [1, null] };
    expect(responseIncomplete(numeric, { capped: 1.0 })).toBe(true);
    expect(responseIncomplete(numeric, { capped: null })).toBe(true);
    expect(responseIncomplete(numeric, { capped: '1' })).toBe(false);
    expect(responseIncomplete(numeric, { capped: true })).toBe(false);
    expect(responseIncomplete(numeric, {})).toBe(false);
    expect(responseIncomplete(MARKER, { request_status: 'incomplete' })).toBe(
      false,
    );
    expect(responseIncomplete(MARKER, [])).toBe(false);
  });

  it('is refused on a rangeWindow or incrementalSync scheme (rule 26)', () => {
    for (const type of ['rangeWindow', 'incrementalSync'] as const) {
      expect(
        validatePaginationScheme('capped', {
          ...scheme(MARKER),
          type,
        } as PaginationSchemeObject).join(),
      ).toMatch(
        /only on a pageNumber, pageToken or nextLink scheme \(rule 26\)/,
      );
    }
    for (const type of ['pageNumber', 'nextLink'] as const) {
      const s = { ...scheme(MARKER), type } as PaginationSchemeObject;
      expect(validatePaginationScheme('capped', s).join()).not.toMatch(
        /rule 26/,
      );
    }
  });

  it('sync() keeps the rows a marked read leaves out, and reports it', async () => {
    let pages: unknown[] = [
      { results: [{ id: 'r1' }, { id: 'r2' }], next_cursor: null },
    ];
    const transport: Transport = () =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(pages[0]),
      });
    const client = createApiClient(document(scheme(MARKER)), { transport });
    expect((await client.sync()).incomplete).toEqual([]);
    pages = [
      { results: [{ id: 'r1' }], next_cursor: null, request_status: capped },
    ];
    const result = await client.sync();
    expect(result.incomplete).toEqual([
      expect.objectContaining({
        collection: 'rows',
        reason: expect.stringMatching(/incomplete/),
      }),
    ]);
    expect((await client.list('rows')).map((r) => r['id']).sort()).toEqual([
      'r1',
      'r2',
    ]);
  });

  it('validates the shape (rule 26)', () => {
    expect(validatePaginationScheme('capped', scheme(MARKER))).toEqual([]);
    expect(
      validatePaginationScheme(
        'capped',
        scheme({ field: 'x', in: ['a', 0, false, null] }),
      ),
    ).toEqual([]);
    for (const bad of [
      { field: 'a..b', equals: 1 },
      { field: '', equals: 1 },
      { field: 'a' },
      { field: 'a', equals: 1, in: [1] },
      { field: 'a', in: [] },
      { field: 'a', equals: { b: 1 } },
      { field: 'a', equals: 1, extra: 1 },
    ]) {
      expect(
        validatePaginationScheme(
          'capped',
          scheme(bad as unknown as IncompleteObject),
        ).join(),
      ).toMatch(/rule 26/);
    }
  });
});
