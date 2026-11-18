import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startMacService } from '../../../src/macos/service.js';
import { macDocument } from '../../../src/macos/document.js';
import { readCollections } from '../../../src/read/collections.js';
import {
  localTransport,
  stageConnectorContent,
} from '../../../src/daemon/local-transport.js';
import { loadBrowserStatus } from '../../../src/daemon/browser-status.js';
import {
  loadDaemonConfig,
  type CollectionConfig,
} from '../../../src/daemon/config.js';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import { DaemonRunner } from '../../../src/daemon/runner.js';
import { withEditLock } from '../../../src/daemon/edits.js';
import { prepareCollection, SOURCE_ID } from '../../../src/daemon/sync.js';
import type { NativeOperation } from '../../../src/macos/native.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'macos-connector-test-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'drive');
  await mkdir(root);
  const token = 'a'.repeat(64);
  await writeFile(join(directory, 'token'), token, { mode: 0o600 });
  let items = [
    { id: 'file-one', name: 'cloud-only.txt', downloadStatus: 'notDownloaded' },
    { id: 'file-two', name: 'other.txt' },
  ];
  let fails = false;
  const native = vi.fn<NativeOperation>(async (request) => {
    if (fails) throw new Error('Permission revoked');
    if (request.operation === 'content') {
      await writeFile(String(request.export), 'Invented source bytes');
      return { exported: true };
    }
    if (request.operation === 'write') return { localStatus: 'written' };
    if (request.path) return { item: { uploadStatus: 'pending' } };
    return {
      items,
      complete: true,
      scope: { directory: root, view: 'macOS-local' },
    };
  });
  const server = await startMacService({
    directory: root,
    stateDirectory: directory,
    token,
    connection: 'test-local',
    port: 0,
    photos: true,
    writable: true,
    native,
    pageSize: 1,
  });
  cleanup.push(server.close);
  const document = macDocument(server.url, root, true, true);
  const documentFile = join(directory, 'openapi.json');
  await writeFile(documentFile, JSON.stringify(document));
  const source: CollectionConfig = {
    platform: 'macos',
    account: 'test',
    name: 'files',
    connection: 'test-local',
    document: documentFile,
    collection: 'files',
    bindings: {},
    query: {},
    pollSeconds: 0,
    local: { url: server.url, tokenFile: join(directory, 'token') },
  };
  return {
    directory,
    source,
    document,
    server,
    native,
    fail: () => {
      fails = true;
    },
    change: () => {
      items = [{ id: 'changed', name: 'changed.txt' }];
    },
  };
}

describe('macOS service through generic OpenAPI paths', () => {
  it('walks a stable paged metadata observation and makes no content calls', async () => {
    const f = await fixture();
    const result = await readCollections(f.document, {
      transport: localTransport(f.source),
    });
    expect(result.errors).toEqual([]);
    expect(result.collections[0].items).toHaveLength(2);
    expect(result.collections[0].complete).toBe(true);
    expect(f.native.mock.calls.map(([request]) => request.operation)).toEqual([
      'drive',
      'photos',
    ]);
  });
  it('rejects unauthenticated requests, origin attacks and expired cursors', async () => {
    const f = await fixture();
    expect((await fetch(f.server.url + '/files')).status).toBe(401);
    expect(
      (
        await fetch(f.server.url + '/files', {
          headers: {
            authorization: 'Bearer ' + 'a'.repeat(64),
            origin: 'https://example.com',
          },
        })
      ).status,
    ).toBe(403);
    const result = await localTransport(f.source)({
      url: new URL('/files?cursor=' + randomUUID() + ':1', f.server.url),
      method: 'GET',
      headers: {},
    });
    expect(result.status).toBe(409);
    await expect(
      localTransport(f.source)({
        url: new URL('https://example.com/files'),
        method: 'GET',
        headers: {},
      }),
    ).rejects.toThrow('escapes');
  });
  it('keeps local status independent of remote login', async () => {
    const f = await fixture();
    const session = vi.fn(async () => {
      throw new Error('Login required');
    });
    const status = await loadBrowserStatus({
      owner: 'test',
      collections: [f.source],
      jobs: async () => [],
      hasSnapshot: async () => true,
      session,
    });
    expect(session).not.toHaveBeenCalled();
    expect(status.discovery.state).toBe('local');
    expect(status.connections[0].availability).toBe('local');
  });
  it('refuses traversal, persists receipts and prevents duplicate dispatch', async () => {
    const f = await fixture();
    const transport = localTransport(f.source);
    const operationId = randomUUID();
    const request = (path: string) =>
      transport({
        url: new URL('/transfers', f.server.url),
        method: 'POST',
        headers: {},
        body: JSON.stringify({ operationId, path, kind: 'directory' }),
      });
    expect((await request('../escape')).status).toBe(400);
    const unusual = await transport({
      url: new URL('/transfers', f.server.url),
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        operationId: randomUUID(),
        path: 'folder\\with\ttab',
        kind: 'directory',
      }),
    });
    expect(unusual.status).toBe(201);
    expect((await request('folder')).status).toBe(201);
    expect((await request('folder')).status).toBe(201);
    expect(
      f.native.mock.calls.filter(([r]) => r.operation === 'write'),
    ).toHaveLength(2);
    expect((await request('different')).status).toBe(409);
    const saved = JSON.parse(
      await readFile(
        join(f.server.storageDirectory, 'receipts', operationId + '.json'),
        'utf8',
      ),
    );
    expect(saved.localStatus).toBe('written');
  });
  it('stages an explicit binary read from another configured collection without putting bytes in the JSON outbox', async () => {
    const f = await fixture();
    const destination = {
      ...f.source,
      name: 'transfers',
      collection: 'transfers',
      writes: { enabled: true as const },
    };
    const prepared = await prepareCollection('test', f.source);
    const path =
      '/files/' + Buffer.from('source.txt').toString('base64url') + '/content';
    const hash = await stageConnectorContent(
      destination,
      prepared,
      path,
      new AbortController().signal,
    );
    expect(
      await readFile(join(f.server.storageDirectory, 'blobs', hash), 'utf8'),
    ).toBe('Invented source bytes');
    expect(
      f.native.mock.calls.filter(
        ([request]) => request.operation === 'content',
      ),
    ).toHaveLength(1);
    await expect(
      stageConnectorContent(
        destination,
        prepared,
        '/photos',
        new AbortController().signal,
      ),
    ).rejects.toThrow('binary GET');
  });
  it('isolates transfer receipts when changing roots and restores them on reconnect', async () => {
    const f = await fixture();
    const operationId = randomUUID();
    const response = await localTransport(f.source)({
      url: new URL('/transfers', f.server.url),
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        operationId,
        path: 'first-root-folder',
        kind: 'directory',
      }),
    });
    expect(response.status).toBe(201);
    const otherRoot = join(f.directory, 'other-root');
    await mkdir(otherRoot);
    const other = await startMacService({
      directory: otherRoot,
      stateDirectory: f.directory,
      token: 'a'.repeat(64),
      connection: 'other-local',
      port: 0,
      photos: false,
      writable: true,
      native: f.native,
    });
    cleanup.push(other.close);
    const source = {
      ...f.source,
      connection: 'other-local',
      local: { ...f.source.local!, url: other.url },
    };
    const second = await localTransport(source)({
      url: new URL('/transfers', other.url),
      method: 'GET',
      headers: {},
    });
    expect(JSON.parse(second.body).items).toEqual([]);
    const restored = await startMacService({
      directory: join(f.directory, 'drive'),
      stateDirectory: f.directory,
      token: 'a'.repeat(64),
      connection: f.source.connection,
      port: 0,
      photos: false,
      writable: true,
      native: f.native,
    });
    cleanup.push(restored.close);
    const restoredSource = {
      ...f.source,
      local: { ...f.source.local!, url: restored.url },
    };
    const original = await localTransport(restoredSource)({
      url: new URL('/transfers', restored.url),
      method: 'GET',
      headers: {},
    });
    expect(
      JSON.parse(original.body).items.map((item: { id: string }) => item.id),
    ).toEqual([operationId]);
  });
  it('prioritizes active or completed uploads over retained errors while preserving the error evidence', async () => {
    const f = await fixture();
    const error = { domain: 'NSCocoaErrorDomain', code: 4355 };
    const active = {
      id: 'active',
      uploaded: false,
      uploading: true,
      uploadError: error,
    };
    f.native.mockImplementation(async (request) => {
      if (request.operation === 'write') return { localStatus: 'written' };
      if (request.path) return { item: active };
      return {
        complete: true,
        scope: {},
        items:
          request.operation === 'photos'
            ? []
            : [
                active,
                { ...active, id: 'complete', uploaded: true },
                { ...active, id: 'failed', uploading: false },
              ],
      };
    });
    const result = await readCollections(f.document, {
      transport: localTransport(f.source),
    });
    expect(result.errors).toEqual([]);
    expect(
      result.collections[0].items.map(
        (item) => (item as { uploadStatus: string }).uploadStatus,
      ),
    ).toEqual(['uploading', 'uploaded', 'failed']);
    const operationId = randomUUID();
    const written = await localTransport(f.source)({
      url: new URL('/transfers', f.server.url),
      method: 'POST',
      headers: {},
      body: JSON.stringify({
        operationId,
        path: 'upload-status',
        kind: 'directory',
      }),
    });
    expect(JSON.parse(written.body)).toMatchObject({
      localStatus: 'written',
      uploadStatus: 'uploading',
      uploadError: error,
    });
  });
  it('describes required path parameters, local authentication and binary staging in OpenAPI', async () => {
    const f = await fixture();
    for (const [template, path] of Object.entries(f.document.paths)) {
      for (const method of ['get', 'post'] as const) {
        const operation = path[method];
        if (!operation) continue;
        const variables = [...template.matchAll(/\{([^{}]+)\}/g)].map(
          (match) => match[1],
        );
        for (const name of variables)
          expect(operation.parameters).toContainEqual({
            name,
            in: 'path',
            required: true,
            schema: { type: 'string' },
          });
        expect(operation.parameters).toContainEqual({
          name: 'x-syncables-connection',
          in: 'header',
          required: true,
          schema: { type: 'string' },
        });
      }
    }
    expect(
      f.document.paths['/blobs'].post?.requestBody?.content?.[
        'application/octet-stream'
      ],
    ).toBeDefined();
    expect(f.document.security).toEqual([{ localConnector: [] }]);
  });
  it('validates explicit local transport configuration', async () => {
    const f = await fixture();
    const file = join(f.directory, 'config.json');
    await writeFile(
      file,
      JSON.stringify({ version: 1, owner: 'test', collections: [f.source] }),
    );
    expect((await loadDaemonConfig(file)).collections[0].local?.url).toBe(
      f.server.url,
    );
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        owner: 'test',
        collections: [
          {
            ...f.source,
            local: { ...f.source.local, url: 'https://example.com' },
          },
        ],
      }),
    );
    await expect(loadDaemonConfig(file)).rejects.toThrow('127.0.0.1');
  });
});

describe.skipIf(!process.env.SYNCABLES_TEST_DATABASE_URL)(
  'configured snapshot publication limits',
  () => {
    it('publishes a generic collection larger than 16 MiB only with an explicit budget', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'snapshot-budget-'));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const owner = 'snapshot-budget-' + randomUUID();
      const archive = new PostgresArchive(
        process.env.SYNCABLES_TEST_DATABASE_URL!,
      );
      cleanup.push(() => archive.close());
      await archive.initialize();
      const store = new PostgresHistoryStore(archive.pool, owner, directory);
      await store.initialize();
      const payload = 'a'.repeat(9 * 1024 * 1024);
      const resources = new Map(
        ['urn:budget:one', 'urn:budget:two'].map((subject) => [
          subject,
          JSON.stringify({ '@id': subject, 'urn:budget:payload': payload }),
        ]),
      );
      const snapshot = { scope: 'budget', resources, context: { owner } };
      await expect(store.commit(snapshot)).rejects.toThrow('16 MiB');
      expect(await store.head('budget')).toBeUndefined();
      const revision = await store.commit({
        ...snapshot,
        context: {
          owner,
          snapshotLimits: { maxRecords: 2, maxBytes: 32 * 1024 * 1024 },
        },
      });
      expect(await store.head('budget')).toBe(revision);
      expect(await store.resource('budget', 'urn:budget:one')).toContain(
        'urn:budget:payload',
      );
    }, 30_000);
  },
);

describe.skipIf(!process.env.SYNCABLES_TEST_DATABASE_URL)(
  'generic daemon and durable outbox with a native source',
  () => {
    it('archives pages, publishes snapshots, preserves the head on failure, and sends queued storage operations without IAP', async () => {
      const f = await fixture();
      const owner = 'macos-test-' + randomUUID();
      const archive = new PostgresArchive(
        process.env.SYNCABLES_TEST_DATABASE_URL!,
      );
      cleanup.push(() => archive.close());
      const config = {
        version: 1 as const,
        owner,
        issuer: 'https://example.com',
        clientId: 'test',
        dataDirectory: join(f.directory, 'data'),
        workspaceDirectory: join(f.directory, 'workspace'),
        collections: [f.source],
      };
      const store = new PostgresHistoryStore(
        archive.pool,
        owner,
        config.workspaceDirectory,
      );
      const auth = {
        session: vi.fn(async () => {
          throw new Error('Remote login must not run');
        }),
        authorizationContext: async () => 'unused',
      };
      const runner = new DaemonRunner(config, archive, store, auth);
      await runner.initialize();
      const initial = (await runner.sync())[0];
      expect(initial.error).toBeUndefined();
      expect(initial.result?.records).toBe(2);
      const prepared = await prepareCollection(owner, f.source);
      expect(
        (await store.list(prepared.scope)).filter((raw) =>
          Object.hasOwn(JSON.parse(raw), SOURCE_ID),
        ),
      ).toHaveLength(2);
      f.change();
      const changed = (await runner.sync())[0];
      expect(changed.result?.records).toBe(1);
      f.fail();
      expect((await runner.sync())[0].error).toBeTruthy();
      expect(await store.head(prepared.scope)).toBe(changed.result?.revision);
      expect(auth.session).not.toHaveBeenCalled();
      const transfer = {
        ...f.source,
        name: 'transfers',
        collection: 'transfers',
        writes: { enabled: true as const },
      };
      const destination = await prepareCollection(owner, transfer);
      const operationId = randomUUID();
      // Restore the adapter after the failed scan to exercise ordinary outbox delivery.
      f.native.mockImplementation(async (request) =>
        request.operation === 'write'
          ? { localStatus: 'written' }
          : { item: { uploadStatus: 'pending' } },
      );
      await withEditLock(archive.pool, owner, destination, (edits) =>
        edits.enqueue({
          action: 'create',
          id: operationId,
          desired: { operationId, path: 'new-folder', kind: 'directory' },
        }),
      );
      const receipt = await withEditLock(
        archive.pool,
        owner,
        destination,
        (edits) =>
          edits.send(localTransport(transfer), undefined, {
            connection_id: transfer.connection,
            platform: transfer.platform,
          }),
      );
      expect(receipt[0].state).toBe('confirmed');
      expect(receipt[0].created_id).toBe(operationId);
    });
  },
);
