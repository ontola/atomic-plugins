import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetch as braidFetch } from 'braid-http';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import {
  startBraidServer,
  type BraidServer,
  type BraidOptions,
} from '../../../src/daemon/braid.js';

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const prefix = 'braid-test-' + randomUUID();
const token = 'invented-local-braid-reader-token-only';
const authorization = 'Bearer ' + token;
const subject = 'urn:example:note';
const schema = 'urn:example:note-class';
const name = 'example/work/notes';
interface Envelope {
  format: string;
  collection: string;
  revision: string;
  resources: Record<string, string>;
}
interface Update {
  version: string[];
  parents: string[];
  body_text: string;
}
interface NativeResponse extends Response {
  subscription: AsyncIterable<Update>;
}
async function next(iterator: AsyncIterator<Update>): Promise<Update> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Missing Braid update')),
          3000,
        );
      }),
    ]);
    if (result.done) throw new Error('Braid subscription ended');
    return result.value;
  } finally {
    clearTimeout(timer);
  }
}
const envelope = (update: Update): Envelope =>
  JSON.parse(update.body_text) as Envelope;

describe.skipIf(!database)(
  'read-only Braid with PostgreSQL and an unmodified braid-http client',
  () => {
    let archive: PostgresArchive;
    let root: string;
    let counter = 0;
    const servers: BraidServer[] = [];
    const controllers: AbortController[] = [];
    beforeAll(async () => {
      archive = new PostgresArchive(database!);
      await archive.initialize();
      root = await mkdtemp(join(tmpdir(), 'syncd-braid-'));
    });
    afterEach(async () => {
      for (const controller of controllers.splice(0)) controller.abort();
      for (const server of servers.splice(0)) await server.close();
    });
    afterAll(async () => {
      if (!archive) return;
      for (const table of [
        'snapshot_refs',
        'snapshot_members',
        'snapshot_revisions',
        'json_nodes',
      ])
        await archive.pool.query(
          `DELETE FROM syncables_cache.${table} WHERE owner LIKE $1`,
          [prefix + '%'],
        );
      await archive.close();
      await rm(root, { recursive: true, force: true });
    });
    async function fixture(): Promise<{
      store: PostgresHistoryStore;
      scope: string;
      publish: (
        value: string | undefined,
        parent?: string,
        schemaValue?: string,
      ) => Promise<string>;
      start: (
        overrides?: Partial<BraidOptions>,
      ) => Promise<{ server: BraidServer; url: string }>;
    }> {
      const owner = prefix + '-' + counter++;
      const scope = JSON.stringify([
        owner,
        'private-connection',
        'document-hash',
      ]);
      const store = new PostgresHistoryStore(
        archive.pool,
        owner,
        join(root, String(counter)),
      );
      await store.initialize();
      return {
        store,
        scope,
        publish: (value, parent, schemaValue = 'v1') =>
          store.commit(
            {
              scope,
              resources: new Map([
                ...(value === undefined
                  ? []
                  : ([
                      [
                        subject,
                        `{"@id":"${subject}","urn:example:value":${value}}`,
                      ],
                    ] as [string, string][])),
                [
                  schema,
                  JSON.stringify({
                    '@id': schema,
                    'urn:example:schema': schemaValue,
                  }),
                ],
              ]),
              context: {
                owner,
                authorizationContext: 'internal-auth-context',
                syncToken: 'private-provider-cursor',
              },
            },
            parent,
          ),
        start: async (
          overrides = {},
        ): Promise<{ server: BraidServer; url: string }> => {
          const server = await startBraidServer({
            store,
            collections: [{ alias: name, scope }],
            token,
            port: 0,
            pollMs: 10,
            ...overrides,
          });

          servers.push(server);
          return {
            server,
            url: server.url + '/collections/' + encodeURIComponent(name),
          };
        },
      };
    }
    async function subscribe(
      url: string,
      parents?: string[],
    ): Promise<{
      response: NativeResponse;
      iterator: AsyncIterator<Update>;
      controller: AbortController;
    }> {
      const controller = new AbortController();
      controllers.push(controller);
      const response = (await braidFetch(url, {
        subscribe: true,
        multiplex: false,
        retry: false,
        heartbeats: 1,
        heartbeat_timer: false,
        headers: { authorization },
        signal: controller.signal,
        ...(parents === undefined ? {} : { parents }),
      })) as NativeResponse;
      return {
        response,
        iterator: response.subscription[Symbol.asyncIterator](),
        controller,
      };
    }
    it('serves pinned records and schemas with exact JSON text, excluding internal sync metadata', async () => {
      const f = await fixture();
      const one = await f.publish('9007199254740993123.00100');
      const { url } = await f.start();
      const response = await fetch(url, { headers: { authorization } });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('range-request-allow-methods')).toBeNull();
      const text = await response.text();
      const data = JSON.parse(text) as Envelope;
      expect(data).toMatchObject({
        format: 'syncd-braid-collection-v1',
        collection: name,
        revision: one,
      });
      expect(data.resources[subject]).toContain('9007199254740993123.00100');
      expect(data.resources[schema]).toContain('v1');
      expect(text).not.toMatch(
        /internal-auth-context|private-provider-cursor|private-connection/,
      );
      const version = response.headers.get('version')!;
      const two = await f.publish('2', one);
      const pinned = await fetch(url, { headers: { authorization, version } });
      expect(((await pinned.json()) as Envelope).revision).toBe(one);
      expect(
        (
          (await fetch(url, { headers: { authorization } }).then((r) =>
            r.json(),
          )) as Envelope
        ).revision,
      ).toBe(two);
    });
    it('streams initial state, schema edits, membership removal and reappearance to multiple native clients', async () => {
      const f = await fixture();
      const one = await f.publish('1');
      const { url } = await f.start();
      const a = await subscribe(url, []);
      const b = await subscribe(url);
      expect(a.response.status).toBe(209);
      expect(a.response.headers.get('content-type')).toBe(
        'application/http-history',
      );
      const first = await next(a.iterator);
      expect(envelope(first).revision).toBe(one);
      expect(envelope(await next(b.iterator)).revision).toBe(one);
      expect(await f.publish('1', one)).toBe(one);
      const two = await f.publish(undefined, one, 'v2');
      const second = await next(a.iterator);
      expect(second.parents).toEqual(first.version);
      expect(envelope(second)).toMatchObject({ revision: two });
      expect(envelope(second).resources[subject]).toBeUndefined();
      expect(envelope(second).resources[schema]).toContain('v2');
      expect(envelope(await next(b.iterator)).revision).toBe(two);
      const three = await f.publish('3', two, 'v2');
      expect(envelope(await next(a.iterator)).resources[subject]).toContain(
        ':3',
      );
      expect(envelope(await next(b.iterator)).revision).toBe(three);
    });
    it('replays every missed revision after server restart and waits quietly when the client is current', async () => {
      const f = await fixture();
      const one = await f.publish('1');
      const firstServer = await f.start();
      const a = await subscribe(firstServer.url);
      const first = await next(a.iterator);
      a.controller.abort();
      await firstServer.server.close();
      const two = await f.publish('2', one);
      const three = await f.publish('3', two);
      const { url } = await f.start();
      const b = await subscribe(url, first.version);
      const second = await next(b.iterator);
      const third = await next(b.iterator);
      expect(envelope(second).revision).toBe(two);
      expect(third.parents).toEqual(second.version);
      expect(envelope(third).revision).toBe(three);
      const c = await subscribe(url, third.version);
      const waiting = next(c.iterator);
      const four = await f.publish('4', three);
      expect(envelope(await waiting).revision).toBe(four);
    });
    it('closes the initial head/read/subscribe race without exposing a failed publication', async () => {
      const f = await fixture();
      const one = await f.publish('1');
      let concurrent: string | undefined;
      let rendered = false;
      const { url } = await f.start({
        store: {
          head: f.store.head.bind(f.store),
          revision: f.store.revision.bind(f.store),
          render: async (hash) => {
            if (!rendered) {
              rendered = true;
              concurrent = await f.publish('2', one);
            }
            return f.store.render(hash);
          },
        },
      });
      const a = await subscribe(url);
      expect(envelope(await next(a.iterator)).revision).toBe(one);
      expect(envelope(await next(a.iterator)).revision).toBe(concurrent);
      await expect(f.publish('99', one)).rejects.toThrow('changed');
      const three = await f.publish('3', concurrent);
      expect(envelope(await next(a.iterator)).revision).toBe(three);
    });
    it('requires scoped read authority and rejects mutations, malformed headers and unexpected origins', async () => {
      const f = await fixture();
      await f.publish('1');
      const { url, server } = await f.start();
      for (const headers of [{}, { authorization: 'Bearer wrong' }])
        expect((await fetch(url, { headers })).status).toBe(401);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
        expect(
          (await fetch(url, { method, headers: { authorization } })).status,
        ).toBe(405);
      expect(
        (
          await fetch(server.url + '/collections/other', {
            headers: { authorization },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await fetch(url, {
            headers: { authorization, origin: 'https://untrusted.example' },
          })
        ).status,
      ).toBe(403);
      const wrongHost = await new Promise<number | undefined>(
        (resolve, reject) => {
          request(
            url,
            { headers: { authorization, host: 'untrusted.example' } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          )
            .on('error', reject)
            .end();
        },
      );
      expect(wrongHost).toBe(403);
      for (const headers of [
        { version: 'not-quoted' },
        { version: '"a", "b"' },
        { subscribe: '?0' },
        { subscribe: '?1', version: '"a"' },
        { subscribe: '?1', heartbeats: '0s' },
        { subscribe: '?1', heartbeats: '-1' },
        { 'multiplex-through': '/.well-known/multiplexer/example/request' },
      ])
        expect(
          (await fetch(url, { headers: { authorization, ...headers } })).status,
        ).toBe(400);
    });
    it('permits only an explicitly allowed browser origin and does not grant cookie access', async () => {
      const f = await fixture();
      await f.publish('1');
      const { url } = await f.start({
        allowedOrigin: 'https://reader.example',
      });
      const headers = {
        origin: 'https://reader.example',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization, subscribe, parents',
      };
      const preflight = await fetch(url, { method: 'OPTIONS', headers });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        'https://reader.example',
      );
      expect(
        preflight.headers.get('access-control-allow-credentials'),
      ).toBeNull();
      expect(
        (await fetch(url, { headers: { origin: headers.origin } })).status,
      ).toBe(401);
      const response = await fetch(url, {
        headers: { authorization, origin: headers.origin },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('access-control-expose-headers')).toContain(
        'Version',
      );
      expect(
        (
          await fetch(url, {
            method: 'OPTIONS',
            headers: { ...headers, 'access-control-request-method': 'PUT' },
          })
        ).status,
      ).toBe(405);
    });
    it('requires a fresh snapshot for unknown or differently scoped versions and recovers with an unmodified client', async () => {
      const f = await fixture();
      await f.publish('1');
      const a = await f.start();
      const response = await fetch(a.url, { headers: { authorization } });
      const version = response.headers.get('version')!;
      const otherName = 'example/work/other';
      const b = await f.start({
        collections: [{ alias: otherName, scope: f.scope }],
      });
      const url =
        b.server.url + '/collections/' + encodeURIComponent(otherName);
      const wrongScope = await fetch(url, {
        headers: { authorization, subscribe: '?1', parents: version },
      });
      expect(wrongScope.status).toBe(409);
      expect(wrongScope.headers.get('braid-reset')).toBe('true');
      const unknown = version.replace(/[a-f0-9]{64}(?=")/, '0'.repeat(64));
      expect(
        (
          await fetch(a.url, {
            headers: { authorization, subscribe: '?1', parents: unknown },
          })
        ).status,
      ).toBe(409);
      const recovered = await subscribe(url);
      expect(envelope(await next(recovered.iterator)).collection).toBe(
        otherName,
      );
    });
    it('disconnects on database failure and replays accepted work after recovery', async () => {
      const f = await fixture();
      const one = await f.publish('1');
      let unavailable = false;
      const { url } = await f.start({
        store: {
          revision: f.store.revision.bind(f.store),
          render: f.store.render.bind(f.store),
          head: async (scope) => {
            if (unavailable) throw new Error('private database address');
            return f.store.head(scope);
          },
        },
      });
      const a = await subscribe(url);
      const first = await next(a.iterator);
      const ended = next(a.iterator).catch(() => 'closed');
      unavailable = true;
      expect(await ended).toBe('closed');
      const failed = await fetch(url, { headers: { authorization } });
      expect(failed.status).toBe(503);
      expect(await failed.text()).not.toContain('private database address');
      const two = await f.publish('2', one);
      unavailable = false;
      const b = await subscribe(url, first.version);
      expect(envelope(await next(b.iterator)).revision).toBe(two);
    });
  },
);

describe('Braid transport bounds', () => {
  const servers: BraidServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
  });
  function fixture(): {
    options: BraidOptions;
    setHead: (id: number) => void;
    setMerge: () => void;
  } {
    let head = 0;
    let merge = false;
    const id = (n: number): string => n.toString(16).padStart(64, '0');
    return {
      setHead: (n): void => {
        head = n;
      },
      setMerge: (): void => {
        merge = true;
      },
      options: {
        token,
        port: 0,
        collections: [{ alias: name, scope: 'invented-scope' }],
        store: {
          head: async (): Promise<string> => id(head),
          revision: async (current) => ({
            id: current,
            scope: 'invented-scope',
            parents:
              Number.parseInt(current, 16) === 0
                ? []
                : merge
                  ? [id(0), id(1)]
                  : [id(Number.parseInt(current, 16) - 1)],
            resources: {},
            context_text: '{}',
            message: '',
            author: '',
            committer: '',
            git_headers: null,
          }),
          render: async (): Promise<string> => '{}',
        },
      },
    };
  }
  async function start(options: BraidOptions): Promise<string> {
    const server = await startBraidServer(options);
    servers.push(server);
    return server.url + '/collections/' + encodeURIComponent(name);
  }
  it('bounds reconnect replay and explicitly resets across merges or a long gap', async () => {
    const f = fixture();
    const url = await start(f.options);
    const first = await fetch(url, { headers: { authorization } });
    const parents = first.headers.get('version')!;
    f.setHead(257);
    const gap = await fetch(url, {
      headers: { authorization, parents, subscribe: '?1' },
    });
    expect(gap.status).toBe(409);
    expect(gap.headers.get('braid-reset')).toBe('true');
    f.setHead(2);
    f.setMerge();
    expect(
      (
        await fetch(url, {
          headers: { authorization, parents, subscribe: '?1' },
        })
      ).status,
    ).toBe(409);
    // A fresh full snapshot remains available regardless of replay history.
    expect((await fetch(url, { headers: { authorization } })).status).toBe(200);
  });
  it('rejects oversized snapshots before streaming any collection state', async () => {
    const f = fixture();
    const base = f.options.store;
    const url = await start({
      ...f.options,
      store: {
        ...base,
        revision: async (current) => ({
          ...(await base.revision(current)),
          resources: { [subject]: 'large' },
        }),
        render: async (): Promise<string> => 'x'.repeat(32 * 1024 * 1024),
      },
    });
    const response = await fetch(url, {
      headers: { authorization, subscribe: '?1' },
    });
    expect(response.status).toBe(413);
    expect(await response.text()).not.toContain('syncd-braid-collection-v1');
  });
  it('bounds simultaneous readers and closes all subscriptions on shutdown', async () => {
    const f = fixture();
    const url = await start(f.options);
    for (let index = 0; index < 16; index++)
      expect(
        (
          await fetch(url, {
            headers: { authorization, subscribe: '?1' },
          })
        ).status,
      ).toBe(209);
    expect((await fetch(url, { headers: { authorization } })).status).toBe(503);
    await servers[0].close();
    await expect(fetch(url)).rejects.toThrow();
  });
  it('requires deliberate token, origin and collection configuration', async () => {
    const f = fixture();
    await expect(startBraidServer({ ...f.options, token: '' })).rejects.toThrow(
      'TOKEN',
    );
    await expect(
      startBraidServer({ ...f.options, allowedOrigin: 'null' }),
    ).rejects.toThrow();
    await expect(
      startBraidServer({
        ...f.options,
        allowedOrigin: 'https://reader.example/path',
      }),
    ).rejects.toThrow('exact');
    await expect(
      startBraidServer({ ...f.options, collections: [] }),
    ).rejects.toThrow('collection');
  });
});
