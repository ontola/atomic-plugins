import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { braidify } from 'braid-http';
import { nodeHash } from '../postgres/json-graph.js';
import type { PostgresHistoryStore, HistoryRevision } from './history-store.js';

const FORMAT = 'syncd-braid-collection-v1';
const MAX_BODY = 32 * 1024 * 1024;
const MAX_REPLAY = 256;
const MAX_CLIENTS = 16;
const TOKEN = /^[\x21-\x7e]{32,256}$/;

export interface BraidCollection {
  alias: string;
  scope: string;
}
export interface BraidOptions {
  store: Pick<PostgresHistoryStore, 'head' | 'revision' | 'render'>;
  collections: BraidCollection[];
  /** Explicit local read authority; never a provider or owner-signing token. */
  token: string;
  port?: number;
  /** One exact browser origin. No browser access is granted by default. */
  allowedOrigin?: string;
  pollMs?: number;
}
export interface BraidServer {
  url: string;
  close(): Promise<void>;
}
interface BraidResponse extends ServerResponse {
  startSubscription(): void;
  sendUpdate(update: {
    version: string[];
    parents: string[];
    body: string;
    repr_type: string;
  }): Promise<void>;
}
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A version namespace covers scope, representation format AND resource URL. */
function namespace(collection: BraidCollection): string {
  return nodeHash(JSON.stringify([FORMAT, collection.alias, collection.scope]));
}
function version(collection: BraidCollection, revision: string): string {
  return 'syncd-v1-' + namespace(collection) + '-' + revision;
}
function headerVersion(
  value: string | string[] | undefined,
  collection: BraidCollection,
  allowEmpty = false,
): string | undefined {
  if (value === undefined) return undefined;
  if (allowEmpty && value === '') return undefined;
  if (typeof value !== 'string' || value.length > 512)
    throw new HttpError(400, 'Supply one quoted version token');
  let parsed: unknown;
  try {
    parsed = JSON.parse('[' + value + ']');
  } catch {
    throw new HttpError(400, 'Supply one quoted version token');
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    typeof parsed[0] !== 'string'
  )
    throw new HttpError(400, 'Supply one quoted version token');
  const prefix = 'syncd-v1-' + namespace(collection) + '-';
  if (
    !parsed[0].startsWith(prefix) ||
    !/^[a-f0-9]{64}$/.test(parsed[0].slice(prefix.length))
  )
    throw new HttpError(409, 'Unknown version; request a fresh snapshot');
  return parsed[0].slice(prefix.length);
}

/** Loopback, read-only Braid view of durable PostgreSQL snapshot heads. */
export async function startBraidServer(
  options: BraidOptions,
): Promise<BraidServer> {
  if (!TOKEN.test(options.token))
    throw new Error(
      'Set SYNCABLES_BRAID_TOKEN to 32–256 printable ASCII characters',
    );
  const port = options.port ?? 9888;
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid Braid port');
  if (!Number.isSafeInteger(pollMs) || pollMs < 10 || pollMs > 60_000)
    throw new Error('Invalid Braid polling interval');
  if (options.allowedOrigin !== undefined) {
    const origin = new URL(options.allowedOrigin);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.origin !== options.allowedOrigin
    )
      throw new Error('Braid browser origin must be an exact HTTP(S) origin');
  }
  const collections = new Map<string, BraidCollection>();
  for (const collection of options.collections) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}\/[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(
        collection.alias,
      ) ||
      !collection.scope ||
      collections.has(collection.alias)
    )
      throw new Error('Invalid or duplicate Braid collection');
    collections.set(collection.alias, { ...collection });
  }
  if (!collections.size)
    throw new Error('Select at least one Braid collection');
  const digest = (text: string): Buffer =>
    createHash('sha256').update(text).digest();
  const expected = digest('Bearer ' + options.token);
  const clients = new Set<ServerResponse>();
  const controllers = new Set<AbortController>();
  let stopping = false;
  let authority = '';

  async function revision(
    collection: BraidCollection,
    id: string,
  ): Promise<HistoryRevision> {
    const result = await options.store.revision(id);
    if (result.scope !== collection.scope)
      throw new Error('Snapshot escaped its configured scope');
    return result;
  }
  // The head itself is the durable publication cursor. No in-memory notification
  // or second queue is needed: only committed, reachable revisions are served.
  async function since(
    collection: BraidCollection,
    head: string,
    known: string,
  ): Promise<string[]> {
    // Keep only IDs while planning replay, not hundreds of resource maps.
    const result: string[] = [];
    const seen = new Set<string>();
    let id = head;
    while (id !== known) {
      if (result.length >= MAX_REPLAY || seen.has(id))
        throw new HttpError(
          409,
          'History cannot be resumed; request a fresh snapshot',
        );
      seen.add(id);
      const entry = await revision(collection, id);
      result.push(entry.id);
      if (entry.parents.length !== 1)
        throw new HttpError(
          409,
          'History cannot be resumed; request a fresh snapshot',
        );
      id = entry.parents[0];
    }
    return result.reverse();
  }
  async function body(
    collection: BraidCollection,
    entry: HistoryRevision,
    signal: AbortSignal,
  ): Promise<string> {
    // Each JSON-AD resource is TEXT, so a standard JSON parser on the consumer
    // cannot round the source's numeric lexemes. Internal context is not served.
    const parts: string[] = [];
    let bytes = 0;
    for (const subject of Object.keys(entry.resources).sort()) {
      if (signal.aborted) throw new Error('Braid client disconnected');
      const raw = await options.store.render(entry.resources[subject]);
      const part = JSON.stringify(subject) + ':' + JSON.stringify(raw);
      bytes += Buffer.byteLength(part) + 1;
      if (bytes > MAX_BODY - 1024)
        throw new HttpError(
          413,
          'Collection exceeds the 32 MiB Braid representation limit',
        );
      parts.push(part);
    }
    return (
      '{"format":' +
      JSON.stringify(FORMAT) +
      ',"collection":' +
      JSON.stringify(collection.alias) +
      ',"revision":' +
      JSON.stringify(entry.id) +
      ',"resources":{' +
      parts.join(',') +
      '}}'
    );
  }
  async function send(
    res: BraidResponse,
    collection: BraidCollection,
    entry: HistoryRevision,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    await res.sendUpdate({
      version: [version(collection, entry.id)],
      parents: entry.parents.map((id) => version(collection, id)),
      repr_type: 'application/json',
      body: value,
    });
    if (!res.writableNeedDrain || signal.aborted) return;
    // At most one bounded snapshot is queued for a client. A slow client
    // reconnects from its last applied version rather than growing a queue.
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        cleanup();
        resolve();
      };
      const closed = (): void => {
        cleanup();
        reject(new Error('Braid stream closed'));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        res.removeListener('drain', done);
        signal.removeEventListener('abort', closed);
      };
      const timer = setTimeout(closed, 5000);
      res.once('drain', done);
      signal.addEventListener('abort', closed, { once: true });
      if (signal.aborted) closed();
    });
  }
  async function handle(
    req: IncomingMessage,
    plain: ServerResponse,
  ): Promise<void> {
    plain.setHeader('Cache-Control', 'no-store');
    plain.setHeader('X-Content-Type-Options', 'nosniff');
    plain.setHeader(
      'Vary',
      'Origin, Authorization, Version, Parents, Subscribe',
    );
    const controller = new AbortController();
    const signal = controller.signal;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let subscribed = false;
    const stop = (): void => controller.abort();
    plain.once('close', stop);
    controllers.add(controller);
    try {
      if (stopping || clients.size >= MAX_CLIENTS)
        throw new HttpError(503, 'Braid reader capacity reached');
      clients.add(plain);
      if (req.headers.host !== authority)
        throw new HttpError(403, 'Use the listener URL');
      const origin = req.headers.origin;
      if (origin !== undefined) {
        if (origin !== options.allowedOrigin)
          throw new HttpError(403, 'Browser origin is not allowed');
        plain.setHeader('Access-Control-Allow-Origin', origin);
        plain.setHeader(
          'Access-Control-Expose-Headers',
          'Version, Parents, Subscribe, Repr-Type, Braid-Reset',
        );
      }
      if (req.method === 'OPTIONS' && origin !== undefined) {
        if (req.headers['access-control-request-method'] !== 'GET')
          throw new HttpError(405, 'Read-only Braid interface');
        const headers = String(
          req.headers['access-control-request-headers'] ?? '',
        )
          .toLowerCase()
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        if (
          headers.some(
            (h) =>
              ![
                'authorization',
                'version',
                'parents',
                'subscribe',
                'heartbeats',
              ].includes(h),
          )
        )
          throw new HttpError(400, 'Unsupported request header');
        plain.setHeader('Access-Control-Allow-Methods', 'GET');
        plain.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Version, Parents, Subscribe, Heartbeats',
        );
        plain.writeHead(204).end();
        return;
      }
      if (!timingSafeEqual(digest(req.headers.authorization ?? ''), expected)) {
        plain.setHeader('WWW-Authenticate', 'Bearer');
        throw new HttpError(401, 'Braid read token required');
      }
      if (req.method !== 'GET') {
        plain.setHeader('Allow', 'GET');
        throw new HttpError(405, 'Read-only Braid interface');
      }
      const url = new URL(req.url ?? '/', 'http://' + authority);
      if (!url.pathname.startsWith('/collections/') || url.search)
        throw new HttpError(404, 'Unknown collection resource');
      let name: string;
      try {
        name = decodeURIComponent(url.pathname.slice('/collections/'.length));
      } catch {
        throw new HttpError(400, 'Invalid collection resource');
      }
      const collection = collections.get(name);
      if (!collection) throw new HttpError(404, 'Unknown collection resource');
      if (
        req.headers['multiplex-through'] !== undefined ||
        req.headers['multiplex-version'] !== undefined
      )
        throw new HttpError(400, 'Multiplexing is not supported');
      subscribed = req.headers.subscribe !== undefined;
      if (subscribed && !['?1', 'true'].includes(String(req.headers.subscribe)))
        throw new HttpError(400, 'Use Subscribe: ?1');
      if (
        (subscribed && req.headers.version !== undefined) ||
        (!subscribed && req.headers.parents !== undefined)
      )
        throw new HttpError(
          400,
          'Use Version for a GET, or Parents for a subscription',
        );
      const requested = headerVersion(req.headers.version, collection);
      let known = headerVersion(req.headers.parents, collection, true);
      const head = await options.store.head(collection.scope);
      if (!head)
        throw new HttpError(404, 'No accepted snapshot for this collection');
      let entries: string[];
      if (requested) {
        // Prove reachability from the selected head, not merely row existence.
        await since(collection, head, requested);
        entries = [requested];
      } else if (known) entries = await since(collection, head, known);
      else entries = [head];
      const first = entries.length
        ? await revision(collection, entries[0])
        : undefined;
      const firstBody = first
        ? await body(collection, first, signal)
        : undefined;
      // braid-http owns framing; reject optional transport features before
      // entering it. Manage heartbeats here so all timers stop on disconnect.
      const heartbeats = req.headers.heartbeats;
      if (
        heartbeats !== undefined &&
        (!subscribed ||
          !/^\d+s?$/.test(String(heartbeats)) ||
          parseInt(String(heartbeats)) < 1 ||
          parseInt(String(heartbeats)) > 60)
      )
        throw new HttpError(
          400,
          'Heartbeats must be 1–60 seconds on a subscription',
        );
      delete req.headers.heartbeats;
      braidify(req, plain);
      plain.removeHeader('Range-Request-Allow-Methods');
      plain.removeHeader('Range-Request-Allow-Units');
      const res = plain as BraidResponse;
      if (subscribed) {
        res.startSubscription();
        // braid-http disables this globally; receiving request bodies still
        // needs a deadline even while completed GET subscriptions stay open.
        server.requestTimeout = 10_000;
        if (heartbeats !== undefined) res.setHeader('Heartbeats', heartbeats);
        res.flushHeaders();
        heartbeat = setInterval(
          () => {
            if (!signal.aborted) {
              if (res.writableLength > 0) res.destroy();
              else res.write('\r\n');
            }
          },
          parseInt(String(heartbeats ?? 15)) * 1000,
        );
      }
      for (let index = 0; index < entries.length; index++) {
        const entry =
          index === 0 ? first! : await revision(collection, entries[index]);
        await send(
          res,
          collection,
          entry,
          index === 0 ? firstBody! : await body(collection, entry, signal),
          signal,
        );
        known = entry.id;
      }
      if (!subscribed) {
        res.end();
        return;
      }
      known = head;
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
          };
          const timer = setTimeout(done, pollMs);
          signal.addEventListener('abort', done, { once: true });
          if (signal.aborted) done();
        });
        if (signal.aborted) break;
        const next = await options.store.head(collection.scope);
        if (!next) throw new Error('Collection head is no longer available');
        if (next === known) continue;
        entries = await since(collection, next, known);
        for (const id of entries) {
          const entry = await revision(collection, id);
          await send(
            res,
            collection,
            entry,
            await body(collection, entry, signal),
            signal,
          );
          known = entry.id;
        }
      }
    } catch (error) {
      if (!plain.headersSent && !signal.aborted) {
        const status = error instanceof HttpError ? error.status : 503;
        if (status === 409) plain.setHeader('Braid-Reset', 'true');
        plain.setHeader('Content-Type', 'application/json');
        plain.writeHead(status).end(
          JSON.stringify({
            error:
              error instanceof HttpError
                ? error.message
                : 'Local snapshot unavailable; reconnect to retry',
          }),
        );
      } else plain.destroy();
    } finally {
      clearInterval(heartbeat);
      plain.removeListener('close', stop);
      controller.abort();
      controllers.delete(controller);
      clients.delete(plain);
    }
  }
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing Braid listener');
  authority = '127.0.0.1:' + address.port;
  let closing: Promise<void> | undefined;
  return {
    url: 'http://' + authority,
    close: (): Promise<void> => {
      closing ??= new Promise<void>((resolve) => {
        stopping = true;
        for (const controller of controllers) controller.abort();
        for (const client of clients) client.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
