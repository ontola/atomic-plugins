// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  committedIdentity,
  createDeclaration,
  type CreateDeclaration,
} from '../../../src/client/created-identity.js';
import { petsDocument } from '../../fixtures/pets.js';

// CRUD Causality 0.8.0 §4.3.3, Committed Error Objects: a 5xx the provider
// documents as sent only after the create was applied, naming the new
// object's id in its error body (Notion's 503 with
// additional_data.committed_resource_id). Ports the reference
// committed_identity() and runs the client against it. Before, a 503 took
// the ordinary retry path and the create was sent again: a duplicate.
// Invented provider and data.

const NOTION_LIKE = [
  {
    status: [503],
    identity: { petId: 'additional_data.committed_resource_id' },
    description: 'Invented, shaped like Notion request limits',
  },
];

function document(crud: Record<string, unknown> = {}): OpenApiDocument {
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
  doc.paths['/pets']!.post!['x-crud'] = {
    action: 'create',
    resource: 'pet',
    addedFields: { id: { source: 'generated' } },
    committedErrors: NOTION_LIKE,
    ...crud,
  };
  return doc;
}

const committed503 = (id: unknown): TransportResponse => ({
  status: 503,
  headers: {},
  body: JSON.stringify({
    object: 'error',
    code: 'service_unavailable',
    additional_data: {
      retry_guidance: 'read_object',
      committed_resource_id: id,
    },
  }),
});

describe('committedIdentity (the reference committed_identity)', () => {
  const declared = (crud: Record<string, unknown> = {}): CreateDeclaration =>
    createDeclaration(document(crud), {
      action: 'create',
      resource: 'pet',
      committedErrors: NOTION_LIKE,
      ...crud,
    })!;

  it('reads the identity from a listed status', () => {
    expect(
      committedIdentity(declared(), 503, committed503('p-9').body),
    ).toEqual({ id: 'p-9' });
    expect(committedIdentity(declared(), 503, committed503(42).body)).toEqual({
      id: '42',
    });
  });

  it.each([
    ['another status', 500, committed503('p-9').body],
    ['a body that is not JSON', 503, 'Service Unavailable'],
    [
      'only retry guidance',
      503,
      JSON.stringify({ additional_data: { retry_guidance: 'retry' } }),
    ],
    ['an empty id', 503, committed503('').body],
    ['a padded id', 503, committed503(' p-9').body],
    ['a dot segment', 503, committed503('..').body],
    ['a slash', 503, committed503('a/b').body],
    ['a query mark', 503, committed503('a?b').body],
    ['a control character', 503, committed503('a\u0007b').body],
    ['a negative number', 503, committed503(-1).body],
    ['a fraction', 503, committed503(1.5).body],
    ['an object', 503, committed503({ id: 'p-9' }).body],
  ] as const)('matches nothing for %s', (_label, status, body) => {
    expect(committedIdentity(declared(), status, body)).toBeUndefined();
  });

  it('gives only the fields the named variables bind', () => {
    // A template with a second variable the error does not name: its value
    // comes from the request, so only the named one is returned.
    const doc = document();
    (
      doc.components!['crudResources'] as Record<
        string,
        Record<string, unknown>
      >
    )['pet']!['identity'] = {
      urlTemplate: '/shops/{shopId}/pets/{petId}',
      bindings: { shopId: { field: 'shop' }, petId: { field: 'id' } },
    };
    const declaration = createDeclaration(doc, {
      action: 'create',
      resource: 'pet',
      committedErrors: [
        {
          status: [503],
          identity: { shopId: 'additional_data.committed_resource_id' },
        },
      ],
    })!;
    expect(
      committedIdentity(declaration, 503, committed503('s-1').body),
    ).toEqual({ shop: 's-1' });
  });

  it('takes the first entry that matches', () => {
    const declaration = declared({
      committedErrors: [
        { status: [503], identity: { petId: 'missing.path' } },
        ...NOTION_LIKE,
      ],
    });
    expect(
      committedIdentity(declaration, 503, committed503('p-9').body),
    ).toEqual({ id: 'p-9' });
  });

  it('ignores entries the rules refuse, and committedErrors beside followUps', () => {
    for (const committedErrors of [
      [{ status: [404], identity: { petId: 'a' } }],
      [{ status: [], identity: { petId: 'a' } }],
      [{ status: [503], identity: { notAVariable: 'a' } }],
      [{ status: [503], identity: {} }],
      'not an array',
    ])
      expect(
        createDeclaration(document(), {
          action: 'create',
          resource: 'pet',
          committedErrors,
        })?.committedErrors,
      ).toBeUndefined();
    expect(
      createDeclaration(document(), {
        action: 'create',
        resource: 'pet',
        committedErrors: NOTION_LIKE,
        followUps: [],
      })?.committedErrors,
    ).toBeUndefined();
  });
});

/** POSTs answer `answer`; GETs an empty list. */
function provider(answer: () => TransportResponse): {
  posts: TransportRequest[];
  transport: Transport;
} {
  const fake = {
    posts: [] as TransportRequest[],
    transport: (async (request) => {
      if (request.method === 'GET')
        return { status: 200, headers: {}, body: '[]' };
      fake.posts.push(request);
      return answer();
    }) as Transport,
  };
  return fake;
}

describe('a create answered by a committed error', () => {
  it('is applied, bound to the named id, and not sent again', async () => {
    const fake = provider(() => committed503('p-9'));
    const client = createApiClient(document(), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    const local = await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.posts).toHaveLength(1);
    expect(await client.get('/pets', 'p-9')).toEqual({
      name: 'Rex',
      id: 'p-9',
    });
    expect(await client.get('/pets', String(local['id']))).toBeUndefined();
  });

  it('without a declaration, a 503 is still retried, as before', async () => {
    let n = 0;
    const fake = provider(() =>
      ++n === 1
        ? committed503('p-9')
        : {
            status: 201,
            headers: {},
            body: JSON.stringify({ id: 'p-10', name: 'Rex' }),
          },
    );
    const client = createApiClient(document({ committedErrors: undefined }), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(fake.posts).toHaveLength(2);
  });

  it('naming no usable id keeps the 5xx an unknown outcome', async () => {
    let n = 0;
    const fake = provider(() =>
      ++n === 1
        ? committed503('')
        : {
            status: 201,
            headers: {},
            body: JSON.stringify({ id: 'p-10', name: 'Rex' }),
          },
    );
    const client = createApiClient(document(), {
      transport: fake.transport,
      retry: { baseDelayMs: 1 },
    });
    await client.create('/pets', { name: 'Rex' });
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    // 503 without a match: the ordinary path, as without the declaration.
    expect(fake.posts).toHaveLength(2);
  });
});
