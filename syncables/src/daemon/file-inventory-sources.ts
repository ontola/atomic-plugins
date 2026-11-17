import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { isRecord } from '../read/model.js';
import { PageStatusError } from '../read/pages.js';
import type {
  PurposedRequest,
  TransportRequest,
  TransportResponse,
} from '../read/transport.js';
import { nodeHash } from '../postgres/json-graph.js';
import type { FileInventorySource } from './config.js';

type Provider = FileInventorySource['provider'];
type CloudSource = Extract<FileInventorySource, { tokenFile: string }>;
export const FILE_RESOURCE = 'file-metadata';
export const DROPBOX_LIST = 'https://api.dropboxapi.com/2/files/list_folder';
const GOOGLE = 'https://www.googleapis.com/drive/v3/';
const GOOGLE_FOLDER = 'application/vnd.google-apps.folder';
const TITLES = {
  'google-drive': 'Google Drive file inventory',
  dropbox: 'Dropbox file inventory',
  'icloud-drive': 'iCloud Drive file inventory',
};

export interface InventoryFile {
  id: string;
  name: string;
  providerId?: string | undefined;
  path?: string | undefined;
  parents?: string[] | undefined;
  mimeType?: string | undefined;
  size?: string | undefined;
  modifiedTime?: string | undefined;
  revision?: string | undefined;
  hashes: Partial<
    Record<
      'sha256' | 'sha1' | 'md5' | 'dropbox-content-hash',
      string | undefined
    >
  >;
}

export function inventoryDocument(provider: Provider): OpenApiDocument {
  const string: SchemaObject = { type: 'string' };
  const item: SchemaObject = {
    type: 'object',
    properties: {
      id: string,
      name: string,
      providerId: string,
      path: string,
      parents: { type: 'array', items: string },
      mimeType: string,
      size: string,
      modifiedTime: string,
      revision: string,
      hashes: { type: 'object' },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: TITLES[provider], version: '1' },
    paths: {
      '/files': {
        get: {
          responses: {
            '200': {
              description: 'Stored file metadata',
              content: {
                'application/json': { schema: { type: 'array', items: item } },
              },
            },
          },
        },
      },
    },
    components: {
      crudResources: {
        [FILE_RESOURCE]: {
          identity: {
            urlTemplate: '/files/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: { files: { urlTemplate: '/files' } },
        },
      },
    },
  };
}

export type InventoryChange =
  | { file: InventoryFile }
  | { remove: string; subtree?: boolean };
export type InventoryCursor =
  | { phase: 'dropbox'; token?: string }
  | { phase: 'google-start' }
  | { phase: 'google-files'; start: string; token?: string }
  | { phase: 'google-changes'; token: string }
  | { phase: 'done'; token: string };
export interface InventoryPage {
  next: InventoryCursor;
  changes: InventoryChange[];
  count: number;
}

export class InventoryCursorExpired extends Error {}
export class InventoryCredentialError extends Error {}
export class InventoryReadError extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value))
    throw new InventoryReadError('Invalid file metadata response');
  return value;
}
function list(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    throw new InventoryReadError('Missing file metadata list');
  return value.map(record);
}
function string(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
function required(value: unknown): string {
  const found = string(value);
  if (!found)
    throw new InventoryReadError('Missing file metadata identity or cursor');
  return found;
}
function size(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value))
    return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  throw new InventoryReadError('Invalid or unsafe file size');
}
function hash(value: unknown, length: number): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length !== length ||
    !/^[a-f\d]+$/i.test(value)
  )
    return undefined;
  return value.toLowerCase();
}
function json(response: TransportResponse): Record<string, unknown> {
  if (response.status === 401 || response.status === 403)
    throw new InventoryCredentialError(
      'Provider refused metadata access. Check the token file and scopes.',
    );
  if (response.status < 200 || response.status >= 300)
    throw new PageStatusError(
      'Provider metadata request failed',
      response.status,
      response.body,
    );
  return record(JSON.parse(response.body) as unknown);
}
function get(path: string, query: Record<string, string>): PurposedRequest {
  const url = new URL(path, GOOGLE);
  url.search = new URLSearchParams(query).toString();
  return { url, method: 'GET', headers: {}, purpose: 'list' };
}
function post(url: string, body: unknown): PurposedRequest {
  return {
    url: new URL(url),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    purpose: 'list',
  };
}

async function privateToken(path: string): Promise<string> {
  try {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.mode & 0o077 ||
        info.uid !== process.getuid?.() ||
        info.size > 4096
      )
        throw new Error();
      const buffer = Buffer.alloc(4097);
      const { bytesRead } = await handle.read(buffer);
      const token = buffer.subarray(0, bytesRead).toString('utf8').trim();
      if (bytesRead > 4096 || !/^[\x21-\x7e]+$/.test(token)) throw new Error();
      return token;
    } finally {
      await handle.close();
    }
  } catch {
    throw new InventoryCredentialError(
      'Supply a private, owner-only token file containing the provider access token.',
    );
  }
}

export async function inventoryAccount(
  source: CloudSource,
  fetchImpl: typeof fetch,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{
  account: string;
  send(
    request: TransportRequest,
    timeoutMs?: number,
  ): Promise<TransportResponse>;
}> {
  const token = await privateToken(source.tokenFile);
  const send = async (
    request: TransportRequest,
    timeoutMs = 10_000,
  ): Promise<TransportResponse> => {
    const timeout = AbortSignal.timeout(
      Math.max(1, Math.min(10_000, timeoutMs)),
    );
    const response = await fetchImpl(request.url.href, {
      method: request.method,
      headers: { ...request.headers, authorization: 'Bearer ' + token },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new InventoryReadError(
            'Metadata response exceeds the read limit',
          );
        }
        chunks.push(chunk.value);
      }
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      headers,
      body: Buffer.concat(chunks).toString('utf8'),
    };
  };
  const info = json(
    await send(
      source.provider === 'dropbox'
        ? {
            url: new URL(
              'https://api.dropboxapi.com/2/users/get_current_account',
            ),
            method: 'POST',
            headers: {},
            purpose: 'item',
          }
        : get('about', { fields: 'user(permissionId)' }),
    ),
  );
  const id =
    source.provider === 'dropbox'
      ? info.account_id
      : record(info.user).permissionId;
  return { account: nodeHash(required(id)), send };
}

function dropboxChange(item: Record<string, unknown>): InventoryChange {
  const path = required(item.path_lower);
  switch (item['.tag']) {
    case 'deleted':
      return { remove: path, subtree: true };
    case 'folder':
      return { remove: path };
    case 'file':
      return {
        file: {
          id: path,
          name: required(item.name),
          path: string(item.path_display) ?? path,
          providerId: required(item.id),
          size: size(item.size),
          modifiedTime: string(item.server_modified),
          revision: string(item.rev),
          hashes: { 'dropbox-content-hash': hash(item.content_hash, 64) },
        },
      };
    default:
      throw new InventoryReadError('Unknown Dropbox entry type');
  }
}

const DRIVE_FIELDS =
  'id,name,parents,mimeType,size,modifiedTime,version,headRevisionId,sha256Checksum,sha1Checksum,md5Checksum,trashed';
const DRIVE_SCOPE = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
};
function googleChange(item: Record<string, unknown>): InventoryChange {
  const id = required(item.id);
  if (item.trashed === true || item.mimeType === GOOGLE_FOLDER)
    return { remove: id };
  return {
    file: {
      id,
      providerId: id,
      name: required(item.name),
      parents: Array.isArray(item.parents)
        ? item.parents.map(required)
        : undefined,
      mimeType: string(item.mimeType),
      size: size(item.size),
      modifiedTime: string(item.modifiedTime),
      revision: string(item.headRevisionId) ?? string(item.version),
      hashes: {
        sha256: hash(item.sha256Checksum, 64),
        sha1: hash(item.sha1Checksum, 40),
        md5: hash(item.md5Checksum, 32),
      },
    },
  };
}

export async function inventoryPage(
  cursor: Exclude<InventoryCursor, { phase: 'done' }>,
  send: (request: PurposedRequest) => Promise<TransportResponse>,
  pageSize: number,
): Promise<InventoryPage> {
  if (cursor.phase === 'dropbox') {
    const response = await send(
      cursor.token
        ? post(DROPBOX_LIST + '/continue', { cursor: cursor.token })
        : post(DROPBOX_LIST, {
            path: '',
            recursive: true,
            include_deleted: true,
            limit: pageSize,
          }),
    );
    if (response.status === 409 && cursor.token) {
      const conflict = record(JSON.parse(response.body) as unknown);
      if (record(conflict.error)['.tag'] === 'reset')
        throw new InventoryCursorExpired();
    }
    const body = json(response);
    if (typeof body.has_more !== 'boolean')
      throw new InventoryReadError('Missing Dropbox pagination state');
    const entries = list(body.entries);
    return {
      next: {
        phase: body.has_more ? 'dropbox' : 'done',
        token: required(body.cursor),
      },
      changes: entries.map(dropboxChange),
      count: entries.length,
    };
  }
  if (cursor.phase === 'google-start') {
    const body = json(
      await send(get('changes/startPageToken', { supportsAllDrives: 'true' })),
    );
    return {
      next: { phase: 'google-files', start: required(body.startPageToken) },
      changes: [],
      count: 0,
    };
  }
  if (cursor.phase === 'google-files') {
    const response = await send(
      get('files', {
        ...DRIVE_SCOPE,
        corpora: 'user',
        spaces: 'drive',
        q: 'trashed = false',
        fields: 'nextPageToken,incompleteSearch,files(' + DRIVE_FIELDS + ')',
        pageSize: String(Math.min(pageSize, 100)),
        ...(cursor.token ? { pageToken: cursor.token } : {}),
      }),
    );
    // Google instructs clients to restart files.list with a fresh token if it rejects a page token.
    if (cursor.token && (response.status === 410 || response.status === 400))
      throw new InventoryCursorExpired();
    const body = json(response);
    if (body.incompleteSearch === true)
      throw new InventoryReadError(
        'Google Drive reported an incomplete search',
      );
    const entries = list(body.files ?? []);
    const next = string(body.nextPageToken);
    return {
      next: next
        ? { ...cursor, token: next }
        : { phase: 'google-changes', token: cursor.start },
      changes: entries.map(googleChange),
      count: entries.length,
    };
  }
  const response = await send(
    get('changes', {
      ...DRIVE_SCOPE,
      includeRemoved: 'true',
      spaces: 'drive',
      fields:
        'nextPageToken,newStartPageToken,changes(changeType,fileId,removed,file(' +
        DRIVE_FIELDS +
        '))',
      pageToken: cursor.token,
      pageSize: String(Math.min(pageSize, 100)),
    }),
  );
  if (response.status === 410) throw new InventoryCursorExpired();
  const body = json(response);
  const entries = list(body.changes ?? []);
  const next = string(body.nextPageToken);
  const changes: InventoryChange[] = [];
  for (const entry of entries) {
    if (entry.changeType === 'drive') continue;
    const id = required(entry.fileId);
    if (entry.removed === true) changes.push({ remove: id });
    else {
      const file = record(entry.file);
      if (file.id !== id)
        throw new InventoryReadError(
          'Google Drive change has inconsistent identity',
        );
      changes.push(googleChange(file));
    }
  }
  return {
    next: next
      ? { phase: 'google-changes', token: next }
      : { phase: 'done', token: required(body.newStartPageToken) },
    changes,
    count: entries.length,
  };
}

/** Only enumerate directories and stat entries. Opening files can hydrate placeholders. */
export async function* localInventory(
  root: string,
  check: () => void,
): AsyncGenerator<InventoryFile> {
  if (!(await lstat(root)).isDirectory())
    throw new InventoryReadError(
      'The iCloud Drive inventory root must be a directory',
    );
  async function* walk(
    directory: string,
    prefix: string,
  ): AsyncGenerator<InventoryFile> {
    check();
    for await (const entry of await opendir(directory)) {
      check();
      const path = prefix + '/' + entry.name;
      const location = join(directory, entry.name);
      const stat = await lstat(location, { bigint: true });
      if (stat.isDirectory()) yield* walk(location, path);
      else if (stat.isFile()) {
        // Older macOS releases expose undownloaded items as .name.icloud.
        // Preserve the listed path and leave the stub's size and time unknown.
        const stub = /^\..+\.icloud$/.test(entry.name);
        yield {
          id: path,
          path,
          name: stub ? entry.name.slice(1, -'.icloud'.length) : entry.name,
          ...(stub
            ? {}
            : {
                size: String(stat.size),
                modifiedTime: new Date(Number(stat.mtimeMs)).toISOString(),
              }),
          hashes: {},
        };
      }
    }
  }
  yield* walk(root, '');
}
