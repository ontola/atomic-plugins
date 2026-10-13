import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  PostgresArchive,
  createCachingTransport,
  createReplayTransport,
  type ArchiveScope,
} from '../../../src/postgres/index.js';
import {
  readCollections,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/index.js';

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const prefix = `invented-owner-${randomUUID()}`;
const scope = (name: string): ArchiveScope => ({
  owner: `${prefix}-${name}`,
  connection: 'demo-connection',
  authorizationContext: 'demo-grant-v1',
});
const request = (path = '/issues'): TransportRequest => ({
  url: new URL(`https://api.example${path}`),
  method: 'GET',
  headers: {},
});
const response = (
  body = 'note '.repeat(1000),
  headers: Record<string, string> = {},
): TransportResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body,
});

describe.skipIf(!database)('local PostgreSQL archive (real database)', () => {
  let archive: PostgresArchive;
  beforeAll(async () => {
    archive = new PostgresArchive(database!);
    await archive.initialize();
  });
  afterAll(async () => {
    if (!archive) return;
    for (const table of ['heads', 'leases', 'attempts', 'payloads', 'runs'])
      await archive.pool.query(
        `DELETE FROM syncables_cache.${table} WHERE owner LIKE $1`,
        [`${prefix}%`],
      );
    await archive.close();
  });

  it('deduplicates/compresses payloads, records cache hits and replays after reopening', async () => {
    const owner = scope('reopen');
    const run = await archive.createRun(owner, 'reopen test');
    let calls = 0;
    const live = createCachingTransport({
      archive,
      scope: owner,
      run,
      mode: 'cache',
      maxAgeMs: 60_000,
      upstream: async () => {
        calls++;
        return response();
      },
    });
    const first = await live(request());
    expect(await live(request())).toEqual(first);
    expect(calls).toBe(1);
    await archive.finishRun(owner.owner, run);
    const payloads = await archive.pool.query(
      'SELECT codec,raw_bytes,octet_length(data) AS packed FROM syncables_cache.payloads WHERE owner=$1',
      [owner.owner],
    );
    expect(payloads.rows).toHaveLength(1);
    expect(payloads.rows[0].codec).toBe('zstd-v1');
    expect(payloads.rows[0].packed).toBeLessThan(payloads.rows[0].raw_bytes);
    const origins = await archive.pool.query(
      'SELECT origin,source_attempt FROM syncables_cache.attempts WHERE owner=$1 ORDER BY sequence',
      [owner.owner],
    );
    expect(origins.rows.map((row) => row.origin)).toEqual([
      'upstream',
      'cache',
    ]);
    expect(origins.rows[1].source_attempt).toBeTruthy();
    const reopened = new PostgresArchive(database!);
    try {
      const replay = await createReplayTransport({
        archive: reopened,
        owner: owner.owner,
        run,
      });
      expect(await replay(request())).toEqual(first);
      expect(await replay(request())).toEqual(first);
      await expect(replay(request())).rejects.toThrow('missing');
    } finally {
      await reopened.close();
    }
  });

  it('isolates owners, connections and authorization revisions', async () => {
    const owner = scope('isolation');
    const run = await archive.createRun(owner, 'isolation test');
    const transport = createCachingTransport({
      archive,
      scope: owner,
      run,
      upstream: async () => response(),
    });
    await transport(request());
    await archive.finishRun(owner.owner, run);
    await expect(
      createReplayTransport({ archive, owner: scope('other').owner, run }),
    ).rejects.toThrow('not found');
    const wrong = { ...owner, connection: 'different-connection' };
    await expect(archive.begin(wrong, run, request())).rejects.toThrow('scope');
    const { requestIdentity } = await import(
      '../../../src/postgres/identity.js'
    );
    const key = requestIdentity(request()).cacheKey;
    expect(await archive.latest(wrong, key)).toBeUndefined();
    expect(
      await archive.latest(
        { ...owner, authorizationContext: 'new-grant' },
        key,
      ),
    ).toBeUndefined();
  });

  it('coalesces concurrent refreshes across independent PostgreSQL pools', async () => {
    const owner = scope('parallel');
    const other = new PostgresArchive(database!);
    try {
      const oneRun = await archive.createRun(owner, 'parallel one');
      const twoRun = await other.createRun(owner, 'parallel two');
      let calls = 0;
      const upstream = async (): Promise<TransportResponse> => {
        calls++;
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        return response();
      };
      const one = createCachingTransport({
        archive,
        scope: owner,
        run: oneRun,
        upstream,
      });
      const two = createCachingTransport({
        archive: other,
        scope: owner,
        run: twoRun,
        upstream,
      });
      const results = await Promise.all([one(request()), two(request())]);
      expect(results[0]).toEqual(results[1]);
      expect(calls).toBe(1);
      await Promise.all([
        archive.finishRun(owner.owner, oneRun),
        other.finishRun(owner.owner, twoRun),
      ]);
    } finally {
      await other.close();
    }
  });

  it('fences expired leases so a late response cannot replace the newer cache head', async () => {
    const owner = scope('fence');
    const run = await archive.createRun(owner, 'lease fencing');
    const old = await archive.begin(owner, run, request());
    const firstLease = (await archive.claim(owner, old.key, 30_000))!;
    await archive.pool.query(
      "UPDATE syncables_cache.leases SET expires_at=clock_timestamp()-interval '1 second' WHERE owner=$1",
      [owner.owner],
    );
    const newer = await archive.begin(owner, run, request());
    const secondLease = (await archive.claim(owner, newer.key, 30_000))!;
    await archive.response(newer, response('newer'), secondLease);
    await archive.response(old, response('older'), firstLease);
    await archive.release(owner, old.key, firstLease);
    expect((await archive.latest(owner, old.cacheKey))?.response.body).toBe(
      'newer',
    );
    const held = await archive.pool.query(
      'SELECT token FROM syncables_cache.leases WHERE owner=$1',
      [owner.owner],
    );
    expect(held.rows[0].token).toBe(secondLease);
    await archive.release(owner, newer.key, secondLease);
    await archive.finishRun(owner.owner, run);
  });

  it('rolls payload insertion back when an outcome cannot be committed', async () => {
    const owner = scope('rollback');
    const run = await archive.createRun(owner, 'transaction rollback');
    const attempt = await archive.begin(owner, run, request());
    const lease = (await archive.claim(owner, attempt.key, 30_000))!;
    await archive.response(attempt, response('first'), lease);
    await expect(
      archive.response(attempt, response('second distinct payload'), lease),
    ).rejects.toThrow('settled');
    const rows = await archive.pool.query(
      'SELECT hash FROM syncables_cache.payloads WHERE owner=$1',
      [owner.owner],
    );
    expect(rows.rows).toHaveLength(1);
    expect((await archive.latest(owner, attempt.cacheKey))?.response.body).toBe(
      'first',
    );
    await archive.release(owner, attempt.key, lease);
    await archive.finishRun(owner.owner, run);
  });

  it('keeps incomplete/crashed runs unreplayable and refuses request mismatch/mutations', async () => {
    const owner = scope('incomplete');
    const run = await archive.createRun(owner, 'interrupted read');
    await archive.begin(owner, run, request());
    await expect(archive.finishRun(owner.owner, run)).rejects.toThrow(
      'pending',
    );
    await expect(
      createReplayTransport({ archive, owner: owner.owner, run }),
    ).rejects.toThrow('completed');
    await archive.finishRun(owner.owner, run, false);
    const complete = await archive.createRun(owner, 'complete read');
    const transport = createCachingTransport({
      archive,
      scope: owner,
      run: complete,
      upstream: async () => response(),
    });
    await expect(transport({ ...request(), method: 'DELETE' })).rejects.toThrow(
      'GET',
    );
    await transport(request());
    await archive.finishRun(owner.owner, complete);
    const replay = await createReplayTransport({
      archive,
      owner: owner.owner,
      run: complete,
    });
    await expect(replay(request('/different'))).rejects.toThrow('match');
    await expect(
      replay({ ...request(), method: 'PUT', body: '{}' }),
    ).rejects.toThrow('GET');
    expect((await replay(request())).status).toBe(200);
  });

  it('records errors and conditional 304s without caching them as fresh bodies or keeping credentials', async () => {
    const owner = scope('conditional');
    const run = await archive.createRun(owner, 'conditional reads');
    let calls = 0;
    const transport = createCachingTransport({
      archive,
      scope: owner,
      run,
      mode: 'cache',
      maxAgeMs: 60_000,
      upstream: async (input) => {
        calls++;
        return input.headers['if-none-match']
          ? { status: 304, headers: { etag: 'demo-version' }, body: '' }
          : response('source body', {
              etag: 'demo-version',
              'set-cookie': 'invented-cookie',
            });
      },
    });
    await transport({
      ...request(),
      headers: { authorization: 'invented-access-value' },
    });
    expect(
      (
        await transport({
          ...request(),
          headers: { 'if-none-match': 'demo-version' },
        })
      ).status,
    ).toBe(304);
    expect(calls).toBe(2);
    const rows = await archive.pool.query(
      'SELECT request,headers,payload_hash,effective_payload_hash FROM syncables_cache.attempts WHERE owner=$1 ORDER BY sequence',
      [owner.owner],
    );
    expect(JSON.stringify(rows.rows)).not.toContain('invented-access-value');
    expect(JSON.stringify(rows.rows)).not.toContain('invented-cookie');
    expect(rows.rows[1].effective_payload_hash).toBe(rows.rows[0].payload_hash);
    expect(rows.rows[1].payload_hash).not.toBe(
      rows.rows[1].effective_payload_hash,
    );
    await archive.finishRun(owner.owner, run);
    const replay = await createReplayTransport({
      archive,
      owner: owner.owner,
      run,
    });
    await replay({
      ...request(),
      headers: { authorization: 'different ephemeral value' },
    });
    expect(
      (
        await replay({
          ...request(),
          headers: { 'if-none-match': 'demo-version' },
        })
      ).body,
    ).toBe('');
  });

  it('archives failed transport attempts without storing unsafe errors', async () => {
    const owner = scope('failure');
    const run = await archive.createRun(owner, 'failed network');
    const transport = createCachingTransport({
      archive,
      scope: owner,
      run,
      upstream: async () => {
        throw new Error('invented-private-error');
      },
    });
    await expect(transport(request())).rejects.toThrow('upstream read failed');
    await archive.finishRun(owner.owner, run);
    const replay = await createReplayTransport({
      archive,
      owner: owner.owner,
      run,
    });
    await expect(replay(request())).rejects.toThrow('upstream read failed');
    expect(
      JSON.stringify(await archive.recorded(owner.owner, run, 0)),
    ).not.toContain('invented-private-error');
  });

  it('respects no-store and upstream Age instead of silently serving stale responses', async () => {
    for (const headers of [
      { 'cache-control': 'no-store' },
      { 'cache-control': 'max-age="60"', age: '120' },
    ]) {
      const owner = scope(`freshness-${randomUUID()}`);
      const run = await archive.createRun(owner, 'freshness test');
      let calls = 0;
      const transport = createCachingTransport({
        archive,
        scope: owner,
        run,
        mode: 'cache',
        maxAgeMs: 60_000,
        upstream: async () => {
          calls++;
          return response('same data', headers);
        },
      });
      await transport(request());
      await transport(request());
      expect(calls).toBe(2);
      await archive.finishRun(owner.owner, run);
    }
  });

  it('rebuilds paginated Syncables collections using recorded responses with no upstream transport', async () => {
    const owner = scope('hydration');
    const run = await archive.createRun(owner, 'paged collection');
    const document: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 'Invented issues', version: '1' },
      servers: [{ url: 'https://api.example' }],
      paths: {
        '/issues': {
          get: {
            'x-pagination': [{ scheme: 'pages' }],
            responses: { '200': { description: 'Issues' } },
          },
        },
      },
      components: {
        crudResources: {
          issue: {
            collections: {
              issues: {
                urlTemplate: '/issues',
                envelope: { itemsField: null },
              },
            },
          },
        },
        paginationSchemes: {
          pages: {
            type: 'nextLink',
            response: { headers: { Link: { role: 'nextLink' } } },
          },
        },
      },
    };
    const transport = createCachingTransport({
      archive,
      scope: owner,
      run,
      upstream: async (input) =>
        input.url.searchParams.has('page')
          ? response(JSON.stringify([{ id: 2 }]))
          : response(JSON.stringify([{ id: 1 }]), {
              link: '<https://api.example/issues?page=2>; rel="next"',
            }),
    });
    const live = await readCollections(document, { transport });
    expect(live.errors).toEqual([]);
    expect(live.collections[0].items).toEqual([{ id: 1 }, { id: 2 }]);
    await archive.finishRun(owner.owner, run);
    const replay = await createReplayTransport({
      archive,
      owner: owner.owner,
      run,
    });
    const hydrated = await readCollections(document, { transport: replay });
    expect(hydrated.collections[0].items).toEqual(live.collections[0].items);
    expect(hydrated.errors).toEqual([]);
  });
});
