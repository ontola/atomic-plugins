import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PostgresArchive,
  createCachingTransport,
  createReplayTransport,
} from '../../../src/postgres/index.js';
const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const owner = 'graph-test-' + randomUUID();
const scope = {
  owner,
  connection: 'test-connection',
  authorizationContext: 'test-grant',
};
const request = {
  url: new URL('https://api.example/items'),
  method: 'GET' as const,
  headers: {},
};

describe.skipIf(!database)('archived nested JSON (real PostgreSQL)', () => {
  let archive: PostgresArchive;
  beforeAll(async () => {
    archive = new PostgresArchive(database!);
    await archive.initialize();
  });
  afterAll(async () => {
    if (!archive) return;
    for (const table of [
      'heads',
      'leases',
      'attempts',
      'payloads',
      'runs',
      'json_nodes',
    ])
      await archive.pool.query(
        `DELETE FROM syncables_cache.${table} WHERE owner=$1`,
        [owner],
      );
    await archive.close();
  });
  it('commits deduplicated nodes with raw responses and reconstructs after restart', async () => {
    const run = await archive.createRun(scope, 'graph restart');
    const body =
      '{ "a": {"value":9007199254740993}, "b": [{"value":9007199254740993}] }';
    const live = createCachingTransport({
      archive,
      scope,
      run,
      mode: 'cache',
      maxAgeMs: 60_000,
      upstream: async () => ({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body,
      }),
    });
    await live(request);
    expect((await live(request)).fromCache).toBe(true);
    await archive.finishRun(owner, run);
    const nodes = await archive.pool.query(
      'SELECT count(*) FROM syncables_cache.json_nodes WHERE owner=$1',
      [owner],
    );
    expect(nodes.rows[0].count).toBe('3');
    const reopened = new PostgresArchive(database!);
    try {
      const indexed = await reopened.jsonResponse(owner, run, 0);
      expect(indexed.json).toBe(
        '{"a":{"value":9007199254740993},"b":[{"value":9007199254740993}]}',
      );
      expect((await reopened.jsonResponse(owner, run, 1)).root).toBe(
        indexed.root,
      );
      const replay = await createReplayTransport({
        archive: reopened,
        owner,
        run,
      });
      expect((await replay(request)).body).toBe(body);
      await expect(
        reopened.jsonResponse('other-owner', run, 0),
      ).rejects.toThrow('not found');
    } finally {
      await reopened.close();
    }
  });
  it('retains invalid/duplicate-key/non-JSON response text without a fake graph', async () => {
    const run = await archive.createRun(scope, 'invalid graph');
    const body = '{"x":1,"x":2}';
    const transport = createCachingTransport({
      archive,
      scope,
      run,
      upstream: async () => ({ status: 200, headers: {}, body }),
    });
    expect((await transport(request)).body).toBe(body);
    await archive.finishRun(owner, run);
    expect(await archive.jsonResponse(owner, run, 0)).toEqual({
      root: null,
      indexingError: 'Response is not indexable JSON within graph limits',
    });
    const replay = await createReplayTransport({ archive, owner, run });
    expect((await replay(request)).body).toBe(body);
  });
  it('rolls back response and node publication together', async () => {
    const run = await archive.createRun(scope, 'transaction rollback');
    const attempt = await archive.begin(scope, run, request);
    const token = await archive.claim(scope, attempt.key, 30_000);
    await archive.failure(attempt);
    await expect(
      archive.response(
        attempt,
        { status: 200, headers: {}, body: '{"new":"rollback"}' },
        token!,
      ),
    ).rejects.toThrow('already settled');
    const graph = await archive.pool.query(
      'SELECT 1 FROM syncables_cache.json_responses WHERE owner=$1 AND attempt=$2',
      [owner, attempt.id],
    );
    expect(graph.rowCount).toBe(0);
    const nodes = await archive.pool.query(
      "SELECT 1 FROM syncables_cache.json_nodes WHERE owner=$1 AND convert_from(data,'UTF8') LIKE '%rollback%'",
      [owner],
    );
    expect(nodes.rowCount).toBe(0);
    await archive.release(scope, attempt.key, token!);
    await archive.finishRun(owner, run, false);
  });
});
