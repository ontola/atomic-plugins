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

/** Adds a supplied access token; token acquisition/refresh belongs to an auth adapter. */
export const bearerAuth: Authenticate = (request, credentials) => {
  if (!credentials.accessToken) {
    throw new Error('Missing accessToken credential');
  }
  return {
    ...request,
    headers: {
      ...request.headers,
      authorization: `Bearer ${credentials.accessToken}`,
    },
  };
};

/** API-key placement comes from the API's contract, never a provider-name branch. */
export function apiKeyAuth(
  name: string,
  placement: 'header' | 'query' = 'header',
): Authenticate {
  return (request, credentials) => {
    if (!credentials.apiKey) {
      throw new Error('Missing apiKey credential');
    }
    if (placement === 'header') {
      return {
        ...request,
        headers: {
          ...request.headers,
          [name.toLowerCase()]: credentials.apiKey,
        },
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
