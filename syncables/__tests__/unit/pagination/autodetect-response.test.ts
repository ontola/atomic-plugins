// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  readCollections,
  resolveEffectiveScheme,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';

// Pagination Schemes §6.3: `matchHeaders` and `matchResponseFields`, the
// response dimensions of auto-detection, off by default. A scheme that
// turns them on and the request dimensions off (the spec's §6.3 Link
// example, as GitHub's and GitLab's overlays declare it) matched no
// operation before, so such a list was read with one request and taken as
// complete. They can only see what the operation's description declares.
// Invented documents and data.

type Json = Record<string, unknown>;

const linkScheme = {
  type: 'nextLink',
  autoDetect: {
    matchQueryParams: false,
    matchBodyFields: false,
    matchHeaders: true,
    requireAll: false,
  },
  response: { headers: { Link: { role: 'nextLink' } } },
};

const cursorScheme = {
  type: 'pageToken',
  autoDetect: {
    matchQueryParams: false,
    matchBodyFields: false,
    matchResponseFields: true,
    requireAll: false,
  },
  request: { queryParameters: { cursor: { role: 'cursor' } } },
  response: { bodyFields: { 'meta.next_cursor': { role: 'nextCursor' } } },
};

function document(scheme: Json, responses: Json): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Issues', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/issues': { get: { responses } },
      '/issues/{id}': {
        get: { responses: { '200': { description: 'One' } } },
      },
    },
    components: {
      paginationSchemes: { scheme },
      crudResources: {
        issue: {
          identity: {
            urlTemplate: '/issues/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: { issues: { urlTemplate: '/issues' } },
        },
      },
    },
  } as unknown as OpenApiDocument;
}

const withHeaders = (headers: Json, code = '200'): Json => ({
  [code]: { description: 'Issues', headers },
});

const withSchema = (schema: Json): Json => ({
  '200': {
    description: 'Issues',
    content: { 'application/json': { schema } },
  },
});

const detected = (doc: OpenApiDocument): string | undefined =>
  resolveEffectiveScheme(doc, doc.paths['/issues']!.get!)?.schemeName;

describe('matchHeaders', () => {
  it.each([
    ['the header as declared', withHeaders({ Link: { schema: {} } })],
    ['the header in another case', withHeaders({ link: { schema: {} } })],
    ['a 2XX response', withHeaders({ Link: {} }, '2XX')],
    ['a 206 response', withHeaders({ LINK: {} }, '206')],
  ])('matches %s', (_label, responses) => {
    expect(detected(document(linkScheme, responses))).toBe('scheme');
  });

  it.each([
    ['no response header', withHeaders({})],
    ['another header', withHeaders({ 'X-Next': {} })],
    ['the header only on an error response', withHeaders({ Link: {} }, '404')],
  ])('does not match %s', (_label, responses) => {
    expect(detected(document(linkScheme, responses))).toBeUndefined();
  });

  it('adds nothing for a scheme without response headers', () => {
    const scheme = {
      ...linkScheme,
      response: { bodyFields: { next: { role: 'nextLink' } } },
    };
    expect(
      detected(document(scheme, withHeaders({ Link: {} }))),
    ).toBeUndefined();
  });

  it('needs the request dimensions too under requireAll', () => {
    const scheme = {
      ...linkScheme,
      autoDetect: { matchHeaders: true },
      request: { queryParameters: { per_page: { role: 'pageSize' } } },
    };
    const without = document(scheme, withHeaders({ Link: {} }));
    expect(detected(without)).toBeUndefined();
    const doc = document(scheme, withHeaders({ Link: {} }));
    doc.paths['/issues']!.get!.parameters = [
      { name: 'per_page', in: 'query' },
    ] as never;
    expect(detected(doc)).toBe('scheme');
  });
});

describe('matchResponseFields', () => {
  it('matches a dot-path through properties and allOf', () => {
    const responses = withSchema({
      allOf: [
        { type: 'object', properties: { data: { type: 'array' } } },
        {
          type: 'object',
          properties: {
            meta: {
              allOf: [{ properties: { next_cursor: { type: 'string' } } }],
            },
          },
        },
      ],
    });
    expect(detected(document(cursorScheme, responses))).toBe('scheme');
  });

  it('counts a path the response parser cannot read as present, so the read fails on it', () => {
    const scheme = {
      ...cursorScheme,
      response: { bodyFields: { 'meta[': { role: 'nextCursor' } } },
    };
    expect(detected(document(scheme, withSchema({ properties: {} })))).toBe(
      'scheme',
    );
  });

  it.each([
    ['a missing nested field', withSchema({ properties: { meta: {} } })],
    ['a response without a JSON schema', withHeaders({})],
  ])('does not match %s', (_label, responses) => {
    expect(detected(document(cursorScheme, responses))).toBeUndefined();
  });
});

describe('a sync of a list detected by its Link header', () => {
  const pages: Json[][] = [
    [
      { id: '1', title: 'A' },
      { id: '2', title: 'B' },
    ],
    [{ id: '3', title: 'C' }],
  ];
  const transport: Transport = async (request) => {
    const page = Number(request.url.searchParams.get('page') ?? '0');
    return {
      status: 200,
      headers:
        page === 0
          ? { link: '<https://api.example.com/issues?page=1>; rel="next"' }
          : {},
      body: JSON.stringify(pages[page]),
    };
  };

  it('reads every page, where it read the first as the whole list before', async () => {
    const doc = document(linkScheme, withHeaders({ Link: {} }));
    const result = await readCollections(doc, { transport });
    expect(result.collections[0]!.items.map((r) => r['id'])).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(result.collections[0]!.complete).toBe(true);
    const client = createApiClient(doc, { transport });
    await client.sync();
    expect((await client.list('issues')).map((r) => r['id'])).toEqual([
      '1',
      '2',
      '3',
    ]);
  });

  it('still reads one page where the description does not declare the header (the documented limit)', async () => {
    const doc = document(linkScheme, withHeaders({}));
    const result = await readCollections(doc, { transport });
    expect(result.collections[0]!.items.map((r) => r['id'])).toEqual([
      '1',
      '2',
    ]);
  });
});
