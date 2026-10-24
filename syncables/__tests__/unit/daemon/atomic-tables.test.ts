import { describe, expect, it } from 'vitest';
import {
  atomicTablesProjection,
  type NativeResource,
  type NativeValue,
  type TableSource,
} from '../../../src/daemon/atomic-tables.js';
import type { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import type { PreparedCollection } from '../../../src/daemon/sync.js';
import { SOURCE_ID, SOURCE_JSON } from '../../../src/daemon/sync.js';
import { indexJson } from '../../../src/postgres/json-graph.js';
import type { SchemaObject } from '../../../src/openapi/types.js';
const P = 'https://atomicdata.dev/properties/',
  C = 'https://atomicdata.dev/classes/';
function prepared(
  name: string,
  account = 'work',
  platform = 'example',
  schema: SchemaObject = {},
): PreparedCollection {
  return {
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
    expect(
      p.resources.some(
        (r) => r.key.includes('nested') && prop(r, 'name')?.value === 'owner',
      ),
    ).toBe(true);
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
        prepared: prepared('values'),
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
    const arrays = values.filter((v) => v.type === 'resources');
    expect(
      arrays.some((v) => Array.isArray(v.value) && v.value.length === 4),
    ).toBe(true);
    expect(JSON.stringify(p)).not.toContain('"type":"json"');
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
