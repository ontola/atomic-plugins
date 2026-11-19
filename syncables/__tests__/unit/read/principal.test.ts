// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  describeAuthenticatedPrincipals,
  resolveAuthenticatedPrincipal,
  responseBodyValue,
  validatePrincipalRead,
} from '../../../src/read/principal.js';
import type { TransportRequest } from '../../../src/read/transport.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

function fixture(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Acme', version: '1' },
    servers: [{ url: 'https://api.example.test/v1' }],
    paths: {
      '/session': {
        get: {
          operationId: 'currentIdentity',
          security: [{ oauth: [] }],
          'x-authenticated-principal': {
            kind: 'user',
            namespace: 'https://identity.example.test',
            subject: '$response.body#/identity/id',
            identifier: { scope: 'provider', stable: true, reassigned: false },
            claims: {
              name: '$response.body#/label',
              email_verified: '$response.body#/verified',
            },
          },
          responses: { '200': { description: 'Current user' } },
        },
      },
    },
  };
}
const transport = (body: unknown) =>
  vi.fn(async (request: TransportRequest) => {
    void request;
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  });

describe('authenticated principal', () => {
  it('discovers and resolves a provider-independent identity and typed display claims', async () => {
    const send = transport({
      identity: { id: 7 },
      label: 'Ada',
      verified: true,
    });
    const result = await resolveAuthenticatedPrincipal(fixture(), {
      transport: send,
    });
    expect(result).toMatchObject({
      namespace: 'https://identity.example.test',
      subject: 7,
      claims: { name: 'Ada', email_verified: true },
    });
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      method: 'GET',
      purpose: 'principal',
    });
    expect(send.mock.calls[0]?.[0].url.href).toBe(
      'https://api.example.test/v1/session',
    );
    expect(describeAuthenticatedPrincipals(fixture())[0]).toMatchObject({
      operationId: 'currentIdentity',
      path: '/session',
    });
  });
  it('preserves string subjects and does not use display claims as identity', async () => {
    expect(
      (
        await resolveAuthenticatedPrincipal(fixture(), {
          transport: transport({ identity: { id: '7' }, label: '7' }),
        })
      ).subject,
    ).toBe('7');
  });
  it.each([null, true, {}, [], 1.5, 9007199254740992, ''])(
    'refuses unusable subjects %j',
    async (subject) => {
      await expect(
        resolveAuthenticatedPrincipal(fixture(), {
          transport: transport({ identity: { id: subject } }),
        }),
      ).rejects.toThrow('Principal subject');
    },
  );
  it('requires client context for pairwise subjects and preserves it', async () => {
    const doc = fixture();
    const principal = doc.paths['/session']!.get![
      'x-authenticated-principal'
    ] as Record<string, unknown>;
    principal['identifier'] = {
      scope: 'client',
      stable: true,
      reassigned: false,
    };
    const send = transport({ identity: { id: 'abc' } });
    await expect(
      resolveAuthenticatedPrincipal(doc, { transport: send }),
    ).rejects.toThrow('clientContext');
    expect(send).not.toHaveBeenCalled();
    expect(
      (
        await resolveAuthenticatedPrincipal(doc, {
          clientContext: 'client-42',
          transport: send,
        })
      ).clientContext,
    ).toBe('client-42');
  });
  it('refuses missing lifecycle guarantees, ambiguous and anonymous operations before requests', async () => {
    const doc = fixture();
    const op = doc.paths['/session']!.get!;
    const raw = op['x-authenticated-principal'] as Record<string, unknown>;
    raw['identifier'] = { scope: 'provider' };
    const send = transport({ identity: { id: 7 } });
    await expect(
      resolveAuthenticatedPrincipal(doc, { transport: send }),
    ).rejects.toThrow('durable');
    op.security = [];
    expect(describeAuthenticatedPrincipals(doc)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });
  it('evaluates JSON pointers using own properties and escaped names', () => {
    expect(
      responseBodyValue('$response.body#/a~1b/~0x', { 'a/b': { '~x': 3 } }),
    ).toBe(3);
    expect(responseBodyValue('$response.body#/toString', {})).toBeUndefined();
    expect(() => responseBodyValue('$response.body#/bad~2', {})).toThrow(
      'Pointer',
    );
  });
  it('distinguishes equal-looking numeric and string principals in identity tuples', async () => {
    const numeric = await resolveAuthenticatedPrincipal(fixture(), {
      transport: transport({ identity: { id: 7 } }),
    });
    const text = await resolveAuthenticatedPrincipal(fixture(), {
      transport: transport({ identity: { id: '7' } }),
    });
    expect(JSON.stringify([numeric.namespace, numeric.subject])).not.toBe(
      JSON.stringify([text.namespace, text.subject]),
    );
  });
  it('validates the declared principal lookup and refuses query, mutation, sibling and HTTP requests', () => {
    const doc = fixture();
    const request: TransportRequest = {
      url: new URL('https://api.example.test/v1/session'),
      method: 'GET',
      headers: {},
    };
    expect(validatePrincipalRead(doc, request)).toBe(true);
    for (const altered of [
      { ...request, method: 'DELETE' as const },
      { ...request, url: new URL('http://api.example.test/v1/session') },
      { ...request, url: new URL('https://api.example.test/v1/session?x=1') },
      { ...request, url: new URL('https://api.example.test/v1/other') },
    ])
      expect(validatePrincipalRead(doc, altered)).toBe(false);
  });
  it.each([7, true, null, {}, [], ''])(
    'refuses malformed clientContext %j before transport',
    async (clientContext) => {
      const doc = fixture();
      const principal = doc.paths['/session']!.get![
        'x-authenticated-principal'
      ] as Record<string, unknown>;
      principal['identifier'] = {
        scope: 'client',
        stable: true,
        reassigned: false,
      };
      const send = transport({ identity: { id: 'pairwise' } });
      await expect(
        resolveAuthenticatedPrincipal(doc, {
          transport: send,
          clientContext: clientContext as unknown as string,
        }),
      ).rejects.toThrow('clientContext');
      expect(send).not.toHaveBeenCalled();
    },
  );
});
