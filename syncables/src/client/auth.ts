import type { Transport, TransportRequest } from '../read/transport.js';

/** Application and connection credentials remain outside the record store. */
export interface Credentials {
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  accessToken?: string;
}

/** May obtain/refresh a token and return an authenticated copy of a request. */
export type Authenticate = (
  request: TransportRequest,
  credentials: Readonly<Credentials>,
) => TransportRequest | Promise<TransportRequest>;

/**
 * `headers` with `name` set to `value`, after removing any header of the
 * same name in another case: HTTP header names are case-insensitive, and
 * `{ Authorization, authorization }` would send both.
 */
function withHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const lower = name.toLowerCase();
  const result: Record<string, string> = {};
  for (const [key, existing] of Object.entries(headers))
    if (key.toLowerCase() !== lower) result[key] = existing;
  result[lower] = value;
  return result;
}

/** Every value of a header, whatever the case of its name. */
function headerValues(headers: Record<string, string>, name: string): string[] {
  const lower = name.toLowerCase();
  return Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === lower)
    .map(([, value]) => value);
}

/** RFC 7230 `token`: what a cookie name must be (RFC 6265 §4.1.1). */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * RFC 6265 §4.1.1 `cookie-octet`s: no control character, whitespace,
 * `"`, `,`, `;` or `\`. A key with `;` would add a cookie of its own
 * (`k;admin=1`).
 */
const COOKIE_OCTETS = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+$/;

/** Adds a supplied access token; token acquisition/refresh belongs to an auth adapter. */
export const bearerAuth: Authenticate = (request, credentials) => {
  if (!credentials.accessToken) {
    throw new Error('Missing accessToken credential');
  }
  return {
    ...request,
    headers: withHeader(
      request.headers,
      'authorization',
      `Bearer ${credentials.accessToken}`,
    ),
  };
};

/**
 * API-key placement comes from the API's contract, never a provider-name
 * branch: an OpenAPI `apiKey` security scheme's `in` (`header`, `query` or
 * `cookie`) and `name`. A header replaces one of the same name in any
 * case; a cookie is added to the request's `cookie` header, replacing a
 * cookie of the same name.
 */
export function apiKeyAuth(
  name: string,
  placement: 'header' | 'query' | 'cookie' = 'header',
): Authenticate {
  if (placement === 'cookie' && !TOKEN.test(name))
    throw new Error(
      `Cookie name ${JSON.stringify(name)} is not an RFC 6265 cookie name`,
    );
  return (request, credentials) => {
    if (!credentials.apiKey) {
      throw new Error('Missing apiKey credential');
    }
    if (placement === 'header') {
      return {
        ...request,
        headers: withHeader(request.headers, name, credentials.apiKey),
      };
    }
    if (placement === 'cookie') {
      // Not echoed: the value is a secret.
      if (!COOKIE_OCTETS.test(credentials.apiKey))
        throw new Error(
          'The apiKey credential is not a valid cookie value (RFC 6265: no control character, whitespace, ", comma, ; or \\)',
        );
      const others = headerValues(request.headers, 'cookie')
        .join(';')
        .split(';')
        .map((pair) => pair.trim())
        .filter(
          (pair) => pair !== '' && (pair.split('=')[0] ?? '').trim() !== name,
        );
      return {
        ...request,
        headers: withHeader(
          request.headers,
          'cookie',
          [...others, `${name}=${credentials.apiKey}`].join('; '),
        ),
      };
    }
    const url = new URL(request.url);
    url.searchParams.set(name, credentials.apiKey);
    return { ...request, url };
  };
}

export function authenticatedTransport(
  transport: Transport,
  credentials: Credentials = {},
  authenticate?: Authenticate,
): Transport {
  if (!authenticate) {
    if (Object.values(credentials).some((value) => value !== undefined)) {
      throw new Error('Credentials require an authenticate adapter');
    }
    return transport;
  }
  return async (request) =>
    transport(
      await authenticate(
        {
          ...request,
          url: new URL(request.url),
          headers: { ...request.headers },
        },
        credentials,
      ),
    );
}
