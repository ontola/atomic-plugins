// @wc-ignore-file
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMockServer,
  type MockServer,
} from '../../../src/mock-server/server.js';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';
import { paginate } from '../../../src/read/read.js';
import { fetchTransport } from '../../../src/read/transport.js';
import type { WalkOutcome } from '../../../src/read/pages.js';

// The mock server serves a Pagination Schemes 0.9.0 item-cursor scheme
// (§4.3.3): the page after the item whose `fromLastItem` value the request
// names, and `hasMore`. Read back through the client's own walker, on the
// spec's example (examples/item-cursor.yaml): 7 generated customers in
// pages of the requested size.

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

describe('the mock server with a cursor read from the last item', () => {
  let server: MockServer;
  let baseUrl: string;
  let doc: OpenApiDocument;

  beforeAll(async () => {
    doc = await loadOpenApiDocument(example());
    server = createMockServer(doc);
    baseUrl = (await server.listen()).url;
  });

  afterAll(() => server.close());

  const page = async (query: string): Promise<Json> =>
    (await (await fetch(`${baseUrl}/v1/customers${query}`)).json()) as Json;

  it('answers the first page, then the page after the named item, with has_more', async () => {
    const first = await page('?limit=3');
    const data = first['data'] as Json[];
    expect(data).toHaveLength(3);
    expect(first['has_more']).toBe(true);
    const next = await page(
      `?limit=3&starting_after=${String(data[2]!['id'])}`,
    );
    expect(next['data']).toHaveLength(3);
    expect((next['data'] as Json[])[0]!['id']).not.toBe(data[2]!['id']);
    const last = await page(
      `?limit=3&starting_after=${String((next['data'] as Json[])[2]!['id'])}`,
    );
    expect(last['data']).toHaveLength(1);
    expect(last['has_more']).toBe(false);
  });

  it('answers an empty last page for a value no item has', async () => {
    const unknown = await page('?limit=3&starting_after=nobody');
    expect(unknown['data']).toEqual([]);
    expect(unknown['has_more']).toBe(false);
  });

  it('is read whole, and complete, by the client', async () => {
    const outcome: WalkOutcome = { complete: true };
    const items = await paginate(
      { ...doc, servers: [{ url: baseUrl }] },
      {
        transport: fetchTransport(fetch),
        path: '/v1/customers',
        pageSize: 2,
        outcome,
      },
    );
    expect(items).toHaveLength(7);
    expect(new Set(items.map((i) => i['id'])).size).toBe(7);
    expect(outcome.complete).toBe(true);
  });

  it('gives each item its own value at a fromLastItem path other than id', async () => {
    const other = await loadOpenApiDocument(example());
    const scheme = other.components!.paginationSchemes![
      'afterLastObject'
    ] as unknown as Json;
    ((scheme['request'] as Json)['queryParameters'] as Record<string, Json>)[
      'starting_after'
    ]!['fromLastItem'] = 'meta.key';
    const second = createMockServer(other);
    const url = (await second.listen()).url;
    try {
      const outcome: WalkOutcome = { complete: true };
      const items = await paginate(
        { ...other, servers: [{ url }] },
        {
          transport: fetchTransport(fetch),
          path: '/v1/customers',
          pageSize: 3,
          outcome,
        },
      );
      expect(items).toHaveLength(7);
      expect(new Set(items.map((i) => (i['meta'] as Json)['key'])).size).toBe(
        7,
      );
      expect(outcome.complete).toBe(true);
    } finally {
      await second.close();
    }
  });
});
