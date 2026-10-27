import { describe, expect, it } from 'vitest';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { fileURLToPath } from 'node:url';
import {
  atomicTablesProjection,
  atomicItemSchema,
  type NativeResource,
  type NativeValue,
  type TableSource,
} from '../../../src/daemon/atomic-tables.js';
import type { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import type { PreparedCollection } from '../../../src/daemon/sync.js';
import { SOURCE_ID, SOURCE_JSON } from '../../../src/daemon/sync.js';
import { indexJson, nodeHash } from '../../../src/postgres/json-graph.js';
import type { SchemaObject } from '../../../src/openapi/types.js';
const P = 'https://atomicdata.dev/properties/',
  C = 'https://atomicdata.dev/classes/';
function prepared(
  name: string,
  account = 'work',
  platform = 'example',
  schema: SchemaObject = {},
): PreparedCollection {
  const result: PreparedCollection = {
    source: {
      platform,
      account,
      name,
      collection: name,
      document: 'invented.json',
      connection: 'invented',
      bindings: {},
      query: {},
      pollSeconds: 300,
    },
    documentHash: 'a'.repeat(64),
    scope: `${platform}/${account}/${name}`,
    document: {
      openapi: '3.0.0',
      info: { title: 'Invented API', version: '1' },
      components: {
        crudResources: {
          record: {
            identity: {
              urlTemplate: '/items/{id}',
              bindings: { id: { field: 'id' } },
            },
            collections: {
              [name]: { urlTemplate: '/items', envelope: { itemsField: null } },
            },
          },
        },
      },
      paths: {
        '/items': {
          get: {
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: { type: 'array', items: schema },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  result.documentHash = nodeHash(JSON.stringify(result.document));
  return result;
}
function fixture(
  inputs: { prepared: PreparedCollection; rows: string[]; revision?: string }[],
): { store: PostgresHistoryStore; sources: TableSource[] } {
  const raws = new Map<string, string>(),
    revisions = new Map<string, object>();
  const sources = inputs.map((input, i) => {
    const revision = input.revision ?? String(i + 1).repeat(64),
      resources: Record<string, string> = {};
    for (const [index, row] of input.rows.entries()) {
      const subject = `urn:item:${input.prepared.scope}:${index}`;
      const raw = `{"@id":${JSON.stringify(subject)},"${SOURCE_ID}":"${index}","${SOURCE_JSON}":${row}}`;
      const graph = indexJson(raw);
      raws.set(graph.root, raw);
      resources[subject] = graph.root;
    }
    revisions.set(revision, {
      id: revision,
      scope: input.prepared.scope,
      context_text: JSON.stringify({
        context: { documentHash: input.prepared.documentHash },
      }),
      resources,
    });
    return { prepared: input.prepared, revision };
  });
  return {
    sources,
    store: {
      owner: 'atomic:agent:invented',
      revision: async (id: string) => revisions.get(id),
      render: async (root: string) => raws.get(root),
    } as unknown as PostgresHistoryStore,
  };
}
function prop(r: NativeResource, external: string): NativeValue | undefined {
  return r.properties.find(
    (p) => 'external' in p.property && p.property.external === P + external,
  )?.value;
}
function isClass(r: NativeResource, name: string): boolean {
  return r.classes.some((c) => 'external' in c && c.external === C + name);
}
function columns(resources: NativeResource[]): NativeResource[] {
  return resources.filter((r) => isClass(r, 'Property'));
}
describe('native Atomic collection tables', () => {
  it('shares operation schemas across accounts while retaining distinct account tables', async () => {
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' }, body: { type: 'object' } },
    };
    const work = prepared('notes', 'work', 'example', schema);
    const home = prepared('notes', 'home', 'example', schema);
    work.document.paths['/items'].get!.operationId = 'listNotes';
    home.document.paths['/items'].get!.operationId = 'listNotes';
    home.source.name = 'Personal notes';
    const f = fixture([
      { prepared: work, rows: ['{"title":"Work"}'] },
      { prepared: home, rows: ['{"title":"Home"}'] },
    ]);
    const projection = await atomicTablesProjection(f.store, f.sources);
    const classes = projection.resources.filter((r) => isClass(r, 'Class'));
    const tables = projection.resources.filter((r) => isClass(r, 'Table'));
    expect(classes).toHaveLength(1);
    expect(prop(classes[0], 'name')?.value).toContain('listNotes');
    expect(classes[0].key).not.toContain('work');
    expect(classes[0].key).not.toContain('home');
    expect(tables).toHaveLength(2);
    expect(prop(tables[0], 'classtype')).toEqual(prop(tables[1], 'classtype'));
    expect(tables[0].parent).not.toEqual(tables[1].parent);
    expect(
      columns(projection.resources).filter(
        (r) => prop(r, 'name')?.value === 'Body',
      ),
    ).toHaveLength(1);
    const schemas = projection.resources.filter(
      (r) =>
        isClass(r, 'Folder') &&
        'local' in r.parent &&
        r.parent.local === 'schemas',
    );
    expect(schemas).toHaveLength(1);
    expect(prop(schemas[0], 'name')?.value).toContain('GET /items');
  });

  it('separates different response operations within the same OAD', async () => {
    const first = prepared('notes');
    const document = first.document;
    document.paths['/archived'] = structuredClone(document.paths['/items']);
    const resource = (
      document.components!.crudResources as Record<
        string,
        {
          collections: Record<
            string,
            { urlTemplate: string; envelope: { itemsField: null } }
          >;
        }
      >
    ).record;
    resource.collections.archived = {
      urlTemplate: '/archived',
      envelope: { itemsField: null },
    };
    const second = structuredClone(first);
    second.source.name = 'Archived notes';
    second.source.collection = 'archived';
    second.scope += '/archived';
    first.documentHash = second.documentHash = nodeHash(
      JSON.stringify(document),
    );
    const f = fixture([
      { prepared: first, rows: [] },
      { prepared: second, rows: [] },
    ]);
    const projection = await atomicTablesProjection(f.store, f.sources);
    const classes = projection.resources.filter((r) => isClass(r, 'Class'));
    expect(classes).toHaveLength(2);
    expect(classes[0].key).not.toBe(classes[1].key);
    expect(classes.map((r) => prop(r, 'description')?.value)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('GET /items'),
        expect.stringContaining('GET /archived'),
      ]),
    );
  });

  it('keeps declared class definitions independent of observed records and changes identities with the OAD', async () => {
    const source = prepared('notes', 'work', 'example', {
      type: 'object',
      properties: { title: { type: 'string' } },
    });
    const empty = fixture([{ prepared: source, rows: [] }]);
    const populated = fixture([
      { prepared: source, rows: ['{"title":"Invented","extra":42}'] },
    ]);
    const first = await atomicTablesProjection(empty.store, empty.sources);
    const second = await atomicTablesProjection(
      populated.store,
      populated.sources,
    );
    const getClass = (resources: NativeResource[]): NativeResource =>
      resources.find((r) => isClass(r, 'Class'))!;
    expect(getClass(first.resources)).toEqual(getClass(second.resources));
    const changed = structuredClone(source);
    changed.documentHash = 'b'.repeat(64);
    const other = fixture([{ prepared: changed, rows: [] }]);
    const third = await atomicTablesProjection(other.store, other.sources);
    expect(getClass(third.resources).key).not.toBe(
      getClass(first.resources).key,
    );
  });

  it('uses the complete pinned Keep OAD, including response schemas and write operations', async () => {
    const document = await loadOpenApiDocument(
      fileURLToPath(
        new URL('../../../examples/daemon/google-keep.json', import.meta.url),
      ),
    );
    const source = prepared('notes');
    source.document = document;
    const item = atomicItemSchema(source);
    expect(document.info.title).toBe('Google Keep API');
    expect(document.paths['/v1/notes'].post).toBeDefined();
    expect(item.properties?.body.properties?.text.properties?.text.type).toBe(
      'string',
    );
    expect(
      item.properties?.body.properties?.list.properties?.listItems.items
        ?.properties?.checked.type,
    ).toBe('boolean');
    expect(item.properties?.permissions.items?.properties?.role.enum).toContain(
      'OWNER',
    );
    const f = fixture([
      {
        prepared: source,
        rows: [
          '{"title":"Invented","body":{"list":{"listItems":[{"text":{"text":"Hello"},"checked":false}]}}}',
        ],
      },
    ]);
    const projection = await atomicTablesProjection(f.store, f.sources);
    const body = columns(projection.resources).find(
      (r) => prop(r, 'name')?.value === 'Body',
    )!;
    const schema = prop(body, 'jsonSchema')!.value as Record<string, unknown>;
    let references = 0;
    const check = (value: unknown): void => {
      if (!value || typeof value !== 'object') return;
      const reference = (value as Record<string, unknown>).$ref;
      if (typeof reference === 'string' && reference.startsWith('#/')) {
        references++;
        const target = reference
          .slice(2)
          .split('/')
          .map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~'))
          .reduce<unknown>(
            (at, key) => (at as Record<string, unknown>)?.[key],
            schema,
          );
        expect(target).toBeDefined();
      }
      Object.values(value).forEach(check);
    };
    check(schema);
    expect(references).toBeGreaterThan(0);
  });

  it('distinguishes API identifiers and keeps the declared schema on inline JSON fields', async () => {
    const body = {
      type: 'object',
      properties: {
        text: { type: 'object', properties: { text: { type: 'string' } } },
      },
    };
    const source = prepared('notes', 'work', 'example', {
      type: 'object',
      properties: {
        title: { type: 'string' },
        name: { type: 'string' },
        body,
        permissions: {
          type: 'array',
          description: 'Provider ACL',
          items: { type: 'object' },
        },
      },
    });
    const resources = source.document.components!.crudResources as Record<
      string,
      { identity: { bindings: object } }
    >;
    resources.record.identity.bindings = { id: { field: 'name' } };
    const f = fixture([
      {
        prepared: source,
        rows: [
          JSON.stringify({
            title: 'Invented note',
            name: 'notes/one',
            body: { text: { text: 'Hello' } },
            permissions: [{ role: 'OWNER' }],
          }),
        ],
      },
    ]);
    const p = await atomicTablesProjection(f.store, f.sources);
    const props = columns(p.resources);
    const identifier = props.find(
      (r) => prop(r, 'name')?.value === 'API ID (name)',
    );
    expect(identifier).toBeDefined();
    expect(
      prop(props.find((r) => prop(r, 'name')?.value === 'Body')!, 'jsonSchema'),
    ).toEqual({ type: 'json', value: body });
    expect(
      prop(
        props.find((r) => prop(r, 'name')?.value === 'Source permissions')!,
        'description',
      )?.value,
    ).toContain('do not grant Atomic');
    expect(p.resources.filter((r) => r.key.startsWith('["row",'))).toHaveLength(
      1,
    );
    expect(p.resources.some((r) => /nested|array-entry/.test(r.key))).toBe(
      false,
    );
  });

  it('groups tables by platform/account and emits declared columns for an empty collection', async () => {
    const f = fixture([
      {
        prepared: prepared('issues', 'work', 'github'),
        rows: [
          '{"number":1,"title":"Issue","state":"open","user":{"login":"owner"},"labels":["bug"],"nothing":null}',
        ],
      },
      { prepared: prepared('comments', 'work', 'github'), rows: [] },
      {
        prepared: prepared('notes', 'work', 'keep', {
          type: 'object',
          properties: {
            title: { type: 'string' },
            created: { type: 'string', format: 'date-time' },
            count: { type: 'integer' },
          },
        }),
        rows: [],
      },
    ]);
    const p = await atomicTablesProjection(f.store, f.sources);
    const tables = p.resources.filter((r) => isClass(r, 'Table'));
    expect(tables).toHaveLength(3);
    expect(tables[0].parent).toEqual(tables[1].parent);
    expect(tables[2].parent).not.toEqual(tables[0].parent);
    expect(
      columns(p.resources).some(
        (r) =>
          prop(r, 'name')?.value === 'Created' &&
          JSON.stringify(prop(r, 'datatype')).includes('/timestamp'),
      ),
    ).toBe(true);
    expect(p.resources.some((r) => r.key.includes('nested'))).toBe(false);
    expect(
      p.resources.flatMap((r) => r.properties.map((p) => p.value)),
    ).toContainEqual({ type: 'json', value: { login: 'owner' } });
    expect(JSON.stringify(p)).not.toContain(SOURCE_JSON);
    expect(JSON.stringify(p)).not.toContain('source-json-ad');
    expect(p.sources).toHaveLength(3);
    expect(p.revision).toBe(
      (await atomicTablesProjection(f.store, [...f.sources].reverse()))
        .revision,
    );
  });
  it('retains exact unsafe numbers as native text, converts safe values and preserves ordered arrays', async () => {
    const f = fixture([
      {
        prepared: prepared('values', 'work', 'example', {
          type: 'object',
          properties: { huge: { type: 'number' } },
        }),
        rows: [
          '{"huge":900719925474099312345.00100,"overflow":1e9999,"decimal":0.1,"safe":42,"array":[true,null,{"nested":"yes"},[2,1]]}',
        ],
      },
    ]);
    const p = await atomicTablesProjection(f.store, f.sources);
    const values = p.resources.flatMap((r) => r.properties.map((p) => p.value));
    expect(values).toContainEqual({
      type: 'string',
      value: '900719925474099312345.00100',
    });
    expect(values).toContainEqual({ type: 'string', value: '1e9999' });
    expect(values).toContainEqual({ type: 'float', value: 0.1 });
    expect(values).toContainEqual({ type: 'integer', value: 42 });
    expect(values).toContainEqual({
      type: 'json',
      value: [true, null, { nested: 'yes' }, [2, 1]],
    });
    expect(p.resources.some((r) => r.key.includes('array-entry'))).toBe(false);
    const huge = columns(p.resources).filter(
      (r) => prop(r, 'name')?.value === 'Huge',
    );
    const exact = huge.find((r) =>
      JSON.stringify(prop(r, 'datatype')).includes('/string'),
    )!;
    const declared = huge.find((r) =>
      JSON.stringify(prop(r, 'datatype')).includes('/float'),
    )!;
    const view = p.resources.find((r) => isClass(r, 'View'))!;
    const visible = JSON.stringify(prop(view, 'view-columns'));
    // A declared numeric column must not hide its populated exact-text variant.
    expect(visible.indexOf(JSON.stringify(exact.key))).toBeLessThan(
      visible.indexOf(JSON.stringify(declared.key)),
    );
  });
  it('keeps complete nested comments inside one row and declares only top-level fields', async () => {
    const comments = [
      { id: 'c1', body: 'Hello', author: { login: 'alice' }, deleted: null },
      { id: 'c2', body: 'Reply', tags: [] },
    ];
    const f = fixture([
      {
        prepared: prepared('issues', 'work', 'github', {
          type: 'object',
          properties: {
            title: { type: 'string' },
            comments: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  author: {
                    type: 'object',
                    properties: { login: { type: 'string' } },
                  },
                },
              },
            },
          },
        }),
        rows: [JSON.stringify({ title: 'Issue', comments })],
      },
    ]);
    const p = await atomicTablesProjection(f.store, f.sources);
    const rows = p.resources.filter((r) => r.key.startsWith('["row",'));
    expect(rows).toHaveLength(1);
    expect(rows[0].properties.map((p) => p.value)).toContainEqual({
      type: 'json',
      value: comments,
    });
    expect(p.resources.filter((r) => isClass(r, 'Class'))).toHaveLength(1);
    expect(
      columns(p.resources).filter((r) => prop(r, 'name')?.value === 'Comments'),
    ).toHaveLength(1);
    expect(
      columns(p.resources).some((r) => prop(r, 'name')?.value === 'Login'),
    ).toBe(false);
    expect(p.format).toBe('atomic-tables-v2');
  });
  it('keeps native row and schema keys across new revisions and rejects a wrong scope or OAD pin', async () => {
    const first = fixture([
      { prepared: prepared('issues'), rows: ['{"title":"Before","n":1}'] },
    ]);
    const next = fixture([
      {
        prepared: prepared('issues'),
        revision: 'b'.repeat(64),
        rows: ['{"title":"After","n":2}'],
      },
    ]);
    const a = await atomicTablesProjection(first.store, first.sources),
      b = await atomicTablesProjection(next.store, next.sources);
    expect(a.resources.map((r) => r.key)).toEqual(
      b.resources.map((r) => r.key),
    );
    expect(a.revision).not.toBe(b.revision);
    first.sources[0].prepared.documentHash = 'c'.repeat(64);
    await expect(
      atomicTablesProjection(first.store, first.sources),
    ).rejects.toThrow('document does not match');
    first.sources[0].prepared.scope = 'other';
    await expect(
      atomicTablesProjection(first.store, first.sources),
    ).rejects.toThrow('another scope');
  });
});

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const binary = process.env.SYNCABLES_ATOMIC_PEER_BINARY;
describe.skipIf(!database || !binary)(
  'PostgreSQL → native collection tables',
  () => {
    it('publishes multiple collections, follows updates and recovers the same drive', async () => {
      const { generateKeyPairSync } = await import('node:crypto');
      const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const { createServer } = await import('node:net');
      const { setTimeout: delay } = await import('node:timers/promises');
      const { PostgresArchive } = await import(
        '../../../src/postgres/archive.js'
      );
      const { PostgresHistoryStore } = await import(
        '../../../src/daemon/history-store.js'
      );
      const { runAtomicTablesPeer } = await import(
        '../../../src/daemon/atomic-peer.js'
      );
      const keys = generateKeyPairSync('ed25519'),
        owner =
          'atomic:agent:' +
          keys.publicKey
            .export({ type: 'spki', format: 'der' })
            .subarray(-32)
            .toString('base64url');
      const secret = Buffer.from(
        JSON.stringify({
          subject: owner,
          privateKey: keys.privateKey
            .export({ type: 'pkcs8', format: 'der' })
            .subarray(-32)
            .toString('base64url'),
        }),
      ).toString('base64url');
      const root = await mkdtemp(join(tmpdir(), 'syncables-native-tables-'));
      const archive = new PostgresArchive(database!);
      const controllers: AbortController[] = [],
        tasks: Promise<void>[] = [];
      try {
        await archive.initialize();
        const store = new PostgresHistoryStore(
          archive.pool,
          owner,
          join(root, 'workspace'),
        );
        await store.initialize();
        const sources = [prepared('issues'), prepared('comments')];
        const save = async (
          source: PreparedCollection,
          title: string,
        ): Promise<string> =>
          store.commit(
            {
              scope: source.scope,
              context: { owner, documentHash: source.documentHash },
              resources: new Map([
                [
                  'urn:invented:' + source.source.name,
                  JSON.stringify({
                    '@id': 'urn:invented:' + source.source.name,
                    [SOURCE_ID]: '1',
                    [SOURCE_JSON]: {
                      id: 1,
                      title,
                      deep: { complete: true },
                      labels: ['one', 'two'],
                    },
                  }),
                ],
              ]),
            },
            await store.head(source.scope),
          );
        await save(sources[0], 'First issue');
        await save(sources[1], 'First comment');
        const server = createServer();
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        const port = (server.address() as { port: number }).port;
        await new Promise<void>((r) => server.close(() => r()));
        const signerFile = join(root, 'signer');
        await writeFile(signerFile, secret, { mode: 0o600 });
        let statuses: { drive: string; revision: string | null }[] = [];
        let failure: unknown;
        const start = (): AbortController => {
          const c = new AbortController();
          controllers.push(c);
          const task = runAtomicTablesPeer(
            store,
            {
              binary: binary!,
              directory: join(root, 'native'),
              signerFile,
              owner,
              collections: sources,
              readers: [owner],
              port,
            },
            c.signal,
            (s) => statuses.push(s),
          );
          void task.catch((e) => {
            failure = e;
          });
          tasks.push(task);
          return c;
        };
        const until = async (condition: () => boolean): Promise<void> => {
          const deadline = Date.now() + 30_000;
          while (!condition()) {
            if (failure) throw failure;
            if (Date.now() > deadline)
              throw Error('Native tables did not publish');
            await delay(25);
          }
        };
        const running = start();
        await until(() => statuses.length >= 2);
        const drive = statuses.at(-1)!.drive,
          first = statuses.at(-1)!.revision;
        await save(sources[0], 'Updated issue');
        await until(() => statuses.at(-1)?.revision !== first);
        running.abort();
        await tasks[0];
        await save(sources[1], 'Offline update');
        statuses = [];
        const restarted = start();
        await until(() => statuses.length >= 2);
        expect(statuses.every((s) => s.drive === drive)).toBe(true);
        restarted.abort();
        await tasks[1];
      } finally {
        controllers.forEach((c) => c.abort());
        await Promise.allSettled(tasks);
        for (const table of [
          'snapshot_refs',
          'snapshot_members',
          'snapshot_revisions',
          'json_nodes',
        ])
          await archive.pool.query(
            `DELETE FROM syncables_cache.${table} WHERE owner=$1`,
            [owner],
          );
        await archive.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
