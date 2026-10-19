// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  apiKeyAuth,
  authenticatedTransport,
  bearerAuth,
  type TransportRequest,
} from '../../../src/browser.js';

// The two authentication adapters syncables ships: a header replaces one
// of the same name in any case (HTTP header names are case-insensitive),
// and an API key goes where the OpenAPI apiKey scheme's `in` says,
// `cookie` included.

const request = (headers: Record<string, string> = {}): TransportRequest => ({
  url: new URL('https://api.example.com/pets?limit=2'),
  method: 'GET',
  headers,
});

const sent = async (
  authenticate: Parameters<typeof authenticatedTransport>[2],
  credentials: Parameters<typeof authenticatedTransport>[1],
  headers: Record<string, string> = {},
): Promise<TransportRequest> => {
  let seen: TransportRequest | undefined;
  await authenticatedTransport(
    async (r) => {
      seen = r;
      return { status: 200, headers: {}, body: '' };
    },
    credentials,
    authenticate,
  )(request(headers));
  return seen!;
};

describe('bearerAuth', () => {
  it('replaces an Authorization header in another case', async () => {
    const { headers } = await sent(
      bearerAuth,
      { accessToken: 'new' },
      { Authorization: 'Bearer old', accept: 'application/json' },
    );
    expect(headers).toEqual({
      accept: 'application/json',
      authorization: 'Bearer new',
    });
  });

  it('refuses without an access token', async () => {
    await expect(sent(bearerAuth, { apiKey: 'k' })).rejects.toThrow(
      /Missing accessToken/,
    );
  });
});

describe('apiKeyAuth', () => {
  it('sets a header, replacing one of the same name in another case', async () => {
    const { headers } = await sent(
      apiKeyAuth('X-API-Key'),
      { apiKey: 'k' },
      { 'X-Api-Key': 'stale' },
    );
    expect(headers).toEqual({ 'x-api-key': 'k' });
  });

  it('adds a query parameter, keeping the others', async () => {
    const { url } = await sent(apiKeyAuth('key', 'query'), { apiKey: 'k' });
    expect(url.search).toBe('?limit=2&key=k');
  });

  it('adds a cookie, keeping the request’s other cookies', async () => {
    const { headers } = await sent(
      apiKeyAuth('session', 'cookie'),
      { apiKey: 'k' },
      { Cookie: 'theme=dark; session=stale' },
    );
    expect(headers).toEqual({ cookie: 'theme=dark; session=k' });
  });

  it('sets a cookie header when the request has none', async () => {
    const { headers } = await sent(apiKeyAuth('session', 'cookie'), {
      apiKey: 'k',
    });
    expect(headers).toEqual({ cookie: 'session=k' });
  });

  it.each([
    'k;admin=1',
    'k admin',
    'k,x',
    'k"x',
    'k\\x',
    'k\nSet: x',
    'k\u0000',
  ])(
    'refuses a cookie value that is not RFC 6265 cookie-octets: %j',
    async (apiKey) => {
      const attempt = sent(apiKeyAuth('session', 'cookie'), { apiKey });
      await expect(attempt).rejects.toThrow(/not a valid cookie value/);
      // The secret is not echoed.
      await expect(attempt).rejects.not.toThrow(apiKey);
    },
  );

  it.each(['X Key', 'X-Key:', 'X-Key\r\nEvil: 1', '', 'Schl\u00fcssel'])(
    'refuses a header name that is not a token: %j',
    (name) => {
      expect(() => apiKeyAuth(name)).toThrow(/not an RFC 7230 header name/);
      expect(() => apiKeyAuth(name, 'header')).toThrow(
        /not an RFC 7230 header name/,
      );
    },
  );

  it('accepts a query parameter name that is not a token', async () => {
    const { url } = await sent(apiKeyAuth('api key', 'query'), {
      apiKey: 'k',
    });
    expect(url.searchParams.get('api key')).toBe('k');
  });

  it.each(['a b', 'a;b', 'a=b', '', 'sess\u00e9'])(
    'refuses a cookie name that is not a token: %j',
    (name) => {
      expect(() => apiKeyAuth(name, 'cookie')).toThrow(
        /not an RFC 6265 cookie name/,
      );
    },
  );

  it('joins every case of a Cookie header, and matches names trimmed', async () => {
    const { headers } = await sent(
      apiKeyAuth('session', 'cookie'),
      { apiKey: 'k' },
      { Cookie: 'theme=dark;session =stale', cookie: 'lang=nl' },
    );
    expect(headers).toEqual({ cookie: 'theme=dark; lang=nl; session=k' });
  });

  it('refuses without an API key', async () => {
    await expect(sent(apiKeyAuth('key'), { accessToken: 't' })).rejects.toThrow(
      /Missing apiKey/,
    );
  });
});

describe('authenticatedTransport', () => {
  it('refuses credentials without an adapter', () => {
    expect(() =>
      authenticatedTransport(
        async () => ({ status: 200, headers: {}, body: '' }),
        {
          apiKey: 'k',
        },
      ),
    ).toThrow(/require an authenticate adapter/);
  });

  it('gives the adapter a copy, so it cannot change the caller’s request', async () => {
    const original = request({ accept: 'application/json' });
    await authenticatedTransport(
      async () => ({ status: 200, headers: {}, body: '' }),
      { apiKey: 'k' },
      (r) => {
        r.headers['x-mutated'] = 'yes';
        r.url.searchParams.set('mutated', 'yes');
        return r;
      },
    )(original);
    expect(original.headers).toEqual({ accept: 'application/json' });
    expect(original.url.search).toBe('?limit=2');
  });
});
