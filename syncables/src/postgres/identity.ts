import type { TransportRequest } from '../read/transport.js';
import { digest } from './codec.js';

export interface ArchiveScope {
  owner: string;
  connection: string;
  authorizationContext: string;
}

const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-access-token',
  'x-atomic-signature',
  'x-atomic-public-key',
  'x-atomic-timestamp',
]);

export function cleanHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers)
      .map(([key, value]) => [key.toLowerCase(), value] as const)
      .filter(([key]) => !SECRET_HEADERS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function scopeValues(scope: ArchiveScope): string[] {
  const values = [scope.owner, scope.connection, scope.authorizationContext];
  if (
    values.some(
      (value) => typeof value !== 'string' || !value || value.length > 1024,
    )
  )
    throw new Error(
      'Archive scope requires owner, connection and authorization context',
    );
  return values;
}

export function requestIdentity(request: TransportRequest): {
  key: string;
  cacheKey: string;
  request: { url: string; method: 'GET'; headers: Record<string, string> };
} {
  if (request.method !== 'GET' || request.body !== undefined)
    throw new Error('This archive stage accepts bodyless GET reads only');
  if (request.url.username || request.url.password || request.url.hash)
    throw new Error(
      'Archived request URLs must not contain credentials or fragments',
    );
  for (const key of request.url.searchParams.keys())
    if (
      /^(access_token|refresh_token|api_key|apikey|token|signature)$/i.test(key)
    )
      throw new Error(
        'Authentication secrets must not appear in archived URLs',
      );
  const headers = cleanHeaders(request.headers);
  const representation = Object.fromEntries(
    Object.entries(headers).filter(
      ([key]) => !['if-none-match', 'if-modified-since'].includes(key),
    ),
  );
  const data = { url: request.url.href, method: 'GET' as const, headers };
  return {
    key: digest(JSON.stringify(data)),
    cacheKey: digest(JSON.stringify({ ...data, headers: representation })),
    request: data,
  };
}
