import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import { prepareCollection } from '../../../src/daemon/sync.js';
import {
  withEditLock,
  type LocalEdit,
  type LocalEdits,
} from '../../../src/daemon/edits.js';
import { WriteModel, mergeEdit } from '../../../src/daemon/write-model.js';
import { proxyWriteTransport } from '../../../src/daemon/write-transport.js';
import { proxyRequest } from '../../../src/cli/auth.js';
import type { Transport } from '../../../src/read/transport.js';
import type { CollectionConfig } from '../../../src/daemon/config.js';

const source: CollectionConfig = {
  platform: 'google-keep',
  account: 'invented',
  name: 'notes',
  connection: 'invented-connection',
  document: resolve('examples/daemon/google-keep.json'),
  collection: 'notes',
  bindings: {},
  query: {},
  pollSeconds: 300,
  writes: { enabled: true, allowReplacement: true },
};
const session = {
  issuer: 'https://proxy.example',
  accessToken: 'invented-access',
  scope: 'connections:read proxy:read proxy:write',
};
const connection = {
  connection_id: source.connection,
  platform: source.platform,
};
const original = {
  name: 'notes/original',
  title: 'Old title',
  body: { text: { text: 'Original text' } },
  permissions: [{ role: 'OWNER', email: 'invented@example.com' }],
  updateTime: '2026-10-29T00:00:00Z',
};
const desired = { title: 'New title', body: original.body };

describe('declared write model and bounded proxy transport', () => {
  it('uses resource-name segments and response body identity without mistaking it for a URL', async () => {
    const model = new WriteModel(
      await prepareCollection('invented-owner', source),
    );
    expect(model.id(original)).toBe('notes/original');
    expect(model.itemPath('notes/original', 'delete')).toBe(
      '/v1/notes/original',
    );
    expect(model.itemPath('notes/a b', 'get')).toBe('/v1/notes/a%20b');
    for (const value of [
      'notes/../escape',
      'notes//empty',
      'notes/.',
      'notes/ padded',
      '/notes/id',
      'notes/id/',
    ])
      expect(() => model.itemPath(value, 'delete')).toThrow();
    expect(model.payload(original)).toEqual({
      title: original.title,
      body: original.body,
    });
    expect(() =>
      model.payload({ ...desired, name: 'notes/injected' }, true),
    ).toThrow('Generated');
    expect(() =>
      model.payload({ ...desired, unknown: 'injected' }, true),
    ).toThrow('Undeclared');
    expect(() => model.payload({ body: { text: { text: 42 } } }, true)).toThrow(
      'Invalid value',
    );
  });
  it('merges disjoint fields and refuses conflicting text or checklist edits', () => {
    expect(
      mergeEdit(
        { title: 'a', body: { text: 'a' } },
        { title: 'b', body: { text: 'a' } },
        { title: 'a', body: { text: 'b' } },
      ),
    ).toEqual({ title: 'b', body: { text: 'b' } });
    expect(() =>
      mergeEdit({ title: 'a' }, { title: 'b' }, { title: 'c' }),
    ).toThrow('/title');
    expect(() =>
      mergeEdit({ items: [1] }, { items: [2] }, { items: [3] }),
    ).toThrow('/items');
  });
  it('requires both scopes, bounds a connection, strips injected headers and never follows redirects', async () => {
    expect(() =>
      proxyWriteTransport({ ...session, scope: 'proxy:read' }, connection),
    ).toThrow('login --write');
    const calls: RequestInit[] = [];
    const transport = proxyWriteTransport(
      session,
      connection,
      undefined,
      (async (_url, init) => {
        calls.push(init!);
        return new Response('{}');
      }) as typeof fetch,
    );
    await transport({
      ...proxyRequest(session, connection, '/v1/notes'),
      method: 'POST',
      body: '{}',
      headers: { authorization: 'injected', 'x-secret': 'injected' },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: 'Bearer invented-access',
        'content-type': 'application/json',
      },
    });
    expect(calls[0].headers).not.toHaveProperty('x-secret');
    for (const path of ['/proxy/other/google-keep/v1/notes', '/connections'])
      await expect(
        transport({
          url: new URL(path, session.issuer),
          method: 'DELETE',
          headers: {},
        }),
      ).rejects.toThrow('escapes');
    await expect(
      transport({
        url: new URL(
          'https://other.example/proxy/invented-connection/google-keep/v1/notes',
        ),
        method: 'DELETE',
        headers: {},
      }),
    ).rejects.toThrow('escapes');
    await expect(
      transport({
        ...proxyRequest(session, connection, '/v1/notes'),
        method: 'POST',
        body: 'x'.repeat(1024 * 1024 + 1),
      }),
    ).rejects.toThrow('1 MiB');
    expect(calls).toHaveLength(1);
  });
});

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
describe.skipIf(!database)('durable local edits against PostgreSQL', () => {
  let archive: PostgresArchive;
  const owners: string[] = [];
  beforeAll(async () => {
    archive = new PostgresArchive(database!);
    await archive.initialize();
  });
  afterAll(async () => {
    if (archive) {
      await archive.pool.query(
        'DELETE FROM syncables_cache.local_edits WHERE owner=ANY($1::text[])',
        [owners],
      );
      await archive.close();
    }
  });
  async function fixture(config = source): Promise<{
    owner: string;
    notes: Map<string, Record<string, unknown>>;
    calls: string[];
    transport: Transport;
    lock: <T>(work: (edits: LocalEdits) => Promise<T>) => Promise<T>;
    enqueue: () => Promise<LocalEdit>;
  }> {
    const owner = 'edits-test-' + randomUUID();
    owners.push(owner);
    const prepared = await prepareCollection(owner, config);
    const notes = new Map<string, Record<string, unknown>>([
      [original.name, structuredClone(original)],
    ]);
    const calls: string[] = [];
    const transport: Transport = async (request) => {
      const path = decodeURIComponent(
        request.url.pathname.split('/google-keep')[1],
      );
      calls.push(request.method + ' ' + path);
      const id = path.slice('/v1/'.length);
      if (request.method === 'GET')
        return {
          status: notes.has(id) ? 200 : 404,
          headers: {},
          body: JSON.stringify(notes.get(id) ?? {}),
        };
      if (request.method === 'POST') {
        const created = {
          ...JSON.parse(request.body!),
          name: 'notes/replacement',
        } as Record<string, unknown>;
        notes.set('notes/replacement', created);
        return { status: 200, headers: {}, body: JSON.stringify(created) };
      }
      notes.delete(id);
      return { status: 200, headers: {}, body: '{}' };
    };
    const lock = <T>(work: (edits: LocalEdits) => Promise<T>): Promise<T> =>
      withEditLock(archive.pool, owner, prepared, work);
    return {
      owner,
      notes,
      calls,
      transport,
      lock,
      enqueue: () =>
        lock((edits) =>
          edits.enqueue({
            action: 'replace',
            target: original.name,
            baseline: original,
            desired,
            revision: 'accepted-revision',
            owned: true,
          }),
        ),
    };
  }
  it('commits intent before acknowledgement, restores after restart, receipts before DELETE, and never replays confirmed edits', async () => {
    const h = await fixture();
    const queued = await h.enqueue();
    expect(queued).toMatchObject({
      state: 'queued',
      desired,
      baseline: original,
    });
    await h.lock(async (edits) => {
      const transport: Transport = async (request) => {
        if (request.method === 'DELETE')
          expect((await edits.list())[0]).toMatchObject({
            state: 'retiring',
            created_id: 'notes/replacement',
          });
        return h.transport(request);
      };
      expect(
        (await edits.send(transport, session, connection))[0],
      ).toMatchObject({ state: 'confirmed', created_id: 'notes/replacement' });
    });
    expect(h.notes.has(original.name)).toBe(false);
    expect(h.notes.get('notes/replacement')).toMatchObject(desired);
    const sent = h.calls.length;
    await h.lock((edits) => edits.send(h.transport, session, connection));
    expect(h.calls).toHaveLength(sent);
    await expect(h.enqueue()).rejects.toThrow('already retired');
  });
  it('records an explicit UUID idempotently and rejects an ID reused for a different intent', async () => {
    const h = await fixture();
    const id = randomUUID();
    const input = { id, action: 'create' as const, desired };
    await h.lock((edits) => edits.enqueue(input));
    expect(await h.lock((edits) => edits.enqueue(input))).toMatchObject({
      id,
      state: 'queued',
    });
    await expect(
      h.lock((edits) =>
        edits.enqueue({ ...input, desired: { title: 'different' } }),
      ),
    ).rejects.toThrow('another intent');
  });
  it('blocks default-off writes, replacement without consent, attachments and live collaborators', async () => {
    const disabled = { ...source };
    delete disabled.writes;
    const h = await fixture(disabled);
    await expect(h.enqueue()).rejects.toThrow('disabled');
    const allowed = await fixture();
    for (const baseline of [
      { ...original, attachments: [{ name: 'attachments/invented' }] },
      { ...original, permissions: [{ role: 'OWNER' }, { role: 'WRITER' }] },
    ]) {
      await expect(
        allowed.lock((edits) =>
          edits.enqueue({
            action: 'replace',
            target: original.name,
            baseline,
            desired,
            revision: 'r',
            owned: true,
          }),
        ),
      ).rejects.toThrow('blocked');
    }
    await expect(
      allowed.lock((edits) =>
        edits.enqueue({
          action: 'replace',
          target: original.name,
          baseline: original,
          desired,
          revision: 'r',
        }),
      ),
    ).rejects.toThrow('--owned');
    expect(allowed.calls).toEqual([]);
  });
  it('merges a remote body change into a local title edit; competing edits never POST', async () => {
    const h = await fixture();
    await h.enqueue();
    h.notes.set(original.name, {
      ...original,
      body: { text: { text: 'Remote text' } },
    });
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('confirmed');
    expect(h.notes.get('notes/replacement')).toMatchObject({
      title: desired.title,
      body: { text: { text: 'Remote text' } },
    });
    const conflict = await fixture();
    await conflict.enqueue();
    conflict.notes.set(original.name, { ...original, title: 'Remote title' });
    expect(
      (
        await conflict.lock((edits) =>
          edits.send(conflict.transport, session, connection),
        )
      )[0].state,
    ).toBe('conflict');
    expect(conflict.calls.every((call) => call.startsWith('GET'))).toBe(true);
  });
  it('rechecks replacement guards against the fresh remote note', async () => {
    const h = await fixture();
    await h.enqueue();
    h.notes.set(original.name, { ...original, attachments: [{}] });
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('conflict');
    expect(h.calls).toEqual(['GET /v1/notes/original']);
  });
  it('holds a lost create response, never repeats POST, and adopts an explicitly verified replacement', async () => {
    const h = await fixture();
    const edit = await h.enqueue();
    const lost: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'POST') throw new Error('Invented lost response');
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(lost, session, connection)))[0].state,
    ).toBe('uncertain');
    await h.lock((edits) => edits.send(h.transport, session, connection));
    expect(h.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    expect(h.notes.has(original.name)).toBe(true);
    await expect(
      h.lock((edits) =>
        edits.adopt(edit.id, original.name, h.transport, session, connection),
      ),
    ).rejects.toThrow('not an adoptable');
    await h.lock((edits) =>
      edits.adopt(
        edit.id,
        'notes/replacement',
        h.transport,
        session,
        connection,
      ),
    );
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('confirmed');
    expect(h.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
  });
  it('turns an interrupted dispatch into uncertain instead of automatically creating again', async () => {
    const h = await fixture();
    const edit = await h.enqueue();
    await archive.pool.query(
      "UPDATE syncables_cache.local_edits SET state='creating',sent=desired WHERE owner=$1 AND id=$2",
      [h.owner, edit.id],
    );
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('uncertain');
    expect(h.calls).toEqual([]);
  });
  it('retries retirement by its durable receipt after DELETE applied but the response was lost', async () => {
    const h = await fixture();
    await h.enqueue();
    const lost: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'DELETE') throw new Error('Lost response');
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(lost, session, connection)))[0],
    ).toMatchObject({ state: 'retiring', created_id: 'notes/replacement' });
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('confirmed');
    expect(h.calls.filter((call) => call.startsWith('POST'))).toHaveLength(1);
    expect(h.calls.filter((call) => call.startsWith('DELETE'))).toHaveLength(1);
  });
  it('keeps both notes if the original changes after POST; explicit keep-both settles without deletion', async () => {
    const h = await fixture();
    const edit = await h.enqueue();
    const race: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'POST')
        h.notes.set(original.name, { ...original, title: 'Concurrent title' });
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(race, session, connection)))[0],
    ).toMatchObject({ state: 'conflict', created_id: 'notes/replacement' });
    expect(h.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    await expect(h.lock((edits) => edits.cancel(edit.id))).rejects.toThrow(
      'Cannot cancel',
    );
    await h.lock((edits) => edits.keepBoth(edit.id));
    expect(h.notes.size).toBe(2);
    expect((await h.lock((edits) => edits.list()))[0].state).toBe('cancelled');
  });
  it('does not delete an original if the durably identified replacement is missing', async () => {
    const h = await fixture();
    await h.enqueue();
    const missing: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'POST') h.notes.delete('notes/replacement');
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(missing, session, connection)))[0]
        .state,
    ).toBe('retiring');
    expect(h.notes.has(original.name)).toBe(true);
    expect(h.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });
  it('never deletes on a failed create, and never automatically retries an ambiguous 500', async () => {
    for (const status of [403, 500]) {
      const h = await fixture();
      await h.enqueue();
      const fail: Transport = (request) =>
        request.method === 'POST'
          ? Promise.resolve({ status, headers: {}, body: '{}' })
          : h.transport(request);
      expect(
        (await h.lock((edits) => edits.send(fail, session, connection)))[0]
          .state,
      ).toBe(status === 500 ? 'uncertain' : 'failed');
      expect(h.notes.has(original.name)).toBe(true);
      expect(h.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
    }
  });
  it('requires an unchanged snapshot for explicit deletion and reconciles a lost DELETE response', async () => {
    const h = await fixture();
    await h.lock((edits) =>
      edits.enqueue({
        action: 'delete',
        target: original.name,
        baseline: original,
        revision: 'r',
      }),
    );
    const lost: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'DELETE') throw new Error('Lost');
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(lost, session, connection)))[0].state,
    ).toBe('retiring');
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('confirmed');
    expect(h.calls.some((call) => call.startsWith('POST'))).toBe(false);
  });
  it('refuses a stale explicit delete and a read-only or different connection send', async () => {
    const h = await fixture();
    await h.lock((edits) =>
      edits.enqueue({
        action: 'delete',
        target: original.name,
        baseline: original,
        revision: 'r',
      }),
    );
    await expect(
      h.lock((edits) =>
        edits.send(
          h.transport,
          { ...session, scope: 'proxy:read' },
          connection,
        ),
      ),
    ).rejects.toThrow('Read/write');
    await expect(
      h.lock((edits) =>
        edits.send(h.transport, session, {
          ...connection,
          connection_id: 'other',
        }),
      ),
    ).rejects.toThrow('configured connection');
    h.notes.set(original.name, { ...original, title: 'Remote edit' });
    expect(
      (await h.lock((edits) => edits.send(h.transport, session, connection)))[0]
        .state,
    ).toBe('conflict');
    expect(h.calls).toEqual(['GET /v1/notes/original']);
  });
  it('stops retirement when replacement permission is withdrawn, keeping its receipt', async () => {
    const config = structuredClone(source);
    const h = await fixture(config);
    await h.enqueue();
    const pause: Transport = async (request) => {
      const response = await h.transport(request);
      if (request.method === 'POST') config.writes!.allowReplacement = false;
      return response;
    };
    expect(
      (await h.lock((edits) => edits.send(pause, session, connection)))[0],
    ).toMatchObject({ state: 'retiring', created_id: 'notes/replacement' });
    expect(h.notes.size).toBe(2);
    expect(h.calls.some((call) => call.startsWith('DELETE'))).toBe(false);
  });
  it('aborts the send signal if the PostgreSQL lock session is terminated', async () => {
    const h = await fixture();
    const prepared = await prepareCollection(h.owner, source);
    const held = await archive.pool.connect();
    // Dedicated one-client pool boundary makes the lock session observable
    // without exposing it from the production queue API.
    const pool = { connect: async () => held } as typeof archive.pool;
    await withEditLock(pool, h.owner, prepared, async (_edits, signal) => {
      const pid = (await held.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid as number;
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await archive.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await aborted;
      expect(signal.aborted).toBe(true);
    });
    expect(h.calls).toEqual([]);
  });
  it('isolates owners and excludes concurrent collection senders', async () => {
    const h = await fixture();
    const other = await fixture();
    await h.enqueue();
    expect(await other.lock((edits) => edits.list())).toEqual([]);
    await h.lock(async () => {
      await expect(
        h.lock((edits) => edits.send(h.transport, session, connection)),
      ).rejects.toThrow('already syncing');
    });
    expect(h.calls).toEqual([]);
  });
});
