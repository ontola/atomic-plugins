import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitAtomicStore } from '../../../src/daemon/git-store.js';
import {
  prepareCollection,
  sourceClass,
  sourceSchemas,
  typeSourceRecord,
  upgradeSourceClasses,
} from '../../../src/daemon/sync.js';
import { daemonCommand } from '../../../src/daemon/commands.js';
const directories: string[] = [];
const IS_A = 'https://atomicdata.dev/properties/is-a';
const ID = 'urn:syncables:property:source-id';
const JSON_PROP = 'urn:syncables:property:source-json';
const BASE = 'urn:syncables:class:source-record';
async function fixture(): Promise<{
  store: GitAtomicStore;
  prepared: Awaited<ReturnType<typeof prepareCollection>>;
  config: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'syncables-class-'));
  directories.push(dir);
  const file = join(dir, 'source.json');
  const document = {
    openapi: '3.1.0',
    info: { title: 'Example notes API', version: '1' },
    servers: [{ url: 'https://example.invalid' }],
    paths: {
      '/notes': { get: { responses: { '200': { description: 'Notes' } } } },
    },
    components: {
      crudResources: {
        note: {
          identity: {
            urlTemplate: '/notes/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: {
            notes: { urlTemplate: '/notes', envelope: { itemsField: 'notes' } },
          },
        },
      },
    },
  };
  await writeFile(file, JSON.stringify(document));
  const source = {
    platform: 'example',
    account: 'work',
    name: 'notes',
    connection: 'invented',
    document: file,
    collection: 'notes',
    bindings: {},
    query: {},
    pollSeconds: 0,
  };
  const prepared = await prepareCollection('invented-owner', source);
  const store = new GitAtomicStore(join(dir, 'data.git'));
  await store.initialize();
  const config = join(dir, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      version: 1,
      owner: 'invented-owner',
      dataDirectory: store.directory,
      collections: [source],
    }),
  );
  return { store, prepared, config };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe('OpenAPI-scoped API resource classes', () => {
  it('namespaces the class to the exact document and API resource', async () => {
    const { prepared } = await fixture();
    const id = sourceClass(prepared);
    expect(id).toBe(`urn:syncables:oad:${prepared.documentHash}:class:note`);
    const schema = JSON.parse(sourceSchemas(prepared).get(id)!);
    expect(schema[IS_A]).toEqual(['https://atomicdata.dev/classes/Class']);
    expect(schema['urn:syncables:property:openapi-resource']).toBe('note');
    expect(schema['urn:syncables:property:openapi-document-hash']).toBe(
      prepared.documentHash,
    );
    expect(sourceClass({ ...prepared, documentHash: 'new-document' })).not.toBe(
      id,
    );
    expect(
      sourceClass({
        ...prepared,
        source: { ...prepared.source, document: '/moved/source.json' },
      }),
    ).toBe(id);
  });
  it('migrates existing data offline, preserves raw number lexemes, old commits and schema resolution', async () => {
    const { store, prepared } = await fixture();
    const raw = `{"@id":"urn:example:note","${IS_A}":["${BASE}"],"${ID}":"notes/1","${JSON_PROP}":{"id":9007199254740993,"unknownField":1.2300}}`;
    const first = await store.commit({
      scope: prepared.scope,
      context: { old: true },
      resources: new Map([['urn:example:note', raw]]),
    });
    await store.tag(prepared.scope, 'old');
    const next = await upgradeSourceClasses(prepared, store);
    expect(next).toBeDefined();
    expect(await store.history(prepared.scope)).toEqual([next, first]);
    expect(await store.resolveRevision(prepared.scope, 'tag:old')).toBe(first);
    const item = (await store.resource(prepared.scope, 'urn:example:note'))!;
    expect(item).toContain('9007199254740993');
    expect(item).toContain('1.2300');
    expect(JSON.parse(item)[IS_A]).toEqual([sourceClass(prepared), BASE]);
    expect(
      await store.resource(prepared.scope, sourceClass(prepared)),
    ).toBeDefined();
    expect(await store.resource(prepared.scope, BASE)).toBeDefined();
    expect(
      JSON.parse(
        (await store.resource(prepared.scope, 'urn:example:note', first))!,
      )[IS_A],
    ).toEqual([BASE]);
    expect(await upgradeSourceClasses(prepared, store)).toBeUndefined();
    expect(await typeSourceRecord(item, sourceClass(prepared))).toBe(item);
  });
  it('checks out and migrates old snapshots through the CLI without authentication or a database', async () => {
    const { store, prepared, config } = await fixture();
    const first = await store.commit({
      scope: prepared.scope,
      context: {},
      resources: new Map([
        [
          'urn:example:note',
          JSON.stringify({
            '@id': 'urn:example:note',
            [IS_A]: [BASE],
            [ID]: 'notes/1',
            [JSON_PROP]: { title: 'Invented' },
          }),
        ],
      ]),
    });
    vi.stubEnv('SYNCABLES_DATABASE_URL', '');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await daemonCommand(['checkout'], { config });
    const rows = JSON.parse(String(output.mock.calls.at(-1)![0]));
    expect(rows[0].alias).toBe('example/work/notes');
    expect(rows[0].directory).toBe(
      join(store.checkoutDirectory, 'example', 'work', 'notes'),
    );
    expect(
      await readFile(join(rows[0].directory, 'context.json'), 'utf8'),
    ).toContain('itemClass');
    expect(await store.history(prepared.scope)).toEqual([
      rows[0].revision,
      first,
    ]);
    await daemonCommand(['checkout'], { config });
    expect(await store.history(prepared.scope)).toHaveLength(2);
  });
});
