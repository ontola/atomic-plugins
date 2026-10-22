import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { GitAtomicStore } from '../../../src/daemon/git-store.js';
import {
  prepareCollection,
  syncCollection,
  SyncRetryError,
} from '../../../src/daemon/sync.js';
import { DaemonRunner, jobStatuses } from '../../../src/daemon/runner.js';
import { itemSubject, type DaemonConfig } from '../../../src/daemon/config.js';
import type { Session } from '../../../src/cli/auth.js';
import type { Transport } from '../../../src/read/transport.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';
const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const prefix = 'daemon-runtime-' + randomUUID();
const directories: string[] = [];
function document(incremental = false): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'Invented entries', version: '1' },
    servers: [{ url: 'https://api.example' }],
    paths: {
      '/entries': {
        get: {
          'x-pagination': [{ scheme: 'pages' }],
          responses: { '200': { description: 'Entries' } },
        },
      },
    },
    components: {
      paginationSchemes: {
        pages: {
          type: incremental ? ('incrementalSync' as never) : 'pageToken',
          request: {
            queryParameters: {
              page: { role: 'pageToken' },
              ...(incremental ? { since: { role: 'syncToken' } } : {}),
            },
          },
          response: {
            bodyFields: {
              next: { role: 'nextPageToken' },
              ...(incremental ? { checkpoint: { role: 'nextSyncToken' } } : {}),
            },
          },
        },
      },
      crudResources: {
        entry: {
          identity: {
            urlTemplate: '/entries/{entryId}',
            bindings: { entryId: { field: 'id' } },
          },
          collections: {
            entries: {
              urlTemplate: '/entries',
              envelope: { itemsField: 'items' },
              'x-list-tombstone': { field: 'deleted', values: [true] },
            },
          },
        },
      },
    },
  };
}
const response = (
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): ReturnType<Transport> => Promise.resolve({ status, headers, body });

describe.skipIf(!database)(
  'daemon snapshots and durable scheduling (real PostgreSQL and Git)',
  () => {
    let archive: PostgresArchive;
    beforeAll(async () => {
      archive = new PostgresArchive(database!);
      await archive.initialize();
    });
    afterAll(async () => {
      if (!archive) return;
      for (const table of [
        'daemon_inbox',
        'daemon_jobs',
        'heads',
        'leases',
        'attempts',
        'payloads',
        'runs',
        'json_nodes',
      ])
        await archive.pool.query(
          `DELETE FROM syncables_cache.${table} WHERE owner LIKE $1`,
          [prefix + '%'],
        );
      await archive.close();
      await Promise.all(
        directories.map((dir) => rm(dir, { recursive: true, force: true })),
      );
    });
    async function setup(incremental = false): Promise<{
      config: DaemonConfig;
      store: GitAtomicStore;
      prepared: Awaited<ReturnType<typeof prepareCollection>>;
      sync: (
        upstream: Transport,
        generation?: string,
        signal?: AbortSignal,
      ) => ReturnType<typeof syncCollection>;
    }> {
      const directory = await mkdtemp(join(tmpdir(), 'syncables-runtime-'));
      directories.push(directory);
      const file = join(directory, 'source.json');
      await writeFile(file, JSON.stringify(document(incremental)));
      const config: DaemonConfig = {
        version: 1,
        owner: prefix + randomUUID(),
        issuer: 'https://issuer.example',
        clientId: 'test-cli',
        dataDirectory: join(directory, 'data.git'),
        collections: [
          {
            platform: 'example',
            account: 'test',
            name: 'entries',
            collection: 'entries',
            document: file,
            connection: 'test-connection',
            bindings: {},
            query: {},
            pollSeconds: 0,
          },
        ],
      };
      const store = new GitAtomicStore(config.dataDirectory);
      await store.initialize();
      const prepared = await prepareCollection(
        config.owner,
        config.collections[0],
      );
      return {
        config,
        store,
        prepared,
        sync: (upstream, generation = 'grant-1', signal) =>
          syncCollection({
            prepared,
            archive,
            store,
            auth: {
              owner: config.owner,
              connection: 'test-connection',
              authorizationContext: generation,
            },
            upstream,
            ...(signal ? { signal } : {}),
          }),
      };
    }
    it('archives lossless nested numbers; full reads remove missing members but keep their history after reopening', async () => {
      const h = await setup();
      const first = await h.sync(async () =>
        response(
          '{"items":[{"id":"a","large":9007199254740993,"nested":{"n":1e400}},{"id":"b"}]}',
        ),
      );
      const subject = itemSubject(
        h.config.owner,
        h.config.collections[0],
        'entry',
        'a',
      );
      expect(
        await h.store.resource(h.prepared.scope, subject, first.revision),
      ).toContain('9007199254740993');
      expect(
        await h.store.resource(h.prepared.scope, subject, first.revision),
      ).toContain('1e400');
      const second = await h.sync(async () => response('{"items":[]}'));
      expect(second.records).toBe(0);
      const reopened = new GitAtomicStore(h.config.dataDirectory);
      await reopened.initialize();
      expect(
        await reopened.resource(h.prepared.scope, subject),
      ).toBeUndefined();
      expect(await reopened.history(h.prepared.scope, subject)).toEqual([
        second.revision,
        first.revision,
      ]);
      expect(
        await archive.jsonResponse(h.config.owner, first.run, 0),
      ).toMatchObject({ root: expect.any(String) });
    });
    it('reads the Keep trial profile through empty continuation pages and retains history on an empty account or failed page', async () => {
      const h = await setup();
      const source = {
        ...h.config.collections[0],
        platform: 'google-keep',
        document: resolve('examples/daemon/google-keep.json'),
        collection: 'notes',
        query: { pageSize: '100' },
      };
      const prepared = await prepareCollection(h.config.owner, source);
      const read = (upstream: Transport): ReturnType<typeof syncCollection> =>
        syncCollection({
          prepared,
          store: h.store,
          archive,
          auth: {
            owner: h.config.owner,
            connection: source.connection,
            authorizationContext: 'invented-keep-grant',
          },
          upstream,
        });
      const pages = [
        {
          notes: [
            {
              name: 'notes/invented-a',
              title: 'Imaginary checklist',
              body: {
                list: {
                  listItems: [
                    { text: { text: 'Fictional item' }, checked: false },
                  ],
                },
              },
            },
          ],
          nextPageToken: 'invented-page-2',
        },
        { nextPageToken: 'invented-page-3' },
        {
          notes: [{ name: 'notes/invented-b', title: 'Another invented note' }],
        },
      ];
      const tokens: (string | null)[] = [];
      const first = await read(async (request) => {
        expect(request.method).toBe('GET');
        expect(request.url.origin + request.url.pathname).toBe(
          'https://keep.googleapis.com/v1/notes',
        );
        expect(request.url.searchParams.get('pageSize')).toBe('100');
        tokens.push(request.url.searchParams.get('pageToken'));
        return response(JSON.stringify(pages[tokens.length - 1]));
      });
      expect(tokens).toEqual([null, 'invented-page-2', 'invented-page-3']);
      expect(first).toMatchObject({ records: 2, strategy: 'full' });
      const subject = itemSubject(
        h.config.owner,
        source,
        'note',
        'notes/invented-a',
      );
      expect(
        await h.store.resource(prepared.scope, subject, first.revision),
      ).toContain('Fictional item');
      const empty = await read(async () => response('{}'));
      expect(empty.records).toBe(0);
      expect(await h.store.resource(prepared.scope, subject)).toBeUndefined();
      expect(await h.store.history(prepared.scope, subject)).toEqual([
        empty.revision,
        first.revision,
      ]);
      let calls = 0;
      await expect(
        read(async () =>
          ++calls === 1
            ? response(JSON.stringify(pages[0]))
            : response('unavailable', 503),
        ),
      ).rejects.toThrow();
      await expect(
        read(async () => response('{"notes":{}}')),
      ).rejects.toThrow();
      expect(await h.store.head(prepared.scope)).toBe(empty.revision);
      expect(
        await archive.jsonResponse(h.config.owner, first.run, 1),
      ).toMatchObject({ root: expect.any(String) });
    });
    it('keeps the published head on a second-page error, cancellation, duplicate identity or unsafe numeric ID', async () => {
      const h = await setup();
      const first = await h.sync(async () =>
        response('{"items":[{"id":"a"}]}'),
      );
      let requests = 0;
      await expect(
        h.sync(async () =>
          ++requests === 1
            ? response('{"items":[{"id":"b"}],"next":"page-2"}')
            : response('unavailable', 503),
        ),
      ).rejects.toThrow();
      expect(requests).toBe(2);
      const controller = new AbortController();
      await expect(
        h.sync(
          async () => {
            controller.abort();
            return response('{"items":[]}');
          },
          'grant-1',
          controller.signal,
        ),
      ).rejects.toThrow('incomplete');
      await expect(
        h.sync(async () => response('{"items":[{"id":"a"},{"id":"a"}]}')),
      ).rejects.toThrow('Repeated identity');
      await expect(
        h.sync(async () => response('{"items":[{"id":9007199254740993}]}')),
      ).rejects.toThrow('unsafe numeric');
      expect(await h.store.head(h.prepared.scope)).toBe(first.revision);
    });
    it('publishes terminal incremental tokens with data, applies tombstones, and bootstraps after 410 or a new grant', async () => {
      const h = await setup(true);
      const initial = await h.sync(async () =>
        response('{"items":[{"id":"a"},{"id":"b"}],"checkpoint":"t1"}'),
      );
      expect(initial.strategy).toBe('bootstrap');
      const delta = await h.sync(async ({ url }) => {
        expect(url.searchParams.get('since')).toBe('t1');
        return response(
          '{"items":[{"id":"a","deleted":true},{"id":"c"}],"checkpoint":"t2"}',
        );
      });
      expect(delta.records).toBe(2);
      expect(delta.strategy).toBe('delta');
      expect(await h.store.context(h.prepared.scope)).toMatchObject({
        syncToken: 't2',
      });
      await expect(
        h.sync(async () => response('{"items":[{"id":"d"}]}')),
      ).rejects.toThrow('nextSyncToken');
      expect(await h.store.head(h.prepared.scope)).toBe(delta.revision);
      let calls = 0;
      const recovered = await h.sync(async ({ url }) => {
        calls++;
        if (url.searchParams.has('since')) return response('', 410);
        return response('{"items":[{"id":"z"}],"checkpoint":"fresh"}');
      });
      expect(calls).toBe(2);
      expect(recovered).toMatchObject({ strategy: 'bootstrap', records: 1 });
      await h.sync(async ({ url }) => {
        expect(url.searchParams.has('since')).toBe(false);
        return response('{"items":[],"checkpoint":"new-grant"}');
      }, 'grant-2');
    });
    it('retains an exhausted provider retry deadline and never retries a declared blocked response', async () => {
      const h = await setup();
      const start = Date.now();
      await expect(
        h.sync(async () => response('', 429, { 'retry-after': '3600' })),
      ).rejects.toMatchObject({ retryAt: expect.any(Number), blocked: false });
      try {
        await h.sync(async () => response('', 429, { 'retry-after': '3600' }));
      } catch (e) {
        expect((e as SyncRetryError).retryAt).toBeGreaterThan(
          start + 3_500_000,
        );
      }
      h.prepared.document['x-throttling'] = {
        signals: [{ status: [403], meaning: 'blocked' }],
      };
      const transport = vi.fn<Transport>(async () => response('', 403));
      await expect(h.sync(transport)).rejects.toMatchObject({ blocked: true });
      expect(transport).toHaveBeenCalledTimes(1);
    });
    it('deduplicates inbox delivery across restart, retains a hint arriving during a fetch, and serializes competing readers', async () => {
      const h = await setup();
      let inject = true;
      const auth = {
        session: async (): Promise<Session> => ({
          issuer: h.config.issuer,
          accessToken: 'invented',
        }),
        authorizationContext: async (): Promise<string> => 'grant-1',
      };
      const fetchImpl: typeof fetch = async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/connections')
          return Response.json({
            owner: h.config.owner,
            connections: [
              { connection_id: 'test-connection', platform: 'example' },
            ],
          });
        if (inject) {
          inject = false;
          await runner.trigger(
            'example/test/entries',
            'during-fetch',
            Buffer.from('{}'),
          );
          const competing = new DaemonRunner(
            h.config,
            archive,
            h.store,
            auth,
            fetchImpl,
          );
          await competing.initialize();
          expect(await competing.sync()).toEqual([
            {
              alias: 'example/test/entries',
              error: 'Collection already syncing',
            },
          ]);
        }
        return Response.json({ items: [{ id: 'a' }] });
      };
      const runner = new DaemonRunner(
        h.config,
        archive,
        h.store,
        auth,
        fetchImpl,
        'Collect a baseline for review',
      );
      await runner.initialize();
      expect(
        await runner.trigger(
          'example/test/entries',
          'delivery-1',
          Buffer.from('{}'),
        ),
      ).toBe(true);
      expect(
        await runner.trigger(
          'example/test/entries',
          'delivery-1',
          Buffer.from('{}'),
        ),
      ).toBe(false);
      expect((await runner.sync())[0]).toHaveProperty('result');
      const manual = (await h.store.historyEntries(h.prepared.scope))[0];
      expect(manual.message).toContain(
        'Intent (user supplied):\n  Collect a baseline for review',
      );
      expect(manual.message).toContain('Syncables-Trigger: manual');
      expect(manual.message).toContain('Syncables-Run: ');
      expect(manual.message).toContain('Syncables-Strategy: full');
      expect(manual.message).toContain('Syncables-Records: 1');
      expect((await jobStatuses(archive, h.config.owner))[0]).toMatchObject({
        state: 'pending',
        generation: '3',
        completed: '2',
      });
      const restarted = new DaemonRunner(
        h.config,
        archive,
        h.store,
        auth,
        fetchImpl,
      );
      await restarted.initialize();
      expect(
        await restarted.trigger(
          'example/test/entries',
          'delivery-1',
          Buffer.from('{}'),
        ),
      ).toBe(false);
      expect((await restarted.sync([], undefined, true))[0]).toHaveProperty(
        'result',
      );
      expect(
        (await h.store.historyEntries(h.prepared.scope))[0].message,
      ).toContain('Syncables-Trigger: scheduled');
      expect((await jobStatuses(archive, h.config.owner))[0]).toMatchObject({
        state: 'idle',
        generation: '3',
        completed: '3',
      });
      expect(await restarted.sync([], undefined, true)).toEqual([]);
      await expect(restarted.sync(['example/test/unknown'])).rejects.toThrow(
        'Unknown collection',
      );
    });
    it('authenticates webhook ingress and acknowledges only a durable deduplicated hint', async () => {
      const h = await setup();
      const temporary = createServer();
      await new Promise<void>((done) => temporary.listen(0, '127.0.0.1', done));
      const address = temporary.address();
      if (!address || typeof address === 'string')
        throw new Error('No loopback port');
      h.config.webhookPort = address.port;
      await new Promise<void>((done, reject) =>
        temporary.close((error) => (error ? reject(error) : done())),
      );
      const token = 'invented-webhook-secret-for-local-tests';
      const fetchImpl: typeof fetch = async (input) =>
        String(input).endsWith('/connections')
          ? Response.json({
              owner: h.config.owner,
              connections: [
                { connection_id: 'test-connection', platform: 'example' },
              ],
            })
          : Response.json({ items: [] });
      const runner = new DaemonRunner(
        h.config,
        archive,
        h.store,
        {
          session: async (): Promise<Session> => ({
            issuer: h.config.issuer,
            accessToken: 'invented',
          }),
          authorizationContext: async (): Promise<string> => 'grant',
        },
        fetchImpl,
      );
      await runner.initialize();
      const controller = new AbortController();
      let ready = false;
      const running = runner.daemon(
        controller.signal,
        () => {
          ready = true;
        },
        [],
        token,
      );
      try {
        await vi.waitFor(() => expect(ready).toBe(true));
        const endpoint = `http://127.0.0.1:${address.port}/webhooks/example%2Ftest%2Fentries`;
        expect(
          (await fetch(endpoint, { method: 'POST', body: '{}' })).status,
        ).toBe(403);
        const headers = {
          authorization: 'Bearer ' + token,
          'x-syncables-delivery-id': 'http-delivery',
        };
        expect(
          (await fetch(endpoint, { method: 'POST', headers, body: '{}' }))
            .status,
        ).toBe(204);
        expect(
          (
            await archive.pool.query(
              'SELECT count(*) FROM syncables_cache.daemon_inbox WHERE owner=$1',
              [h.config.owner],
            )
          ).rows[0].count,
        ).toBe('1');
        expect(
          (await fetch(endpoint, { method: 'POST', headers, body: '{}' }))
            .status,
        ).toBe(204);
        expect(
          (
            await archive.pool.query(
              'SELECT count(*) FROM syncables_cache.daemon_inbox WHERE owner=$1',
              [h.config.owner],
            )
          ).rows[0].count,
        ).toBe('1');
      } finally {
        controller.abort();
        await running;
      }
    });
    it('exits when its database advisory-lock session is terminated', async () => {
      const h = await setup();
      const runner = new DaemonRunner(
        h.config,
        archive,
        h.store,
        {
          session: async (): Promise<Session> => ({
            issuer: h.config.issuer,
            accessToken: 'invented',
          }),
          authorizationContext: async (): Promise<string> => 'grant',
        },
        async () => Response.json({ owner: h.config.owner, connections: [] }),
      );
      await runner.initialize();
      const controller = new AbortController();
      let ready = false;
      const running = runner.daemon(controller.signal, () => {
        ready = true;
      });
      const outcome = running.catch((error: unknown) => error);
      await vi.waitFor(() => expect(ready).toBe(true));
      await archive.pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND classid=(hashtext('syncables-daemon')::bigint & 4294967295)::oid AND objid=(hashtext($1)::bigint & 4294967295)::oid",
        [h.config.owner],
      );
      expect(await outcome).toMatchObject({
        message: expect.stringContaining('lost its database lock'),
      });
    });
    it('does not publish data for an unapproved connection', async () => {
      const h = await setup();
      const fetchImpl = vi.fn<typeof fetch>(async () =>
        Response.json({ owner: h.config.owner, connections: [] }),
      );
      const runner = new DaemonRunner(
        h.config,
        archive,
        h.store,
        {
          session: async (): Promise<Session> => ({
            issuer: h.config.issuer,
            accessToken: 'invented',
          }),
          authorizationContext: async (): Promise<string> => 'grant',
        },
        fetchImpl,
      );
      await runner.initialize();
      expect((await runner.sync())[0].error).toContain('Authorization');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await h.store.head(h.prepared.scope)).toBeUndefined();
    });
  },
);
