import { discoverResources } from '../resources/discover.js';
import type { OpenApiDocument } from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { findRoute } from '../routing/router.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { readCollections } from '../read/collections.js';
import {
  discoverReadModel,
  isRecord,
  upstreamOf,
  type QuerySelection,
  type ReadCollection,
} from '../read/model.js';
import { bindPath, type ReadLimits } from '../read/pages.js';
import { paginate as paginateOperation } from '../read/read.js';
import {
  fetchTransport,
  type ListMethod,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../read/transport.js';
import {
  captureReadResponses,
  type StoreReadResponse,
} from '../read/responses.js';
import {
  authenticatedTransport,
  type Authenticate,
  type Credentials,
} from './auth.js';
import { InMemoryStorageAdapter, type StorageAdapter } from './storage.js';

export interface RetryOptions {
  /** Delay before the first retry of a failed write, in milliseconds. Doubles on each subsequent attempt. Default 200. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff between retries, in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Stop auto-retrying a write after this many attempts. Default is unlimited (keep retrying until it succeeds). */
  maxAttempts?: number;
}

export interface ApiClientOptions {
  /** Defaults to document.servers[0].url. */
  baseUrl?: string;
  /** All reads and writes use this transport. Mutually exclusive with fetch. */
  transport?: Transport;
  credentials?: Credentials;
  authenticate?: Authenticate;
  /** Root path bindings; per-call context overrides these. */
  constants?: Record<string, string>;
  selection?: QuerySelection;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
  /** Optional, awaited storage of original collection-read responses. */
  storeResponse?: StoreReadResponse;
  storage?: StorageAdapter;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /**
   * Record property that holds a resource's identity — the value used as the
   * local storage key, read back from a create response to reconcile the
   * server-assigned id, and substituted into the item URL's path variable.
   * For legacy path-pair discovery, defaults to `id`. CRUD metadata supplies
   * each collection's identity field instead. Set this when a legacy API addresses a resource by a
   * different field (e.g. GitHub issues are keyed by `number`, not the
   * global `id` the payload also carries).
   */
  identityField?: string;
}

export interface PaginateOptions {
  /** Page size to request. Falls back to the server's own default when omitted. */
  pageSize?: number;
  method?: ListMethod;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, unknown>;
}

export interface SyncResult {
  /** Collection names (legacy: paths) whose local copy changed during this sync. */
  changed: string[];
}

export interface PollOptions {
  /** How often to call `sync()`, in milliseconds. An initial sync runs immediately. */
  intervalMs: number;
  /** Called after every sync while polling, including ones where nothing changed. */
  onSync?: (result: SyncResult) => void;
  /** Called when a sync throws while polling; polling continues on the next interval. */
  onError?: (error: unknown) => void;
}

export interface PollingHandle {
  /** Stops future polling. Does not cancel a sync already in flight. */
  stop(): void;
}

export type PendingWriteType = 'create' | 'update' | 'delete';

export interface PendingWriteInfo {
  resource: string;
  /** The id the write is filed under locally. For an unsettled `create`, this is the client-generated id, not (yet) whatever the server assigns. */
  id: string;
  type: PendingWriteType;
  /** Bound collection context, present for nested collections. */
  context?: Record<string, string>;
  /**
   * How many attempts to reach the server have failed so far. If
   * `ApiClientOptions.retry.maxAttempts` is set and reached, this stops
   * growing and the write stops auto-retrying — it stays listed here
   * (with `lastError` set) until `create`/`update`/`remove` is called
   * again for the same record.
   */
  attempts: number;
  /** The most recent failure, if at least one attempt has failed. */
  lastError?: string;
}

export interface ApiClient {
  resources: string[];
  sync(): Promise<SyncResult>;
  /**
   * Calls `sync()` on `options.intervalMs`, skipping a tick if the previous
   * sync is still running. Returns a handle whose `stop()` cancels it.
   */
  startPolling(options: PollOptions): PollingHandle;
  list(
    resource: string,
    context?: Record<string, string>,
  ): Promise<Record<string, unknown>[]>;
  get(
    resource: string,
    id: string,
    context?: Record<string, string>,
  ): Promise<Record<string, unknown> | undefined>;
  /**
   * Writes `data` to local storage immediately, under a client-generated id
   * (or `data.id`, if already set) and returns without waiting on the
   * network. The write to the server happens in the background and is
   * retried on failure — see `pendingWrites()` for its outcome so far. If
   * the server assigns a different id than the one used locally, the
   * record is moved to it once the write settles.
   */
  create(
    resource: string,
    data: Record<string, unknown>,
    context?: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  /**
   * Merges `data` into the local copy of `id` immediately and returns
   * without waiting on the network; the declared `PUT` or `PATCH` is sent (and
   * retried on failure) in the background.
   */
  update(
    resource: string,
    id: string,
    data: Record<string, unknown>,
    context?: Record<string, string>,
  ): Promise<Record<string, unknown>>;
  /**
   * Removes `id` from local storage immediately and returns without
   * waiting on the network; the corresponding `DELETE` is sent (and
   * retried on failure) in the background.
   */
  remove(
    resource: string,
    id: string,
    context?: Record<string, string>,
  ): Promise<void>;
  /**
   * Writes not yet confirmed by the server, across every resource (or just
   * `resource`, if given) — local storage already reflects them, but the
   * background attempt to apply them server-side hasn't succeeded yet.
   */
  pendingWrites(resource?: string): PendingWriteInfo[];
  /**
   * Fetches every item from a GET list operation at `path`, walking every
   * page per its resolved pagination scheme (explicit `x-pagination` or
   * auto-detected from `components.paginationSchemes`). `path` need not be
   * a discovered resource — any GET operation in the document works, e.g.
   * a search/listing endpoint with no paired item route.
   */
  paginate(
    path: string,
    options?: PaginateOptions,
  ): Promise<Record<string, unknown>[]>;
}

const CHANGE_INDICATOR_FIELDS = [
  'updatedAt',
  'updated_at',
  'modifiedAt',
  'modified_at',
  'version',
  'revision',
  '_rev',
  'etag',
];

function itemFingerprint(item: Record<string, unknown>): string {
  for (const field of CHANGE_INDICATOR_FIELDS) {
    if (field in item) {
      return `${field}:${String(item[field])}`;
    }
  }
  return JSON.stringify(item);
}

/**
 * Compares a previously synced item list against a freshly fetched one to
 * decide whether local storage actually needs updating — the fallback used
 * when the server gave no (or an untrusted) conditional-request signal.
 */
function hasChanges(
  previous: Record<string, unknown>[] | undefined,
  next: Record<string, unknown>[],
  idField: string,
): boolean {
  if (!previous || previous.length !== next.length) {
    return true;
  }
  const previousById = new Map(
    previous.map((item) => [String(item[idField]), item]),
  );
  return next.some((item) => {
    const match = previousById.get(String(item[idField]));
    return !match || itemFingerprint(match) !== itemFingerprint(item);
  });
}

interface ClientRoute {
  collection: ReadCollection;
  createPath?: string;
  updateMethod?: 'PUT' | 'PATCH';
  deletePath?: string;
}

interface QueuedWrite {
  route: ClientRoute;
  scope: string;
  context: Record<string, string>;
  id: string;
  type: PendingWriteType;
  data?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  attempts: number;
  lastError?: string;
}

type WriteOutcome =
  | { status: 'succeeded'; resolvedId: string }
  | { status: 'retry'; delayMs: number }
  | { status: 'gaveUp' };

function clientRoutes(
  document: OpenApiDocument,
  collections: ReadCollection[],
): ClientRoute[] {
  const legacy = document.components?.['crudResources'] === undefined;
  const paired = new Map(
    discoverResources(document.paths).map((r) => [r.collectionPath, r]),
  );
  return collections.map((collection) => {
    const route: ClientRoute = { collection };
    const item = collection.itemUrl
      ? document.paths[collection.itemUrl]
      : undefined;
    if (
      legacy ||
      (collection.method === 'GET' && document.paths[collection.url]?.post)
    ) {
      route.createPath = collection.url;
    }
    if (item?.put) route.updateMethod = 'PUT';
    else if (item?.patch) route.updateMethod = 'PATCH';
    else if (legacy)
      route.updateMethod = paired.get(collection.url)?.updateMethod ?? 'PUT';
    if (collection.itemUrl && (legacy || item?.delete))
      route.deletePath = collection.itemUrl;
    for (const [path, entry] of Object.entries(document.paths)) {
      for (const method of ['post', 'put', 'patch', 'delete'] as const) {
        const crud = entry[method]?.['x-crud'];
        if (!isRecord(crud) || crud['resource'] !== collection.resource)
          continue;
        if (method === 'post' && crud['action'] === 'create')
          route.createPath = path;
        if (method === 'delete' && crud['action'] === 'delete')
          route.deletePath = path;
      }
    }
    return route;
  });
}

/** A browser-safe local replica. Transport/auth/storage are supplied at its boundaries. */
export function createApiClient(
  document: OpenApiDocument,
  options: ApiClientOptions = {},
): ApiClient {
  if (options.transport && options.fetch)
    throw new Error('Choose transport or fetch, not both');
  const doc = resolveRefs(document);
  if (options.baseUrl) doc['servers'] = [{ url: options.baseUrl }];
  const upstream = upstreamOf(doc);
  const storage = options.storage ?? new InMemoryStorageAdapter();
  const transport = authenticatedTransport(
    options.transport ?? fetchTransport(options.fetch ?? globalThis.fetch),
    options.credentials,
    options.authenticate,
  );
  const readTransport = captureReadResponses(transport, options.storeResponse);
  const legacy =
    options.identityField === undefined
      ? {}
      : { identityField: options.identityField };
  const routes = clientRoutes(doc, discoverReadModel(doc, legacy).collections);
  const byResource = new Map(routes.map((r) => [r.collection.name, r]));
  if (byResource.size !== routes.length)
    throw new Error('Collection names must be unique across resources');
  const confirmed = new Map<string, Map<string, Record<string, unknown>>>();
  const lastSyncedItems = new Map<string, Record<string, unknown>[]>();
  const conditionalCache = new Map<string, TransportResponse>();
  const writeQueues = new Map<string, QueuedWrite[]>();
  const gaveUpWrites = new Map<string, QueuedWrite>();
  const draining = new Set<string>();
  const revisions = new Map<string, number>();
  let syncing: Promise<SyncResult> | undefined;
  const retry = {
    baseDelayMs: options.retry?.baseDelayMs ?? 200,
    maxDelayMs: options.retry?.maxDelayMs ?? 30000,
    maxAttempts: options.retry?.maxAttempts,
  };

  function resolveRoute(resource: string): ClientRoute {
    const named = byResource.get(resource);
    if (named) return named;
    const matches = routes.filter((r) => r.collection.url === resource);
    if (matches.length === 1 && matches[0]) return matches[0];
    throw new Error(
      `Unknown resource "${resource}". Known resources: ${[...byResource.keys()].join(', ')}`,
    );
  }

  function contextFor(
    route: ClientRoute,
    context: Record<string, string> = {},
  ): Record<string, string> {
    const all = { ...options.constants, ...context };
    // Validates missing values before a local write is accepted.
    bindPath(route.collection.url, all);
    return Object.fromEntries(
      route.collection.contextParams.map((p) => [p, all[p] as string]),
    );
  }

  function scopeFor(
    route: ClientRoute,
    context: Record<string, string>,
  ): string {
    return route.collection.contextParams.length
      ? JSON.stringify([
          route.collection.name,
          route.collection.contextParams.map((p) => context[p]),
        ])
      : route.collection.name;
  }

  function keyFor(scope: string, id: string): string {
    return JSON.stringify([scope, id]);
  }

  function remote(scope: string): Map<string, Record<string, unknown>> {
    let records = confirmed.get(scope);
    if (!records) {
      records = new Map();
      confirmed.set(scope, records);
    }
    return records;
  }

  async function rebuild(scope: string, id: string): Promise<void> {
    let value = remote(scope).get(id);
    const key = keyFor(scope, id);
    const abandoned = gaveUpWrites.get(key);
    const pending = [
      ...(abandoned ? [abandoned] : []),
      ...(writeQueues.get(key) ?? []),
    ];
    for (const write of pending) {
      if (write.type === 'create') value = write.data;
      else if (write.type === 'update')
        value = {
          ...value,
          ...write.changes,
          [write.route.collection.idField]: id,
        };
      else value = undefined;
    }
    if (value) await storage.put(scope, id, value);
    else await storage.delete(scope, id);
  }

  function target(path: string, context: Record<string, string>): URL {
    const url = new URL(upstream);
    url.pathname =
      upstream.pathname.replace(/\/$/, '') + bindPath(path, context);
    return url;
  }

  async function requestJson(request: TransportRequest): Promise<unknown> {
    const response = await transport(request);
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Request to ${request.url.pathname} failed with status ${response.status}`,
      );
    }
    return response.body ? JSON.parse(response.body) : undefined;
  }

  async function attemptWrite(write: QueuedWrite): Promise<WriteOutcome> {
    const route = write.route;
    const idField = route.collection.idField;
    try {
      let resolvedId = write.id;
      if (write.type === 'delete') {
        await requestJson({
          url: target(route.deletePath as string, {
            ...write.context,
            [route.collection.itemParam ?? 'id']: write.id,
          }),
          method: 'DELETE',
          headers: {},
        });
        remote(write.scope).delete(write.id);
      } else {
        const data =
          write.type === 'create'
            ? write.data
            : {
                ...remote(write.scope).get(write.id),
                ...write.changes,
                [idField]: write.id,
              };
        const result = await requestJson({
          url:
            write.type === 'create'
              ? target(route.createPath as string, write.context)
              : target(route.collection.itemUrl as string, {
                  ...write.context,
                  [route.collection.itemParam ?? 'id']: write.id,
                }),
          method:
            write.type === 'create'
              ? 'POST'
              : (route.updateMethod as 'PUT' | 'PATCH'),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
        });
        if (write.type === 'create' && !isRecord(result)) {
          throw new Error('Create response has no record');
        }
        const record = isRecord(result) ? result : data;
        if (!record) throw new Error('Write returned no record');
        if (write.type === 'create') {
          const id = record[idField];
          if (id === undefined || id === null || id === '')
            throw new Error('Create response has no record identity');
          resolvedId = String(id);
          if (resolvedId !== write.id) remote(write.scope).delete(write.id);
        }
        remote(write.scope).set(resolvedId, record);
      }
      revisions.set(write.scope, (revisions.get(write.scope) ?? 0) + 1);
      conditionalCache.clear();
      return { status: 'succeeded', resolvedId };
    } catch (error) {
      write.attempts += 1;
      write.lastError = error instanceof Error ? error.message : String(error);
      if (
        retry.maxAttempts !== undefined &&
        write.attempts >= retry.maxAttempts
      )
        return { status: 'gaveUp' };
      return {
        status: 'retry',
        delayMs: Math.min(
          retry.baseDelayMs * 2 ** (write.attempts - 1),
          retry.maxDelayMs,
        ),
      };
    }
  }

  async function drainQueue(initialKey: string): Promise<void> {
    let key = initialKey;
    let ownsQueue = true;
    draining.add(key);
    try {
      for (;;) {
        const queue = writeQueues.get(key);
        const write = queue?.[0];
        if (!write) return;
        const outcome = await attemptWrite(write);
        if (outcome.status === 'retry') {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, outcome.delayMs);
            if (typeof timer.unref === 'function') timer.unref();
          });
          continue;
        }
        queue.shift();
        if (outcome.status === 'gaveUp') gaveUpWrites.set(key, write);
        if (outcome.status === 'succeeded' && outcome.resolvedId !== write.id) {
          const oldId = write.id;
          const rest = queue
            .splice(0)
            .map((pending) => ({ ...pending, id: outcome.resolvedId }));
          writeQueues.delete(key);
          draining.delete(key);
          key = keyFor(write.scope, outcome.resolvedId);
          // Keep the array owned by an in-flight worker: replacing it would
          // leave that worker acknowledging a different queue and resend its head.
          const existing = writeQueues.get(key) ?? [];
          existing.push(...rest);
          writeQueues.set(key, existing);
          ownsQueue = !draining.has(key);
          if (ownsQueue) draining.add(key);
          await rebuild(write.scope, oldId);
          await rebuild(write.scope, outcome.resolvedId);
          if (!ownsQueue) return;
        } else {
          await rebuild(write.scope, write.id);
          if (!queue.length) writeQueues.delete(key);
        }
      }
    } finally {
      if (ownsQueue) draining.delete(key);
    }
  }

  function enqueue(write: Omit<QueuedWrite, 'attempts'>): void {
    const key = keyFor(write.scope, write.id);
    gaveUpWrites.delete(key);
    const queue = writeQueues.get(key) ?? [];
    queue.push({ ...write, attempts: 0 });
    writeQueues.set(key, queue);
    if (!draining.has(key)) void drainQueue(key);
  }

  const conditionalTransport: Transport = async (request) => {
    const path = request.url.pathname.slice(
      upstream.pathname.replace(/\/$/, '').length,
    );
    const matched = findRoute(Object.keys(doc.paths), path);
    const operation = matched ? doc.paths[matched.template]?.get : undefined;
    const cacheable =
      request.method === 'GET' &&
      !resolveEffectiveScheme(doc, operation ?? { responses: {} });
    const key = request.url.href;
    const cached = cacheable ? conditionalCache.get(key) : undefined;
    const headers = { ...request.headers };
    if (cached?.headers['etag'])
      headers['if-none-match'] = cached.headers['etag'];
    if (cached?.headers['last-modified'])
      headers['if-modified-since'] = cached.headers['last-modified'];
    const raw = await readTransport({ ...request, headers });
    const response = {
      ...raw,
      headers: Object.fromEntries(
        Object.entries(raw.headers).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    if (response.status === 304 && cached) return cached;
    if (cacheable && response.status === 200)
      conditionalCache.set(key, response);
    return response;
  };

  async function performSync(): Promise<SyncResult> {
    const started = new Map(revisions);
    const result = await readCollections(doc, {
      transport: conditionalTransport,
      constants: options.constants ?? {},
      legacy,
      ...(options.selection ? { selection: options.selection } : {}),
      ...(options.limits ? { limits: options.limits } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
    const changed = new Set<string>();
    for (const snapshot of result.collections) {
      if (!snapshot.complete) continue;
      const route = byResource.get(snapshot.collection.name) as ClientRoute;
      const context = contextFor(route, snapshot.pathParams);
      const scope = scopeFor(route, context);
      const previous = lastSyncedItems.get(scope);
      const differs = hasChanges(
        previous,
        snapshot.items,
        route.collection.idField,
      );
      // A write acknowledged after this read began is newer than this snapshot.
      if ((started.get(scope) ?? 0) !== (revisions.get(scope) ?? 0)) {
        if (differs) changed.add(route.collection.name);
        continue;
      }
      if (differs) {
        const before = new Set(remote(scope).keys());
        const records = new Map(
          snapshot.items.map((item) => [
            String(item[route.collection.idField]),
            item,
          ]),
        );
        confirmed.set(scope, records);
        for (const id of records.keys()) before.add(id);
        for (const queue of writeQueues.values())
          for (const write of queue)
            if (write.scope === scope) before.add(write.id);
        for (const write of gaveUpWrites.values())
          if (write.scope === scope) before.add(write.id);
        for (const id of before) await rebuild(scope, id);
        changed.add(route.collection.name);
        lastSyncedItems.set(scope, snapshot.items);
      }
    }
    if (result.errors.length)
      throw new Error(`Read incomplete: ${result.errors.join('; ')}`);
    return { changed: [...changed] };
  }

  function sync(): Promise<SyncResult> {
    syncing ??= performSync().finally(() => {
      syncing = undefined;
    });
    return syncing;
  }

  return {
    resources: [...byResource.keys()],
    sync,
    startPolling(pollOptions): PollingHandle {
      let stopped = false;
      let running = false;
      const tick = (): void => {
        if (stopped || running) return;
        running = true;
        sync()
          .then((r) => pollOptions.onSync?.(r))
          .catch((error: unknown) => pollOptions.onError?.(error))
          .finally(() => {
            running = false;
          });
      };
      tick();
      const timer = setInterval(tick, pollOptions.intervalMs);
      if (typeof timer.unref === 'function') timer.unref();
      return {
        stop(): void {
          stopped = true;
          clearInterval(timer);
        },
      };
    },
    async list(resource, context): Promise<Record<string, unknown>[]> {
      const route = resolveRoute(resource);
      return storage.list(scopeFor(route, contextFor(route, context)));
    },
    async get(
      resource,
      id,
      context,
    ): Promise<Record<string, unknown> | undefined> {
      const route = resolveRoute(resource);
      return storage.get(scopeFor(route, contextFor(route, context)), id);
    },
    async create(resource, data, supplied): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      if (!route.createPath)
        throw new Error(`Resource ${resource} declares no create operation`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.createPath, context);
      const id =
        data[route.collection.idField] === undefined
          ? crypto.randomUUID()
          : String(data[route.collection.idField]);
      const record = { ...data, [route.collection.idField]: id };
      await storage.put(scope, id, record);
      enqueue({ route, scope, context, id, type: 'create', data: record });
      return record;
    },
    async update(
      resource,
      id,
      data,
      supplied,
    ): Promise<Record<string, unknown>> {
      const route = resolveRoute(resource);
      if (!route.updateMethod || !route.collection.itemUrl)
        throw new Error(`Resource ${resource} declares no update operation`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.collection.itemUrl, {
        ...context,
        [route.collection.itemParam ?? 'id']: id,
      });
      const existing = await storage.get(scope, id);
      if (
        !remote(scope).has(id) &&
        existing &&
        !writeQueues.has(keyFor(scope, id))
      )
        remote(scope).set(id, existing);
      const record = { ...existing, ...data, [route.collection.idField]: id };
      await storage.put(scope, id, record);
      enqueue({ route, scope, context, id, type: 'update', changes: data });
      return record;
    },
    async remove(resource, id, supplied): Promise<void> {
      const route = resolveRoute(resource);
      if (!route.deletePath)
        throw new Error(`Resource ${resource} declares no delete operation`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.deletePath, {
        ...context,
        [route.collection.itemParam ?? 'id']: id,
      });
      await storage.delete(scope, id);
      enqueue({ route, scope, context, id, type: 'delete' });
    },
    pendingWrites(resource): PendingWriteInfo[] {
      const name = resource
        ? resolveRoute(resource).collection.name
        : undefined;
      const writes = [...writeQueues.values()]
        .flat()
        .concat([...gaveUpWrites.values()]);
      return writes
        .filter((w) => !name || w.route.collection.name === name)
        .map((write) => ({
          resource: write.route.collection.name,
          id: write.id,
          type: write.type,
          attempts: write.attempts,
          ...(Object.keys(write.context).length
            ? { context: { ...write.context } }
            : {}),
          ...(write.lastError ? { lastError: write.lastError } : {}),
        }));
    },
    async paginate(path, pagination = {}): Promise<Record<string, unknown>[]> {
      const matched = findRoute(Object.keys(doc.paths), path);
      const template = doc.paths[path] ? path : matched?.template;
      const method = pagination.method ?? 'GET';
      if (
        !template ||
        !doc.paths[template]?.[method === 'GET' ? 'get' : 'post']
      ) {
        throw new Error(`No ${method} operation found for path "${path}"`);
      }
      return paginateOperation(doc, {
        ...pagination,
        path: template,
        transport: readTransport,
        pathParams: {
          ...options.constants,
          ...(doc.paths[path] ? {} : matched?.params),
          ...pagination.pathParams,
        },
        ...(options.limits ? { limits: options.limits } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
    },
  };
}
