// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  bindCollection,
  bindCollectionNavigation,
  validateCollectionEntryRead,
  describeCollections,
  relatedCollectionReads,
  resolveCollectionNavigation,
  readBoundCollection,
  validateCollectionRead,
  validateCollectionNavigationRead,
  projectReadRecord,
  readPlatform,
  prepareDocument,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';

function fixture(): OpenApiDocument {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Example', version: '1' },
    servers: [{ url: 'https://api.example.test/v2' }],
    components: {
      crudResources: {
        account: {
          schema: {
            type: 'object',
            title: 'Accounts',
            properties: { id: { type: 'integer' }, slug: { type: 'string' } },
          },
          identity: {
            urlTemplate: '/accounts/{account_id}',
            bindings: { account_id: { field: 'id' } },
          },
          references: {
            address: {
              resource: 'accountAddress',
              bindings: { handle: { field: 'slug' } },
            },
          },
          collections: { myAccounts: { urlTemplate: '/me/accounts' } },
        },
        accountAddress: {
          identity: {
            urlTemplate: '/names/{handle}',
            bindings: { handle: { field: 'slug' } },
          },
        },
        workspace: {
          schema: {
            type: 'object',
            title: 'Workspaces',
            properties: {
              id: { type: 'integer' },
              name: { type: 'string', title: 'Workspace' },
              updated_at: { type: 'string', format: 'date-time' },
              active: {
                type: 'boolean',
                oneOf: [
                  { enum: [true], title: 'Active' },
                  { enum: [false], title: 'Inactive' },
                ],
              },
            },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}',
            bindings: { workspace_id: { field: 'id' } },
          },
          collections: {
            myWorkspaces: { urlTemplate: '/me/workspaces' },
            accountWorkspaces: { urlTemplate: '/names/{handle}/workspaces' },
          },
        },
        task: {
          schema: {
            type: 'object',
            properties: { id: { type: 'string' }, name: { type: 'string' } },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}/tasks/{task_id}',
            bindings: { task_id: { field: 'id' } },
          },
          collections: {
            tasks: {
              urlTemplate: '/workspaces/{workspace_id}/tasks',
              listQuery: { status: 'all' },
            },
          },
        },
      },
      paginationSchemes: {
        pages: {
          type: 'nextLink',
          request: { queryParameters: { limit: { role: 'pageSize' } } },
          response: { headers: { Link: { role: 'nextLink' } } },
        },
      },
    },
    paths: {},
  } as unknown as OpenApiDocument;
  const get = (
    id: string,
    resource: string,
    collection?: string,
  ): Record<string, unknown> => ({
    operationId: id,
    parameters: collection
      ? [{ name: 'page', in: 'query', schema: { type: 'integer' } }]
      : [],
    responses: {
      '200': {
        description: 'Result',
        content: {
          'application/json': {
            schema: {
              type: collection ? 'array' : 'object',
              ...(collection ? { items: { type: 'object' } } : {}),
            },
          },
        },
      },
    },
    'x-crud': {
      action: collection ? 'list' : 'read',
      resource,
      ...(collection ? { collection } : {}),
    },
    ...(collection ? { 'x-pagination': [{ scheme: 'pages' }] } : {}),
  });
  doc.paths['/me/accounts'] = {
    get: get('accounts', 'account', 'myAccounts') as never,
  };
  doc.paths['/me/workspaces'] = {
    get: get('myWorkspaces', 'workspace', 'myWorkspaces') as never,
  };
  doc.paths['/names/{handle}/workspaces'] = {
    get: get('accountWorkspaces', 'workspace', 'accountWorkspaces') as never,
  };
  doc.paths['/workspaces/{workspace_id}/tasks'] = {
    get: {
      ...get('tasks', 'task', 'tasks'),
      parameters: [
        {
          name: 'workspace_id',
          in: 'path',
          required: true,
          schema: { type: 'integer', title: 'Workspace ID' },
        },
        { name: 'status', in: 'query', schema: { type: 'string' } },
        { name: 'page', in: 'query', schema: { type: 'integer' } },
      ],
    } as never,
  };
  doc.paths['/names/{handle}'] = {
    get: {
      ...get('namedAccount', 'accountAddress'),
      responses: {
        '200': {
          description: 'An account',
          links: {
            workspaces: {
              operationId: 'accountWorkspaces',
              parameters: { handle: '$response.body#/slug' },
            },
          },
        },
      },
    } as never,
  };
  return prepareDocument(doc as unknown as Record<string, unknown>);
}
const response = (body: unknown, headers: Record<string, string> = {}) => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

describe('catalog collection navigation', () => {
  it('describes field presentation, inputs and explicit relationships without provider rules', () => {
    const all = describeCollections(fixture());
    const child = all.find((c) => c.name === 'accountWorkspaces')!;
    expect(child.idField).toBe('id');
    expect(child.relationships).toContainEqual({
      kind: 'responseLink',
      parentResource: 'account',
      reference: 'address',
      sourcePath: '/names/{handle}',
      link: 'workspaces',
      bindings: { handle: 'slug' },
    });
    expect(child.presentation).toMatchObject({
      title: 'Workspaces',
      columns: [
        { property: 'id' },
        { property: 'name', label: 'Workspace' },
        { property: 'updated-at' },
        { property: 'active', labels: { true: 'Active', false: 'Inactive' } },
      ],
    });
    expect(all.find((c) => c.name === 'tasks')!.inputs).toMatchObject([
      {
        name: 'workspace_id',
        location: 'path',
        required: true,
        title: 'Workspace ID',
      },
    ]);
  });
  it('materializes a link descriptor from the declared CRUD reference without fetching', () => {
    const nav = relatedCollectionReads(fixture(), {
      resource: 'account',
      record: { id: 13, slug: 'old-handle' },
    });
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatchObject({
      kind: 'responseLink',
      parentResource: 'account',
      source: {
        path: '/names/old-handle',
        pathParams: { handle: 'old-handle' },
      },
      collection: 'accountWorkspaces',
    });
  });
  it('uses an actual detail response Link and follows pages for that child only', async () => {
    const doc = fixture();
    const calls: string[] = [];
    const transport: Transport = async (req) => {
      calls.push(req.url.href);
      if (req.purpose === 'navigation') return response({ slug: 'new-handle' });
      if (req.url.searchParams.has('page'))
        return response([{ id: 22, name: 'Two' }]);
      return response([{ id: 21, name: 'One' }], {
        Link: '<https://api.example.test/v2/names/new-handle/workspaces?page=2>; rel="next"',
      });
    };
    const nav = relatedCollectionReads(doc, {
      resource: 'account',
      record: { id: 13, slug: 'old-handle' },
    })[0]!;
    const bound = await resolveCollectionNavigation(doc, nav, { transport });
    expect(bound.path).toBe('/names/new-handle/workspaces');
    const result = await readBoundCollection(doc, bound, { transport });
    expect(result.errors).toEqual([]);
    expect(result.collections).toHaveLength(1);
    expect(result.collections[0]!.items.map((i) => i['id'])).toEqual([21, 22]);
    expect(calls).toEqual([
      'https://api.example.test/v2/names/old-handle',
      'https://api.example.test/v2/names/new-handle/workspaces',
      'https://api.example.test/v2/names/new-handle/workspaces?page=2',
    ]);
  });
  it('binds children directly from declared stable parent identity without enumeration', async () => {
    const doc = fixture();
    const nav = relatedCollectionReads(doc, {
      resource: 'workspace',
      record: { id: 22, name: 'One' },
    });
    expect(nav).toHaveLength(1);
    expect(nav[0]).toMatchObject({
      kind: 'direct',
      collection: 'tasks',
      bound: { path: '/workspaces/22/tasks', query: { status: 'all' } },
    });
    const calls: string[] = [];
    const transport: Transport = async (req) => {
      calls.push(req.url.pathname);
      return response([{ id: 'a', name: 'Task' }]);
    };
    const bound = await resolveCollectionNavigation(doc, nav[0]!, {
      transport,
    });
    await readBoundCollection(doc, bound, { transport });
    expect(calls).toEqual(['/v2/workspaces/22/tasks']);
  });
  it('keeps multiple named collection aliases deterministic and independently bound', async () => {
    const doc = fixture();
    const resources = doc.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    const collections = resources['task']!['collections'] as Record<
      string,
      unknown
    >;
    collections['tasksAlias'] = {
      urlTemplate: '/workspaces/{workspace_id}/tasks',
      listQuery: { status: 'all' },
    };
    const nav = relatedCollectionReads(doc, {
      resource: 'workspace',
      record: { id: 22 },
    });
    expect(nav.map((n) => n.collection)).toEqual(['tasks', 'tasksAlias']);
    const result = await readBoundCollection(
      doc,
      bindCollection(doc, {
        collection: 'tasksAlias',
        context: { workspace_id: '22' },
      }),
      { transport: async () => response([{ id: 'x' }]) },
    );
    expect(result.errors).toEqual([]);
    expect(result.collections.map((c) => c.collection.name)).toEqual([
      'tasksAlias',
    ]);
  });
  it.each(['..', '.', '\u0000', ' padded ', ''])(
    'rejects unsafe context %j before requests',
    (value) => {
      expect(() =>
        bindCollection(fixture(), {
          collection: 'tasks',
          context: { workspace_id: value },
        }),
      ).toThrow('invalid');
    },
  );
  it('refuses cross-origin, sibling, mutation, arbitrary and changed fixed query requests', () => {
    const doc = fixture();
    const bound = bindCollection(doc, {
      collection: 'tasks',
      context: { workspace_id: '22' },
    });
    const req = (
      url: string,
      method: TransportRequest['method'] = 'GET',
    ): TransportRequest => ({ url: new URL(url), method, headers: {} });
    expect(
      validateCollectionRead(
        doc,
        bound,
        req(
          'https://api.example.test/v2/workspaces/22/tasks?status=all&page=2',
        ),
      ),
    ).toBe(true);
    for (const request of [
      req('https://evil.example/v2/workspaces/22/tasks?status=all'),
      req('https://api.example.test/v2/workspaces/23/tasks?status=all'),
      req('https://api.example.test/v2/workspaces/22/tasks?status=open'),
      req(
        'https://api.example.test/v2/workspaces/22/tasks?status=all&attack=1',
      ),
      req(
        'https://api.example.test/v2/workspaces/22/tasks?status=all',
        'DELETE',
      ),
    ])
      expect(validateCollectionRead(doc, bound, request)).toBe(false);
  });
  it('shares pure projection with readPlatform and retains exact descriptor resource', async () => {
    const doc = fixture();
    const c = describeCollections(doc).find((c) => c.name === 'myWorkspaces')!;
    const raw = {
      id: 21,
      name: 'One',
      updated_at: '2026-01-02T03:04:05Z',
      active: false,
    };
    const projected = projectReadRecord(doc, { collection: c, record: raw });
    expect(projected.values['updated-at']).toBe(Date.parse(raw.updated_at));
    const result = await readPlatform(doc, {
      platform: 'example',
      constants: {},
      collectionNames: ['myWorkspaces'],
      transport: async () => response([raw]),
    });
    expect(result.records).toEqual([projected]);
    expect(c.resource).toBe('workspace');
  });
  it('refuses invalid scalar values in the shared pure projection', () => {
    const doc = fixture();
    const collection = describeCollections(doc).find(
      (c) => c.name === 'myWorkspaces',
    )!;
    for (const record of [
      { id: '21' },
      { id: 9007199254740992 },
      { name: 42 },
      { active: 'false' },
      { updated_at: '2026-02-30T00:00:00Z' },
      { updated_at: '2026-01-01T88:00:00Z' },
    ])
      expect(() =>
        projectReadRecord(doc, { collection, record: { id: 21, ...record } }),
      ).toThrow('Invalid provider');
  });
  it('distinguishes public discovery from authenticated-only collections using effective security', () => {
    const doc = fixture();
    doc['security'] = [{ oauth: [] }];
    doc.paths['/me/accounts']!.get!['security'] = [{ oauth: [] }];
    doc.paths['/me/workspaces']!.get!['security'] = [];
    doc.paths['/names/{handle}/workspaces']!.get!['security'] = [
      { oauth: [] },
      {},
    ];
    const publicCollections = describeCollections(doc)
      .filter((c) => c.allowsAnonymous)
      .map((c) => c.name);
    expect(publicCollections).toEqual(['myWorkspaces', 'accountWorkspaces']);
    expect(
      describeCollections(doc).find((c) => c.name === 'myAccounts')!
        .requiresAuthentication,
    ).toBe(true);
  });
  it('validates only the saved declared navigation source and refuses mutations and siblings', () => {
    const doc = fixture();
    const nav = relatedCollectionReads(doc, {
      resource: 'account',
      record: { id: 1, slug: 'alpha' },
    })[0]!;
    const request: TransportRequest = {
      url: new URL('https://api.example.test/v2/names/alpha'),
      method: 'GET',
      headers: {},
    };
    expect(validateCollectionNavigationRead(doc, nav, request)).toBe(true);
    expect(
      validateCollectionNavigationRead(doc, nav, {
        ...request,
        method: 'DELETE',
      }),
    ).toBe(false);
    expect(
      validateCollectionNavigationRead(doc, nav, {
        ...request,
        url: new URL('https://api.example.test/v2/names/beta'),
      }),
    ).toBe(false);
    expect(
      validateCollectionNavigationRead(doc, nav, {
        ...request,
        url: new URL('https://api.example.test/v2/names/alpha?extra=1'),
      }),
    ).toBe(false);
  });
  it('allows POST pagination fields while preserving the exact declared fixed filter', async () => {
    const doc = fixture();
    const resources = doc.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    (resources['task']!['collections'] as Record<string, unknown>)[
      'searchedTasks'
    ] = {
      urlTemplate: '/search',
      listMethod: 'POST',
      listBody: { filter: { kind: 'task' } },
    };
    doc.paths['/search'] = {
      post: {
        operationId: 'searchTasks',
        responses: {
          '200': {
            description: 'Page',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    results: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
        parameters: [],
        requestBody: {
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        'x-pagination': [{ scheme: 'postPages' }],
      },
    };
    doc.components!.paginationSchemes!['postPages'] = {
      type: 'pageToken',
      request: { bodyFields: { cursor: { role: 'pageToken' } } },
      response: {
        bodyFields: { next: { role: 'nextPageToken' } },
        envelope: { itemsField: 'results' },
      },
    };
    const bound = bindCollection(doc, { collection: 'searchedTasks' });
    const base: TransportRequest = {
      url: new URL('https://api.example.test/v2/search'),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filter: { kind: 'task' }, cursor: 'next' }),
    };
    expect(validateCollectionRead(doc, bound, base)).toBe(true);
    expect(
      validateCollectionRead(doc, bound, {
        ...base,
        body: JSON.stringify({ filter: { kind: 'other' }, cursor: 'next' }),
      }),
    ).toBe(false);
    expect(
      validateCollectionRead(doc, bound, {
        ...base,
        body: JSON.stringify({ filter: { kind: 'task' }, attack: true }),
      }),
    ).toBe(false);
    expect(
      validateCollectionRead(doc, bound, {
        ...base,
        body: JSON.stringify({ filter: { kind: 'task' }, attack: {} }),
      }),
    ).toBe(false);
    const calls: unknown[] = [];
    const result = await readBoundCollection(doc, bound, {
      transport: async (request) => {
        const body = JSON.parse(request.body!);
        calls.push(body);
        return response({
          results: [{ id: body.cursor ? 'b' : 'a' }],
          next: body.cursor ? null : 'next',
        });
      },
    });
    expect(result.errors).toEqual([]);
    expect(calls).toEqual([
      { filter: { kind: 'task' } },
      { filter: { kind: 'task' }, cursor: 'next' },
    ]);
  });
  it('discovers and binds public source entrypoints before materializing the canonical list', async () => {
    const doc = fixture();
    doc.paths['/names/{handle}']!.get!['security'] = [{}];
    const target = describeCollections(doc).find(
      (c) => c.name === 'accountWorkspaces',
    )!;
    expect(target.entrypoints).toMatchObject([
      {
        sourcePath: '/names/{handle}',
        method: 'GET',
        operationId: 'namedAccount',
        allowsAnonymous: true,
        inputs: [{ name: 'handle' }],
      },
    ]);
    const navigation = bindCollectionNavigation(doc, {
      collection: 'accountWorkspaces',
      sourcePath: '/names/{handle}',
      context: { handle: 'given' },
    });
    expect(navigation).toMatchObject({
      kind: 'entrypoint',
      source: { path: '/names/given' },
    });
    const calls: string[] = [];
    const bound = await resolveCollectionNavigation(doc, navigation, {
      transport: async (request) => {
        calls.push(request.url.pathname);
        return response({ slug: 'canonical' });
      },
    });
    expect(calls).toEqual(['/v2/names/given']);
    expect(bound.pathParams).toEqual({ handle: 'canonical' });
  });
  it('limits root entry reads to metadata-declared GETs and honors Public security', () => {
    const doc = fixture();
    doc['security'] = [{ oauth: [] }];
    const request: TransportRequest = {
      url: new URL('https://api.example.test/v2/names/acme'),
      method: 'GET',
      headers: {},
    };
    expect(validateCollectionEntryRead(doc, request)).toBe(true);
    expect(
      validateCollectionEntryRead(doc, request, { publicOnly: true }),
    ).toBe(false);
    doc.paths['/names/{handle}']!.get!['security'] = [{ oauth: [] }, {}];
    expect(
      validateCollectionEntryRead(doc, request, { publicOnly: true }),
    ).toBe(true);
    for (const altered of [
      { ...request, method: 'DELETE' as const },
      { ...request, body: '{}' },
      { ...request, url: new URL('https://api.example.test/v2/me/accounts') },
      {
        ...request,
        url: new URL('https://api.example.test/v2/names/acme?extra=1'),
      },
      { ...request, url: new URL('https://other.example.test/v2/names/acme') },
    ])
      expect(
        validateCollectionEntryRead(doc, altered, { publicOnly: true }),
      ).toBe(false);
  });
  it('does not advertise unsupported Link expressions or ambiguous target aliases', () => {
    const doc = fixture();
    const response = doc.paths['/names/{handle}']!.get!.responses[
      '200'
    ] as unknown as Record<string, unknown>;
    (response['links'] as Record<string, unknown>)['workspaces'] = {
      operationId: 'accountWorkspaces',
      parameters: { handle: '$response.header.Location' },
    };
    expect(
      describeCollections(doc).find((c) => c.name === 'accountWorkspaces')!
        .entrypoints,
    ).toEqual([]);
    expect(
      relatedCollectionReads(doc, {
        resource: 'account',
        record: { id: 7, slug: 'x' },
      }),
    ).toEqual([]);
  });

  it('rejects missing/nonnullable required values while nullable null omits managed values', () => {
    const doc = fixture();
    const resources = doc.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    resources['workspace']!['schema'] = {
      type: 'object',
      required: ['id', 'name', 'nullableName', 'nullableJson'],
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        nullableName: { type: 'string', nullable: true },
        nullableJson: { type: ['string', 'null'] },
      },
    };
    const collection = describeCollections(doc).find(
      (c) => c.name === 'myWorkspaces',
    )!;
    const valid = { id: 2, name: 'A', nullableName: null, nullableJson: null };
    expect(
      projectReadRecord(doc, { collection, record: valid }).values,
    ).toEqual({ id: 2, name: 'A' });
    for (const record of [
      { ...valid, name: null },
      { id: 2, name: 'A', nullableJson: null },
    ])
      expect(() => projectReadRecord(doc, { collection, record })).toThrow(
        'required provider field',
      );
  });
  it.each([
    [{}, undefined],
    [{ filter: {} }, {}],
    [{ filter: {} }, { filter: null }],
    [{ filter: {} }, { filter: [] }],
    [{ filter: { criteria: {} } }, { filter: {} }],
    [{ filter: { criteria: {} } }, { filter: { criteria: null } }],
    [JSON.parse('{"__proto__":{}}'), {}],
  ])(
    'requires each declared fixed object to be an own object: %j',
    (fixedBody, incompleteBody) => {
      const doc = fixture();
      const resources = doc.components!['crudResources'] as Record<
        string,
        Record<string, unknown>
      >;
      (resources['task']!['collections'] as Record<string, unknown>)[
        'fixedObjects'
      ] = {
        urlTemplate: '/fixed-search',
        listMethod: 'POST',
        listBody: fixedBody,
      };
      doc.paths['/fixed-search'] = {
        post: {
          responses: { '200': { description: 'Results' } },
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      };
      const bound = bindCollection(doc, { collection: 'fixedObjects' });
      const request: TransportRequest = {
        url: new URL('https://api.example.test/v2/fixed-search'),
        method: 'POST',
        headers: {},
        body: JSON.stringify(incompleteBody),
      };
      expect(validateCollectionRead(doc, bound, request)).toBe(false);
      expect(
        validateCollectionRead(doc, bound, {
          ...request,
          body: JSON.stringify(fixedBody),
        }),
      ).toBe(true);
    },
  );
});
