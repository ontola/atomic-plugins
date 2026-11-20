// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  prepareDocument,
  bindCollection,
  describeCollections,
  resolveEntityIdentity,
  describeEntityTypes,
  parseReadSelection,
  readSelectionKey,
  compileReadSelection,
  projectEntityObservation,
  readSelection,
  type ReadSelection,
  type OriginRecord,
  type OpenApiDocument,
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

const response = (body: unknown, status = 200) => ({
  status,
  headers: {},
  body: JSON.stringify(body),
});
function bound(
  doc: OpenApiDocument,
  name: string,
  context: Record<string, string> = {},
): ReadSelection {
  const b = bindCollection(doc, { collection: name, context });
  return {
    version: 1,
    resource: b.resource,
    source: { kind: 'bound', bound: b },
  };
}
function origin(doc: OpenApiDocument, id = 7): OriginRecord {
  const read = bindCollection(doc, { collection: 'myAccounts' }),
    record = { id, slug: 'alpha' };
  return {
    entity: resolveEntityIdentity(doc, { resource: 'account', record }),
    record,
    context: {},
    read,
  };
}
const via = {
  collection: 'accountWorkspaces',
  kind: 'responseLink' as const,
  reference: 'address',
  link: 'workspaces',
};
function related(doc: OpenApiDocument): ReadSelection {
  return {
    version: 1,
    resource: 'workspace',
    source: { kind: 'related', origin: origin(doc), via },
  };
}
const request = (path: string): TransportRequest => ({
  url: new URL('https://api.example.test/v2' + path),
  method: 'GET',
  headers: {},
});

describe('flat catalog selections', () => {
  it('keeps undeclared fields raw rather than borrowing another resource datatype', () => {
    const doc = fixture();
    const resources = doc.components!.crudResources as Record<
      string,
      {
        schema: { properties: Record<string, unknown> };
      }
    >;
    resources.account.schema.properties.type = { type: 'string' };
    const record = {
      id: 42,
      name: 'Workspace',
      type: { id: 7, name: 'Example type' },
    };
    const read = bindCollection(doc, { collection: 'myWorkspaces' });
    const collection = describeCollections(doc).find(
      (c) => c.name === 'myWorkspaces',
    )!;
    const observation = projectEntityObservation(doc, {
      collection,
      record,
      provenance: { read },
    });
    expect(observation.raw).toEqual(record);
    expect(observation.projected.values).not.toHaveProperty('type');
    expect(observation.fields).not.toHaveProperty('type');
    expect(observation.projected.values.name).toBe('Workspace');
    const accountRead = bindCollection(doc, { collection: 'myAccounts' });
    const account = describeCollections(doc).find(
      (c) => c.name === 'myAccounts',
    )!;
    expect(() =>
      projectEntityObservation(doc, {
        collection: account,
        record: { id: 7, type: record.type },
        provenance: { read: accountRead },
      }),
    ).toThrow('Invalid provider value for declared datatype');
    expect(
      projectEntityObservation(doc, {
        collection: account,
        record: { id: 7, type: 'Person' },
        provenance: { read: accountRead },
      }).projected.values.type,
    ).toBe('Person');
  });

  it('reads an invented object-valued issue type against the actual GitHub catalog without projecting an undeclared field', async () => {
    const doc = prepareDocument(
      JSON.parse(
        readFileSync(
          new URL(
            '../../fixtures/real-world/github-reference-links-2026-11-20.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ),
    );
    const read = bindCollection(doc, {
      collection: 'repositoryIssues',
      context: { repository_id: '456' },
    });
    const record = {
      id: 15,
      number: 1,
      title: 'Invented issue',
      type: { id: 7, name: 'Example type', is_enabled: true },
    };
    const result = await readSelection(
      doc,
      {
        version: 1,
        resource: 'issue',
        source: { kind: 'bound', bound: read },
      },
      { transport: async () => response([record]) },
    );
    expect(result.errors).toEqual([]);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.raw).toEqual(record);
    expect(result.observations[0]!.projected.values).not.toHaveProperty('type');
    expect(result.observations[0]!.fields).not.toHaveProperty('type');
    expect(result.observations[0]!.projected.values.title).toBe(
      'Invented issue',
    );
  });

  it.each(['related', 'fanout'] as const)(
    'applies the actual GitHub catalog page-size override to %s issues and follows proved next pages',
    async (kind) => {
      const doc = prepareDocument(
        JSON.parse(
          readFileSync(
            new URL(
              '../../fixtures/real-world/github-reference-links-2026-11-20.json',
              import.meta.url,
            ),
            'utf8',
          ),
        ),
      );
      const catalog = JSON.parse(
        readFileSync(
          new URL(
            '../../../../overlays/catalog/2026-11-20-reference-links.json',
            import.meta.url,
          ),
          'utf8',
        ),
      ) as {
        platforms: {
          name: string;
          selection: {
            query_overrides: {
              path: string;
              values: Record<string, unknown>;
            }[];
          };
        }[];
      };
      const querySelection = catalog.platforms.find(
        (platform) => platform.name === 'github',
      )!.selection;
      const repository = {
        id: 456,
        full_name: 'example/repo',
        name: 'repo',
        owner: { id: 7, login: 'example', type: 'User' },
      };
      const read = bindCollection(doc, {
        collection: 'githubRepositories',
        selection: querySelection,
      });
      const entity = resolveEntityIdentity(doc, {
        resource: 'githubRepository',
        record: repository,
      });
      const relation = {
        collection: 'repositoryIssues',
        kind: 'identity' as const,
      };
      const selection: ReadSelection = {
        version: 1,
        resource: 'issue',
        source:
          kind === 'related'
            ? {
                kind,
                origin: { entity, record: repository, context: {}, read },
                via: relation,
              }
            : {
                kind,
                from: {
                  version: 1,
                  resource: 'githubRepository',
                  source: { kind: 'bound', bound: read },
                },
                via: relation,
              },
      };
      const guard = compileReadSelection(doc, selection, { querySelection });
      const requests: URL[] = [];
      const result = await readSelection(doc, selection, {
        querySelection,
        transport: async (request) => {
          requests.push(new URL(request.url.href));
          expect(guard.allows(request)).toBe(true);
          const isRepository = request.url.pathname === '/user/repos';
          const page = Number(request.url.searchParams.get('page') ?? 1);
          const next = new URL(request.url.href);
          next.searchParams.set('page', '2');
          const body = isRepository
            ? [repository]
            : [{ id: page, number: page, title: `Issue ${page}` }];
          const reply = {
            ...response(body),
            headers:
              !isRepository && page === 1
                ? { link: `<${next.href}>; rel="next"` }
                : {},
          };
          await guard.observe(request, reply);
          return reply;
        },
      });
      expect(result.errors).toEqual([]);
      expect(result.observations).toHaveLength(2);
      const issueRequests = requests.filter(
        (url) => url.pathname === '/repositories/456/issues',
      );
      expect(issueRequests).toHaveLength(2);
      expect(
        issueRequests.map((url) => url.searchParams.get('per_page')),
      ).toEqual(['100', '100']);
      expect(issueRequests.map((url) => url.searchParams.get('page'))).toEqual([
        null,
        '2',
      ]);
      expect(
        result.partitions.find((partition) => partition.role === 'target')!
          .bound.query.per_page,
      ).toBe('100');
      if (kind === 'fanout')
        expect(requests[0]!.searchParams.get('per_page')).toBe('100');
    },
  );

  it('groups aliases by exact resource and derives only canonical typed identity variables', () => {
    const doc = fixture();
    expect(
      describeEntityTypes(doc)
        .find((t) => t.resource === 'workspace')
        ?.collections.map((c) => c.name),
    ).toEqual(['myWorkspaces', 'accountWorkspaces']);
    const a = resolveEntityIdentity(doc, {
      resource: 'workspace',
      record: { id: 42 },
      context: { handle: 'alpha' },
    });
    expect(a).toEqual(
      resolveEntityIdentity(doc, {
        resource: 'workspace',
        record: { id: 42 },
        context: { handle: 'beta' },
      }),
    );
    expect(a.values).toEqual([['workspace_id', 42]]);
    expect(a.key).not.toBe(
      resolveEntityIdentity(doc, {
        resource: 'workspace',
        record: { id: '42' },
      }).key,
    );
    const task = (workspace_id: string) =>
      resolveEntityIdentity(doc, {
        resource: 'task',
        record: { id: '7' },
        context: { workspace_id },
      });
    expect(task('42').key).not.toBe(task('43').key);
    expect(task('42').values).toEqual([
      ['workspace_id', 42],
      ['task_id', '7'],
    ]);
    expect(() =>
      resolveEntityIdentity(doc, { resource: 'missing', record: { id: 1 } }),
    ).toThrow(/canonical/);
  });
  it('strictly parses selections and excludes mutable origin snapshots from logical keys', () => {
    const doc = fixture(),
      s = related(doc),
      changed = structuredClone(s);
    if (changed.source.kind === 'related') {
      changed.source.origin.record.slug = 'renamed';
      changed.source.origin.read.path = '/changed';
    }
    expect(readSelectionKey(changed)).toBe(readSelectionKey(s));
    expect(() => parseReadSelection({ ...s, extra: true })).toThrow();
    expect(() => parseReadSelection({ ...s, version: 2 })).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => parseReadSelection(cycle)).toThrow();
    const unknown = bound(doc, 'myWorkspaces');
    if (unknown.source.kind === 'bound') unknown.source.bound.query.fake = 'no';
    expect(() => compileReadSelection(doc, unknown)).toThrow(/recipe/);
  });
  it('does not trust saved source rows as response proof and unlocks only a matching actual detail Link', async () => {
    const doc = fixture(),
      guard = compileReadSelection(doc, related(doc));
    expect(guard.allows(request('/names/alpha'))).toBe(true);
    expect(guard.allows(request('/names/alpha/workspaces'))).toBe(false);
    await guard.observe(
      request('/names/alpha'),
      response({ id: 8, slug: 'alpha' }),
    );
    expect(guard.allows(request('/names/alpha/workspaces'))).toBe(false);
    await guard.observe(
      request('/names/alpha'),
      response({ id: 7, slug: 'alpha' }),
    );
    expect(guard.allows(request('/names/alpha/workspaces'))).toBe(true);
    expect(guard.allows(request('/names/beta/workspaces'))).toBe(false);
    expect(
      guard.allows({ ...request('/names/alpha/workspaces'), method: 'POST' }),
    ).toBe(false);
    expect(
      guard.allows({
        ...request('/names/alpha/workspaces'),
        url: new URL('https://evil.test/v2/names/alpha/workspaces'),
      }),
    ).toBe(false);
  });
  it('enforces anonymous access on target, discovery and detail operations', () => {
    const doc = fixture();
    doc.security = [{ token: [] }];
    doc.paths['/me/accounts']!.get!.security = [];
    doc.paths['/names/{handle}/workspaces']!.get!.security = [];
    expect(() =>
      compileReadSelection(doc, related(doc), { publicOnly: true }),
    ).toThrow(/detail/);
    doc.paths['/names/{handle}']!.get!.security = [];
    expect(() =>
      compileReadSelection(doc, related(doc), { publicOnly: true }),
    ).not.toThrow();
    doc.paths['/me/accounts']!.get!.security = [{ token: [] }];
    const s: ReadSelection = {
      version: 1,
      resource: 'workspace',
      source: { kind: 'fanout', from: bound(doc, 'myAccounts'), via },
    };
    expect(() => compileReadSelection(doc, s, { publicOnly: true })).toThrow(
      /authentication/,
    );
  });
  it('projects explicit field evidence without treating absence as null', () => {
    const doc = fixture(),
      collection = describeCollections(doc).find(
        (c) => c.name === 'myWorkspaces',
      )!;
    const read = bindCollection(doc, { collection: collection.name });
    const o = projectEntityObservation(doc, {
      collection,
      record: { id: 42, name: null, active: true },
      provenance: { read },
    });
    expect(o.fields.name).toEqual({ kind: 'null' });
    expect(o.fields['updated-at']).toEqual({ kind: 'absent' });
    expect(o.fields.active).toEqual({ kind: 'value', value: true });
    expect(o.projected.values).not.toHaveProperty('name');
  });
  it('fans out actual accepted rows, shares budget, and retains successful partitions on sibling failure', async () => {
    const doc = fixture(),
      s: ReadSelection = {
        version: 1,
        resource: 'task',
        source: {
          kind: 'fanout',
          from: bound(doc, 'myWorkspaces'),
          via: { collection: 'tasks', kind: 'identity' },
        },
      };
    const seen: string[] = [];
    const result = await readSelection(doc, s, {
      transport: async (req) => {
        seen.push(req.url.pathname);
        if (req.url.pathname.endsWith('/me/workspaces'))
          return response([
            { id: 42, name: 'a' },
            { id: 43, name: 'b' },
          ]);
        if (req.url.pathname.includes('/42/'))
          return response([{ id: '7', name: 'task' }]);
        return response({}, 401);
      },
    });
    expect(result.complete).toBe(false);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]!.entity.values).toEqual([
      ['workspace_id', 42],
      ['task_id', '7'],
    ]);
    expect(result.partitions).toHaveLength(3);
    expect(result.partitions[0]!.role).toBe('discovery');
    expect(seen).toEqual([
      '/v2/me/workspaces',
      '/v2/workspaces/42/tasks',
      '/v2/workspaces/43/tasks',
    ]);
    const limited = await readSelection(doc, s, {
      limits: { maxRequests: 1 },
      transport: async () => response([{ id: 42 }]),
    });
    expect(limited.complete).toBe(false);
    expect(limited.observations).toEqual([]);
  });
  it('guards fanout descendants using actual source responses rather than arbitrary contexts', async () => {
    const doc = fixture(),
      s: ReadSelection = {
        version: 1,
        resource: 'task',
        source: {
          kind: 'fanout',
          from: bound(doc, 'myWorkspaces'),
          via: { collection: 'tasks', kind: 'identity' },
        },
      };
    const guard = compileReadSelection(doc, s);
    expect(guard.allows(request('/workspaces/42/tasks?status=all'))).toBe(
      false,
    );
    await guard.observe(request('/me/workspaces'), response([{ id: 42 }]));
    expect(guard.allows(request('/workspaces/42/tasks?status=all'))).toBe(true);
    expect(guard.allows(request('/workspaces/43/tasks?status=all'))).toBe(
      false,
    );
  });
  it('completes an empty discovery without inventing partitions or fetching descendants', async () => {
    const doc = fixture(),
      s: ReadSelection = {
        version: 1,
        resource: 'task',
        source: {
          kind: 'fanout',
          from: bound(doc, 'myWorkspaces'),
          via: { collection: 'tasks', kind: 'identity' },
        },
      };
    const result = await readSelection(doc, s, {
      transport: async () => response([]),
    });
    expect(result.complete).toBe(true);
    expect(result.observations).toEqual([]);
    expect(result.partitions).toHaveLength(1);
  });
  it('intersects a selected entity with its actual source scope, including host grants', async () => {
    const doc = fixture(),
      entity = resolveEntityIdentity(doc, {
        resource: 'workspace',
        record: { id: 42 },
      });
    const selection: ReadSelection = {
      version: 1,
      resource: 'task',
      source: {
        kind: 'fanout',
        from: bound(doc, 'myWorkspaces'),
        via: { collection: 'tasks', kind: 'identity' },
        entities: [entity],
      },
    };
    const guard = compileReadSelection(doc, selection);
    await guard.observe(request('/me/workspaces'), response([{ id: 43 }]));
    expect(guard.allows(request('/workspaces/42/tasks?status=all'))).toBe(
      false,
    );
    expect(guard.allows(request('/workspaces/43/tasks?status=all'))).toBe(
      false,
    );
    await guard.observe(
      request('/me/workspaces'),
      response([{ id: 42 }, { id: 43 }]),
    );
    expect(guard.allows(request('/workspaces/42/tasks?status=all'))).toBe(true);
    expect(guard.allows(request('/workspaces/43/tasks?status=all'))).toBe(
      false,
    );
    const all = structuredClone(selection);
    if (all.source.kind === 'fanout') delete all.source.entities;
    expect(readSelectionKey(selection)).not.toBe(readSelectionKey(all));
    const result = await readSelection(doc, selection, {
      transport: async (req) =>
        req.url.pathname.endsWith('/me/workspaces')
          ? response([{ id: 43 }])
          : response([{ id: 'bad' }]),
    });
    expect(result.complete).toBe(true);
    expect(result.observations).toEqual([]);
  });
  it('keeps paged partial discoveries incomplete while following only accepted source rows', async () => {
    const doc = fixture(),
      selection: ReadSelection = {
        version: 1,
        resource: 'task',
        source: {
          kind: 'fanout',
          from: bound(doc, 'myWorkspaces'),
          via: { collection: 'tasks', kind: 'identity' },
        },
      };
    const result = await readSelection(doc, selection, {
      transport: async (req) => {
        if (req.url.pathname.endsWith('/me/workspaces'))
          return req.url.search
            ? response({}, 401)
            : {
                ...response([{ id: 42 }]),
                headers: {
                  link: '<https://api.example.test/v2/me/workspaces?page=2>; rel="next"',
                },
              };
        return response([{ id: '7' }]);
      },
    });
    expect(result.complete).toBe(false);
    expect(result.observations).toHaveLength(1);
    expect(result.partitions[0]!.complete).toBe(false);
    expect(result.partitions[1]!.complete).toBe(true);
  });
  it('rejects changed fixed POST recipes and invalid trusted origin snapshots', () => {
    const doc = fixture(),
      s = related(doc);
    const bad = origin(doc);
    bad.record.id = 8;
    expect(() => compileReadSelection(doc, s, { origins: [bad] })).toThrow(
      /identity/,
    );
    const changed = structuredClone(s);
    if (changed.source.kind === 'related')
      changed.source.origin.context.fake = 'ignored';
    expect(() => compileReadSelection(doc, changed)).not.toThrow();
    const root = bound(doc, 'myWorkspaces');
    if (root.source.kind === 'bound') root.source.bound.body = { filter: {} };
    expect(() => compileReadSelection(doc, root)).toThrow(/recipe/);
  });
  it('preserves differently typed record IDs within one paginated collection', async () => {
    const doc = fixture();
    const resource = (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).workspace!;
    resource.schema = {
      type: 'object',
      properties: { id: {}, name: { type: 'string' } },
    };
    const result = await readSelection(doc, bound(doc, 'myWorkspaces'), {
      transport: async () => response([{ id: 7 }, { id: '7' }]),
    });
    expect(result.complete).toBe(true);
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]!.entity.key).not.toBe(
      result.observations[1]!.entity.key,
    );
  });
  it('permits unclassified next-link query only after an actual page proves that next read', async () => {
    const doc = fixture(),
      guard = compileReadSelection(doc, bound(doc, 'myWorkspaces'));
    expect(guard.allows(request('/me/workspaces?page=2'))).toBe(false);
    await guard.observe(request('/me/workspaces'), {
      ...response([{ id: 42 }]),
      headers: {
        link: '<https://api.example.test/v2/me/workspaces?page=2>; rel="next"',
      },
    });
    expect(guard.allows(request('/me/workspaces?page=2'))).toBe(true);
    expect(guard.allows(request('/me/workspaces?page=3'))).toBe(false);
  });
  it('accepts a mutable address rename only after matching canonical detail identity', async () => {
    const doc = fixture(),
      guard = compileReadSelection(doc, related(doc));
    await guard.observe(request('/names/alpha'), response({ slug: 'renamed' }));
    expect(guard.allows(request('/names/renamed/workspaces'))).toBe(false);
    await guard.observe(
      request('/names/alpha'),
      response({ id: 7, slug: 'renamed' }),
    );
    expect(guard.allows(request('/names/renamed/workspaces'))).toBe(true);
    expect(guard.allows(request('/names/alpha/workspaces'))).toBe(false);
  });
  it('normalizes constrained entities as a deterministic typed set and rejects inconsistent duplicates', () => {
    const doc = fixture();
    const entities = [7, '7', 'ä', 'z', 'A'].map((id) =>
      resolveEntityIdentity(doc, { resource: 'workspace', record: { id } }),
    );
    const selection: ReadSelection = {
      version: 1,
      resource: 'task',
      source: {
        kind: 'fanout',
        from: bound(doc, 'myWorkspaces'),
        via: { collection: 'tasks', kind: 'identity' },
        entities: [...entities, entities[0]!, entities[1]!],
      },
    };
    const reordered = structuredClone(selection);
    if (reordered.source.kind === 'fanout')
      reordered.source.entities = entities.slice().reverse();
    const parsed = parseReadSelection(selection);
    expect(parsed.source.kind).toBe('fanout');
    if (parsed.source.kind !== 'fanout') throw new Error('Expected fanout');
    expect(parsed.source.entities?.map((e) => e.key)).toEqual(
      entities.map((e) => e.key).sort(),
    );
    expect(parsed.source.entities).toHaveLength(5);
    expect(readSelectionKey(selection)).toBe(readSelectionKey(reordered));
    const invalid = structuredClone(selection);
    if (invalid.source.kind === 'fanout')
      invalid.source.entities![5]!.values[0]![1] = 'different';
    expect(() => parseReadSelection(invalid)).toThrow(/identity/);
  });
});

describe('trusted response journal observations', () => {
  it('returns only new accepted target observations, retains raw values and ignores forged projection metadata', async () => {
    const doc = fixture(),
      guard = compileReadSelection(doc, bound(doc, 'myWorkspaces'));
    const raw = {
      id: 42,
      name: 'Actual provider value',
      owner: { id: 7 },
      projected: { values: { name: 'forged' } },
    };
    const observed = await guard.observe(
      request('/me/workspaces'),
      response([raw]),
    );
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      raw,
      projected: { values: { name: 'Actual provider value' } },
      entity: { resource: 'workspace' },
    });
    expect(
      await guard.observe(request('/me/workspaces'), response([raw])),
    ).toEqual([]);
    expect(
      await guard.observe(
        request('/me/workspaces'),
        response([{ ...raw, name: 'Changed' }]),
      ),
    ).toHaveLength(1);
    await expect(
      guard.observe(request('/me/accounts'), response([{ id: 8 }])),
    ).rejects.toThrow('authority');
  });
});

it('returns a journal page delta without re-emitting earlier roots or exposing mutable authority state', async () => {
  const doc = fixture(),
    guard = compileReadSelection(doc, bound(doc, 'myWorkspaces'));
  const first = await guard.observe(request('/me/workspaces'), {
    ...response([{ id: 42 }]),
    headers: {
      link: '<https://api.example.test/v2/me/workspaces?page=2>; rel="next"',
    },
  });
  expect(first).toHaveLength(1);
  first[0]!.raw.id = 999;
  first[0]!.entity.values[0]![1] = 999;
  const next = await guard.observe(
    request('/me/workspaces?page=2'),
    response([{ id: 43 }]),
  );
  expect(next.map((item) => item.raw.id)).toEqual([43]);
  expect(next[0]!.entity.values).toEqual([['workspace_id', 43]]);
  await expect(
    guard.observe(
      { ...request('/me/workspaces'), method: 'DELETE' },
      response([{ id: 99 }]),
    ),
  ).rejects.toThrow('authority');
});
