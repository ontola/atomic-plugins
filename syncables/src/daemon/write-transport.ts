import { proxyRequest, type Session, type Connection } from '../cli/auth.js';
import type { Transport } from '../read/transport.js';

/** One attempt, no redirects, replay cache, automatic retries or credential forwarding. */
export function proxyWriteTransport(
  session: Session,
  connection: Connection,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = globalThis.fetch,
): Transport {
  if (
    !session.scope?.split(' ').includes('proxy:write') ||
    !session.scope.split(' ').includes('proxy:read')
  )
    throw new Error(
      'Read and write login required; run syncables login --write',
    );
  const root = proxyRequest(session, connection, '/').url;
  return async (input) => {
    if (
      input.url.origin !== root.origin ||
      !input.url.pathname.startsWith(root.pathname) ||
      input.url.username ||
      input.url.password ||
      input.url.hash ||
      !['GET', 'POST', 'DELETE'].includes(input.method) ||
      (input.method !== 'POST' && input.body !== undefined)
    )
      throw new Error(
        'Write transport request escapes the approved connection',
      );
    if (Buffer.byteLength(input.body ?? '') > 1024 * 1024)
      throw new Error('Edit body exceeds 1 MiB');
    const response = await fetchImpl(input.url, {
      method: input.method,
      redirect: 'error',
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(30_000),
      ]),
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(input.body === undefined
          ? {}
          : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: input.body }),
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
          throw new Error('API response exceeds 8 MiB');
        }
        chunks.push(chunk.value);
      }
    return {
      status: response.status,
      headers: {},
      body: Buffer.concat(chunks).toString('utf8'),
    };
  };
}
