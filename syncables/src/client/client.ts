import { discoverResources } from '../resources/discover.js';
import type { OpenApiDocument, ParameterObject } from '../openapi/types.js';
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
import {
  DEFAULT_OUTBOX_NAMESPACE,
  OUTBOX_RECORD_ID,
  OUTBOX_VERSION,
  OutboxVersionError,
  readOutbox,
  type StoredRebuild,
  type StoredRecordWrites,
  type StoredWrite,
} from './outbox.js';

export interface RetryOptions {
  /** Delay before the first retry of a failed write, in milliseconds. Doubles on each subsequent attempt. Default 200. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff between retries, in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Stop auto-retrying a write after this many attempts. Default is unlimited (keep retrying until it succeeds). */
  maxAttempts?: number;
}

/**
 * What the client does with a write the server answered with a non-2xx
 * status (see `defaultWriteFailureClass` for the defaults):
 * - `retry`: count a failed attempt and send it again after the backoff delay,
 *   or after the response's `Retry-After`. A create's 5xx other than 503 still
 *   becomes `uncertain` without a usable idempotency key.
 * - `permanent`: count a failed attempt and stop: the write becomes `failed`
 *   at once, resolvable with `resolveWrite`.
 * - `auth`: the credentials were refused. No attempt is counted; the write
 *   becomes `blocked` and the client sends no write until `authRenewed()`.
 * - `satisfied`: the write's goal already holds, so it settles as if it had
 *   succeeded. Only a delete can be satisfied; for a create or update it
 *   counts as `permanent`.
 */
export type WriteFailureClass = 'retry' | 'permanent' | 'auth' | 'satisfied';

/** A write the server answered with a non-2xx status, as a classifier sees it. */
export interface WriteFailure {
  type: PendingWriteType;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  status: number;
  /** Response headers, names lower-cased. */
  headers: Record<string, string>;
  /** Response body text. */
  body: string;
  resource: string;
  id: string;
  /**
   * True when this request was sent after the latest `authRenewed()` and no
   * write has had a 2xx response since: the renewed credentials are not yet
   * seen to work.
   */
  afterRenewal: boolean;
}

/**
 * The default classification:
 * - a delete answered 404 or 410: `satisfied` (the record is already gone);
 * - 401: `auth`;
 * - 403: `retry` when the response carries `Retry-After` or
 *   `x-ratelimit-remaining: 0` (a rate limit, as GitHub sends); otherwise
 *   `permanent` when `afterRenewal` (a refusal that renewed credentials did
 *   not fix is a missing permission), and `auth` before that;
 * - 408, 425 and 429: `retry`;
 * - every other 4xx (400, 404 and 410 on a create or update, 405, 409, 413,
 *   415, 422, ...): `permanent`;
 * - anything else (5xx, and 1xx/3xx a transport did not handle): `retry`.
 */
export function defaultWriteFailureClass(
  failure: WriteFailure,
): WriteFailureClass {
  const { status, type, headers } = failure;
  if (type === 'delete' && (status === 404 || status === 410))
    return 'satisfied';
  if (status === 401) return 'auth';
  if (status === 403) {
    if (
      headers['retry-after'] !== undefined ||
      headers['x-ratelimit-remaining'] === '0'
    )
      return 'retry';
    return failure.afterRenewal ? 'permanent' : 'auth';
  }
  if (status === 408 || status === 425 || status === 429) return 'retry';
  if (status >= 400 && status < 500) return 'permanent';
  return 'retry';
}

/** The client stopped sending writes because the server refused its credentials. */
export interface AuthBlock {
  /** The status that blocked the client (401 or 403 by default; 0 when a stored block could not be read). */
  status: number;
  /** The error of the write that met it, with a body excerpt. */
  lastError: string;
  /** The write that met it. */
  resource: string;
  id: string;
  context?: Record<string, string>;
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
  /**
   * Request header that carries an idempotency key on creates. By default the
   * client uses a header parameter named `Idempotency-Key` (any case) that
   * the create operation (or its path item) declares. A string forces that
   * header name for every create; `false` disables idempotency keys. With a
   * key, a create whose outcome is uncertain is retried automatically with the
   * same key; without one it becomes `uncertain` and waits for `resolveWrite`.
   */
  idempotencyKeyHeader?: string | false;
  /**
   * Called when a refresh shows that a field with a pending local update
   * also changed remotely. The pending local value stays visible and is the
   * one the queued write sends; the conflict is also listed on
   * `pendingWrites()` until that write settles or is discarded.
   */
  onConflict?: (conflict: WriteConflict) => void;
  /**
   * Storage namespace (the `resource` argument of the `StorageAdapter`) of the
   * durable outbox: one record, id `outbox`, holding every unsettled write so
   * that a client built later on the same storage resumes them. Default
   * `syncables:outbox` when `storage` is given; without `storage` (the
   * default in-memory adapter) there is nothing to resume, so the default is
   * `false`, which keeps writes in memory only, as before the outbox existed.
   */
  outboxNamespace?: string | false;
  /**
   * Classifies a write the server answered with a non-2xx status; see
   * `WriteFailureClass`. Defaults to `defaultWriteFailureClass`, which a
   * classifier can call for the cases it does not decide itself. A classifier
   * that throws or returns another value falls back to the default.
   */
  classifyWriteFailure?: (failure: WriteFailure) => WriteFailureClass;
  /**
   * Called when a write meets an `auth` failure and the client stops sending
   * writes, and when a client restores an outbox that was blocked. Renew the
   * credentials (in the `authenticate` adapter or the transport), then call
   * `authRenewed()`.
   */
  onAuthBlocked?: (block: AuthBlock) => void;
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

/**
 * - `pending`: queued, in flight, or waiting for an automatic retry.
 * - `uncertain`: a create may or may not have been applied by the server (the
 *   response was lost, unusable, or a 5xx other than 503) and no idempotency
 *   key makes a resend safe. It is not retried automatically; later writes to
 *   the same record wait behind it until `resolveWrite` is called.
 * - `failed`: the server refused it (a `permanent` failure, see
 *   `WriteFailureClass`) or automatic retries stopped at `retry.maxAttempts`.
 *   A failed create holds back later writes to the record, like an uncertain
 *   one. A
 *   failed update or delete does not: later writes go ahead, and once one of
 *   them settles it replaces the fields it set in the failed update (a failed
 *   delete, or an update with no fields left, is dropped). Otherwise a failed
 *   write stays, and stays visible locally, until `resolveWrite`.
 * - `blocked`: the server refused the client's credentials for this write (an
 *   `auth` failure). The client sends no write, of any record, until
 *   `authRenewed()`; then it is sent again, in its place in the queue.
 */
export type PendingWriteState = 'pending' | 'uncertain' | 'failed' | 'blocked';

/** A field that changed remotely while a local update to it was pending. */
export interface WriteConflict {
  resource: string;
  id: string;
  context?: Record<string, string>;
  field: string;
  /** The confirmed remote value when the local update was made (or last compared). */
  base: unknown;
  /** The value the latest refresh returned. */
  remote: unknown;
  /** The pending local value, which stays visible. */
  local: unknown;
}

/**
 * How to settle an `uncertain` or `failed` write, or a restored update that is
 * waiting for a refresh (`awaitingRefresh`; `retry` sends it now, `discard`
 * drops it and leaves the writes queued behind it):
 * - `retry`: send it again (an uncertain create may then duplicate the record
 *   on a provider without idempotency support; that is the caller's decision).
 *   Failed updates and deletes are queued again behind any newer writes for
 *   the record, minus the fields those newer writes set; a failed delete is
 *   not retried while newer writes are queued. When nothing is left, `retry`
 *   throws and changes nothing. Retrying a failed create resends it: without a
 *   key only unambiguous failures lead to `failed`, and with a key the same
 *   key is sent again.
 * - `discard`: drop it locally (all failed updates and deletes of the record);
 *   the visible record falls back to confirmed remote state plus newer pending
 *   writes. Discarding an uncertain or failed create also drops the writes
 *   queued behind it for that record.
 * - `confirm` (uncertain creates only): the create did reach the server as
 *   record `id`, for instance as found by a refresh. The local record and any
 *   queued follow-up writes move to that id; nothing is resent.
 */
export type WriteResolution =
  | { action: 'retry' }
  | { action: 'discard' }
  | { action: 'confirm'; id: string };

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
   * growing and the write stops auto-retrying: it stays listed here with
   * `state: 'failed'` and `lastError` set (see `PendingWriteState`).
   */
  attempts: number;
  /** The most recent failure, if at least one attempt has failed. */
  lastError?: string;
  /** The HTTP status behind `lastError`, when `lastError` describes a response. */
  lastStatus?: number;
  state: PendingWriteState;
  /**
   * Set on a `pending` update restored from the durable outbox: it is not sent
   * until a `sync()` has read its record's collection completely, so the
   * record it sends is built on current remote state and checked for
   * conflicts first. Never set on other states: after three syncs that did not
   * release it, the update becomes `failed` without this flag.
   */
  awaitingRefresh?: true;
  /** For updates: fields that also changed remotely since the edit was made. */
  conflicts?: WriteConflict[];
}

export interface ApiClient {
  resources: string[];
  /**
   * Resolves once the writes an earlier client left in the durable outbox
   * (see `ApiClientOptions.outboxNamespace`) are restored, and their visible
   * records rebuilt. Every other async method waits for it; call it before
   * reading `pendingWrites()` after a restart. Rejects (as do those methods)
   * when the stored outbox has a version this client cannot read.
   */
  ready(): Promise<void>;
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
   * network. Once it resolves, the write is in the durable outbox (unless
   * `outboxNamespace` is `false`); if it rejects, or the process stops
   * before it resolves, check `pendingWrites()` after `ready()`: the write
   * may have been recorded anyway. The write to the server happens in the
   * background and is retried on failure — see `pendingWrites()` for its
   * outcome so far. If
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
   * Includes writes restored from the durable outbox once `ready()` resolves.
   */
  pendingWrites(resource?: string): PendingWriteInfo[];
  /**
   * Settles the `uncertain` or `failed` write for record `id`, or its restored
   * updates waiting for a refresh (see `WriteResolution`). Throws if that
   * record has none of these; any other `pending` write cannot be resolved
   * this way.
   */
  resolveWrite(
    resource: string,
    id: string,
    resolution: WriteResolution,
    context?: Record<string, string>,
  ): Promise<void>;
  /**
   * Set while the client sends no writes because the server refused its
   * credentials (see `ApiClientOptions.onAuthBlocked`); otherwise undefined.
   * Reads (`sync()`) are not affected.
   */
  authBlocked(): AuthBlock | undefined;
  /**
   * Tells the client that its credentials were renewed: `blocked` writes
   * become `pending` and every queue resumes in order. Does nothing when the
   * client is not blocked. The next 403 without rate-limit headers then
   * fails its write instead of blocking again, until a write succeeds (see
   * `defaultWriteFailureClass`).
   */
  authRenewed(): Promise<void>;
  /**
   * Fetches every item from a GET or POST list operation at `path`, walking every
   * page per its resolved pagination scheme (explicit `x-pagination` or
   * auto-detected from `components.paginationSchemes`). `path` need not be
   * a discovered resource — any GET or POST operation in the document works,
   * e.g. a search/listing endpoint with no paired item route. Defaults to GET.
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
  idempotencyHeader?: string;
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
  lastStatus?: number;
  state: PendingWriteState;
  /** Confirmed remote values of the changed fields, for conflict detection. */
  base?: Record<string, unknown>;
  conflicts?: Map<string, WriteConflict>;
  idempotencyKey?: string;
  /** Set by `resolveWrite` confirm: settle without sending. */
  confirmedId?: string;
  /** The request may be in flight; stored so a restart can tell. */
  sending?: boolean;
  /** False until the outbox holding this write is stored; not sent before. */
  durable?: boolean;
  /** A restored update: not sent before a refresh of its collection. */
  awaitingRefresh?: boolean;
  /** Syncs that ran without releasing an `awaitingRefresh` write. */
  refreshMisses?: number;
  /** The last confirmed record, kept when a refresh no longer had it. */
  lastKnown?: Record<string, unknown>;
  /** Queue order across the client and its restarts (absent in older outboxes). */
  seq?: number;
}

type WriteOutcome =
  | { status: 'succeeded'; resolvedId: string }
  | { status: 'retry'; delayMs: number }
  | { status: 'uncertain' }
  | { status: 'gaveUp' }
  | { status: 'blocked' };

/** The server answered with a non-2xx status. */
class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly headers: Record<string, string>,
    readonly body: string,
  ) {
    super(message);
  }
}

/** At most this many characters of an error response body go into `lastError`. */
const BODY_EXCERPT_LENGTH = 200;

function excerpt(body: string): string {
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > BODY_EXCERPT_LENGTH
    ? `${text.slice(0, BODY_EXCERPT_LENGTH)}…`
    : text;
}

/**
 * The delay a `Retry-After` header asks for (delay-seconds or an HTTP date),
 * in milliseconds; undefined when absent or unparseable.
 */
function retryAfterMs(headers: Record<string, string>): number | undefined {
  const value = headers['retry-after']?.trim();
  if (!value) return undefined;
  // An HTTP date has letters (a day or month name); anything else that is
  // not delay-seconds, such as "1.5", is unusable.
  const ms = /^\d+$/.test(value)
    ? Number(value) * 1000
    : /[a-z]/i.test(value)
      ? Date.parse(value) - Date.now()
      : NaN;
  // Cut to setTimeout's largest delay (about 24.8 days), which would
  // otherwise fire at once.
  return Number.isFinite(ms)
    ? Math.min(Math.max(0, ms), MAX_TIMER_MS)
    : undefined;
}

const MAX_TIMER_MS = 2 ** 31 - 1;

const FAILURE_CLASSES = new Set<WriteFailureClass>([
  'retry',
  'permanent',
  'auth',
  'satisfied',
]);

/** The server answered 2xx, so it applied the write, but the body is unusable. */
class UnusableResponseError extends Error {}

/** The request never reached the transport (for example, `authenticate` threw). */
class NotSentError extends Error {}

/**
 * Whether a failed create may have been applied server-side. No response at
 * all (the transport threw while sending), an unusable 2xx body, and 5xx
 * responses other than 503 count as uncertain: a gateway error or timeout can
 * follow a committed create. 503 and 429 conventionally mean the request was
 * not processed, other 4xx responses mean it was refused, and an error before
 * sending means nothing went out, so those keep the ordinary retry path.
 */
function mayHaveApplied(error: unknown): boolean {
  if (error instanceof NotSentError) return false;
  if (error instanceof HttpStatusError)
    return error.status >= 500 && error.status !== 503;
  return true;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function declaredIdempotencyHeader(
  document: OpenApiDocument,
  path: string,
): string | undefined {
  const item = document.paths[path];
  const parameters = [
    ...((item?.['parameters'] as ParameterObject[] | undefined) ?? []),
    ...(item?.post?.parameters ?? []),
  ];
  return parameters.find(
    (p) => p.in === 'header' && /^idempotency-key$/i.test(p.name),
  )?.name;
}

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
    const header =
      route.createPath && declaredIdempotencyHeader(document, route.createPath);
    if (header) route.idempotencyHeader = header;
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
  const baseTransport =
    options.transport ?? fetchTransport(options.fetch ?? globalThis.fetch);
  const transport = authenticatedTransport(
    baseTransport,
    options.credentials,
    options.authenticate,
  );
  const readTransport = captureReadResponses(transport, options.storeResponse);
  const legacy =
    options.identityField === undefined
      ? {}
      : { identityField: options.identityField };
  const routes = clientRoutes(doc, discoverReadModel(doc, legacy).collections);
  for (const route of routes) {
    if (options.idempotencyKeyHeader === false) delete route.idempotencyHeader;
    else if (options.idempotencyKeyHeader && route.createPath)
      route.idempotencyHeader = options.idempotencyKeyHeader;
  }
  const byResource = new Map(routes.map((r) => [r.collection.name, r]));
  if (byResource.size !== routes.length)
    throw new Error('Collection names must be unique across resources');
  const confirmed = new Map<string, Map<string, Record<string, unknown>>>();
  const lastSyncedItems = new Map<string, Record<string, unknown>[]>();
  const conditionalCache = new Map<string, TransportResponse>();
  const writeQueues = new Map<string, QueuedWrite[]>();
  /** Failed updates and deletes per record, oldest first. Failed creates stay parked in their queue. */
  const gaveUpWrites = new Map<string, QueuedWrite[]>();
  const draining = new Set<string>();
  const revisions = new Map<string, number>();
  /** Like `revisions`, per record: settles during a read, by record key. */
  const recordRevisions = new Map<string, number>();
  let syncing: Promise<SyncResult> | undefined;
  const retry = {
    baseDelayMs: options.retry?.baseDelayMs ?? 200,
    maxDelayMs: options.retry?.maxDelayMs ?? 30000,
    maxAttempts: options.retry?.maxAttempts,
  };
  // The default in-memory adapter dies with this client: nothing to resume.
  const outboxNamespace =
    options.outboxNamespace === undefined
      ? options.storage
        ? DEFAULT_OUTBOX_NAMESPACE
        : false
      : options.outboxNamespace;
  if (outboxNamespace !== false && byResource.has(outboxNamespace))
    throw new Error(
      `Collection "${outboxNamespace}" clashes with the outbox namespace; set outboxNamespace`,
    );
  /** Records whose visible copy must still be rebuilt after an id remap. */
  const pendingRebuilds = new Map<
    string,
    {
      route: ClientRoute;
      scope: string;
      context: Record<string, string>;
      id: string;
    }
  >();
  /** Stored entries this client cannot restore; written back unchanged. */
  let unrestorable: unknown[] = [];
  /** Order in which writes were queued; stored, so it survives a restart. */
  let nextSeq = 0;
  /** Set while no write is sent because the credentials were refused; stored. */
  let authBlock: AuthBlock | undefined;
  /** Renewed and not yet seen to work (`WriteFailure.afterRenewal`). */
  let afterRenewal = false;
  /** Counts `authRenewed()` calls that unblocked the client. */
  let authEpoch = 0;

  /**
   * Records the newest confirmed copy of a record on all its unsettled
   * updates, so the fallback base never reverts a newer confirmed record.
   * All of a record's updates that carry `lastKnown` hold the same copy.
   */
  function setLastKnown(key: string, record: Record<string, unknown>): void {
    for (const write of [
      ...(gaveUpWrites.get(key) ?? []),
      ...(writeQueues.get(key) ?? []),
    ])
      if (write.type === 'update') write.lastKnown = record;
  }

  /**
   * The last confirmed record any write of this record kept when a refresh
   * no longer had it: the base for updates once `confirmed` lacks the record.
   */
  function lastKnownFor(
    scope: string,
    id: string,
  ): Record<string, unknown> | undefined {
    const key = keyFor(scope, id);
    return [
      ...(gaveUpWrites.get(key) ?? []),
      ...(writeQueues.get(key) ?? []),
    ].find((w) => w.lastKnown)?.lastKnown;
  }
  let outboxChain: Promise<void> = Promise.resolve();

  function storeWrite(write: QueuedWrite): StoredWrite {
    return {
      type: write.type,
      ...(write.data ? { data: write.data } : {}),
      ...(write.changes ? { changes: write.changes } : {}),
      attempts: write.attempts,
      ...(write.lastError ? { lastError: write.lastError } : {}),
      ...(write.lastStatus !== undefined
        ? { lastStatus: write.lastStatus }
        : {}),
      state: write.state,
      ...(write.base ? { base: write.base } : {}),
      ...(write.conflicts?.size
        ? { conflicts: [...write.conflicts.values()] }
        : {}),
      ...(write.idempotencyKey ? { idempotencyKey: write.idempotencyKey } : {}),
      ...(write.confirmedId !== undefined
        ? { confirmedId: write.confirmedId }
        : {}),
      ...(write.sending ? { sending: true as const } : {}),
      ...(write.refreshMisses ? { refreshMisses: write.refreshMisses } : {}),
      ...(write.seq !== undefined ? { seq: write.seq } : {}),
    };
  }

  /**
   * The whole outbox, as JSON, taken synchronously from the in-memory state.
   * Writes whose own first store has not succeeded are left out, apart from
   * `including` (the write this store is for): a rejected `create` must not
   * reach storage through another call's store.
   */
  function outboxSnapshot(including?: QueuedWrite): Record<string, unknown> {
    const stored = (write: QueuedWrite): boolean =>
      write.durable !== false || write === including;
    const records: StoredRecordWrites[] = [];
    for (const key of new Set([
      ...gaveUpWrites.keys(),
      ...writeQueues.keys(),
    ])) {
      const failed = (gaveUpWrites.get(key) ?? []).filter(stored);
      const queue = (writeQueues.get(key) ?? []).filter(stored);
      const first = failed[0] ?? queue[0];
      if (!first) continue;
      const confirmedRecord = confirmed.get(first.scope)?.get(first.id);
      // One copy per record, and none when `confirmed` already holds it:
      // per write, it would grow the outbox by a record per update.
      const lastKnown = confirmedRecord
        ? undefined
        : lastKnownFor(first.scope, first.id);
      records.push({
        resource: first.route.collection.name,
        context: first.context,
        id: first.id,
        ...(confirmedRecord ? { confirmed: confirmedRecord } : {}),
        ...(lastKnown ? { lastKnown } : {}),
        failed: failed.map(storeWrite),
        queue: queue.map(storeWrite),
      });
    }
    const rebuild: StoredRebuild[] = [...pendingRebuilds.values()].map(
      ({ route, scope, context, id }) => {
        const confirmedRecord = confirmed.get(scope)?.get(id);
        return {
          resource: route.collection.name,
          context,
          id,
          ...(confirmedRecord ? { confirmed: confirmedRecord } : {}),
        };
      },
    );
    return JSON.parse(
      JSON.stringify({
        version: OUTBOX_VERSION,
        records,
        rebuild,
        unrestorable,
        ...(authBlock ? { authBlock } : {}),
      }),
    ) as Record<string, unknown>;
  }

  /**
   * Stores the outbox. Calls run one after another; each stores the state
   * as it is when its turn comes, so the last call stores the newest state.
   * `write`, if given, is a newly queued write: it is included in this store
   * and marked durable as soon as the store succeeds, before the next call
   * takes its snapshot. `rollback` runs, also before that, if the store fails.
   */
  function persist(rollback?: () => void, write?: QueuedWrite): Promise<void> {
    if (outboxNamespace === false) {
      if (write) write.durable = true;
      return Promise.resolve();
    }
    const link = outboxChain.then(async () => {
      try {
        await storage.put(
          outboxNamespace,
          OUTBOX_RECORD_ID,
          outboxSnapshot(write),
        );
      } catch (error) {
        rollback?.();
        throw error;
      }
      if (write) write.durable = true;
    });
    outboxChain = link.catch(() => undefined);
    return link;
  }

  /**
   * For state changes that already happened in memory: a failed store leaves
   * the stored outbox behind until the next successful one, which stores the
   * whole state again. A restart in between sees the older state, at worst a
   * write marked in flight, which it treats as uncertain or resends.
   */
  function persistLater(): Promise<void> {
    return persist().catch(() => undefined);
  }

  /** Whether resending this create is safe: a key, and a header to send it in. */
  function usableKey(write: QueuedWrite): boolean {
    return Boolean(write.idempotencyKey && write.route.idempotencyHeader);
  }

  function restoreWrite(
    route: ClientRoute,
    scope: string,
    context: Record<string, string>,
    id: string,
    stored: StoredWrite,
  ): QueuedWrite {
    const write: QueuedWrite = {
      route,
      scope,
      context,
      id,
      type: stored.type,
      attempts: stored.attempts,
      state: stored.state,
      durable: true,
      ...(stored.data ? { data: stored.data } : {}),
      ...(stored.changes ? { changes: stored.changes } : {}),
      ...(stored.lastError ? { lastError: stored.lastError } : {}),
      ...(stored.lastStatus !== undefined
        ? { lastStatus: stored.lastStatus }
        : {}),
      ...(stored.base ? { base: stored.base } : {}),
      ...(stored.conflicts?.length
        ? {
            conflicts: new Map(
              stored.conflicts.map((c) => [c.field, c] as const),
            ),
          }
        : {}),
      ...(stored.idempotencyKey
        ? { idempotencyKey: stored.idempotencyKey }
        : {}),
      ...(stored.confirmedId !== undefined
        ? { confirmedId: stored.confirmedId }
        : {}),
      ...(stored.refreshMisses ? { refreshMisses: stored.refreshMisses } : {}),
      ...(stored.seq !== undefined ? { seq: stored.seq } : {}),
    };
    if (stored.seq !== undefined && stored.seq >= nextSeq)
      nextSeq = stored.seq + 1;
    if (stored.sending) {
      // The process stopped between storing "about to send" and storing the
      // outcome: the request may or may not have reached the server.
      write.attempts += 1;
      write.lastError =
        'The process stopped while this write may have been in flight';
      delete write.lastStatus;
      if (write.type === 'create' && !usableKey(write))
        write.state = 'uncertain';
      else if (
        retry.maxAttempts !== undefined &&
        write.attempts >= retry.maxAttempts
      )
        write.state = 'failed';
    }
    return write;
  }

  async function restore(): Promise<void> {
    if (outboxNamespace === false) return;
    const outbox = readOutbox(
      await storage.get(outboxNamespace, OUTBOX_RECORD_ID),
    );
    // A retried restore starts again from what is stored.
    writeQueues.clear();
    gaveUpWrites.clear();
    confirmed.clear();
    unrestorable = outbox.unrestorable;
    authBlock = outbox.authBlock;
    const touchedKeys = new Map<string, { scope: string; id: string }>();
    for (const entry of outbox.rebuild) {
      const route = byResource.get(entry.resource);
      if (!route) {
        unrestorable.push(entry);
        continue;
      }
      const scope = scopeFor(route, entry.context);
      if (entry.confirmed) remote(scope).set(entry.id, entry.confirmed);
      else remote(scope).delete(entry.id);
      touchedKeys.set(keyFor(scope, entry.id), { scope, id: entry.id });
    }
    let changed = outbox.rebuild.length > 0;
    for (const entry of outbox.records) {
      const route = byResource.get(entry.resource);
      if (!route) {
        unrestorable.push(entry);
        continue;
      }
      const scope = scopeFor(route, entry.context);
      const key = keyFor(scope, entry.id);
      if (entry.confirmed) remote(scope).set(entry.id, entry.confirmed);
      const restored = (stored: StoredWrite): QueuedWrite => {
        if (stored.sending) changed = true;
        return restoreWrite(route, scope, entry.context, entry.id, stored);
      };
      const failed = entry.failed.map(restored);
      const queue = entry.queue.map(restored);
      // Blocked writes wait for authRenewed() only while the client is blocked.
      for (const write of queue)
        if (write.state === 'blocked' && !authBlock) write.state = 'pending';
      // An update or delete that reached retry.maxAttempts while in flight
      // joins the failed writes, as it would have without the stop.
      const head = queue[0];
      if (head && head.state === 'failed' && head.type !== 'create')
        failed.push(queue.shift() as QueuedWrite);
      // Updates send the whole record, so they wait for a refresh of their
      // collection instead of replaying on a confirmed record from before
      // the stop. Behind a create, the create's response is fresh enough.
      let afterCreate = false;
      for (const write of queue) {
        if (write.type === 'create') afterCreate = true;
        if (write.type === 'update' && !afterCreate)
          write.awaitingRefresh = true;
      }
      if (failed.length) gaveUpWrites.set(key, failed);
      if (queue.length) writeQueues.set(key, queue);
      // Stored once per record entry.
      const known = entry.lastKnown ?? entry.confirmed;
      if (known) setLastKnown(key, known);
      touchedKeys.set(key, { scope, id: entry.id });
    }
    // The outbox is stored before the visible record, so a stop in between
    // leaves the visible record behind; rebuild every record it names.
    for (const { scope, id } of touchedKeys.values()) await rebuild(scope, id);
    if (changed) await persistLater();
    if (authBlock) notifyAuthBlocked();
    for (const key of writeQueues.keys())
      if (!draining.has(key)) void drainQueue(key);
  }

  function publicAuthBlock(block: AuthBlock): AuthBlock {
    return {
      ...block,
      ...(block.context ? { context: { ...block.context } } : {}),
    };
  }

  function notifyAuthBlocked(): void {
    if (!authBlock) return;
    try {
      options.onAuthBlocked?.(publicAuthBlock(authBlock));
    } catch {
      // A failing callback does not stop the client.
    }
  }

  /**
   * The restore, started at construction. A failure other than a version
   * refusal is not kept: the next call (or `ready()`) tries again.
   */
  let restoring: Promise<void> | undefined;
  function whenRestored(): Promise<void> {
    if (!restoring) {
      const attempt = restore();
      restoring = attempt;
      attempt.catch((error: unknown) => {
        if (!(error instanceof OutboxVersionError) && restoring === attempt)
          restoring = undefined;
      });
    }
    return restoring;
  }
  // Callers observe a failure through ready() and the methods that await it.
  whenRestored().catch(() => undefined);

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
    const pending = [
      ...(gaveUpWrites.get(key) ?? []),
      ...(writeQueues.get(key) ?? []),
    ];
    for (const write of pending) {
      // Not visible before its own first store succeeded (it may never).
      if (write.durable === false) continue;
      if (write.type === 'create') value = write.data;
      else if (write.type === 'update')
        value = {
          ...(value ?? write.lastKnown ?? lastKnownFor(scope, id)),
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
    // Tells an error raised before the request left (an authenticate adapter
    // failing, say) apart from one raised while it was being sent.
    let sent = false;
    const send = authenticatedTransport(
      (r) => {
        sent = true;
        return baseTransport(r);
      },
      options.credentials,
      options.authenticate,
    );
    let response: TransportResponse;
    try {
      response = await send(request);
    } catch (error) {
      if (sent) throw error;
      throw new NotSentError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const body = excerpt(response.body ?? '');
      throw new HttpStatusError(
        `Request to ${request.url.pathname} failed with status ${response.status}${body ? `: ${body}` : ''}`,
        response.status,
        Object.fromEntries(
          Object.entries(response.headers ?? {}).map(([k, v]) => [
            k.toLowerCase(),
            v,
          ]),
        ),
        response.body ?? '',
      );
    }
    // The credentials work (for this request, at least).
    afterRenewal = false;
    try {
      return response.body ? JSON.parse(response.body) : undefined;
    } catch {
      throw new UnusableResponseError(
        `Response from ${request.url.pathname} is not JSON`,
      );
    }
  }

  function settled(write: QueuedWrite, resolvedId: string): WriteOutcome {
    revisions.set(write.scope, (revisions.get(write.scope) ?? 0) + 1);
    for (const id of new Set([write.id, resolvedId])) {
      const key = keyFor(write.scope, id);
      recordRevisions.set(key, (recordRevisions.get(key) ?? 0) + 1);
    }
    conditionalCache.clear();
    // Confirmed state moved on without a read: the next snapshot must be
    // compared (and checked for conflicts) even if it equals the last one.
    lastSyncedItems.delete(write.scope);
    return { status: 'succeeded', resolvedId };
  }

  async function attemptWrite(write: QueuedWrite): Promise<WriteOutcome> {
    const route = write.route;
    const idField = route.collection.idField;
    if (write.confirmedId !== undefined) {
      const resolvedId = write.confirmedId;
      const records = remote(write.scope);
      if (!records.has(resolvedId))
        records.set(resolvedId, { ...write.data, [idField]: resolvedId });
      if (resolvedId !== write.id) records.delete(write.id);
      return settled(write, resolvedId);
    }
    const epoch = authEpoch;
    try {
      let resolvedId = write.id;
      // Stored before sending, so a restart knows the request may have left.
      write.sending = true;
      try {
        await persist(() => {
          write.sending = false;
        });
      } catch (error) {
        throw new NotSentError(
          `Outbox not stored, so nothing was sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
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
                ...(remote(write.scope).get(write.id) ??
                  write.lastKnown ??
                  lastKnownFor(write.scope, write.id)),
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
          headers: {
            'content-type': 'application/json',
            ...(write.idempotencyKey && route.idempotencyHeader
              ? { [route.idempotencyHeader]: write.idempotencyKey }
              : {}),
          },
          body: JSON.stringify(data),
        });
        if (write.type === 'create' && !isRecord(result)) {
          throw new UnusableResponseError('Create response has no record');
        }
        // An update's response may hold only some fields: merge it over the
        // record that was sent (the edit included), not over the copy from
        // before the edit, which would revert it.
        const record = isRecord(result)
          ? write.type === 'update'
            ? { ...data, ...result }
            : result
          : data;
        if (!record) throw new Error('Write returned no record');
        if (write.type === 'create') {
          const id = record[idField];
          if (id === undefined || id === null || id === '')
            throw new UnusableResponseError(
              'Create response has no record identity',
            );
          resolvedId = String(id);
          if (resolvedId !== write.id) remote(write.scope).delete(write.id);
        }
        remote(write.scope).set(resolvedId, record);
        setLastKnown(keyFor(write.scope, resolvedId), record);
      }
      return settled(write, resolvedId);
    } catch (error) {
      const failureClass =
        error instanceof HttpStatusError
          ? // Only a request sent after the latest renewal tests it.
            classify(write, error, afterRenewal && epoch === authEpoch)
          : 'retry';
      if (failureClass === 'satisfied') {
        // A delete of a record that is already gone.
        remote(write.scope).delete(write.id);
        return settled(write, write.id);
      }
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof HttpStatusError ? error.status : undefined;
      if (failureClass === 'auth') {
        // Sent with credentials from before the latest renewal: send it
        // again with the new ones instead of blocking again.
        if (epoch !== authEpoch) return { status: 'retry', delayMs: 0 };
        write.lastError = message;
        if (status !== undefined) write.lastStatus = status;
        return { status: 'blocked' };
      }
      write.attempts += 1;
      write.lastError = message;
      if (status === undefined) delete write.lastStatus;
      else write.lastStatus = status;
      if (failureClass === 'permanent') return { status: 'gaveUp' };
      // An idempotency key makes a resend safe, except after a 2xx: the
      // create happened, and a replay would return the same unusable body.
      if (
        write.type === 'create' &&
        mayHaveApplied(error) &&
        (!usableKey(write) || error instanceof UnusableResponseError)
      )
        return { status: 'uncertain' };
      if (
        retry.maxAttempts !== undefined &&
        write.attempts >= retry.maxAttempts
      )
        return { status: 'gaveUp' };
      const asked =
        error instanceof HttpStatusError
          ? retryAfterMs(error.headers)
          : undefined;
      return {
        status: 'retry',
        delayMs:
          asked ??
          Math.min(
            retry.baseDelayMs * 2 ** (write.attempts - 1),
            retry.maxDelayMs,
          ),
      };
    }
  }

  function classify(
    write: QueuedWrite,
    error: HttpStatusError,
    sentAfterRenewal: boolean,
  ): WriteFailureClass {
    const failure: WriteFailure = {
      type: write.type,
      method:
        write.type === 'create'
          ? 'POST'
          : write.type === 'delete'
            ? 'DELETE'
            : (write.route.updateMethod as 'PUT' | 'PATCH'),
      status: error.status,
      headers: { ...error.headers },
      body: error.body,
      resource: write.route.collection.name,
      id: write.id,
      afterRenewal: sentAfterRenewal,
    };
    let result: WriteFailureClass = defaultWriteFailureClass(failure);
    if (options.classifyWriteFailure) {
      try {
        const custom = options.classifyWriteFailure(failure);
        if (FAILURE_CLASSES.has(custom)) result = custom;
      } catch {
        // Falls back to the default classification.
      }
    }
    if (result === 'satisfied' && write.type !== 'delete') return 'permanent';
    return result;
  }

  async function drainQueue(initialKey: string): Promise<void> {
    let key = initialKey;
    let ownsQueue = true;
    draining.add(key);
    try {
      for (;;) {
        const queue = writeQueues.get(key);
        const write = queue?.[0];
        // An uncertain or failed create blocks its record until resolveWrite;
        // a write is not sent before the outbox holding it is stored, nor
        // while the credentials are refused (authRenewed restarts the queues).
        if (
          !write ||
          write.state !== 'pending' ||
          write.durable === false ||
          write.awaitingRefresh ||
          authBlock
        )
          return;
        const outcome = await attemptWrite(write);
        write.sending = false;
        if (outcome.status === 'blocked') {
          write.state = 'blocked';
          const first = !authBlock;
          if (first) {
            authBlock = {
              status: write.lastStatus ?? 0,
              lastError: write.lastError ?? '',
              resource: write.route.collection.name,
              id: write.id,
              ...(Object.keys(write.context).length
                ? { context: { ...write.context } }
                : {}),
            };
            afterRenewal = false;
          }
          await persistLater();
          if (first) notifyAuthBlocked();
          return;
        }
        if (outcome.status === 'uncertain') {
          write.state = 'uncertain';
          await persistLater();
          return;
        }
        if (outcome.status === 'gaveUp' && write.type === 'create') {
          write.state = 'failed';
          await persistLater();
          return;
        }
        if (outcome.status === 'retry') {
          await persistLater();
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, outcome.delayMs);
            if (typeof timer.unref === 'function') timer.unref();
          });
          continue;
        }
        queue.shift();
        if (outcome.status === 'gaveUp') {
          write.state = 'failed';
          gaveUpWrites.set(key, [...(gaveUpWrites.get(key) ?? []), write]);
        } else {
          supersede(key, write);
          rebase(queue, write, outcome.resolvedId);
        }
        if (outcome.status === 'succeeded' && outcome.resolvedId !== write.id) {
          const oldId = write.id;
          const oldKey = key;
          // Moved in place, not copied: a create() still storing the outbox
          // for one of these writes finds it by identity.
          const rest = queue.splice(0);
          for (const pending of rest) pending.id = outcome.resolvedId;
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
          const moved = {
            route: write.route,
            scope: write.scope,
            context: write.context,
          };
          pendingRebuilds.set(oldKey, { ...moved, id: oldId });
          pendingRebuilds.set(key, { ...moved, id: outcome.resolvedId });
          // Settled, moved and still to be made visible: one stored step.
          await persistLater();
          await rebuild(write.scope, oldId);
          await rebuild(write.scope, outcome.resolvedId);
          pendingRebuilds.delete(oldKey);
          pendingRebuilds.delete(key);
          await persistLater();
          if (!ownsQueue) return;
        } else {
          if (!queue.length) writeQueues.delete(key);
          await persistLater();
          await rebuild(write.scope, write.id);
        }
      }
    } finally {
      if (ownsQueue) draining.delete(key);
    }
  }

  /** Fields a write sets; `undefined` means the whole record (create, delete). */
  function touched(write: QueuedWrite): string[] | undefined {
    return write.type === 'update'
      ? Object.keys(write.changes ?? {})
      : undefined;
  }

  /**
   * A write that settled after a failed one replaces what it sets: the failed
   * writes lose those fields, and are dropped when nothing is left (always,
   * for a failed delete, or after a settled create or delete).
   */
  function supersede(key: string, settled: QueuedWrite): void {
    const failed = gaveUpWrites.get(key);
    if (!failed) return;
    const fields = touched(settled);
    const left = failed.filter((write) => {
      if (write.type !== 'update' || !fields) return false;
      const changes = { ...write.changes };
      for (const field of fields) delete changes[field];
      write.changes = changes;
      return Object.keys(changes).length > 0;
    });
    if (left.length) gaveUpWrites.set(key, left);
    else gaveUpWrites.delete(key);
  }

  /**
   * After a write settles, later queued updates compare against the newly
   * confirmed values of the fields it set, so a refresh that returns our own
   * write is not reported as a remote change.
   */
  function rebase(
    queue: QueuedWrite[],
    settled: QueuedWrite,
    resolvedId: string,
  ): void {
    const record = remote(settled.scope).get(resolvedId);
    if (!record) return;
    const fields = touched(settled);
    for (const later of queue) {
      if (later.type !== 'update') continue;
      const changed = Object.keys(later.changes ?? {});
      if (!later.base) {
        later.base = Object.fromEntries(changed.map((f) => [f, record[f]]));
        continue;
      }
      for (const field of changed)
        if (!fields || fields.includes(field))
          later.base[field] = record[field];
    }
  }

  /**
   * Queues a write, stores the outbox holding it, and only then updates the
   * visible record and lets the write be sent. If storing fails, the write is
   * taken out again (before any later store) and the error is thrown.
   */
  async function enqueue(
    write: Omit<QueuedWrite, 'attempts' | 'state'>,
  ): Promise<void> {
    const queued: QueuedWrite = {
      ...write,
      attempts: 0,
      state: 'pending',
      durable: false,
      seq: nextSeq++,
    };
    const key = keyFor(write.scope, write.id);
    const queue = writeQueues.get(key) ?? [];
    queue.push(queued);
    writeQueues.set(key, queue);
    await persist(() => {
      for (const [k, q] of writeQueues) {
        const at = q.indexOf(queued);
        if (at < 0) continue;
        q.splice(at, 1);
        if (!q.length) writeQueues.delete(k);
      }
    }, queued);
    try {
      await rebuild(queued.scope, queued.id);
    } finally {
      // A create that settled meanwhile may have moved this write to its id.
      const current = keyFor(queued.scope, queued.id);
      if (!draining.has(current)) void drainQueue(current);
    }
  }

  function detectConflicts(
    scope: string,
    records: Map<string, Record<string, unknown>>,
  ): void {
    const keys = new Set([...gaveUpWrites.keys(), ...writeQueues.keys()]);
    for (const key of keys) {
      // Oldest first: failed writes, then the queue in sending order.
      const writes = [
        ...(gaveUpWrites.get(key) ?? []),
        ...(writeQueues.get(key) ?? []),
      ];
      // Values this client already sent or queued, per field, so a refresh
      // showing an earlier write applied (before its response arrived) is
      // not mistaken for a remote change.
      const ours = new Map<string, unknown[]>();
      for (const write of writes) {
        if (write.scope !== scope || write.type !== 'update') continue;
        checkConflicts(write, records.get(write.id), ours);
        for (const [field, value] of Object.entries(write.changes ?? {}))
          ours.set(field, [...(ours.get(field) ?? []), value]);
      }
    }
  }

  function checkConflicts(
    write: QueuedWrite,
    next: Record<string, unknown> | undefined,
    ours: Map<string, unknown[]>,
  ): void {
    // A remote deletion under a pending update is not reported here.
    if (!write.base || !next) return;
    for (const [field, local] of Object.entries(write.changes ?? {})) {
      const base = write.base[field];
      const value = next[field];
      if (sameValue(value, base)) continue;
      write.base[field] = value;
      write.conflicts ??= new Map();
      if (
        sameValue(value, local) ||
        ours.get(field)?.some((own) => sameValue(own, value))
      ) {
        write.conflicts.delete(field);
        continue;
      }
      const conflict: WriteConflict = {
        resource: write.route.collection.name,
        id: write.id,
        ...(Object.keys(write.context).length
          ? { context: { ...write.context } }
          : {}),
        field,
        base,
        remote: value,
        local,
      };
      write.conflicts.set(field, conflict);
      options.onConflict?.(conflict);
    }
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

  /** Every unsettled write, failed ones first, then queues in order. */
  function allWrites(): QueuedWrite[] {
    return [...gaveUpWrites.values(), ...writeQueues.values()].flat();
  }

  /**
   * Turns a queued update into a failed one, kept with the record's failed
   * writes; writes queued behind it go ahead, as after any failed update.
   */
  function failWrite(
    write: QueuedWrite,
    message: string,
    lastKnown?: Record<string, unknown>,
  ): void {
    const key = keyFor(write.scope, write.id);
    const queue = writeQueues.get(key);
    const at = queue?.indexOf(write) ?? -1;
    if (queue && at >= 0) {
      queue.splice(at, 1);
      if (!queue.length) writeQueues.delete(key);
    }
    write.state = 'failed';
    write.lastError = message;
    delete write.lastStatus;
    delete write.awaitingRefresh;
    delete write.refreshMisses;
    if (lastKnown) write.lastKnown = lastKnown;
    gaveUpWrites.set(key, [...(gaveUpWrites.get(key) ?? []), write]);
    if (lastKnown) setLastKnown(key, lastKnown);
  }

  function missingMessage(write: QueuedWrite): string {
    return `Record ${write.id} is not in the refreshed collection ${write.route.collection.name} (filtered or deleted remotely); not sent, to avoid a partial update`;
  }

  /**
   * Releases the restored updates of `scope` whose records this complete
   * read saw fresh (`isFresh`: no write to the record settled during it).
   * With `apply`, the read was not applied to the whole collection, so the
   * fresh records are taken over (and checked for conflicts) here.
   * `previous` holds the confirmed records from before the read.
   *
   * A released PUT update whose record the read did not return would send
   * only its own fields as the whole record. When it is the first unsettled
   * write of its record, it fails instead and keeps the last confirmed
   * record for a retry. Otherwise it goes out as before.
   */
  async function releaseRefreshed(
    scope: string,
    records: Map<string, Record<string, unknown>>,
    previous: Map<string, Record<string, unknown>>,
    isFresh: (id: string) => boolean,
    apply: boolean,
    released: Set<QueuedWrite>,
  ): Promise<void> {
    const fresh = new Map<string, Record<string, unknown>>();
    const touchedIds = new Set<string>();
    for (const write of allWrites()) {
      if (write.scope !== scope || !write.awaitingRefresh) continue;
      if (!isFresh(write.id)) continue;
      released.add(write);
      touchedIds.add(write.id);
      const record = records.get(write.id);
      const key = keyFor(scope, write.id);
      if (
        !record &&
        write.route.updateMethod === 'PUT' &&
        writeQueues.get(key)?.[0] === write
      ) {
        failWrite(write, missingMessage(write), previous.get(write.id));
        continue;
      }
      if (apply && record) fresh.set(write.id, record);
      delete write.awaitingRefresh;
      delete write.refreshMisses;
    }
    if (!touchedIds.size) return;
    if (fresh.size) {
      for (const [id, record] of fresh) {
        remote(scope).set(id, record);
        setLastKnown(keyFor(scope, id), record);
      }
      detectConflicts(scope, fresh);
    }
    await persistLater();
    for (const id of touchedIds) await rebuild(scope, id);
    for (const [key, queue] of writeQueues)
      if (queue[0]?.scope === scope && !draining.has(key)) void drainQueue(key);
  }

  /**
   * A restored update that `limit` syncs in a row did not release (its
   * collection never read completely, or a write to it kept settling)
   * fails, so it is listed and can be retried or discarded.
   */
  const REFRESH_MISS_LIMIT = 3;
  async function countRefreshMisses(released: Set<QueuedWrite>): Promise<void> {
    // While blocked, no write could be sent anyway (and reads likely fail
    // for the same reason): waiting does not count.
    if (authBlock) return;
    let changed = false;
    for (const write of allWrites()) {
      if (!write.awaitingRefresh || released.has(write)) continue;
      // Only the head: failing a write behind unsettled ones would make a
      // failed write newer than queued ones, which a settle then drops.
      if (writeQueues.get(keyFor(write.scope, write.id))?.[0] !== write)
        continue;
      write.refreshMisses = (write.refreshMisses ?? 0) + 1;
      changed = true;
      if (write.refreshMisses < REFRESH_MISS_LIMIT) continue;
      failWrite(
        write,
        `Waiting for a complete refresh of ${write.route.collection.name}: ${REFRESH_MISS_LIMIT} syncs did not read this record completely`,
      );
    }
    if (!changed) return;
    await persistLater();
    for (const [key, queue] of writeQueues)
      if (queue.length && !draining.has(key)) void drainQueue(key);
  }

  async function performSync(): Promise<SyncResult> {
    await whenRestored();
    const started = new Map(revisions);
    const startedRecords = new Map(recordRevisions);
    const released = new Set<QueuedWrite>();
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
      const persisted = differs ? await storage.list(scope) : [];
      const records = new Map(
        snapshot.items.map((item) => [
          String(item[route.collection.idField]),
          item,
        ]),
      );
      // A write acknowledged after this read began is newer than this snapshot.
      if ((started.get(scope) ?? 0) !== (revisions.get(scope) ?? 0)) {
        if (differs) changed.add(route.collection.name);
        // Records no write settled on during the read are still fresh.
        await releaseRefreshed(
          scope,
          records,
          remote(scope),
          (id) =>
            (startedRecords.get(keyFor(scope, id)) ?? 0) ===
            (recordRevisions.get(keyFor(scope, id)) ?? 0),
          true,
          released,
        );
        continue;
      }
      let confirmedBefore = remote(scope);
      if (differs) {
        // A reused adapter can contain records from before this client instance.
        const before = new Set([
          ...remote(scope).keys(),
          ...persisted.map((item) => String(item[route.collection.idField])),
        ]);
        confirmedBefore = new Map(remote(scope));
        confirmed.set(scope, records);
        // The newest confirmed copy of each written record: from this read,
        // or, for a record the read lacks, from just before it.
        for (const write of allWrites()) {
          if (write.scope !== scope) continue;
          const newest = records.get(write.id) ?? confirmedBefore.get(write.id);
          if (newest) setLastKnown(keyFor(scope, write.id), newest);
        }
        detectConflicts(scope, records);
        for (const id of records.keys()) before.add(id);
        // Writes not yet stored stay out of the visible records.
        for (const write of allWrites())
          if (write.scope === scope && write.durable !== false)
            before.add(write.id);
        for (const id of before) await rebuild(scope, id);
        changed.add(route.collection.name);
        // A write that settled during the rebuild invalidated this snapshot.
        if ((started.get(scope) ?? 0) === (revisions.get(scope) ?? 0))
          lastSyncedItems.set(scope, snapshot.items);
        // Confirmed records and conflict bases of pending writes moved on.
        if (writeQueues.size || gaveUpWrites.size) await persistLater();
      }
      await releaseRefreshed(
        scope,
        remote(scope),
        confirmedBefore,
        () => true,
        false,
        released,
      );
    }
    await countRefreshMisses(released);
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
    ready: () => whenRestored(),
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
      await whenRestored();
      const route = resolveRoute(resource);
      return storage.list(scopeFor(route, contextFor(route, context)));
    },
    async get(
      resource,
      id,
      context,
    ): Promise<Record<string, unknown> | undefined> {
      await whenRestored();
      const route = resolveRoute(resource);
      return storage.get(scopeFor(route, contextFor(route, context)), id);
    },
    async create(resource, data, supplied): Promise<Record<string, unknown>> {
      await whenRestored();
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
      await enqueue({
        route,
        scope,
        context,
        id,
        type: 'create',
        data: record,
        ...(route.idempotencyHeader
          ? { idempotencyKey: crypto.randomUUID() }
          : {}),
      });
      return record;
    },
    async update(
      resource,
      id,
      data,
      supplied,
    ): Promise<Record<string, unknown>> {
      await whenRestored();
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
      const key = keyFor(scope, id);
      const failed = gaveUpWrites.get(key);
      // The visible record carries failed changes; seeding from it would send
      // them implicitly. With failed writes, seed from their last known record.
      const seed = failed
        ? lastKnownFor(scope, id)
        : writeQueues.has(key)
          ? undefined
          : existing;
      if (!remote(scope).has(id) && seed) remote(scope).set(id, seed);
      const record = { ...existing, ...data, [route.collection.idField]: id };
      const confirmedRecord = remote(scope).get(id);
      await enqueue({
        route,
        scope,
        context,
        id,
        type: 'update',
        changes: data,
        ...(confirmedRecord
          ? {
              base: Object.fromEntries(
                Object.keys(data).map((f) => [f, confirmedRecord[f]]),
              ),
            }
          : {}),
      });
      return record;
    },
    async remove(resource, id, supplied): Promise<void> {
      await whenRestored();
      const route = resolveRoute(resource);
      if (!route.deletePath)
        throw new Error(`Resource ${resource} declares no delete operation`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.deletePath, {
        ...context,
        [route.collection.itemParam ?? 'id']: id,
      });
      await enqueue({ route, scope, context, id, type: 'delete' });
    },
    pendingWrites(resource): PendingWriteInfo[] {
      const name = resource
        ? resolveRoute(resource).collection.name
        : undefined;
      const writes = [...gaveUpWrites.values(), ...writeQueues.values()].flat();
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
          ...(write.lastStatus !== undefined
            ? { lastStatus: write.lastStatus }
            : {}),
          state: write.state,
          ...(write.awaitingRefresh && write.state === 'pending'
            ? { awaitingRefresh: true }
            : {}),
          ...(write.conflicts?.size
            ? {
                conflicts: [...write.conflicts.values()].map((c) => ({
                  ...c,
                })),
              }
            : {}),
        }));
    },
    async resolveWrite(resource, id, resolution, supplied): Promise<void> {
      await whenRestored();
      const route = resolveRoute(resource);
      const scope = scopeFor(route, contextFor(route, supplied));
      const key = keyFor(scope, id);
      const failed = gaveUpWrites.get(key);
      const queue = writeQueues.get(key);
      const head = queue?.[0];
      // A parked create (uncertain or failed) holds back everything behind it.
      if (head && (head.state === 'uncertain' || head.state === 'failed')) {
        if (resolution.action === 'confirm' && head.state !== 'uncertain')
          throw new Error('Only an uncertain create can be confirmed');
        if (resolution.action === 'discard') {
          writeQueues.delete(key);
          await persistLater();
          await rebuild(scope, id);
          return;
        }
        if (resolution.action === 'confirm') head.confirmedId = resolution.id;
        if (head.state === 'failed') head.attempts = 0;
        head.state = 'pending';
        await persistLater();
        if (!draining.has(key)) void drainQueue(key);
        return;
      }
      // A blocked write waits for authRenewed(), not for a refresh.
      const waiting =
        queue?.filter((w) => w.awaitingRefresh && w.state === 'pending') ?? [];
      if (queue && waiting.length && !failed) {
        // A restored update waiting for a refresh: send it now, or drop it.
        if (resolution.action === 'confirm')
          throw new Error('Only an uncertain create can be confirmed');
        for (const write of waiting) {
          delete write.awaitingRefresh;
          delete write.refreshMisses;
          if (resolution.action === 'discard')
            queue.splice(queue.indexOf(write), 1);
        }
        if (!queue.length) writeQueues.delete(key);
        await persistLater();
        await rebuild(scope, id);
        if (queue.length && !draining.has(key)) void drainQueue(key);
        return;
      }
      if (!failed)
        throw new Error(
          head?.state === 'blocked'
            ? `Record ${id} of ${resource} has a write blocked by refused credentials; renew them and call authRenewed()`
            : `Record ${id} of ${resource} has no uncertain, failed or waiting write`,
        );
      if (resolution.action === 'confirm')
        throw new Error('Only an uncertain create can be confirmed');
      if (resolution.action === 'retry') {
        // Newer queued writes are sent first; a retried older write must not
        // overwrite what they set.
        const newer = queue ?? [];
        const retried = failed.flatMap((write): QueuedWrite[] => {
          if (newer.length && write.type === 'delete') return [];
          const changes = { ...write.changes };
          for (const later of newer)
            for (const field of touched(later) ?? Object.keys(changes))
              delete changes[field];
          return write.type === 'update' && !Object.keys(changes).length
            ? []
            : [
                {
                  ...write,
                  changes,
                  attempts: 0,
                  state: 'pending',
                  // Queued behind newer writes now, so newer in order too.
                  seq: nextSeq++,
                },
              ];
        });
        if (!retried.length)
          throw new Error(
            `The failed writes for record ${id} of ${resource} are superseded by queued writes; discard them or wait for those to settle`,
          );
        const pending = queue ?? [];
        // Retrying sends now: updates waiting for a refresh stop waiting.
        for (const write of pending) {
          delete write.awaitingRefresh;
          delete write.refreshMisses;
        }
        pending.push(...retried);
        writeQueues.set(key, pending);
        if (!draining.has(key)) void drainQueue(key);
      }
      gaveUpWrites.delete(key);
      await persistLater();
      await rebuild(scope, id);
    },
    authBlocked(): AuthBlock | undefined {
      return authBlock && publicAuthBlock(authBlock);
    },
    async authRenewed(): Promise<void> {
      await whenRestored();
      if (!authBlock) return;
      authBlock = undefined;
      afterRenewal = true;
      authEpoch += 1;
      for (const queue of writeQueues.values())
        for (const write of queue)
          if (write.state === 'blocked') write.state = 'pending';
      await persistLater();
      for (const [key, queue] of writeQueues)
        if (queue.length && !draining.has(key)) void drainQueue(key);
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
