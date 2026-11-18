import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createServer, type Server, type IncomingMessage } from 'node:http';
import { timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  readdir,
  lstat,
  realpath,
  link,
} from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { isRecord } from '../read/model.js';
import type { NativeOperation } from './native.js';

class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function save(file: string, value: unknown): Promise<void> {
  const temporary = file + '.' + randomUUID();
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}
function safePath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          part.startsWith('.syncables-transfer-'),
      ) ||
    [...value].some(
      (character) => character.charCodeAt(0) < 32 || character === '\\',
    )
  )
    throw new ServiceError(
      400,
      'Use a relative destination path without traversal',
    );
  return value;
}
async function body(request: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit)
      throw new ServiceError(413, 'Request exceeds the operation limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export interface MacServiceOptions {
  directory: string;
  stateDirectory: string;
  token: string;
  connection: string;
  port: number;
  photos: boolean;
  writable: boolean;
  native: NativeOperation;
  pageSize?: number;
}
export async function startMacService(
  options: MacServiceOptions,
): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const root = await realpath(options.directory);
  if (!(await lstat(root)).isDirectory()) throw new Error('Select a directory');
  const blobDirectory = join(options.stateDirectory, 'blobs');
  const receipts = join(options.stateDirectory, 'receipts');
  await mkdir(blobDirectory, { recursive: true, mode: 0o700 });
  await mkdir(receipts, { recursive: true, mode: 0o700 });
  const snapshots = new Map<
    string,
    {
      collection: string;
      items: unknown[];
      observation: Record<string, unknown>;
      time: number;
    }
  >();
  let serial = Promise.resolve();
  function exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = serial.then(work);
    serial = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async function receipt(id: string): Promise<Record<string, unknown>> {
    const value: unknown = JSON.parse(
      await readFile(join(receipts, id + '.json'), 'utf8'),
    );
    if (!isRecord(value)) throw new Error('Invalid transfer receipt');
    if (value.localStatus === 'written') {
      try {
        const result = await options.native({
          operation: 'drive',
          directory: root,
          path: value.path,
        });
        value.uploadStatus = isRecord(result.item)
          ? (result.item.uploadStatus ?? 'unknown')
          : 'unknown';
      } catch {
        value.uploadStatus = 'unknown';
      }
    }
    return value;
  }
  async function transfer(input: unknown): Promise<Record<string, unknown>> {
    if (
      !isRecord(input) ||
      typeof input.operationId !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(input.operationId) ||
      !['file', 'directory'].includes(String(input.kind)) ||
      Object.keys(input).some(
        (key) =>
          !['operationId', 'path', 'kind', 'sha256', 'modifiedTime'].includes(
            key,
          ),
      )
    )
      throw new ServiceError(400, 'Invalid storage operation');
    const path = safePath(input.path);
    if (
      input.modifiedTime !== undefined &&
      (typeof input.modifiedTime !== 'string' ||
        !Number.isFinite(Date.parse(input.modifiedTime)))
    )
      throw new ServiceError(400, 'Invalid modification time');
    if (
      input.kind === 'file' &&
      (typeof input.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256))
    )
      throw new ServiceError(400, 'Stage content before creating a file');
    const destination = resolve(root, path);
    const relativePath = relative(root, destination);
    if (relativePath.startsWith('../') || isAbsolute(relativePath))
      throw new ServiceError(400, 'Destination escapes its root');
    const file = join(receipts, input.operationId + '.json');
    const prior = await readFile(file, 'utf8').catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    if (prior) {
      const saved = JSON.parse(prior) as Record<string, unknown>;
      for (const key of ['path', 'kind', 'sha256', 'modifiedTime'])
        if (saved[key] !== input[key])
          throw new ServiceError(
            409,
            'Operation ID already names another transfer',
          );
      if (saved.localStatus !== 'written')
        throw new ServiceError(
          409,
          'Inspect the previous transfer outcome before retrying',
        );
      return receipt(input.operationId);
    }
    const record = {
      ...input,
      id: input.operationId,
      localStatus: 'writing',
      uploadStatus: 'unknown',
    };
    await save(file, record);
    try {
      await options.native({
        operation: 'write',
        directory: root,
        path,
        kind: input.kind,
        ...(input.kind === 'file'
          ? {
              blob: join(blobDirectory, String(input.sha256)),
              sha256: input.sha256,
            }
          : {}),
        ...(input.modifiedTime === undefined
          ? {}
          : { modifiedTime: input.modifiedTime }),
      });
      record.localStatus = 'written';
      await save(file, record);
      return receipt(input.operationId);
    } catch {
      record.localStatus = 'uncertain';
      await save(file, record);
      throw new ServiceError(
        409,
        'Transfer was not confirmed. Inspect the destination and receipt before queuing another operation.',
      );
    }
  }
  let origin = '';
  const server = createServer(async (request, response) => {
    const json = (status: number, value: unknown): void => {
      response.writeHead(status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      response.end(JSON.stringify(value));
    };
    try {
      if (
        request.headers.host !== new URL(origin).host ||
        request.headers.origin !== undefined
      )
        throw new ServiceError(403, 'Use the native connector transport');
      const provided = Buffer.from(request.headers.authorization ?? '');
      const expected = Buffer.from('Bearer ' + options.token);
      if (
        provided.length !== expected.length ||
        !timingSafeEqual(provided, expected)
      )
        throw new ServiceError(401, 'Local connector permission required');
      if (request.headers['x-syncables-connection'] !== options.connection)
        throw new ServiceError(
          409,
          'Connector identity differs from the configured source',
        );
      const url = new URL(request.url ?? '/', origin);
      if (
        request.method === 'POST' &&
        url.pathname === '/blobs' &&
        options.writable
      ) {
        const temporary = join(blobDirectory, '.' + randomUUID());
        const file = await open(temporary, 'wx', 0o600);
        let size = 0;
        const hash = createHash('sha256');
        try {
          try {
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 1024 * 1024 * 1024)
                throw new ServiceError(
                  413,
                  'Staging is limited to 1 GiB per file',
                );
              hash.update(chunk);
              await file.writeFile(chunk);
            }
            await file.sync();
          } finally {
            await file.close();
          }
          const sha256 = hash.digest('hex');
          await link(temporary, join(blobDirectory, sha256)).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            },
          );
          json(201, { sha256, size: String(size) });
        } finally {
          await rm(temporary, { force: true });
        }
        return;
      }
      if (
        request.method === 'POST' &&
        url.pathname === '/transfers' &&
        options.writable
      ) {
        const input: unknown = JSON.parse(
          (await body(request, 16 * 1024)).toString('utf8'),
        );
        json(201, await exclusive(() => transfer(input)));
        return;
      }
      if (request.method !== 'GET')
        throw new ServiceError(405, 'Operation unavailable');
      const parts = url.pathname.split('/').slice(1);
      const collection = parts[0];
      if (
        !['files', 'transfers', ...(options.photos ? ['photos'] : [])].includes(
          collection,
        )
      )
        throw new ServiceError(404, 'Unknown collection');
      if (
        parts.length === 3 &&
        collection === 'files' &&
        parts[2] === 'content'
      ) {
        const path = safePath(
          Buffer.from(decodeURIComponent(parts[1]), 'base64url').toString(
            'utf8',
          ),
        );
        const exported = join(blobDirectory, '.' + randomUUID());
        try {
          await exclusive(() =>
            options.native({
              operation: 'content',
              directory: root,
              path,
              export: exported,
            }),
          );
          response.writeHead(200, {
            'content-type': 'application/octet-stream',
            'cache-control': 'no-store',
          });
          await pipeline(createReadStream(exported), response);
        } finally {
          await rm(exported, { force: true });
        }
        return;
      }
      if (parts.length === 2 && collection === 'files') {
        const path = safePath(
          Buffer.from(decodeURIComponent(parts[1]), 'base64url').toString(
            'utf8',
          ),
        );
        const result = await exclusive(() =>
          options.native({ operation: 'drive', directory: root, path }),
        );
        json(200, result.item);
        return;
      }
      if (parts.length === 2 && collection === 'photos') {
        const result = await exclusive(() =>
          options.native({ operation: 'photos', directory: root }),
        );
        const item = Array.isArray(result.items)
          ? result.items.find(
              (item) =>
                isRecord(item) && item.id === decodeURIComponent(parts[1]),
            )
          : undefined;
        if (!item)
          throw new ServiceError(
            404,
            'Asset is absent from the selected Photos scope',
          );
        json(200, item);
        return;
      }
      if (
        parts.length === 2 &&
        collection === 'transfers' &&
        /^[0-9a-f-]{36}$/i.test(parts[1])
      ) {
        json(200, await exclusive(() => receipt(parts[1])));
        return;
      }
      if (parts.length !== 1) throw new ServiceError(404, 'Unknown operation');
      const cursor = url.searchParams.get('cursor');
      let id: string;
      let offset: number;
      if (cursor) {
        const match = /^([0-9a-f-]{36}):(\d+)$/.exec(cursor);
        if (!match) throw new ServiceError(400, 'Invalid scan cursor');
        [, id] = match;
        offset = Number(match[2]);
      } else {
        const startedAt = new Date().toISOString();
        const scan = await exclusive(async () => {
          if (collection !== 'transfers')
            return options.native({
              operation: collection === 'photos' ? 'photos' : 'drive',
              directory: root,
            });
          const items: Record<string, unknown>[] = [];
          for (const name of await readdir(receipts))
            if (/^[0-9a-f-]{36}\.json$/i.test(name))
              items.push(await receipt(name.slice(0, -5)));
          return {
            complete: true,
            items,
            scope: { directory: root, receipts: true },
          };
        });
        if (scan.complete !== true || !Array.isArray(scan.items))
          throw new ServiceError(503, 'Native metadata scan did not complete');
        id = randomUUID();
        offset = 0;
        // Bound retained scans and reject expired cursors instead of mixing scans.
        for (const [key, snapshot] of snapshots)
          if (Date.now() - snapshot.time > 600_000) snapshots.delete(key);
        if (snapshots.size >= 8)
          snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(id, {
          collection,
          items: scan.items,
          observation: {
            adapter: 'macos-v1',
            scan: id,
            startedAt,
            completedAt: new Date().toISOString(),
            scope: scan.scope,
          },
          time: Date.now(),
        });
      }
      const snapshot = snapshots.get(id);
      if (
        !snapshot ||
        snapshot.collection !== collection ||
        Date.now() - snapshot.time > 600_000 ||
        offset > snapshot.items.length
      )
        throw new ServiceError(
          409,
          'Scan expired. Restart the full collection read.',
        );
      const end = offset + (options.pageSize ?? 500);
      json(200, {
        items: snapshot.items.slice(offset, end),
        observation: snapshot.observation,
        ...(end < snapshot.items.length ? { nextCursor: id + ':' + end } : {}),
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      json(
        error instanceof ServiceError
          ? error.status
          : (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 404
            : 503,
        {
          error:
            error instanceof ServiceError
              ? error.message
              : 'Local operation failed. Check macOS access permissions and the connector.',
        },
      );
    }
  });
  server.requestTimeout = 300_000;
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', done);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Connector did not listen');
  origin = 'http://127.0.0.1:' + address.port;
  return {
    server,
    url: origin,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error ? reject(error) : done()));
        server.closeAllConnections();
      }),
  };
}
