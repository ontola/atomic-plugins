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

/** A header's value whatever the case of its name, if present. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === lower) return value;
  return undefined;
}

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
      const others = (headerValue(request.headers, 'cookie') ?? '')
        .split(';')
        .map((pair) => pair.trim())
        .filter((pair) => pair !== '' && pair.split('=')[0] !== name);
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
