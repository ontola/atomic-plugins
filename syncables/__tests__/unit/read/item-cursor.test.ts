// @wc-ignore-file
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  paginate,
  PageReadError,
  validatePaginationScheme,
  type OpenApiDocument,
  type PaginationSchemeObject,
  type Transport,
  type WalkOutcome,
} from '../../../src/browser.js';

// Pagination Schemes 0.9.0 §4.3.3: a cursor read from the previous page's
// last item (`fromLastItem`, Stripe's `starting_after`), ended by an empty
// page or `hasMore: false`. Ports the spec's ItemCursorTests (test_validate.py)
// on its example (examples/item-cursor.yaml), against `paginate`, plus the
// stricter rule that a present non-boolean `hasMore` is an error, and a
// sync. Invented data.

const repository = new URL('../../../../', import.meta.url);
const example = (): OpenApiDocument =>
  yaml.load(
    readFileSync(
      new URL(
        'openapi-extensions/spec/pagination-schemes/examples/item-cursor.yaml',
        repository,
      ),
      'utf8',
    ),
  ) as OpenApiDocument;

type Json = Record<string, unknown>;

const scheme = (doc: OpenApiDocument): Json =>
  doc.components!.paginationSchemes!['afterLastObject'] as unknown as Json;

/** Customers cus_000.. in pages of `size`, after `starting_after`. */
function provider(
  total: number,
  { size = 2, hasMore = true, key = 'id' } = {},
): { calls: URL[]; transport: Transport } {
  const ids = Array.from(
    { length: total },
    (_, i) => `cus_${String(i).padStart(3, '0')}`,
  );
  const fake = {
    calls: [] as URL[],
    transport: (async (request) => {
      fake.calls.push(request.url);
      const after = request.url.searchParams.get('starting_after');
      const start = after ? ids.indexOf(after) + 1 : 0;
      const body: Json = {
        object: 'list',
        data: ids.slice(start, start + size).map((id) => ({ [key]: id })),
      };
      if (hasMore) body['has_more'] = start + size < total;
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    }) as Transport,
  };
  return fake;
}

/** Answers `pages` in turn. */
const answering = (pages: Json[]): { calls: URL[]; transport: Transport } => {
  let at = 0;
  const fake = {
    calls: [] as URL[],
    transport: (async (request) => {
      fake.calls.push(request.url);
      const page = pages[Math.min(at, pages.length - 1)];
      at += 1;
      return { status: 200, headers: {}, body: JSON.stringify(page) };
    }) as Transport,
  };
  return fake;
};

async function read(
  transport: Transport,
  doc = example(),
  pageSize?: number,
): Promise<{ items: Json[]; outcome: WalkOutcome }> {
  const outcome: WalkOutcome = { complete: true };
  const items = await paginate(doc, {
    transport,
    path: '/v1/customers',
    outcome,
    ...(pageSize ? { pageSize } : {}),
  });
  return { items, outcome };
}

describe('the shape (rules 27-29)', () => {
  const problems = (change: (s: Json) => unknown): string[] => {
    const doc = example();
    const s = scheme(doc);
    change(s);
    return validatePaginationScheme(
      'afterLastObject',
      s as unknown as PaginationSchemeObject,
    );
  };
  const query = (s: Json): Json =>
    (s['request'] as Json)['queryParameters'] as Json;

  it('accepts the example', () => {
    expect(problems(() => {})).toEqual([]);
  });

  it.each([
    [
      'fromLastItem on a pageSize field',
      (s: Json): unknown =>
        ((query(s)['limit'] as Json)['fromLastItem'] = 'id'),
      /rule 27/,
    ],
    [
      'an empty fromLastItem',
      (s: Json): unknown =>
        ((query(s)['starting_after'] as Json)['fromLastItem'] = ''),
      /rule 27/,
    ],
    [
      'a fromLastItem with an empty name',
      (s: Json): unknown =>
        ((query(s)['starting_after'] as Json)['fromLastItem'] = 'a..b'),
      /rule 27/,
    ],
    [
      'a fromLastItem that is not a string',
      (s: Json): unknown =>
        ((query(s)['starting_after'] as Json)['fromLastItem'] = 3),
      /rule 27/,
    ],
    [
      'a next token beside it',
      (s: Json): unknown =>
        (((s['response'] as Json)['bodyFields'] as Json)['next'] = {
          role: 'nextCursor',
        }),
      /rule 28/,
    ],
    [
      'a next link beside it',
      (s: Json): unknown =>
        (((s['response'] as Json)['bodyFields'] as Json)['next'] = {
          role: 'nextLink',
        }),
      /rule 28/,
    ],
    [
      'two fromLastItem fields',
      (s: Json): unknown =>
        (query(s)['ending_before'] = {
          role: 'pageToken',
          fromLastItem: 'id',
        }),
      /rule 28/,
    ],
    [
      'another scheme type',
      (s: Json): unknown => (s['type'] = 'nextLink'),
      /rule 28/,
    ],
    [
      'hasMore in a header',
      (s: Json): unknown =>
        ((s['response'] as Json)['headers'] = {
          'X-Has-More': { role: 'hasMore' },
        }),
      /rule 29/,
    ],
    [
      'hasMore without fromLastItem',
      (s: Json): unknown =>
        delete (query(s)['starting_after'] as Json)['fromLastItem'],
      /rule 29/,
    ],
  ])('refuses %s', (_label, change, rule) => {
    expect(problems(change)).toContainEqual(expect.stringMatching(rule));
  });

  it('refuses an override that adds a next token, after the merge', async () => {
    const doc = example();
    (doc.paths['/v1/customers']!.get!['x-pagination'] as Json[])[0]![
      'overrides'
    ] = {
      response: { bodyFields: { next: { role: 'nextCursor' } } },
    };
    await expect(read(provider(3).transport, doc)).rejects.toThrow(/rule 28/);
  });
});

describe('a read by the last item', () => {
  it('sends the last id and ends at has_more false, complete', async () => {
    const fake = provider(5);
    const { items, outcome } = await read(fake.transport, example(), 2);
    expect(items).toHaveLength(5);
    expect(outcome.complete).toBe(true);
    expect(fake.calls.map((u) => u.searchParams.get('starting_after'))).toEqual(
      [null, 'cus_001', 'cus_003'],
    );
    expect(new Set(fake.calls.map((u) => u.searchParams.get('limit')))).toEqual(
      new Set(['2']),
    );
  });

  it('ends at an empty page without has_more', async () => {
    const fake = provider(4, { hasMore: false });
    const { items, outcome } = await read(fake.transport);
    expect(items).toHaveLength(4);
    expect(outcome.complete).toBe(true);
    expect(fake.calls.map((u) => u.searchParams.get('starting_after'))).toEqual(
      [null, 'cus_001', 'cus_003'],
    );
  });

  it('sends integer ids in decimal', async () => {
    const fake = answering([{ data: [{ id: 7 }, { id: 9 }] }, { data: [] }]);
    const { outcome } = await read(fake.transport);
    expect(fake.calls[1]!.searchParams.get('starting_after')).toBe('9');
    expect(outcome.complete).toBe(true);
  });

  it('does not end at a short page', async () => {
    const fake = answering([
      { data: [{ id: 'a' }], has_more: true },
      { data: [{ id: 'b' }], has_more: false },
    ]);
    const { items } = await read(fake.transport, example(), 2);
    expect(items).toHaveLength(2);
  });

  it('uses the whole item where there is no identity', async () => {
    const doc = example();
    (
      (scheme(doc)['request'] as Json)['queryParameters'] as Record<
        string,
        Json
      >
    )['starting_after']!['fromLastItem'] = 'key';
    const fake = answering([
      { data: [{ key: 'a' }, { key: 'b' }] },
      { data: [] },
    ]);
    expect((await read(fake.transport, doc)).outcome.complete).toBe(true);
  });
});

describe('a read by the last item ends with an error', () => {
  it.each([
    [
      'a last item without the field',
      [{ data: [{ name: 'x' }], has_more: true }],
      /no usable id/,
    ],
    [
      'a boolean id',
      [{ data: [{ id: true }], has_more: true }],
      /no usable id/,
    ],
    [
      'a fractional id',
      [{ data: [{ id: 1.5 }], has_more: true }],
      /no usable id/,
    ],
    [
      'an integer id past 2^53, already rounded when parsed',
      [{ data: [{ id: 2 ** 53 }], has_more: true }],
      /not a safe integer/,
    ],
    [
      'an integer id of 1e21, which String() writes as 1e+21',
      [{ data: [{ id: 1e21 }], has_more: true }],
      /not a safe integer/,
    ],
    [
      'a repeated item',
      [
        { data: [{ id: 'a' }], has_more: true },
        { data: [{ id: 'b' }, { id: 'a' }], has_more: true },
      ],
      /earlier page/,
    ],
    [
      'an empty page that says has_more true',
      [
        { data: [{ id: 'a' }], has_more: true },
        { data: [], has_more: true },
      ],
      /hasMore true/,
    ],
    [
      'a has_more that is not a boolean',
      [{ data: [{ id: 'a' }], has_more: 'false' }],
      /not a boolean/,
    ],
    [
      'a has_more of 0',
      [{ data: [{ id: 'a' }], has_more: 0 }],
      /not a boolean/,
    ],
  ])('on %s', async (_label, pages, message) => {
    const error = await read(answering(pages).transport).catch((e) => e);
    expect(error).toBeInstanceOf(PageReadError);
    expect(String(error)).toMatch(message);
  });

  it('on a cursor that does not move (a server that ignores it)', async () => {
    // Read by `key`, so the items differ by id and only the cursor repeats.
    const doc = example();
    (
      (scheme(doc)['request'] as Json)['queryParameters'] as Record<
        string,
        Json
      >
    )['starting_after']!['fromLastItem'] = 'key';
    const fake = answering([
      { data: [{ id: '1', key: 'k' }], has_more: true },
      { data: [{ id: '2', key: 'k' }], has_more: true },
    ]);
    const error = await read(fake.transport, doc).catch((e) => e);
    expect(error).toBeInstanceOf(PageReadError);
    expect(String(error)).toMatch(/did not move/);
  });

  it('on a has_more of null (0.9.1: only an absent one is no information)', async () => {
    const error = await read(
      answering([{ data: [{ id: 'a' }], has_more: null }, { data: [] }])
        .transport,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(PageReadError);
    expect(String(error)).toMatch(/null, not a boolean/);
  });

  it('but not on an absent has_more, which decides nothing', async () => {
    const fake = answering([{ data: [{ id: 'a' }] }, { data: [] }]);
    expect((await read(fake.transport)).outcome.complete).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });
});

describe('a marked page', () => {
  const marked = (): OpenApiDocument => {
    const doc = example();
    (scheme(doc)['response'] as Json)['incomplete'] = {
      field: 'capped',
      equals: true,
    };
    return doc;
  };

  it('makes the read not complete, also when only the first page is marked', async () => {
    let calls = 0;
    const fake = provider(5);
    const firstOnly: Transport = async (request) => {
      const response = await fake.transport(request);
      calls += 1;
      const body = JSON.parse(response.body) as Json;
      body['capped'] = calls === 1;
      return { ...response, body: JSON.stringify(body) };
    };
    const { items, outcome } = await read(firstOnly, marked());
    expect(items).toHaveLength(5);
    expect(outcome.complete).toBe(false);
    expect(outcome.reason).toMatch(/marked the result incomplete/);
  });
});

describe('sync() through a read by the last item', () => {
  it('reads every page of a CRUD collection, and removes what a later complete read lacks', async () => {
    const doc = example();
    doc.paths['/v1/customers/{id}'] = {
      get: { responses: { '200': { description: 'A customer' } } },
    } as never;
    doc.components!['crudResources'] = {
      customer: {
        identity: {
          urlTemplate: '/v1/customers/{id}',
          bindings: { id: { field: 'id' } },
        },
        collections: { customers: { urlTemplate: '/v1/customers' } },
      },
    };
    let total = 5;
    const transport: Transport = (request) =>
      provider(total).transport(request);
    const client = createApiClient(doc, { transport });
    const first = await client.sync();
    expect(first.incomplete).toEqual([]);
    expect(await client.list('customers')).toHaveLength(5);
    total = 3;
    await client.sync();
    expect((await client.list('customers')).map((c) => c['id']).sort()).toEqual(
      ['cus_000', 'cus_001', 'cus_002'],
    );
  });
});

describe('a cursor in a POST body', () => {
  it('sends the last id in the body, the first request without it', async () => {
    const doc = example();
    const s = scheme(doc);
    s['request'] = {
      bodyFields: {
        starting_after: { role: 'cursor', fromLastItem: 'id' },
      },
    };
    doc.paths['/v1/customers/search'] = {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: { starting_after: { type: 'string' } },
              },
            },
          },
        },
        'x-pagination': [{ scheme: 'afterLastObject' }],
        responses: { '200': { description: 'A page of customers.' } },
      },
    } as never;
    const bodies: (Json | undefined)[] = [];
    const pages = [
      { data: [{ id: 'a' }, { id: 'b' }], has_more: true },
      { data: [{ id: 'c' }], has_more: false },
    ];
    const transport: Transport = async (request) => {
      bodies.push(
        request.body ? (JSON.parse(request.body) as Json) : undefined,
      );
      return {
        status: 200,
        headers: {},
        body: JSON.stringify(pages[bodies.length - 1]),
      };
    };
    const outcome: WalkOutcome = { complete: true };
    const items = await paginate(doc, {
      transport,
      path: '/v1/customers/search',
      method: 'POST',
      body: { query: 'x' },
      outcome,
    });
    expect(items.map((i) => i['id'])).toEqual(['a', 'b', 'c']);
    expect(bodies).toEqual([
      { query: 'x' },
      { query: 'x', starting_after: 'b' },
    ]);
    expect(outcome.complete).toBe(true);
  });
});

// Rule 28 allows another pageToken- or cursor-role field beside the
// fromLastItem one (Stripe's ending_before beside starting_after). Only the
// fromLastItem field carries the cursor, as in the spec's read_item_cursor:
// sending it in ending_before too bounded the read from both sides, the
// second page came back empty, and the read ended with 2 of 5 items as
// complete (#600's review).
describe('another cursor-role field beside fromLastItem', () => {
  const ids = ['a', 'b', 'c', 'd', 'e'];
  /** Honours both bounds, as Stripe does. */
  const bounded = (
    read: (request: Parameters<Transport>[0]) => Json,
  ): { requests: Json[]; transport: Transport } => {
    const fake = {
      requests: [] as Json[],
      transport: (async (request) => {
        const params = read(request);
        fake.requests.push(params);
        const after = params['starting_after'] as string | undefined;
        const before = params['ending_before'] as string | undefined;
        const from = after ? ids.indexOf(after) + 1 : 0;
        const to = before ? ids.indexOf(before) : ids.length;
        const data = ids
          .slice(from, Math.min(to, from + 2))
          .map((id) => ({ id }));
        const body = { data, has_more: from + 2 < to };
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      }) as Transport,
    };
    return fake;
  };

  it('is valid, and gets no cursor in the query', async () => {
    const doc = example();
    ((scheme(doc)['request'] as Json)['queryParameters'] as Json)[
      'ending_before'
    ] = { role: 'pageToken' };
    expect(
      validatePaginationScheme(
        'afterLastObject',
        scheme(doc) as unknown as PaginationSchemeObject,
      ),
    ).toEqual([]);
    const fake = bounded((request) =>
      Object.fromEntries(request.url.searchParams),
    );
    const { items, outcome } = await read(fake.transport, doc);
    expect(items.map((item) => item['id'])).toEqual(ids);
    expect(outcome.complete).toBe(true);
    expect(fake.requests.every((params) => !('ending_before' in params))).toBe(
      true,
    );
  });

  it('gets no cursor in a POST body', async () => {
    const doc = example();
    scheme(doc)['request'] = {
      bodyFields: {
        starting_after: { role: 'cursor', fromLastItem: 'id' },
        ending_before: { role: 'cursor' },
      },
    };
    doc.paths['/v1/customers/search'] = {
      post: {
        'x-pagination': [{ scheme: 'afterLastObject' }],
        responses: { '200': { description: 'A page of customers.' } },
      },
    } as never;
    const fake = bounded((request) =>
      request.body ? (JSON.parse(request.body) as Json) : {},
    );
    const outcome: WalkOutcome = { complete: true };
    const items = await paginate(doc, {
      transport: fake.transport,
      path: '/v1/customers/search',
      method: 'POST',
      outcome,
    });
    expect(items.map((item) => item['id'])).toEqual(ids);
    expect(outcome.complete).toBe(true);
    expect(fake.requests.every((body) => !('ending_before' in body))).toBe(
      true,
    );
  });
});
