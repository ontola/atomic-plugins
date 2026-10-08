// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  mergePatch,
  prepareDocument,
  type ApiClient,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// CRUD Causality 0.4.0 §4.3 `mode` and §4.6 `patchFormat` on the update
// operation (pieces.md K11): `mode: replace` sends the full record as
// before; `mode: patch, patchFormat: jsonMergePatch` sends only the changes
// as an RFC 7396 JSON Merge Patch and applies its semantics locally (null
// removes a field, a nested object merges); `jsonPatch` is refused;
// `custom`, no `patchFormat` and no declaration keep the full record.
// Transports and data are invented.

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
  private ns(resource: string): Map<string, Record<string, unknown>> {
    let ns = this.data.get(resource);
    if (!ns) this.data.set(resource, (ns = new Map()));
    return ns;
  }
  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.ns(resource).values()].map((v) => structuredClone(v));
  }
  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.ns(resource).set(id, structuredClone(value));
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
  crash(): CrashableStorage {
    const copy = new CrashableStorage();
    for (const [name, records] of this.data)
      copy.data.set(name, new Map(structuredClone([...records])));
    return copy;
  }
}

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

type Pet = Record<string, unknown>;
type Crud = Record<string, unknown>;

const REPLACE: Crud = { action: 'update', mode: 'replace', resource: 'pet' };
const MERGE: Crud = {
  action: 'update',
  mode: 'patch',
  patchFormat: 'jsonMergePatch',
  resource: 'pet',
};

/**
 * The pets fixture as a CRUD Causality document. `put`/`patch` give each
 * item operation's `x-crud` (`false` leaves the operation out; PATCH is
 * absent unless given). `mergeContent` declares
 * `application/merge-patch+json` as the PATCH request body.
 */
function document(
  options: {
    put?: Crud | false;
    patch?: Crud;
    mergeContent?: boolean;
  } = {},
): OpenApiDocument {
  const doc = prepareDocument({
    ...petsDocument,
    servers: [{ url: 'https://provider.example/api' }],
    components: {
      ...petsDocument.components,
      crudResources: {
        pet: {
          identity: {
            urlTemplate: '/pets/{petId}',
            bindings: { petId: { field: 'id' } },
          },
          collections: { pets: { urlTemplate: '/pets' } },
        },
      },
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  const put = item.put!;
  if (options.patch) {
    item.patch = { ...structuredClone(put), 'x-crud': options.patch };
    if (options.mergeContent)
      item.patch.requestBody = {
        content: { 'application/merge-patch+json': { schema: {} } },
      };
  }
  if (options.put === false) delete item.put;
  else if (options.put) put['x-crud'] = options.put;
  return doc;
}

/**
 * A fake provider that applies PUT as a replacement and PATCH as a JSON
 * Merge Patch, and records each write's method, content type and body.
 * `blocked` answers every write 503; `script` gives the status of the next
 * writes (a 2xx applies the write, anything else refuses it); `hold`, when
 * set, is awaited after a write is applied and before it is answered.
 */
function provider(initial: Pet[]): {
  pets: Map<string, Pet>;
  blocked: boolean;
  script: number[];
  hold: Promise<void> | undefined;
  writes: { method: string; contentType: string | undefined; body: unknown }[];
  transport: Transport;
} {
  const fake = {
    pets: new Map(initial.map((p) => [String(p['id']), p])),
    blocked: false,
    script: [] as number[],
    hold: undefined as Promise<void> | undefined,
    writes: [] as {
      method: string;
      contentType: string | undefined;
      body: unknown;
    }[],
    transport: (async (r: TransportRequest) => {
      const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
      if (r.method === 'GET' && !id) return response([...fake.pets.values()]);
      if (r.method === 'GET') {
        const pet = fake.pets.get(id);
        return pet ? response(pet) : response({ error: 'not found' }, 404);
      }
      const body: unknown = r.body ? JSON.parse(r.body) : undefined;
      fake.writes.push({
        method: r.method,
        contentType: r.headers['content-type'],
        body,
      });
      if (fake.blocked) return response({ error: 'invented' }, 503);
      const scripted = fake.script.shift();
      if (scripted !== undefined && (scripted < 200 || scripted >= 300))
        return response({ error: 'invented' }, scripted);
      const current = fake.pets.get(id);
      if (!current) return response({ error: 'not found' }, 404);
      if (r.method === 'DELETE') {
        fake.pets.delete(id);
        return response(undefined, 204);
      }
      const updated =
        r.method === 'PATCH'
          ? ({ ...(mergePatch(current, body) as Pet), id } as Pet)
          : { ...(body as Pet), id };
      fake.pets.set(id, updated);
      if (fake.hold) await fake.hold;
      return response(updated);
    }) as Transport,
  };
  return fake;
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
  await settle(5);
}

const rex = {
  id: '1',
  name: 'Rex',
  tag: 'dog',
  meta: { a: '1', b: '2' },
};

/** A synced client over `fake`, with the given document. */
async function synced(
  doc: OpenApiDocument,
  storage = new CrashableStorage(),
  retryMs = 60_000,
): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof provider>;
  storage: CrashableStorage;
}> {
  const fake = provider([structuredClone(rex)]);
  const client = createApiClient(doc, {
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: retryMs },
  });
  await client.sync();
  return { client, fake, storage };
}

describe('mergePatch (RFC 7396)', () => {
  it('applies the RFC 7396 example', () => {
    const target = {
      title: 'Goodbye!',
      author: { givenName: 'John', familyName: 'Doe' },
      tags: ['example', 'sample'],
      content: 'This will be unchanged',
    };
    const patch = {
      title: 'Hello!',
      phoneNumber: '+01-123-456-7890',
      author: { familyName: null },
      tags: ['example'],
    };
    expect(mergePatch(target, patch)).toEqual({
      title: 'Hello!',
      author: { givenName: 'John' },
      tags: ['example'],
      content: 'This will be unchanged',
      phoneNumber: '+01-123-456-7890',
    });
    // The target is not changed.
    expect(target.author).toEqual({ givenName: 'John', familyName: 'Doe' });
  });

  it("follows the RFC's appendix cases", () => {
    expect(mergePatch({ a: 'b' }, { a: 'c' })).toEqual({ a: 'c' });
    expect(mergePatch({ a: 'b' }, { b: 'c' })).toEqual({ a: 'b', b: 'c' });
    expect(mergePatch({ a: 'b' }, { a: null })).toEqual({});
    expect(mergePatch({ a: 'b', b: 'c' }, { a: null })).toEqual({ b: 'c' });
    expect(mergePatch({ a: ['b'] }, { a: 'c' })).toEqual({ a: 'c' });
    expect(mergePatch({ a: 'c' }, { a: ['b'] })).toEqual({ a: ['b'] });
    expect(mergePatch({ a: { b: 'c' } }, { a: { b: 'd', c: null } })).toEqual({
      a: { b: 'd' },
    });
    expect(mergePatch({ a: [{ b: 'c' }] }, { a: [1] })).toEqual({ a: [1] });
    expect(mergePatch(['a', 'b'], ['c', 'd'])).toEqual(['c', 'd']);
    expect(mergePatch({ a: 'b' }, ['c'])).toEqual(['c']);
    expect(mergePatch({ a: 'foo' }, null)).toBeNull();
    expect(mergePatch({ a: 'foo' }, 'bar')).toBe('bar');
    expect(mergePatch({ e: null }, { a: 1 })).toEqual({ e: null, a: 1 });
    expect(mergePatch([1, 2], { a: 'b', c: null })).toEqual({ a: 'b' });
    expect(mergePatch({}, { a: { bb: { ccc: null } } })).toEqual({
      a: { bb: {} },
    });
  });

  it('skips an undefined member, which has no JSON form', () => {
    expect(mergePatch({ a: 'b' }, { a: undefined, c: 'd' })).toEqual({
      a: 'b',
      c: 'd',
    });
  });
});

describe('update modes: mode: replace and the default', () => {
  for (const [label, doc] of [
    ['mode: replace on PUT', document({ put: REPLACE })],
    ['no x-crud', document()],
    [
      'mode: patch with patchFormat: custom',
      document({
        put: false,
        patch: { ...MERGE, patchFormat: 'custom' },
      }),
    ],
    [
      'mode: patch without patchFormat',
      document({
        put: false,
        patch: { action: 'update', mode: 'patch', resource: 'pet' },
      }),
    ],
    [
      'x-crud for another resource',
      document({ put: false, patch: { ...MERGE, resource: 'owner' } }),
    ],
  ] as const)
    it(`sends the full record with ${label}`, async () => {
      const { client, fake } = await synced(doc);
      await client.update('/pets', '1', { name: 'Rex 2', tag: null });
      await idle(client);
      expect(fake.writes).toEqual([
        {
          method: doc.paths['/pets/{petId}']!.put ? 'PUT' : 'PATCH',
          contentType: 'application/json',
          // The changes over the record, as before: null is a value.
          body: { ...rex, name: 'Rex 2', tag: null },
        },
      ]);
      expect(await client.get('/pets', '1')).toEqual({
        ...rex,
        name: 'Rex 2',
        tag: null,
      });
    });

  it('keeps the full record for a legacy document whatever x-crud says', async () => {
    const legacy = prepareDocument({
      ...petsDocument,
      servers: [{ url: 'https://provider.example/api' }],
    });
    const item = legacy.paths['/pets/{petId}']!;
    item.patch = {
      ...structuredClone(item.put!),
      'x-crud': { ...MERGE, resource: '/pets' },
    };
    delete item.put;
    const { client, fake } = await synced(legacy);
    await client.update('/pets', '1', { name: 'Rex 2', tag: null });
    await idle(client);
    expect(fake.writes).toEqual([
      {
        method: 'PATCH',
        contentType: 'application/json',
        body: { ...rex, name: 'Rex 2', tag: null },
      },
    ]);
  });

  it('prefers a declared PUT (replace) over a PATCH declared as a merge patch', async () => {
    const { client, fake } = await synced(
      document({ put: REPLACE, patch: MERGE }),
    );
    await client.update('/pets', '1', { name: 'Rex 2' });
    await idle(client);
    expect(fake.writes).toEqual([
      {
        method: 'PUT',
        contentType: 'application/json',
        body: { ...rex, name: 'Rex 2' },
      },
    ]);
  });
});

describe('update modes: mode: patch, patchFormat: jsonMergePatch', () => {
  it('sends only the changes, as application/json unless the operation declares the merge-patch media type', async () => {
    for (const mergeContent of [false, true]) {
      const { client, fake } = await synced(
        document({ put: false, patch: MERGE, mergeContent }),
      );
      await client.update('/pets', '1', { name: 'Rex 2' });
      await idle(client);
      expect(fake.writes).toEqual([
        {
          method: 'PATCH',
          contentType: mergeContent
            ? 'application/merge-patch+json'
            : 'application/json',
          body: { name: 'Rex 2' },
        },
      ]);
      // The response (the full record) is the confirmed copy.
      expect(await client.get('/pets', '1')).toEqual({ ...rex, name: 'Rex 2' });
      expect(fake.pets.get('1')).toEqual({ ...rex, name: 'Rex 2' });
    }
  });

  it('removes a field set to null, locally and at the provider', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
    );
    const visible = await client.update('/pets', '1', { tag: null });
    // Returned and visible at once without the field.
    expect(visible).toEqual({ id: '1', name: 'Rex', meta: rex.meta });
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex',
      meta: rex.meta,
    });
    await idle(client);
    expect(fake.writes).toEqual([
      { method: 'PATCH', contentType: 'application/json', body: { tag: null } },
    ]);
    expect(fake.pets.get('1')).toEqual({
      id: '1',
      name: 'Rex',
      meta: rex.meta,
    });
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex',
      meta: rex.meta,
    });
  });

  it('merges a nested object into the existing one, and sends only the nested patch', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
    );
    await client.update('/pets', '1', { meta: { b: null, c: '3' } });
    expect(await client.get('/pets', '1')).toEqual({
      ...rex,
      meta: { a: '1', c: '3' },
    });
    await idle(client);
    expect(fake.writes).toEqual([
      {
        method: 'PATCH',
        contentType: 'application/json',
        body: { meta: { b: null, c: '3' } },
      },
    ]);
    expect(fake.pets.get('1')).toEqual({ ...rex, meta: { a: '1', c: '3' } });
  });

  it('sends two queued edits each with its own changes only, in order', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
      new CrashableStorage(),
      50,
    );
    fake.blocked = true;
    await client.update('/pets', '1', { name: 'Rex 2' });
    await client.update('/pets', '1', { tag: 'wolf' });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    fake.writes.length = 0;
    // The head's backoff (50 ms) elapses and the queue goes on.
    fake.blocked = false;
    await idle(client);
    expect(fake.writes.map((w) => w.body)).toEqual([
      { name: 'Rex 2' },
      { tag: 'wolf' },
    ]);
    expect(fake.pets.get('1')).toEqual({ ...rex, name: 'Rex 2', tag: 'wolf' });
  });

  it('keeps a null removal through a second queued edit and a restart', async () => {
    const storage = new CrashableStorage();
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
      storage,
    );
    fake.blocked = true;
    await client.update('/pets', '1', { tag: null });
    await client.update('/pets', '1', { name: 'Rex 2' });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    expect(await client.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex 2',
      meta: rex.meta,
    });
    // Restarted on a copy of the storage: the replay removes the field too.
    const again = createApiClient(document({ put: false, patch: MERGE }), {
      storage: storage.crash(),
      transport: fake.transport,
      retry: { baseDelayMs: 10 },
    });
    await again.ready();
    expect(again.pendingWrites()).toMatchObject([
      { state: 'pending', awaitingRefresh: true },
      { state: 'pending', awaitingRefresh: true },
    ]);
    expect(await again.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex 2',
      meta: rex.meta,
    });
    // Released by a complete refresh and sent, the removal first.
    fake.writes.length = 0;
    fake.blocked = false;
    await again.sync();
    await idle(again);
    expect(fake.writes.map((w) => w.body)).toEqual([
      { tag: null },
      { name: 'Rex 2' },
    ]);
    expect(fake.pets.get('1')).toEqual({
      id: '1',
      name: 'Rex 2',
      meta: rex.meta,
    });
    expect(await again.get('/pets', '1')).toEqual({
      id: '1',
      name: 'Rex 2',
      meta: rex.meta,
    });
  });

  it('keeps the order of a removal after a set of the same field', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
      new CrashableStorage(),
      50,
    );
    fake.blocked = true;
    await client.update('/pets', '1', { tag: 'wolf' });
    await client.update('/pets', '1', { tag: null });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    expect(await client.get('/pets', '1')).not.toHaveProperty('tag');
    // The head's backoff (50 ms) elapses and the queue goes on.
    fake.blocked = false;
    await idle(client);
    expect(fake.pets.get('1')).not.toHaveProperty('tag');
    expect(await client.get('/pets', '1')).not.toHaveProperty('tag');
  });

  it('reports a conflict when the field of a pending merge-patch edit also changed remotely', async () => {
    const conflicts: string[] = [];
    const fake = provider([structuredClone(rex)]);
    const client = createApiClient(document({ put: false, patch: MERGE }), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      onConflict: (c) => conflicts.push(`${c.field}:${String(c.remote)}`),
    });
    await client.sync();
    fake.blocked = true;
    await client.update('/pets', '1', { name: 'Rex 2' });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    fake.pets.set('1', { ...rex, name: 'Rexy' });
    await client.sync();
    expect(conflicts).toEqual(['name:Rexy']);
    // The local value stays visible and is what the patch sends.
    expect(await client.get('/pets', '1')).toMatchObject({ name: 'Rex 2' });
  });
});

describe('update modes: patchFormat: jsonPatch', () => {
  it('refuses update() with a clear error, while create and remove work', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: { ...MERGE, patchFormat: 'jsonPatch' } }),
    );
    await expect(
      client.update('/pets', '1', { name: 'Rex 2' }),
    ).rejects.toThrow(
      /Resource \/pets declares its PATCH update with patchFormat jsonPatch \(RFC 6902\), which this client does not send/,
    );
    expect(client.pendingWrites()).toEqual([]);
    await client.remove('/pets', '1');
    await idle(client);
    expect(fake.writes.map((w) => w.method)).toEqual(['DELETE']);
  });
});

describe('update modes: conflicts with the client’s own merge patches', () => {
  /** A synced client whose provider applies writes but answers them only on `release()`. */
  async function held(): Promise<{
    client: ApiClient;
    fake: ReturnType<typeof provider>;
    conflicts: string[];
    release: () => void;
  }> {
    const conflicts: string[] = [];
    const fake = provider([structuredClone(rex)]);
    let release = (): void => undefined;
    fake.hold = new Promise<void>((resolve) => (release = resolve));
    const client = createApiClient(document({ put: false, patch: MERGE }), {
      transport: fake.transport,
      retry: { baseDelayMs: 60_000 },
      onConflict: (c) => conflicts.push(c.field),
    });
    await client.sync();
    return { client, fake, conflicts, release: () => release() };
  }

  it('does not report its own null removal, read back before its response', async () => {
    const { client, fake, conflicts, release } = await held();
    await client.update('/pets', '1', { tag: null });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await client.sync();
    expect(conflicts).toEqual([]);
    expect(client.pendingWrites()[0]?.conflicts ?? []).toEqual([]);
    release();
    await idle(client);
    expect(conflicts).toEqual([]);
  });

  it('does not report its own nested patch, read back before its response', async () => {
    const { client, fake, conflicts, release } = await held();
    await client.update('/pets', '1', { meta: { c: '3' } });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await client.sync();
    expect(conflicts).toEqual([]);
    release();
    await idle(client);
    expect(await client.get('/pets', '1')).toEqual({
      ...rex,
      meta: { a: '1', b: '2', c: '3' },
    });
  });

  it('does not report an earlier write’s patch on a later queued write of the same field', async () => {
    const { client, fake, conflicts, release } = await held();
    await client.update('/pets', '1', { meta: { c: '3' } });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    await client.update('/pets', '1', { meta: { b: null } });
    await client.sync();
    expect(conflicts).toEqual([]);
    release();
    await idle(client);
    expect(conflicts).toEqual([]);
    expect(fake.pets.get('1')).toEqual({ ...rex, meta: { a: '1', c: '3' } });
  });

  it('still reports a remote change inside a field it patches', async () => {
    const { client, fake, conflicts, release } = await held();
    await client.update('/pets', '1', { meta: { c: '3' } });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(1));
    fake.pets.set('1', { ...rex, meta: { a: 'remote', b: '2', c: '3' } });
    await client.sync();
    expect(conflicts).toEqual(['meta']);
    release();
    await idle(client);
  });
});

describe('update modes: failed merge patches are superseded by nested member', () => {
  it('keeps a failed nested change that a settled later patch does not set, and retries it', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
    );
    fake.script = [422];
    await client.update('/pets', '1', { meta: { a: 'X' } });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    await client.update('/pets', '1', { meta: { c: '3' } });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(2));
    await settle();
    // The failed edit is still there, and still visible.
    expect(client.pendingWrites()).toMatchObject([
      { type: 'update', state: 'failed' },
    ]);
    expect(await client.get('/pets', '1')).toEqual({
      ...rex,
      meta: { a: 'X', b: '2', c: '3' },
    });
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    await idle(client);
    expect(fake.writes.map((w) => w.body)).toEqual([
      { meta: { a: 'X' } },
      { meta: { c: '3' } },
      { meta: { a: 'X' } },
    ]);
    expect(fake.pets.get('1')).toEqual({
      ...rex,
      meta: { a: 'X', b: '2', c: '3' },
    });
  });

  it('retries a failed nested change while a later patch of the same field is queued', async () => {
    const { client, fake } = await synced(
      document({ put: false, patch: MERGE }),
      new CrashableStorage(),
      50,
    );
    fake.script = [422, 503];
    await client.update('/pets', '1', { meta: { a: 'X' } });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('failed'),
    );
    await client.update('/pets', '1', { meta: { c: '3', b: null } });
    await vi.waitFor(() => expect(fake.writes).toHaveLength(2));
    // Not refused as superseded: the queued patch sets other members.
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    // The queued patch goes again after its backoff (50 ms), then the retry.
    await idle(client);
    expect(fake.writes.map((w) => w.body)).toEqual([
      { meta: { a: 'X' } },
      { meta: { c: '3', b: null } },
      { meta: { c: '3', b: null } },
      { meta: { a: 'X' } },
    ]);
    expect(fake.pets.get('1')).toEqual({ ...rex, meta: { a: 'X', c: '3' } });
  });
});

describe('update modes: the body format is stored with each update', () => {
  /** Two queued updates made under `before`, restarted under `after`. */
  async function restartedUnder(
    before: OpenApiDocument,
    after: OpenApiDocument,
    changes: Pet,
  ): Promise<{
    again: ApiClient;
    fake: ReturnType<typeof provider>;
    stored: CrashableStorage;
  }> {
    const { client, fake, storage } = await synced(before);
    fake.blocked = true;
    await client.update('/pets', '1', changes);
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    const stored = storage.crash();
    fake.blocked = false;
    fake.writes.length = 0;
    const again = createApiClient(after, {
      storage: stored,
      transport: fake.transport,
      retry: { baseDelayMs: 10 },
    });
    await again.ready();
    return { again, fake, stored };
  }

  it('stores updateBody: mergePatch on a merge-patch update, and nothing on a record update', async () => {
    for (const [doc, expected] of [
      [document({ put: false, patch: MERGE }), 'mergePatch'],
      [document(), undefined],
    ] as const) {
      const { client, fake, storage } = await synced(doc);
      fake.blocked = true;
      await client.update('/pets', '1', { tag: null });
      await vi.waitFor(() =>
        expect(client.pendingWrites()[0]?.attempts).toBe(1),
      );
      const outbox = (await storage.get('syncables:outbox', 'outbox')) as {
        records: { queue: Record<string, unknown>[] }[];
      };
      expect(outbox.records[0]?.queue[0]?.['updateBody']).toBe(expected);
    }
  });

  for (const [label, before, after, changes, visible] of [
    [
      'a merge patch restored under a PUT replace',
      document({ put: false, patch: MERGE }),
      document({ put: REPLACE }),
      { tag: null },
      { id: '1', name: 'Rex', meta: rex.meta },
    ],
    [
      'a record update restored under a merge patch',
      document(),
      document({ put: false, patch: MERGE }),
      { tag: null },
      { ...rex, tag: null },
    ],
    [
      'a merge patch restored under jsonPatch',
      document({ put: false, patch: MERGE }),
      document({ put: false, patch: { ...MERGE, patchFormat: 'jsonPatch' } }),
      { meta: { c: '3' } },
      { ...rex, meta: { a: '1', b: '2', c: '3' } },
    ],
  ] as const)
    it(`fails ${label} instead of reinterpreting it`, async () => {
      const { again, fake } = await restartedUnder(before, after, changes);
      expect(again.pendingWrites()).toMatchObject([
        {
          type: 'update',
          state: 'failed',
          lastError: expect.stringMatching(/discard it$/),
        },
      ]);
      // Still visible as it was made, and never sent.
      expect(await again.get('/pets', '1')).toEqual(visible);
      await again.sync();
      await settle();
      expect(fake.writes).toEqual([]);
      await expect(
        again.resolveWrite('/pets', '1', { action: 'retry' }),
      ).rejects.toThrow(/was made for a .* body and the document now declares/);
      await again.resolveWrite('/pets', '1', { action: 'discard' });
      expect(again.pendingWrites()).toEqual([]);
      expect(await again.get('/pets', '1')).toEqual(rex);
    });

  it('keeps a record unrestorable when a create is queued before such an update', async () => {
    const { client, fake, storage } = await synced(
      document({ put: false, patch: MERGE }),
    );
    fake.blocked = true;
    const created = await client.create('/pets', { name: 'Fido' });
    const id = String(created['id']);
    await client.update('/pets', id, { tag: null });
    await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
    fake.blocked = false;
    fake.writes.length = 0;
    const again = createApiClient(document({ put: REPLACE }), {
      storage: storage.crash(),
      transport: fake.transport,
      retry: { baseDelayMs: 10 },
    });
    await again.ready();
    expect(again.pendingWrites()).toEqual([]);
    await settle();
    expect(fake.writes).toEqual([]);
  });

  it('restores an update under the format it was made with', async () => {
    const { again, fake } = await restartedUnder(
      document({ put: false, patch: MERGE }),
      document({ put: false, patch: MERGE }),
      { tag: null },
    );
    await again.sync();
    await idle(again);
    expect(fake.writes.map((w) => w.body)).toEqual([{ tag: null }]);
  });
});

describe('mergePatch: __proto__', () => {
  it('treats a __proto__ member as data', () => {
    const patch = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    const result = mergePatch({}, patch) as Record<string, unknown>;
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });
});
