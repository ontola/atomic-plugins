import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDaemonConfig, alias } from '../../../src/daemon/config.js';
import { findFileDuplicates } from '../../../src/daemon/file-duplicates.js';
import { inventoryFiles } from '../../../src/daemon/file-inventory.js';
import { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import { DaemonRunner } from '../../../src/daemon/runner.js';
import { prepareCollection } from '../../../src/daemon/sync.js';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { requestIdentity } from '../../../src/postgres/identity.js';

const db = process.env.SYNCABLES_TEST_DATABASE_URL;
const cleanups: (() => Promise<void>)[] = [];
const checksum = 'a'.repeat(64);
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const dropboxFile = (path: string, rev = 'rev-1'): Record<string, unknown> => ({
  '.tag': 'file',
  id: 'id:' + path,
  name: path.split('/').at(-1),
  path_lower: path,
  path_display: path,
  size: 18,
  rev,
  server_modified: '2026-10-01T09:00:00Z',
  content_hash: checksum,
});
const driveFile = (id: string, extra = {}): Record<string, unknown> => ({
  id,
  name: id + '.txt',
  parents: ['parent'],
  size: '19',
  version: '2',
  modifiedTime: '2026-10-02T09:00:00Z',
  sha256Checksum: checksum,
  sha1Checksum: 'b'.repeat(40),
  md5Checksum: 'c'.repeat(32),
  ...extra,
});

async function fixture(
  fileInventory: Record<string, unknown>,
  fetchImpl: typeof fetch,
  readLimits = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'syncd-file-inventory-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const owner = 'test-inventory-' + randomUUID();
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      owner,
      collections: [
        { account: 'personal', name: 'files', fileInventory, readLimits },
      ],
    }),
  );
  await writeFile(join(dir, 'token'), 'invented-token\n', { mode: 0o600 });
  const config = await loadDaemonConfig(path);
  const prepared = await prepareCollection(owner, config.collections[0]);
  const archive = new PostgresArchive(db!);
  const store = new PostgresHistoryStore(
    archive.pool,
    owner,
    join(dir, 'workspace'),
  );
  cleanups.push(async () => {
    try {
      for (const table of [
        'file_inventory_stages',
        'snapshot_refs',
        'snapshot_members',
        'snapshot_revisions',
        'daemon_jobs',
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
    } finally {
      await archive.close();
    }
  });
  const session = vi.fn(async () => {
    throw new Error('Unexpected IAP login');
  });
  const makeRunner = async (): Promise<DaemonRunner> => {
    const runner = new DaemonRunner(
      config,
      archive,
      store,
      {
        session,
        authorizationContext: session,
      },
      fetchImpl,
    );
    await runner.initialize();
    return runner;
  };
  const runner = await makeRunner();
  return {
    dir,
    runner,
    makeRunner,
    store,
    archive,
    session,
    scope: prepared.scope,
    alias: alias(prepared.source),
    head: () => store.head(prepared.scope),
    files: async (at?: string) =>
      inventoryFiles(await store.list(prepared.scope, at)),
  };
}

describe.skipIf(!db)('file inventories through the SyncD runner', () => {
  it('resumes Dropbox after a restart, archives read POSTs, and applies ordered subtree changes', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://api.dropboxapi.com');
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer invented-token',
      );
      expect(init?.method).toBe('POST');
      if (url.pathname === '/2/users/get_current_account')
        return Response.json({ account_id: 'dbid:test' });
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      calls.push(url.pathname + ':' + (body.cursor ?? ''));
      if (url.pathname === '/2/files/list_folder') {
        expect(body).toEqual({
          path: '',
          recursive: true,
          include_deleted: true,
          limit: 1000,
        });
        return Response.json({
          entries: [dropboxFile('/old/a.txt')],
          cursor: 'a',
          has_more: true,
        });
      }
      expect(url.pathname).toBe('/2/files/list_folder/continue');
      if (body.cursor === 'a')
        return Response.json({
          entries: [dropboxFile('/other.txt')],
          cursor: 'b',
          has_more: false,
        });
      if (body.cursor === 'c')
        return Response.json({ entries: [], cursor: 'c', has_more: false });
      expect(body.cursor).toBe('b');
      return Response.json({
        entries: [
          { '.tag': 'deleted', path_lower: '/old' },
          dropboxFile('/old/b.txt'),
          dropboxFile('/old/b.txt', 'rev-2'),
        ],
        cursor: 'c',
        has_more: false,
      });
    });
    const f = await fixture(
      { provider: 'dropbox', tokenFile: 'token' },
      fetchImpl,
      { maxRequests: 1 },
    );
    expect(await f.runner.sync()).toEqual([{ alias: f.alias, pending: true }]);
    expect(await f.head()).toBeUndefined();
    const restarted = await f.makeRunner();
    const [full] = await restarted.sync();
    expect(full.result).toMatchObject({ records: 2, strategy: 'bootstrap' });
    expect((await f.files()).get('/old/a.txt')).toMatchObject({
      path: '/old/a.txt',
      size: '18',
      hashes: { 'dropbox-content-hash': checksum },
    });
    const recorded = await f.archive.recorded(
      restarted.config.owner,
      full.result!.run,
      0,
    );
    expect(recorded.request).toMatchObject({
      method: 'POST',
      body: '{"cursor":"a"}',
    });
    expect(recorded.request.headers).not.toHaveProperty('authorization');
    const [delta] = await restarted.sync();
    expect(delta.result).toMatchObject({ records: 2, strategy: 'delta' });
    expect((await f.files()).get('/old/b.txt')?.revision).toBe('rev-2');
    expect((await f.files()).has('/old/a.txt')).toBe(false);
    expect((await f.files(full.result!.revision)).has('/old/a.txt')).toBe(true);
    expect((await restarted.sync())[0].result?.revision).toBe(
      delta.result?.revision,
    );
    expect(calls).toEqual([
      '/2/files/list_folder:',
      '/2/files/list_folder/continue:a',
      '/2/files/list_folder/continue:b',
      '/2/files/list_folder/continue:c',
    ]);
    expect(f.session).not.toHaveBeenCalled();
  });

  it('retains the published Dropbox inventory through an expired cursor and failed replacement', async () => {
    let reset = false;
    let first = true;
    let unavailable = true;
    let account = 'dbid:original';
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/2/users/get_current_account')
        return Response.json({ account_id: account });
      if (path === '/2/files/list_folder') {
        if (first) {
          first = false;
          return Response.json({
            entries: [dropboxFile('/old.txt')],
            cursor: 'initial',
            has_more: false,
          });
        }
        return Response.json({
          entries: [dropboxFile('/new.txt')],
          cursor: 'replacement',
          has_more: true,
        });
      }
      const { cursor } = JSON.parse(String(init?.body)) as { cursor: string };
      if (cursor === 'initial')
        return Response.json({
          entries: [dropboxFile('/stale.txt')],
          cursor: 'expired',
          has_more: true,
        });
      if (cursor === 'expired') {
        reset = true;
        return Response.json({ error: { '.tag': 'reset' } }, { status: 409 });
      }
      expect(cursor).toBe('replacement');
      if (unavailable) return Response.json({}, { status: 500 });
      return Response.json({ entries: [], cursor: 'current', has_more: false });
    });
    const f = await fixture(
      { provider: 'dropbox', tokenFile: 'token' },
      fetchImpl,
    );
    const [initial] = await f.runner.sync();
    const head = initial.result?.revision;
    expect(head).toBeTruthy();
    account = 'dbid:different';
    expect((await f.runner.sync())[0].error).toContain(
      'different provider account',
    );
    expect(await f.head()).toBe(head);
    account = 'dbid:original';
    expect((await f.runner.sync())[0].pending).toBe(true);
    expect(reset).toBe(true);
    expect((await f.runner.sync())[0].error).toContain('last saved page');
    expect(await f.head()).toBe(head);
    unavailable = false;
    expect((await (await f.makeRunner()).sync())[0].result?.strategy).toBe(
      'bootstrap',
    );
    expect([...(await f.files()).keys()]).toEqual(['/new.txt']);
  });

  it('bootstraps Google Drive using a pre-listing token, reconciles it, then polls changes', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://www.googleapis.com');
      expect(init?.method).toBe('GET');
      const path = url.pathname.replace('/drive/v3/', '');
      const token = url.searchParams.get('pageToken');
      if (path === 'about')
        return Response.json({ user: { permissionId: 'drive-person' } });
      calls.push(path + ':' + (token ?? ''));
      if (path === 'changes/startPageToken')
        return Response.json({ startPageToken: 'start' });
      const fields = url.searchParams.get('fields');
      expect(fields).toContain('sha256Checksum');
      expect(fields).toContain('md5Checksum');
      if (path === 'files') {
        if (!token) return Response.json({ files: [], nextPageToken: 'page2' });
        expect(token).toBe('page2');
        return Response.json({
          files: [
            driveFile('one'),
            driveFile('removed'),
            driveFile('folder', {
              mimeType: 'application/vnd.google-apps.folder',
            }),
            {
              id: 'doc',
              name: 'Docs document',
              mimeType: 'application/vnd.google-apps.document',
              version: '12',
            },
          ],
        });
      }
      expect(path).toBe('changes');
      if (token === 'start')
        return Response.json({
          changes: [{ fileId: 'removed', removed: true }],
          nextPageToken: 'next',
        });
      if (token === 'next')
        return Response.json({
          changes: [
            {
              fileId: 'one',
              file: driveFile('one', { headRevisionId: 'rev-3' }),
            },
          ],
          newStartPageToken: 'caught-up',
        });
      expect(token).toBe('caught-up');
      return Response.json({
        changes: [{ fileId: 'one', file: driveFile('one', { trashed: true }) }],
        newStartPageToken: 'synced',
      });
    });
    const f = await fixture(
      { provider: 'google-drive', tokenFile: 'token' },
      fetchImpl,
      { maxRequests: 2 },
    );
    expect((await f.runner.sync())[0].pending).toBe(true);
    expect((await f.runner.sync())[0].pending).toBe(true);
    expect(await f.head()).toBeUndefined();
    expect((await f.runner.sync())[0].result).toMatchObject({
      records: 2,
      strategy: 'bootstrap',
    });
    const records = await f.files();
    expect(records.get('one')).toMatchObject({
      size: '19',
      revision: 'rev-3',
      parents: ['parent'],
      hashes: { sha256: checksum, sha1: 'b'.repeat(40), md5: 'c'.repeat(32) },
    });
    expect(records.get('doc')).toMatchObject({ revision: '12', hashes: {} });
    expect((await f.runner.sync())[0].result).toMatchObject({
      records: 1,
      strategy: 'delta',
    });
    expect(calls).toEqual([
      'changes/startPageToken:',
      'files:',
      'files:page2',
      'changes:start',
      'changes:next',
      'changes:caught-up',
    ]);
  });

  it('resumes a listing past 5,000 records under the default read limits', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/2/users/get_current_account')
        return Response.json({ account_id: 'large' });
      const body = JSON.parse(String(init?.body)) as { cursor?: string };
      const page = Number(body.cursor ?? 0);
      const entries = Array.from({ length: page < 5 ? 1000 : 1 }, (_, i) =>
        dropboxFile('/file-' + (1000 * page + i) + '.txt'),
      );
      return Response.json({
        entries,
        cursor: String(page + 1),
        has_more: page < 5,
      });
    });
    const f = await fixture(
      { provider: 'dropbox', tokenFile: 'token' },
      fetchImpl,
    );
    expect((await f.runner.sync())[0].pending).toBe(true);
    expect(await f.head()).toBeUndefined();
    expect((await f.runner.sync())[0].result).toMatchObject({
      records: 5_001,
    });
    expect((await f.files()).size).toBe(5_001);
  }, 60_000);

  it('scans iCloud Drive metadata without using HTTP or following symlinks', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('Unexpected network request');
    });
    const f = await fixture(
      { provider: 'icloud-drive', directory: 'drive' },
      fetchImpl,
    );
    const drive = join(f.dir, 'drive');
    await mkdir(join(drive, 'sub'), { recursive: true });
    await writeFile(join(drive, 'sub', 'file.txt'), 'abc', { mode: 0o000 });
    await writeFile(join(drive, '.cloud.txt.icloud'), '');
    await symlink(f.dir, join(drive, 'outside'));
    const [initial] = await f.runner.sync();
    expect(initial.result).toMatchObject({ records: 2, strategy: 'full' });
    expect((await f.files()).get('/sub/file.txt')).toMatchObject({
      size: '3',
      hashes: {},
    });
    expect((await f.files()).get('/.cloud.txt.icloud')).toMatchObject({
      name: 'cloud.txt',
      hashes: {},
    });
    await rm(drive, { recursive: true });
    expect((await f.runner.sync())[0].error).toBeTruthy();
    expect(await f.head()).toBe(initial.result?.revision);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a token file readable by other users before reaching the provider', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const f = await fixture(
      { provider: 'google-drive', tokenFile: 'public' },
      fetchImpl,
    );
    await writeFile(join(f.dir, 'public'), 'invented-token', { mode: 0o644 });
    expect((await f.runner.sync())[0].error).toContain('owner-only token file');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

it('allows only metadata listing POSTs through the archive', () => {
  const request = {
    url: new URL('https://api.dropboxapi.com/2/files/list_folder/continue'),
    method: 'POST' as const,
    headers: {},
    body: '{"cursor":"a"}',
    purpose: 'list' as const,
  };
  expect(requestIdentity(request).key).not.toBe(
    requestIdentity({ ...request, body: '{"cursor":"b"}' }).key,
  );
  expect(() =>
    requestIdentity({
      ...request,
      body: '{"cursor":"a","access_token":"secret"}',
    }),
  ).toThrow();
  expect(() =>
    requestIdentity({
      ...request,
      url: new URL('https://api.dropboxapi.com/2/files/delete_v2'),
    }),
  ).toThrow();
});

it('compares provider hashes by algorithm and keeps name-and-size candidates separate', () => {
  const base = { id: 'one', name: 'file', size: '18' };
  const result = findFileDuplicates([
    {
      collection: 'dropbox/personal/files',
      provider: 'dropbox',
      file: { ...base, hashes: { 'dropbox-content-hash': checksum } },
    },
    {
      collection: 'google-drive/personal/files',
      provider: 'google-drive',
      file: { ...base, hashes: { sha256: checksum, md5: 'd'.repeat(32) } },
    },
    {
      collection: 'google-drive/personal/files',
      provider: 'google-drive',
      file: { ...base, id: 'two', hashes: { md5: 'd'.repeat(32) } },
    },
    {
      collection: 'icloud-drive/personal/files',
      provider: 'icloud-drive',
      file: { ...base, id: 'three', hashes: {} },
    },
  ]);
  expect(
    result.confirmed.map((group) => group.map((location) => location.file.id)),
  ).toEqual([['one', 'two']]);
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0].groups.map((group) => group.length)).toEqual([
    1, 2, 1,
  ]);
});
