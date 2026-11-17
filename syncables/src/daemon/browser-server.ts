// @wc-ignore-file
import type { BrowserStatus } from './browser-status.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { SnapshotStore } from './snapshot-store.js';
import { SOURCE_ID, SOURCE_JSON } from './sync.js';
import {
  indexJson,
  renderJson,
  type GraphNode,
} from '../postgres/json-graph.js';
import { BROWSER_HTML, BROWSER_SCRIPT, BROWSER_STYLE } from './browser-ui.js';

export interface BrowserCollection {
  alias: string;
  scope: string;
}
export interface BrowserServer {
  url: string;
  close(): Promise<void>;
}
type BrowserStore = Pick<SnapshotStore, 'head' | 'resolveRevision' | 'list'>;
class BrowserError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Read-only loopback view of accepted local snapshots; no provider transport. */
export async function startBrowserServer(options: {
  store: BrowserStore;
  collections: BrowserCollection[];
  port?: number;
  status?: () => Promise<BrowserStatus>;
  management?: {
    issuer: string;
    request: (action: unknown) => Promise<unknown>;
  };
}): Promise<BrowserServer> {
  const collections = new Map(
    options.collections.map((entry) => [entry.alias, entry]),
  );
  if (collections.size !== options.collections.length)
    throw new Error('Duplicate browser collection');
  const port = options.port ?? 9889;
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid browser port');
  const managementOrigin = options.management
    ? new URL(options.management.issuer).origin
    : undefined;
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const server = createServer(async (req, res) => {
    const send = (
      status: number,
      body: string,
      type = 'application/json',
    ): void => {
      res.writeHead(status, {
        'Content-Type': type + '; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src ${managementOrigin ?? "'none'"}; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      });
      res.end(body);
    };
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin !== undefined && req.headers.origin !== origin)
      ) {
        throw new BrowserError(403, 'Use the local browser URL');
      }
      const isManagement =
        req.url === '/api/management' &&
        req.method === 'POST' &&
        options.management;
      if (req.method !== 'GET' && !isManagement)
        throw new BrowserError(405, 'Read-only browser');
      const url = new URL(req.url ?? '/', origin);
      if (url.pathname === '/') {
        send(200, BROWSER_HTML, 'text/html');
        return;
      }
      if (url.pathname === '/browser.js') {
        send(200, BROWSER_SCRIPT, 'text/javascript');
        return;
      }
      if (url.pathname === '/browser.css') {
        send(200, BROWSER_STYLE, 'text/css');
        return;
      }
      const supplied = Buffer.from(
        req.headers.authorization?.replace(/^Bearer /, '') ?? '',
      );
      const expected = Buffer.from(token);
      if (
        supplied.length !== expected.length ||
        !timingSafeEqual(supplied, expected)
      ) {
        throw new BrowserError(401, 'Open the browser link printed by SyncD');
      }
      if (url.pathname === '/api/management/config') {
        send(
          200,
          JSON.stringify({
            url: managementOrigin
              ? managementOrigin +
                '/manage?parent_origin=' +
                encodeURIComponent(origin)
              : null,
          }),
        );
        return;
      }
      if (isManagement) {
        if (
          req.headers['content-type'] !== 'application/json' ||
          req.headers.origin !== origin
        )
          throw new BrowserError(
            403,
            'Management requires a same-origin JSON request',
          );
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 8192)
            throw new BrowserError(413, 'Management request too large');
          chunks.push(Buffer.from(chunk));
        }
        try {
          const result = await options.management!.request(
            JSON.parse(Buffer.concat(chunks).toString('utf8')),
          );
          send(200, JSON.stringify(result));
        } catch {
          throw new BrowserError(
            403,
            'IAP management access unavailable or refused',
          );
        }
        return;
      }
      if (url.pathname === '/api/status') {
        if (!options.status)
          throw new BrowserError(
            503,
            'Connection status is unavailable in this browser.',
          );
        try {
          send(200, JSON.stringify(await options.status()));
        } catch {
          throw new BrowserError(
            503,
            'Could not load SyncD status. Local snapshots may still be browsed.',
          );
        }
        return;
      }
      if (url.pathname === '/api/collections') {
        const entries = await Promise.all(
          options.collections.map(async (entry) => ({
            alias: entry.alias,
            synced: Boolean(await options.store.head(entry.scope)),
          })),
        );
        send(200, JSON.stringify({ collections: entries }));
        return;
      }
      if (url.pathname !== '/api/records')
        throw new BrowserError(404, 'Not found');
      const collection = collections.get(
        url.searchParams.get('collection') ?? '',
      );
      if (!collection) throw new BrowserError(404, 'Unknown collection');
      const head = await options.store.head(collection.scope);
      if (!head) {
        send(
          200,
          JSON.stringify({
            revision: null,
            total: 0,
            page: 1,
            pages: 0,
            records: [],
          }),
        );
        return;
      }
      const requested = url.searchParams.get('revision') ?? head;
      let revision: string;
      try {
        revision = await options.store.resolveRevision(
          collection.scope,
          requested,
        );
      } catch {
        throw new BrowserError(
          409,
          'This snapshot is unavailable. Refresh the collection.',
        );
      }
      const pageText = url.searchParams.get('page') ?? '1';
      if (!/^[1-9]\d{0,5}$/.test(pageText))
        throw new BrowserError(400, 'Invalid page');
      const page = Number(pageText);
      const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
      if (query.length > 200)
        throw new BrowserError(400, 'Search is limited to 200 characters');
      const rawRows = await options.store.list(collection.scope, revision);
      if (
        rawRows.length > 50_000 ||
        rawRows.reduce((sum, raw) => sum + Buffer.byteLength(raw), 0) >
          32 * 1024 * 1024
      ) {
        throw new BrowserError(
          413,
          'This snapshot is too large for the simple browser. Use the CLI browser.',
        );
      }
      const rows = rawRows
        .map((raw) => ({
          raw,
          data: JSON.parse(raw) as Record<string, unknown>,
        }))
        .filter(
          ({ raw, data }) =>
            Object.hasOwn(data, SOURCE_ID) &&
            (!query || raw.toLowerCase().includes(query)),
        )
        .sort((a, b) =>
          String(a.data[SOURCE_ID]).localeCompare(String(b.data[SOURCE_ID])),
        );
      const selected = rows.slice((page - 1) * 25, page * 25);
      const records = await Promise.all(
        selected.map(async ({ raw, data }) => {
          const source = data[SOURCE_JSON];
          const object =
            source && typeof source === 'object'
              ? (source as Record<string, unknown>)
              : {};
          const label = [
            object['title'],
            object['name'],
            object['summary'],
            object['label'],
          ].find((v) => typeof v === 'string' && v.trim());
          // Render the original JSON graph rather than round-tripping numeric values.
          const graph = indexJson(raw, { maxBytes: 32 * 1024 * 1024 });
          const root = JSON.parse(graph.nodes.get(graph.root)!) as GraphNode;
          const child = (root[3] as [string, unknown][]).find(
            ([key]) => key === SOURCE_JSON,
          )?.[1];
          if (!Array.isArray(child) || child[0] !== 'ref')
            throw new Error('Missing source JSON');
          return {
            id: String(data[SOURCE_ID]),
            label: label ?? String(data[SOURCE_ID]),
            raw: await renderJson(
              child[1] as string,
              async (hash) => graph.nodes.get(hash)!,
            ),
          };
        }),
      );
      const body = JSON.stringify({
        revision,
        total: rows.length,
        page,
        pages: Math.ceil(rows.length / 25),
        records,
      });
      if (Buffer.byteLength(body) > 8 * 1024 * 1024)
        throw new BrowserError(
          413,
          'This page exceeds the browser response limit. Use the CLI browser.',
        );
      send(200, body);
    } catch (error) {
      send(
        error instanceof BrowserError ? error.status : 500,
        JSON.stringify({
          error:
            error instanceof BrowserError
              ? error.message
              : 'Could not read the local snapshot',
        }),
      );
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing browser address');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: origin + '/#token=' + token,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
