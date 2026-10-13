// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  paginate,
  readCollections,
  invalidAutoDetected,
  readPlatform,
  resolveEffectiveScheme,
  responseIncomplete,
  validatePaginationScheme,
  type OpenApiDocument,
  type IncompleteObject,
  type PaginationSchemeObject,
  type Transport,
  type WalkOutcome,
} from '../../../src/browser.js';

// Pagination Schemes 0.8.0 §4.4.6, `response.incomplete`: a response body
// value that marks the result as cut short by the server. Shaped like the
// spec's examples/incomplete-marker.yaml and Notion's Query a data source,
// which past 10,000 results answers `has_more: false` (no next cursor) and
// marks every page `request_status: { type: incomplete }`. A marked read is
// not complete: its items are real, but nothing is concluded about records
// it does not return. Invented data.

const capped = (
  incomplete: Record<string, unknown> = {
    field: 'request_status.type',
    equals: 'incomplete',
  },
): PaginationSchemeObject =>
  ({
    type: 'pageToken',
    autoDetect: false,
    request: {
      bodyFields: {
        start_cursor: { role: 'cursor' },
        page_size: { role: 'pageSize' },
      },
    },
    response: {
      envelope: { itemsField: 'results' },
      bodyFields: { next_cursor: { role: 'nextCursor' } },
      incomplete,
    },
  }) as unknown as PaginationSchemeObject;

function document(
  options: {
    scheme?: PaginationSchemeObject;
    absent?: 'deleted' | 'removed' | undefined;
  } = {},
): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Capped query', version: '1.0.0' },
    servers: [{ url: 'https://api.notion.example/v1' }],
    paths: {
      '/data_sources/{data_source_id}/query': {
        post: {
          parameters: [{ name: 'data_source_id', in: 'path', required: true }],
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          'x-pagination': [{ scheme: 'cappedQuery' }],
          responses: { '200': { description: 'One page of rows' } },
        },
      },
      '/pages/{page_id}': {
        get: { responses: { '200': { description: 'One row' } } },
        patch: { responses: { '200': { description: 'Updated' } } },
      },
    },
    components: {
      paginationSchemes: { cappedQuery: options.scheme ?? capped() },
      crudResources: {
        row: {
          identity: {
            urlTemplate: '/pages/{page_id}',
            bindings: { page_id: { field: 'id' } },
          },
          collections: {
            rows: {
              urlTemplate: '/data_sources/{data_source_id}/query',
              listMethod: 'POST',
              ...(options.absent
                ? { 'x-completeness': { absent: options.absent } }
                : {}),
            },
          },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

type Row = Record<string, unknown>;

/**
 * A data source answering `pages` (each a list of rows), following
 * `start_cursor`; the last page has `next_cursor: null` and
 * `has_more: false`. With `marked`, every page carries Notion's
 * `request_status` for a capped result. Item GETs answer `itemStatus`;
 * a PATCH answers 503.
 */
function server(): {
  set: (pages: Row[][], marked?: boolean) => void;
  itemStatus: number;
  requests: string[];
  transport: Transport;
} {
  let pages: Row[][] = [];
  let marked = false;
  const fake = {
    itemStatus: 503,
    requests: [] as string[],
    set: (next: Row[][], mark = false): void => {
      pages = next;
      marked = mark;
    },
    transport: (async (request) => {
      fake.requests.push(`${request.method} ${request.url.pathname}`);
      if (request.method === 'POST') {
        const sent = JSON.parse(request.body ?? '{}') as Row;
        const index = sent['start_cursor'] ? Number(sent['start_cursor']) : 0;
        const last = index >= pages.length - 1;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            object: 'list',
            results: pages[index] ?? [],
            has_more: !last,
            next_cursor: last ? null : String(index + 1),
            ...(marked
              ? {
                  request_status: {
                    type: 'incomplete',
                    incomplete_reason: 'query_result_limit_reached',
                  },
                }
              : {}),
          }),
        };
      }
      return {
        status: request.method === 'PATCH' ? 503 : fake.itemStatus,
        headers: {},
        body: JSON.stringify({ message: 'busy' }),
      };
    }) as Transport,
  };
  return fake;
}

const a: Row = { id: 'a', title: 'A' };
const b: Row = { id: 'b', title: 'B' };
const c: Row = { id: 'c', title: 'C' };
const d: Row = { id: 'd', title: 'D' };
const context = { data_source_id: 'ds1' };

describe('responseIncomplete (response_incomplete)', () => {
  const marker = (m: Record<string, unknown>): IncompleteObject =>
    m as unknown as IncompleteObject;

  it('marks a body whose value at the dot-path equals the marker', () => {
    const m = marker({ field: 'request_status.type', equals: 'incomplete' });
    expect(
      responseIncomplete(m, { request_status: { type: 'incomplete' } }),
    ).toBe(true);
    expect(
      responseIncomplete(m, { request_status: { type: 'complete' } }),
    ).toBe(false);
    expect(responseIncomplete(m, { request_status: {} })).toBe(false);
    expect(responseIncomplete(m, { request_status: 'incomplete' })).toBe(false);
    expect(responseIncomplete(m, {})).toBe(false);
    expect(responseIncomplete(m, [])).toBe(false);
    expect(responseIncomplete(m, 'incomplete')).toBe(false);
  });

  it('compares by JSON equality', () => {
    const zero = marker({ field: 'capped', equals: 0 });
    expect(responseIncomplete(zero, { capped: 0 })).toBe(true);
    expect(responseIncomplete(zero, { capped: 0.0 })).toBe(true);
    expect(responseIncomplete(zero, { capped: '0' })).toBe(false);
    expect(responseIncomplete(zero, { capped: false })).toBe(false);
    const listed = marker({ field: 'capped', in: [1, null] });
    expect(responseIncomplete(listed, { capped: 1.0 })).toBe(true);
    expect(responseIncomplete(listed, { capped: null })).toBe(true);
    expect(responseIncomplete(listed, { capped: '1' })).toBe(false);
    expect(responseIncomplete(listed, { capped: true })).toBe(false);
    expect(responseIncomplete(listed, {})).toBe(false);
  });

  it('takes any value of in, and reads only own properties', () => {
    const m = marker({ field: 'state', in: ['capped', 'truncated'] });
    expect(responseIncomplete(m, { state: 'truncated' })).toBe(true);
    expect(responseIncomplete(m, { state: 'done' })).toBe(false);
    expect(
      responseIncomplete(marker({ field: 'constructor', in: ['x'] }), {}),
    ).toBe(false);
  });

  it('reads the names literally: a name holding a dot cannot be addressed', () => {
    const body = { meta: { 'request.status': 'capped' } };
    expect(
      responseIncomplete(
        marker({ field: 'meta.request.status', equals: 'capped' }),
        body,
      ),
    ).toBe(false);
    expect(
      responseIncomplete(
        marker({ field: 'meta["request.status"]', equals: 'capped' }),
        body,
      ),
    ).toBe(false);
  });
});

describe('rule 26: an Incomplete Object the validator refuses', () => {
  it.each([
    [{ field: 'x' }, 'exactly one of equals and in'],
    [{ field: 'x', equals: 1, in: [1] }, 'exactly one of equals and in'],
    [{ field: '', equals: 1 }, 'segments are non-empty'],
    [{ field: 'a..b', equals: 1 }, 'segments are non-empty'],
    [{ equals: 1 }, 'segments are non-empty'],
    [{ field: 'x', equals: { a: 1 } }, 'equals must be a JSON scalar'],
    [{ field: 'x', in: [] }, 'nonempty array of JSON scalars'],
    [{ field: 'x', in: [[1]] }, 'nonempty array of JSON scalars'],
    [
      { field: 'x', equals: 1, other: true },
      'is not an Incomplete Object field',
    ],
    ['incomplete', 'must be an object'],
  ])('refuses %j', (marker, message) => {
    expect(
      validatePaginationScheme(
        'cappedQuery',
        capped(marker as Record<string, unknown>),
      ).join('\n'),
    ).toContain(message);
  });

  it('accepts the example, with x- fields and a description', () => {
    expect(
      validatePaginationScheme(
        'cappedQuery',
        capped({
          field: 'request_status.type',
          equals: 'incomplete',
          description: 'Notion past 10,000 results',
          'x-note': 1,
        }),
      ),
    ).toEqual([]);
  });

  it('allows it only on a pageNumber, pageToken or nextLink scheme', () => {
    for (const type of ['rangeWindow', 'incrementalSync'])
      expect(
        validatePaginationScheme('w', {
          ...capped(),
          type,
        } as unknown as PaginationSchemeObject).join('\n'),
      ).toContain('allowed only on a pageNumber, pageToken or nextLink scheme');
    for (const type of ['pageNumber', 'nextLink'])
      expect(
        validatePaginationScheme('w', {
          ...capped(),
          type,
        } as unknown as PaginationSchemeObject).join('\n'),
      ).not.toContain('rule 26');
  });

  it('fails a read whose explicit scheme it makes invalid, never reading it as complete', async () => {
    const fake = server();
    fake.set([[a, b]]);
    const result = await readCollections(
      document({ scheme: capped({ field: 'request_status.type' }) }),
      { transport: fake.transport, constants: context },
    );
    expect(result.collections[0]!.complete).toBe(false);
    expect(result.errors.join('\n')).toMatch(/cappedQuery/);
  });
});

describe('a read with a marked response is not complete', () => {
  it('pages on as the scheme says, and reports why', async () => {
    const fake = server();
    fake.set([[a, b], [c]], true);
    const result = await readCollections(document(), {
      transport: fake.transport,
      constants: context,
    });
    const [snapshot] = result.collections;
    expect(fake.requests).toEqual([
      'POST /v1/data_sources/ds1/query',
      'POST /v1/data_sources/ds1/query',
    ]);
    expect(snapshot!.items.map((r) => r['id'])).toEqual(['a', 'b', 'c']);
    expect(snapshot!.complete).toBe(false);
    expect(snapshot!.notComplete).toMatch(
      /the server marked the result incomplete .*request_status\.type "incomplete".*Pagination Schemes 0\.8\.0 §4\.4\.6/,
    );
    expect(snapshot!.error).toBeUndefined();
  });

  it('needs only one marked response', async () => {
    const fake = server();
    let calls = 0;
    const transport: Transport = async (request) => {
      const response = await fake.transport(request);
      calls += 1;
      if (calls === 2) {
        const body = JSON.parse(response.body) as Row;
        body['request_status'] = { type: 'incomplete' };
        return { ...response, body: JSON.stringify(body) };
      }
      return response;
    };
    fake.set([[a], [b], [c]]);
    const result = await readCollections(document(), {
      transport,
      constants: context,
    });
    expect(result.collections[0]!.items.map((r) => r['id'])).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(result.collections[0]!.complete).toBe(false);
  });

  it('is complete when no response is marked', async () => {
    const fake = server();
    fake.set([[a, b], [c]]);
    const result = await readCollections(document(), {
      transport: fake.transport,
      constants: context,
    });
    expect(result.collections[0]!.complete).toBe(true);
  });

  it('is listed in readPlatform’s incomplete, with its records', async () => {
    const fake = server();
    fake.set([[a, b]], true);
    const result = await readPlatform(document(), {
      platform: 'notion-like',
      transport: fake.transport,
      constants: context,
    });
    expect(result.records.map((r) => r.id)).toEqual(['a', 'b']);
    expect(result.incomplete).toEqual([
      {
        collection: 'rows',
        context,
        reason: expect.stringMatching(/marked the result incomplete/),
      },
    ]);
  });

  it('fills paginate’s outcome', async () => {
    const fake = server();
    fake.set([[a], [b]], true);
    const outcome: WalkOutcome = { complete: true };
    const items = await paginate(document(), {
      transport: fake.transport,
      path: '/data_sources/{data_source_id}/query',
      method: 'POST',
      pathParams: context,
      outcome,
    });
    expect(items.map((r) => r['id'])).toEqual(['a', 'b']);
    expect(outcome.complete).toBe(false);
    expect(outcome.reason).toMatch(/marked the result incomplete/);
    // The same outcome passed to a walk with no marked response: the
    // earlier walk's mark does not carry over.
    fake.set([[a], [b]]);
    await paginate(document(), {
      transport: fake.transport,
      path: '/data_sources/{data_source_id}/query',
      method: 'POST',
      pathParams: context,
      outcome,
    });
    expect(outcome).toEqual({ complete: true });
  });

  it('reads an auto-detected scheme whose marker the validator refuses as not complete', async () => {
    const scheme = {
      ...capped({ field: 'request_status.type' }),
      autoDetect: true,
    } as unknown as PaginationSchemeObject;
    expect(validatePaginationScheme('cappedQuery', scheme)).not.toEqual([]);
    const doc = document({ scheme });
    const operation = doc.paths['/data_sources/{data_source_id}/query']!.post!;
    delete (operation as Record<string, unknown>)['x-pagination'];
    // The body declares the scheme's fields, so it would be auto-detected.
    operation.requestBody!.content!['application/json']!.schema = {
      type: 'object',
      properties: {
        start_cursor: { type: 'string' },
        page_size: { type: 'integer' },
      },
    };
    expect(resolveEffectiveScheme(doc, operation)).toBeUndefined();
    expect(invalidAutoDetected(doc, operation)).toMatchObject({
      schemeName: 'cappedQuery',
    });
    // Two pages; without a scheme only the first is read, and it is not
    // taken for the whole collection.
    const fake = server();
    fake.set([[a, b], [c]]);
    const result = await readCollections(doc, {
      transport: fake.transport,
      constants: context,
    });
    const snapshot = result.collections[0]!;
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.items.map((r) => r['id'])).toEqual(['a', 'b']);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.notComplete).toMatch(
      /"cappedQuery" matches this operation by auto-detection but is invalid/,
    );
  });
});

describe('sync() with a capped result (has_more false, every page marked)', () => {
  it.each([
    ['no completeness declaration', undefined],
    ['absent: removed', 'removed' as const],
    ['absent: deleted', 'deleted' as const],
  ])(
    'removes nothing and reports the read incomplete, under %s',
    async (_label, absent) => {
      const fake = server();
      const client = createApiClient(document({ absent }), {
        transport: fake.transport,
        constants: context,
        retry: { baseDelayMs: 60_000 },
        missingRecordChecks: 'all',
      });
      fake.set([
        [a, b],
        [c, d],
      ]);
      await client.sync();
      expect((await client.list('rows')).map((r) => r['id'])).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
      // A held update of c, between retries.
      await client.update('rows', 'c', { title: 'C2' });
      await vi.waitFor(() =>
        expect(client.pendingWrites()[0]?.attempts).toBe(1),
      );
      // The capped result: two rows, has_more false, every page marked.
      fake.set([[a, { ...b, title: 'B2' }]], true);
      fake.requests.length = 0;
      const result = await client.sync();
      expect(result.incomplete).toEqual([
        {
          collection: 'rows',
          context,
          reason: expect.stringMatching(
            /marked the result incomplete.*§4\.4\.6/,
          ),
        },
      ]);
      // Nothing removed or checked; what the read returned is applied.
      expect((await client.list('rows')).map((r) => r['id']).sort()).toEqual([
        'a',
        'b',
        'c',
        'd',
      ]);
      expect((await client.get('rows', 'b'))?.['title']).toBe('B2');
      expect(fake.requests.filter((r) => r.startsWith('GET'))).toEqual([]);
      expect(client.pendingWrites()).toMatchObject([
        { id: 'c', state: 'pending' },
      ]);
      expect(client.pendingWrites()[0]).not.toHaveProperty('missingRecord');
      expect(client.presence()).toEqual([]);
    },
  );
});
