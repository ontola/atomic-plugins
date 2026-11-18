import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { Transport } from '../read/transport.js';
import { findRoute } from '../routing/router.js';
import { upstreamOf } from '../read/model.js';
import type { PreparedCollection } from './sync.js';
import type { CollectionConfig } from './config.js';

/** A configured loopback service has local permissions, independent of IAP. */
export async function localHeaders(
  source: CollectionConfig,
): Promise<Record<string, string>> {
  if (!source.local) throw new Error('Select a local connector');
  const file = await open(
    source.local.tokenFile,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 512
    )
      throw new Error('Local connector token must be an owner-only file');
    const token = (await file.readFile('utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new Error('Invalid local connector token');
    return {
      authorization: 'Bearer ' + token,
      'x-syncables-connection': source.connection,
    };
  } finally {
    await file.close();
  }
}
export function localTransport(
  source: CollectionConfig,
  signal?: AbortSignal,
): Transport {
  if (!source.local) throw new Error('Select a local connector');
  const origin = new URL(source.local.url).origin;
  return async (request) => {
    if (
      request.url.origin !== origin ||
      request.url.username ||
      request.url.password ||
      request.url.hash
    )
      throw new Error('Request escapes the configured local connector');
    const response = await fetch(request.url, {
      method: request.method,
      redirect: 'error',
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(300_000),
      ]),
      headers: {
        ...request.headers,
        ...(await localHeaders(source)),
        ...(request.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('Local response exceeds 8 MiB');
        }
        chunks.push(chunk.value);
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
}
/** Stage immutable content before enqueueing its JSON operation in the shared outbox. */
export async function stageLocalContent(
  source: CollectionConfig,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!source.local || !source.writes?.enabled)
    throw new Error('Select a writable local storage collection');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const information = await file.stat();
  if (!information.isFile() || information.size > 1024 * 1024 * 1024) {
    await file.close();
    throw new Error('Copy supports regular files up to 1 GiB');
  }
  const stream = file.createReadStream();
  try {
    return await stageContent(source, stream as unknown as BodyInit, signal);
  } finally {
    stream.destroy();
  }
}

export async function stageConnectorContent(
  destination: CollectionConfig,
  source: PreparedCollection,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  if (!source.source.local)
    throw new Error('Source collection must have a local connector transport');
  const url = new URL(path, upstreamOf(source.document));
  const match = findRoute(Object.keys(source.document.paths), url.pathname);
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    url.origin !== source.source.local.url ||
    !match ||
    !source.document.paths[match.template].get?.responses['200']?.content?.[
      'application/octet-stream'
    ]
  )
    throw new Error(
      'Select a declared binary GET operation on the source connector',
    );
  const response = await fetch(url, {
    redirect: 'error',
    headers: await localHeaders(source.source),
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error('Source content read failed');
  try {
    return await stageContent(destination, response.body, signal);
  } finally {
    if (!response.body.locked) await response.body.cancel();
  }
}

async function stageContent(
  source: CollectionConfig,
  body: BodyInit,
  signal: AbortSignal,
): Promise<string> {
  if (!source.local || !source.writes?.enabled)
    throw new Error('Select a writable local storage collection');
  const response = await fetch(new URL('/blobs', source.local.url), {
    method: 'POST',
    redirect: 'error',
    headers: {
      ...(await localHeaders(source)),
      'content-type': 'application/octet-stream',
    },
    body,
    duplex: 'half',
    signal,
  } as RequestInit);
  if (!response.ok)
    throw new Error('Content staging failed (HTTP ' + response.status + ')');
  const result = (await response.json()) as { sha256?: unknown };
  if (
    typeof result.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.sha256)
  )
    throw new Error('Invalid staging receipt');
  return result.sha256;
}
