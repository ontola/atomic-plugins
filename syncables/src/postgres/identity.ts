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

export interface ArchivedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

function dropboxMetadataRead(request: TransportRequest): boolean {
  if (
    request.method !== 'POST' ||
    request.purpose !== 'list' ||
    request.url.origin !== 'https://api.dropboxapi.com' ||
    request.url.search ||
    request.body === undefined
  )
    return false;
  let body: Record<string, unknown> | null;
  try {
    body = JSON.parse(request.body) as Record<string, unknown> | null;
  } catch {
    return false;
  }
  if (!body) return false;
  if (request.url.pathname === '/2/files/list_folder/continue')
    return Object.keys(body).length === 1 && typeof body.cursor === 'string';
  return (
    request.url.pathname === '/2/files/list_folder' &&
    Object.keys(body).length === 4 &&
    body.path === '' &&
    body.recursive === true &&
    body.include_deleted === true &&
    typeof body.limit === 'number' &&
    Number.isInteger(body.limit) &&
    body.limit >= 1 &&
    body.limit <= 1000
  );
}

export function requestIdentity(request: TransportRequest): {
  key: string;
  cacheKey: string;
  request: ArchivedRequest;
} {
  if (
    (request.method !== 'GET' || request.body !== undefined) &&
    !dropboxMetadataRead(request)
  )
    throw new Error(
      'This archive stage accepts bodyless GET reads and Dropbox inventory listings only',
    );
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
  const data: ArchivedRequest = {
    url: request.url.href,
    method: request.method as ArchivedRequest['method'],
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
  };
  return {
    key: digest(JSON.stringify(data)),
    cacheKey: digest(JSON.stringify({ ...data, headers: representation })),
    request: data,
  };
}
