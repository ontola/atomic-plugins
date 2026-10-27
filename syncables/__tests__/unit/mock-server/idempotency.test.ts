// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import {
  createMockServer,
  type MockServer,
} from '../../../src/mock-server/server.js';
import { loadOpenApiDocument } from '../../../src/openapi/load.js';
import { fetchTransport } from '../../../src/read/transport.js';
import { petsDocument } from '../../fixtures/pets.js';

// "Whether the provider actually deduplicates on that key is the
// provider's contract": the client's half, over HTTP. The mock server
// answers a create sent again with the same Idempotency-Key with the
// record it made the first time, so a create whose response was lost and
// was retried with its key leaves one record, not two.

let server: MockServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(
  declare: boolean,
): Promise<{ doc: OpenApiDocument; url: string }> {
  const source = JSON.parse(JSON.stringify(petsDocument)) as {
    paths: Record<string, { post?: Record<string, unknown> }>;
    components: Record<string, unknown>;
  };
  // The server makes the id (CRUD Causality `addedFields`), so the client
  // sends none and only the key can tell the server a create is repeated:
  // a client-made id in the body would make the create idempotent anyway.
  source.components['crudResources'] = {
    pet: {
      identity: {
        urlTemplate: '/pets/{petId}',
        bindings: { petId: { field: 'id' } },
      },
      collections: { pets: { urlTemplate: '/pets' } },
    },
  };
  source.paths['/pets']!.post!['x-crud'] = {
    action: 'create',
    resource: 'pet',
    addedFields: { id: { source: 'generated' } },
  };
  if (declare)
    source.paths['/pets']!.post!['parameters'] = [
      { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
    ];
  const doc = await loadOpenApiDocument(source as never);
  server = createMockServer(doc);
  const { url } = await server.listen();
  return {
    doc: { ...doc, servers: [{ url }] } as OpenApiDocument,
    url,
  };
}

const post = (url: string, body: unknown, key?: string): Promise<Response> =>
  fetch(`${url}/pets`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });

describe('the mock server with a declared Idempotency-Key', () => {
  it('answers the same key and body with the first record', async () => {
    const { url } = await serve(true);
    const first = (await (await post(url, { name: 'Milo' }, 'k1')).json()) as {
      id: string;
    };
    const again = await post(url, { name: 'Milo' }, 'k1');
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(first);
    const other = (await (await post(url, { name: 'Milo' }, 'k2')).json()) as {
      id: string;
    };
    expect(other.id).not.toBe(first.id);
  });

  it('compares bodies with their keys sorted', async () => {
    const { url } = await serve(true);
    const first = await (
      await post(url, { name: 'Milo', tag: 'cat' }, 'k1')
    ).json();
    const again = await post(url, { tag: 'cat', name: 'Milo' }, 'k1');
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual(first);
  });

  it('compares bodies that are not JSON as text', async () => {
    const { url } = await serve(true);
    const raw = (text: string): Promise<Response> =>
      fetch(`${url}/pets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': 'k1',
        },
        body: text,
      });
    const first = await (await raw('{not json')).json();
    const same = await raw('{not json');
    expect(same.status).toBe(201);
    expect(await same.json()).toEqual(first);
    expect((await raw('{other')).status).toBe(422);
  });

  it('refuses the same key with another body', async () => {
    const { url } = await serve(true);
    await post(url, { name: 'Milo' }, 'k1');
    expect((await post(url, { name: 'Otis' }, 'k1')).status).toBe(422);
  });

  it('creates again without a declaration, key or not', async () => {
    const { url } = await serve(false);
    const a = (await (await post(url, { name: 'Milo' }, 'k1')).json()) as {
      id: string;
    };
    const b = (await (await post(url, { name: 'Milo' }, 'k1')).json()) as {
      id: string;
    };
    expect(b.id).not.toBe(a.id);
  });
});

describe('a create whose response was lost', () => {
  /** Sends every request, but loses the answer to the first POST. */
  const losing = (): { posts: TransportRequest[]; transport: Transport } => {
    const live = fetchTransport(fetch);
    const fake = {
      posts: [] as TransportRequest[],
      transport: (async (request) => {
        const response = await live(request);
        if (request.method === 'POST') {
          fake.posts.push(request);
          if (fake.posts.length === 1) throw new TypeError('fetch failed');
        }
        return response;
      }) as Transport,
    };
    return fake;
  };

  const pets = async (url: string): Promise<{ name: string }[]> =>
    (await (await fetch(`${url}/pets`)).json()) as { name: string }[];

  it('is retried with its key and leaves one record at the server', async () => {
    const { doc, url } = await serve(true);
    const before = (await pets(url)).length;
    const { posts, transport } = losing();
    const client = createApiClient(doc, {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(posts).toHaveLength(2);
    expect(JSON.parse(posts[0]!.body!)).toEqual({ name: 'Milo' });
    // The key is sent under the header the document declares.
    expect(posts[0]!.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(posts[1]!.headers['Idempotency-Key']).toBe(
      posts[0]!.headers['Idempotency-Key'],
    );
    const after = await pets(url);
    expect(after).toHaveLength(before + 1);
    expect(after.filter((p) => p.name === 'Milo')).toHaveLength(1);
  });

  it('without a declared key stays uncertain and is not resent', async () => {
    const { doc, url } = await serve(false);
    const before = (await pets(url)).length;
    const { posts, transport } = losing();
    const client = createApiClient(doc, {
      transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()[0]?.state).toBe('uncertain'),
    );
    expect(posts).toHaveLength(1);
    // The server made it; the client does not know, and does not guess.
    expect(await pets(url)).toHaveLength(before + 1);
  });
});
