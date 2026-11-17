import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import {
  atomicProjection,
  runAtomicPeer,
  type AtomicPeerStatus,
} from '../../../src/daemon/atomic-peer.js';
import { SOURCE_ID } from '../../../src/daemon/sync.js';

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const binary = process.env.SYNCABLES_ATOMIC_PEER_BINARY;
const collection = 'invented/work/notes';
const scope = 'invented-source-scope';
function signer(): { owner: string; secret: string } {
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ type: 'spki', format: 'der' })
    .subarray(-32)
    .toString('base64url');
  const privateKey = keys.privateKey
    .export({ type: 'pkcs8', format: 'der' })
    .subarray(-32)
    .toString('base64url');
  const owner = 'atomic:agent:' + publicKey;
  return {
    owner,
    secret: Buffer.from(
      JSON.stringify({ subject: owner, privateKey }),
    ).toString('base64url'),
  };
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function until(condition: () => boolean): Promise<void> {
  const end = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > end)
      throw new Error('Peer did not reach the expected revision');
    await delay(25);
  }
}
describe.skipIf(!database)(
  'Atomic projection of accepted PostgreSQL revisions',
  () => {
    it('preserves source number lexemes, schema provenance and owner boundaries', async () => {
      const { owner } = signer();
      const archive = new PostgresArchive(database!);
      const dir = await mkdtemp(join(tmpdir(), 'syncables-peer-source-'));
      try {
        await archive.initialize();
        const store = new PostgresHistoryStore(archive.pool, owner, dir);
        await store.initialize();
        const subject = 'urn:invented:item';
        const raw = `{"@id":"${subject}","${SOURCE_ID}":"1","urn:invented:value":900719925474099312345.00100,"https://atomicdata.dev/properties/is-a":["urn:invented:schema"]}`;
        const revision = await store.commit({
          scope,
          context: { owner, documentHash: 'invented-oad-pin' },
          resources: new Map([[subject, raw]]),
        });
        const projection = await atomicProjection(
          store,
          collection,
          scope,
          revision,
        );
        expect(projection.resources[0]?.raw).toContain(
          '900719925474099312345.00100',
        );
        expect(projection.resources[0]?.types).toEqual(['urn:invented:schema']);
        expect(projection.resources[0]?.item).toBe(true);
        expect(projection.context).toContain('invented-oad-pin');
        await expect(
          atomicProjection(store, collection, 'another-scope', revision),
        ).rejects.toThrow('another scope');
        const other = new PostgresHistoryStore(
          archive.pool,
          signer().owner,
          dir,
        );
        await expect(
          atomicProjection(other, collection, scope, revision),
        ).rejects.toThrow('Unknown snapshot');
      } finally {
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
        await rm(dir, { recursive: true, force: true });
      }
    });
  },
);
describe.skipIf(!database || !binary)(
  'real PostgreSQL → native Atomic process',
  () => {
    it('follows accepted revisions, catches up after stopping and reuses the drive', async () => {
      const { owner, secret } = signer();
      const reader = signer().owner;
      const archive = new PostgresArchive(database!);
      const dir = await mkdtemp(join(tmpdir(), 'syncables-peer-native-'));
      const controllers: AbortController[] = [];
      const tasks: Promise<void>[] = [];
      try {
        await archive.initialize();
        const store = new PostgresHistoryStore(
          archive.pool,
          owner,
          join(dir, 'workspace'),
        );
        await store.initialize();
        const signerFile = join(dir, 'invented-signer');
        await writeFile(signerFile, secret, { mode: 0o600 });
        const options = {
          owner,
          collection,
          scope,
          readers: [reader],
          binary: binary!,
          directory: join(dir, 'native'),
          signerFile,
          port: await port(),
        };
        const save = async (value: string): Promise<string> =>
          store.commit(
            {
              scope,
              context: { owner },
              resources: new Map([
                [
                  'urn:invented:item',
                  `{"@id":"urn:invented:item","${SOURCE_ID}":"1","urn:invented:value":${value}}`,
                ],
              ]),
            },
            await store.head(scope),
          );
        const first = await save('1.0000');
        const statuses: AtomicPeerStatus[] = [];
        const start = (): {
          controller: AbortController;
          task: Promise<void>;
        } => {
          const controller = new AbortController();
          controllers.push(controller);
          const task = runAtomicPeer(
            store,
            options,
            controller.signal,
            (status) => {
              statuses.push(status);
            },
          );
          // Keep failures observable while waiting for asynchronous publications.
          void task.catch(() => {});
          tasks.push(task);
          return { controller, task };
        };
        const running = start();
        await until(() => statuses.length >= 2);
        expect(statuses.at(-1)?.revision).toBe(first);
        const drive = statuses.at(-1)!.drive;
        const second = await save('900719925474099312345.001');
        await until(() => statuses.at(-1)?.revision === second);
        running.controller.abort();
        await running.task;
        const third = await save('1e9999');
        statuses.length = 0;
        const restarted = start();
        await until(() => statuses.length >= 2);
        expect(statuses.at(-1)?.revision).toBe(third);
        expect(statuses.every((s) => s.drive === drive)).toBe(true);
        restarted.controller.abort();
        await restarted.task;
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
        await rm(dir, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
