// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  mergePatch,
  prepareDocument,
  type ApiClient,
  type MissingRecord,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { petsDocument } from '../../fixtures/pets.js';

// Two features together: a JSON Merge Patch update (CRUD Causality 0.4.0
// §4.3/§4.6, #419) of a record that a complete refresh no longer returns
// and whose GET answers 404 under `notFound: unavailable` (Collection
// Completeness 0.2.0 §4.3, #399). The update must be held, not sent, and
// keep its merge-patch form for when the app decides. Transports and data
// are invented.

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

type Pet = Record<string, unknown>;

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

/** The pets fixture: PATCH declared as a merge patch, the collection `notFound: unavailable`. */
function document(): OpenApiDocument {
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
          collections: {
            pets: {
              urlTemplate: '/pets',
              'x-completeness': { absent: 'removed', notFound: 'unavailable' },
            },
          },
        },
      },
    },
  });
  const item = doc.paths['/pets/{petId}']!;
  item.patch = {
    ...structuredClone(item.put!),
    'x-crud': {
      action: 'update',
      mode: 'patch',
      patchFormat: 'jsonMergePatch',
      resource: 'pet',
    },
    requestBody: {
      content: { 'application/merge-patch+json': { schema: {} } },
    },
  };
  delete item.put;
  return doc;
}

/**
 * A provider that applies PATCH as a merge patch. `blocked` answers writes
 * 503; `hidden` ids are left out of the list and answer 404 to their GET.
 */
function provider(initial: Pet[]): {
  pets: Map<string, Pet>;
  hidden: Set<string>;
  blocked: boolean;
  writes: TransportRequest[];
  transport: Transport;
} {
  const fake = {
    pets: new Map(initial.map((p) => [String(p['id']), p])),
    hidden: new Set<string>(),
    blocked: true,
    writes: [] as TransportRequest[],
    transport: (async (r: TransportRequest) => {
      const id = decodeURIComponent(r.url.pathname.split('/')[3] ?? '');
      if (r.method === 'GET' && !id)
        return response(
          [...fake.pets.values()].filter(
            (p) => !fake.hidden.has(String(p['id'])),
          ),
        );
      if (r.method === 'GET')
        return fake.hidden.has(id) || !fake.pets.has(id)
          ? response({ error: 'not found' }, 404)
          : response(fake.pets.get(id));
      fake.writes.push(r);
      if (fake.blocked) return response({ error: 'invented' }, 503);
      const current = fake.pets.get(id);
      if (!current || fake.hidden.has(id))
        return response({ error: 'not found' }, 404);
      const updated = {
        ...(mergePatch(current, JSON.parse(r.body ?? '{}')) as Pet),
        id,
      };
      fake.pets.set(id, updated);
      return response(updated);
    }) as Transport,
  };
  return fake;
}

const rex = { id: '1', name: 'Rex', tag: 'dog', meta: { a: '1', b: '2' } };

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A synced client with two merge-patch edits of rex queued behind a 503,
 * after which rex leaves the list and its GET answers 404.
 */
async function editedThenUnavailable(): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof provider>;
  storage: CrashableStorage;
  reports: MissingRecord[];
}> {
  const fake = provider([structuredClone(rex)]);
  const storage = new CrashableStorage();
  const reports: MissingRecord[] = [];
  const client = createApiClient(document(), {
    storage,
    transport: fake.transport,
    retry: { baseDelayMs: 60_000 },
    onMissingRecord: (r) => reports.push(r),
  });
  await client.sync();
  await client.update('/pets', '1', { tag: null });
  await client.update('/pets', '1', { meta: { c: '3' } });
  await vi.waitFor(() => expect(client.pendingWrites()[0]?.attempts).toBe(1));
  await settle(5);
  fake.writes.length = 0;
  fake.hidden.add('1');
  return { client, fake, storage, reports };
}

const visible = { id: '1', name: 'Rex', meta: { a: '1', b: '2', c: '3' } };

describe('a merge-patch update of a record that becomes unavailable', () => {
  it('is held, not sent, and the record keeps its last known values with the patches', async () => {
    const { client, fake, reports } = await editedThenUnavailable();
    await client.sync();
    expect(reports).toMatchObject([
      { id: '1', evidence: 'unavailable', source: 'read', status: 404 },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { type: 'update', state: 'failed', missingRecord: 'unavailable' },
      { type: 'update', state: 'failed', missingRecord: 'unavailable' },
    ]);
    // The provider unblocks; nothing is sent without a decision.
    fake.blocked = false;
    await client.sync();
    await settle(50);
    expect(fake.writes).toEqual([]);
    // RFC 7396 locally: the null removal and the nested merge both show.
    expect(await client.get('/pets', '1')).toEqual(visible);
  });

  it('keeps the held merge patches, and their format, across a restart', async () => {
    const { client, fake, storage } = await editedThenUnavailable();
    await client.sync();
    const outbox = (await storage.get('syncables:outbox', 'outbox')) as {
      records: { failed: Record<string, unknown>[] }[];
    };
    expect(outbox.records[0]?.failed).toMatchObject([
      { updateBody: 'mergePatch', missingRecord: 'unavailable' },
      { updateBody: 'mergePatch', missingRecord: 'unavailable' },
    ]);
    fake.blocked = false;
    const again = createApiClient(document(), {
      storage: storage.crash(),
      transport: fake.transport,
      retry: { baseDelayMs: 10 },
    });
    await again.ready();
    await again.sync();
    await settle(50);
    expect(fake.writes).toEqual([]);
    expect(again.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unavailable' },
      { state: 'failed', missingRecord: 'unavailable' },
    ]);
    expect(await again.get('/pets', '1')).toEqual(visible);
  });

  it('sends each patch alone, as a merge patch, once the record is back and the app retries', async () => {
    const { client, fake } = await editedThenUnavailable();
    await client.sync();
    fake.blocked = false;
    fake.hidden.delete('1');
    await client.resolveWrite('/pets', '1', { action: 'retry' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(
      fake.writes.map((w) => [
        w.method,
        w.headers['content-type'],
        JSON.parse(w.body ?? '{}'),
      ]),
    ).toEqual([
      ['PATCH', 'application/merge-patch+json', { tag: null }],
      ['PATCH', 'application/merge-patch+json', { meta: { c: '3' } }],
    ]);
    expect(fake.pets.get('1')).toEqual(visible);
  });

  it('drops the held patches on discard without sending them, keeping the last known record', async () => {
    const { client, fake } = await editedThenUnavailable();
    await client.sync();
    fake.blocked = false;
    await client.resolveWrite('/pets', '1', { action: 'discard' });
    await client.sync();
    await settle(50);
    expect(client.pendingWrites()).toEqual([]);
    expect(fake.writes).toEqual([]);
    // §4.3: the last known values stay, marked, until a later read settles
    // the record; the discarded patches are gone from them.
    expect(await client.get('/pets', '1')).toEqual(rex);
    // A new merge patch of it is held for the next refresh, not sent.
    await client.update('/pets', '1', { name: 'Rexy' });
    await settle();
    expect(fake.writes).toEqual([]);
    expect(await client.get('/pets', '1')).toEqual({ ...rex, name: 'Rexy' });
  });
});
