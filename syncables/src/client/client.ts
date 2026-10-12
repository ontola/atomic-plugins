import {
  createBody,
  createDeclaration,
  createdIdentity,
  type CreateDeclaration,
} from './created-identity.js';
import {
  followUpRequest,
  missingValue,
  NOTHING_MISSING,
  parseFollowUps,
  type FollowUp,
} from './compound-create.js';
import type { ReadCoverage } from '../read/time-zone.js';
import { discoverResources } from '../resources/discover.js';
import type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
} from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { findRoute } from '../routing/router.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import {
  readCollections,
  type CollectionReadOptions,
  type CollectionSnapshot,
} from '../read/collections.js';
import type {
  RuntimeDescriber,
  RuntimeMembers,
} from '../read/runtime-schemas.js';
import {
  asText,
  discoverReadModel,
  isRecord,
  upstreamOf,
  type QuerySelection,
  type ReadCollection,
} from '../read/model.js';
import {
  mergePatchRecord,
  patchedField,
  withoutPatched,
} from './merge-patch.js';
import {
  bindPath,
  Budget,
  BudgetExhausted,
  DEFAULT_READ_LIMITS,
  PageStatusError,
  RetryBeyondDeadline,
  walkPages,
  type ReadLimits,
  type WalkOutcome,
} from '../read/pages.js';

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
import { readNestedField } from '../pagination/response-parser.js';
import {
  classifyThrottling,
  declaredThrottling,
  operationBuckets,
  parseHttpDate,
  type ThrottlingVerdict,
} from '../throttling/throttling.js';
import { paginate as paginateOperation } from '../read/read.js';
import {
  fetchTransport,
  lowerCaseHeaders,
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
  type StoredFeedCursor,
  type StoredFeedTombstones,
  type StoredUnavailable,
  type StoredRebuild,
  type StoredRecordWrites,
  type StoredThrottlingPause,
  type StoredFollowUp,
  type StoredWrite,
} from './outbox.js';

export interface RetryOptions {
  /** Delay before the first retry of a failed write, in milliseconds. Doubles on each subsequent attempt. Default 200. */
  baseDelayMs?: number;
  /** Ceiling for the exponential backoff between retries, in milliseconds. Default 30000. */
  maxDelayMs?: number;
  /** Stop auto-retrying a write after this many attempts. Default is unlimited (keep retrying until it succeeds). */
  maxAttempts?: number;
  /**
   * The longest a `Retry-After` header may hold a write back, in
   * milliseconds. Default 3600000 (1 hour). A longer `Retry-After` waits this
   * long instead, so the client may ask again before the server wants it to.
   */
  maxRetryAfterMs?: number;
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
   * True when, as this request was sent, the latest `authRenewed()` had not
   * yet been followed by an accepted response: a response to a request sent
   * after that renewal that is not a refusal (a 2xx, or a failure classified
   * `retry`, `permanent` or `satisfied`, except one the classifier in use
   * calls `auth` when asked again with `afterRenewal: false`, such as a 403
   * failed because of the renewal). A custom classifier is therefore called
   * twice for a failure of a request sent after a renewal that it does not
   * call `auth`.
   */
  afterRenewal: boolean;
  /**
   * Set when the response is throttling under the document's `x-throttling`
   * (draft Throttling extension: a matching Signal Object, or a 429), with
   * the earliest retry time when one is known. See `classifyThrottling`.
   */
  throttling?: ThrottlingVerdict;
  /**
   * True when the document declares `x-throttling.signals`. With signals,
   * only a matching signal or a 429 is throttling (a 403 that matches none
   * is a refused credential or a missing permission); without them (absent
   * or false) the default classification keeps its header heuristic for a
   * 403. The client sets it on every failure it classifies.
   */
  signalsDeclared?: boolean;
  /**
   * Set when the write is a follow-up of a compound create (CRUD Causality
   * 0.5.0 §4.7): its operation and the field it sets. `method` is then the
   * follow-up operation's.
   */
  followUp?: { operation: string; field: string };
}

/**
 * The default classification:
 * - a delete answered 404 or 410: `satisfied` (the record is already gone);
 * - a response that is throttling under the document's `x-throttling`
 *   (`failure.throttling`: a matching signal, or any 429): `retry`;
 * - 401: `auth`;
 * - 403, when the document declares no signals: `retry` when the response
 *   carries `Retry-After` or `x-ratelimit-remaining: 0` (a rate limit, as
 *   GitHub sends); otherwise, and with signals declared, `permanent` when
 *   `afterRenewal` (a refusal that renewed credentials did not fix is a
 *   missing permission) or for a compound create's follow-up (the create
 *   just succeeded with the same credentials, so the 403 refuses that
 *   field, as GitHub does for labels without push access), and `auth`
 *   otherwise;
 * - 408 and 425: `retry`;
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
  if (failure.throttling) return 'retry';
  if (status === 401) return 'auth';
  if (status === 403) {
    if (
      !failure.signalsDeclared &&
      (headers['retry-after'] !== undefined ||
        headers['x-ratelimit-remaining'] === '0')
    )
      return 'retry';
    return failure.afterRenewal || failure.followUp ? 'permanent' : 'auth';
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

/**
 * What the client found out about a record a complete refresh no longer
 * returned:
 * - `deleted`: the provider deleted it. The API document declares that a
 *   record absent from a complete read of the collection was deleted
 *   (`x-completeness: { absent: deleted }`), a GET of the record answered
 *   404 or 410, or 2xx with the record and the resource's declared
 *   read-tombstone marker (`x-read-tombstone`), or the collection's
 *   deletion feed (`x-deletion-feed`)
 *   reported it with a tombstone: in an earlier sync (stored, used before
 *   the GET), or in this sync's feed read when the GET did not decide.
 * - `filtered`: it still exists; the list just does not return it. A GET of
 *   the record answered 2xx with the record, without a declared
 *   read-tombstone marker.
 * - `unavailable`: this caller can no longer read it, and the API does not
 *   say whether it was deleted, moved out of reach, or access was lost. A
 *   GET of the record answered 404 or 410 and the collection declares
 *   `x-completeness: { notFound: unavailable }` (Collection Completeness
 *   0.2.0 §4.3). Never reported as deleted; the last known values are kept.
 * - `unknown`: neither could be told: the GET answered another status, its
 *   2xx body did not hold the record, it failed, or no GET was made (the
 *   resource declares no item GET, or `missingRecordChecks` is `'none'`).
 */
export type MissingRecordEvidence =
  | 'deleted'
  | 'filtered'
  | 'unavailable'
  | 'unknown';

/**
 * Why an update failed because a complete refresh no longer returned its
 * record: the `MissingRecordEvidence` other than `filtered`.
 */
export type MissingRecordFailure = 'deleted' | 'unavailable' | 'unknown';

/** A record a complete refresh no longer returned, and what that means. */
export interface MissingRecord {
  resource: string;
  id: string;
  context?: Record<string, string>;
  evidence: MissingRecordEvidence;
  /**
   * Where the evidence comes from: `declaration` (the API document's
   * `x-completeness`), `feed` (a tombstone in the collection's deletion
   * feed), `read` (a GET of the record), `parent` (the record's parent
   * object, which supplies a path variable of its nested collection, was
   * concluded deleted or unavailable, and the collection declares
   * `x-completeness: { parentAbsent }`; the record itself was not read;
   * Collection Completeness 0.2.0 §4.4) or `none` (no GET made).
   */
  source: 'declaration' | 'feed' | 'read' | 'parent' | 'none';
  /** The status the GET answered, when one answered. */
  status?: number;
  /**
   * For `filtered`: the record the GET returned. For `unavailable`: the
   * last known values the client keeps, when it has them (a record it had
   * confirmed before the read, or the last known copy of its writes).
   */
  record?: Record<string, unknown>;
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
  /**
   * The range `sync()` reads a collection over when its list operation
   * applies a `rangeWindow` pagination scheme (Pagination Schemes 0.5.0
   * §4.6), as for `readCollections`. Such a read is never complete: its
   * records are added or updated, nothing is removed (`SyncResult.incomplete`).
   */
  ranges?: NonNullable<CollectionReadOptions['ranges']>;
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
  /**
   * What an `auth` failure does. `'block'` (the default): the write becomes
   * `blocked` and the client sends no write until `authRenewed()`. `'retry'`:
   * it is retried with backoff like a `retry` failure, counting attempts, and
   * nothing is blocked; for an `authenticate` adapter that renews tokens by
   * itself. With `'retry'`, a block stored in the outbox is dropped on
   * restore.
   */
  onAuthFailure?: 'block' | 'retry';
  /**
   * Which records that a complete `sync()` no longer returns the client
   * checks with a GET of the record (see `MissingRecordEvidence`), within the
   * sync's read budget (`limits`):
   * - `'pending'` (the default): records with a queued update, when that
   *   update is the first unsettled write of the record and not in flight,
   *   and records under which a nested collection declaring
   *   `x-completeness: { parentAbsent }` has records with unsettled writes;
   * - `'all'`: those, and also records without queued writes, once, in the
   *   sync that first misses them;
   * - `'none'`: no GET and no deletion feed read; without a declaration
   *   the evidence is `unknown`.
   * A collection declared `x-completeness: { absent: deleted }` needs no GET.
   * A collection with an `x-deletion-feed` has its feed read once per sync,
   * at its end, after these GETs; its tombstones decide records the GETs
   * did not, and are kept so that the next sync needs no GET for them.
   */
  missingRecordChecks?: 'pending' | 'all' | 'none';
  /**
   * Called with the evidence for each record checked as above. Nothing is
   * deleted locally because of it; what to do with a record the provider
   * deleted is the app's decision. A queued update of the record is failed
   * (`deleted`, `unknown`) or kept and rebased on the returned record
   * (`filtered`).
   */
  onMissingRecord?: (record: MissingRecord) => void;
  /**
   * Told the presence changes of a sync: before the client removes records
   * from its local copy (tell before prune; awaited, the records are
   * removed only after it returns), and, at the end of the sync, the marks
   * it set or cleared on records it keeps. If it throws or rejects, the
   * records are not removed, `sync()` rejects with the error, and a later
   * sync tells again. The same changes are on `SyncResult.presence`.
   */
  onPresence?: (changes: PresenceChange[]) => void | Promise<void>;
  /**
   * Keep a record a sync concludes deleted, marked `deleted`, instead of
   * removing it from the local copy (it is told either way). Default false.
   */
  retainDeleted?: boolean;
  /**
   * How many records without writes a sync looks up (a GET of the record)
   * to settle their presence; the others stay `unconfirmed` and are looked
   * up first by the next sync. Records with queued writes are always
   * checked. Default 50.
   */
  maxMissingRecordChecks?: number;
}

/** A mark on a record the local copy keeps although a read did not return it. */
export type PresenceMarkValue = 'unconfirmed' | 'unavailable' | 'deleted';

/** A record's current presence mark (`ApiClient.presence()`). */
export interface PresenceMark {
  collection: string;
  context?: Record<string, string>;
  id: string;
  presence: PresenceMarkValue;
  /** What set the mark, as on `MissingRecord`. */
  source?: MissingRecord['source'];
  /** Why, in words. */
  detail: string;
  /** The values the local copy keeps. */
  record: Record<string, unknown>;
  /**
   * When a read last returned the record (ISO 8601, the start of that
   * sync), as far as this client knows: absent when no read of this client
   * returned it (a record from storage written before a restart).
   */
  lastSeen?: string;
}

/**
 * A change of a record's presence in the local copy, and why.
 * - `pruned: true`: the record is about to be removed. `presence` is
 *   `deleted` when a declaration (`x-completeness: { absent: deleted }`) or
 *   a check concluded it deleted, else `removed` (no longer returned by a
 *   complete read, or present but no longer in the collection).
 * - `pruned: false`: the record stays, with a new mark (`unconfirmed`,
 *   `unavailable`, `deleted` under `retainDeleted`), or `present` when a
 *   read returned a marked record again (the mark is dropped).
 * `record`: its values in the local copy.
 */
export interface PresenceChange {
  collection: string;
  context?: Record<string, string>;
  id: string;
  presence: 'present' | 'removed' | PresenceMarkValue;
  /**
   * What concluded it: `declaration` (`absent: deleted`), `read` (a
   * complete read no longer returned it, or the record's own read), `feed`,
   * `parent` or `none` (no check made), as on `MissingRecord`.
   */
  source: MissingRecord['source'];
  record?: Record<string, unknown>;
  /** The record is removed from the local copy right after this is told. */
  pruned: boolean;
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
  /**
   * The presence changes of this sync, as told to `onPresence`: records
   * removed from the local copy (`pruned: true`, told before removal) and
   * marks set or dropped on records it keeps (`pruned: false`, told at the
   * end of the sync), one per record. Absent when there were none.
   */
  presence?: PresenceChange[];
  /**
   * Collections this sync read without error but not completely: a read by
   * range windows (Pagination Schemes 0.5.0 §4.6.4) or one ended by a short
   * page whose end is not documented (0.6.0 §4.4.5). Their records were
   * added or updated; nothing was removed or concluded about the records
   * they did not return. One entry per collection and parent context.
   */
  incomplete: IncompleteRead[];
  /**
   * The describers this sync read and the classes derived from them, when
   * a resource declares `x-runtime-schema` (Runtime Schemas 0.1.0-draft);
   * absent otherwise. `runtimeMembers()` gives a record's values.
   */
  describers?: RuntimeDescriber[];
  /**
   * Non-fatal problems of a sync whose collections were read: a describer
   * that could not be read (`<resource>: describer <path>: <message>`), so
   * its records' `runtimeMembers()` have `noClass`. Absent when there are
   * none. A collection that could not be read still makes `sync()` throw.
   */
  warnings?: string[];
  /**
   * Per collection read whose list operation has `x-time-zone` query
   * parameters with values (Filtering 0.2.0-draft, set through
   * `selection`): the values sent and the UTC span the read is known to
   * cover. Absent when there is none.
   */
  coverage?: CollectionCoverage[];
}

/** A `ReadCoverage` with the collection and bound context it belongs to. */
export interface CollectionCoverage extends ReadCoverage {
  collection: string;
  context?: Record<string, string>;
}

export interface IncompleteRead {
  collection: string;
  /** The parent path parameters the collection was read under. */
  context: Record<string, string>;
  /** Why the read is not complete. */
  reason: string;
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
 *   `resolveWrite` `discard` drops it (a create with the writes queued
 *   behind it) and leaves the client blocked; `retry` does not resend it.
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
  /**
   * Set on an update that failed because a complete refresh no longer
   * returned its record: `deleted` (`lastError` "deleted at the provider"),
   * `unavailable` (`lastError` "unavailable at the provider") or `unknown`
   * (`lastError` "not in the refreshed collection"). See
   * `MissingRecordEvidence`.
   */
  missingRecord?: MissingRecordFailure;
  /**
   * Set on an `uncertain` create whose 2xx response did not identify the
   * created record as its operation's `x-crud` declares (CRUD Causality
   * §4.3.2): the record exists at the provider but is unbound. It is never
   * sent again; `resolveWrite` `confirm` (with the server's id) or
   * `discard` settles it, and `retry` throws.
   */
  unbound?: true;
  /**
   * Set on an update that is a follow-up of a compound create (CRUD
   * Causality 0.5.0 §4.7): the follow-up `operation`, the `field` it sets,
   * and, once it did not apply, why: `refused` (its answer refused it; the
   * create is partly applied), `unknown` (no usable answer; it waits for a
   * read of the record, `awaitingRefresh`, before it is sent again) or
   * `notSent` (an earlier follow-up of the same create did not apply, or
   * its request could not be filled). The create itself is settled and is
   * never sent again.
   */
  followUp?: {
    operation: string;
    field: string;
    reason?: 'refused' | 'unknown' | 'notSent';
  };
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
   * A record's user-defined members (`x-runtime-schema`), as the latest
   * complete read of its collection interpreted them against its
   * describer's class: of the record as that read returned it, so local
   * edits still pending are not in them. Undefined when no complete read of this client returned
   * the record, or its resource declares no runtime schema. Kept in memory
   * only: after a restart, until the next sync.
   */
  runtimeMembers(
    resource: string,
    id: string,
    context?: Record<string, string>,
  ): RuntimeMembers | undefined;
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
   * The presence marks of records the local copy keeps although a read did
   * not return them (for `resource`, if given). A record without a mark is
   * present as far as the client knows.
   */
  presence(resource?: string): PresenceMark[];
  /**
   * Settles the `uncertain` or `failed` write for record `id`, or its restored
   * updates waiting for a refresh (see `WriteResolution`), or drops its
   * `blocked` write (`discard` only; the client stays blocked). Throws if
   * that record has none of these; any other `pending` write cannot be
   * resolved this way.
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
   * client is not blocked. A 403 without rate-limit headers to a request sent
   * after it then fails its write instead of blocking again, until a response
   * shows the credentials accepted (see `WriteFailure.afterRenewal`).
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
  /**
   * How an update's body is built, from the chosen operation's `x-crud`
   * (CRUD Causality §4.3 `mode` and §4.6 `patchFormat`): `record` (the
   * default, and `mode: replace`), the last known record with the changes
   * on top; `mergePatch` (`mode: patch, patchFormat: jsonMergePatch`), the
   * changes alone as an RFC 7396 JSON Merge Patch, with its semantics
   * applied locally too (`null` removes a field, a nested object merges
   * into the existing one).
   */
  updateBody?: 'record' | 'mergePatch';
  /**
   * The update request's `Content-Type`: `application/merge-patch+json`
   * for a merge patch whose operation declares that media type in its
   * `requestBody.content`, else `application/json`.
   */
  updateContentType?: string;
  /** Why `update()` refuses: a `patchFormat` this client does not send. */
  updateRefused?: string;
  /** Why `create()` refuses: a compound create's `followUps` this client cannot use. */
  createRefused?: string;
  deletePath?: string;
  /**
   * The resource's declared `create` (`x-crud`, not in legacy documents):
   * generated fields left out of the body, and where the created
   * record's identity comes from.
   */
  create?: CreateDeclaration;
  idempotencyHeader?: string;
  /** `x-completeness: { absent: deleted }`: absence from a complete read is deletion. */
  absentMeansDeleted?: boolean;
  /**
   * `x-completeness: { absent: removed }`: a record a complete read lacks
   * is kept, marked `unconfirmed`, until a check settles it.
   */
  absentRemoved?: boolean;
  /**
   * The `notFound` the route's **resource** states (Collection
   * Completeness 0.2.0 §4.3): any of its collections, this one or not, set
   * on every route of the resource; `unavailable` when they differ or a
   * stated value is not recognised. Undefined: not stated anywhere, so a
   * 404 or 410 means `deleted` by the spec's default only, which is not a
   * stated confirmation of a deletion.
   */
  notFound?: 'deleted' | 'unavailable';
  /**
   * The `gone` the route's resource states (Collection Completeness
   * 0.3.0 §4.3), resource-wide like `notFound`: what a 410 means. Undefined:
   * not stated, so a 410 means what `notFound` says.
   */
  gone?: 'deleted' | 'unavailable';
  /**
   * The route's own Completeness Object has an `absent` this client does
   * not recognise: a 404, or a 410 that neither `gone` nor `notFound`
   * classifies, then means `unavailable`, never the `deleted` default
   * (Collection Completeness §7; the reference `classify_read`).
   */
  unrecognisedAbsent?: true;
  /**
   * `x-completeness: { parentAbsent }` on a nested collection, any value:
   * its members are unavailable once the parent object that supplies one
   * of its path variables is concluded deleted or unavailable (Collection
   * Completeness 0.2.0 §4.4). Applied without reading them.
   */
  parentAbsent?: 'unavailable';
  /** The item URL declares a GET, so a missing record can be read. */
  itemReadable?: boolean;
  /** `x-deletion-feed`: the operation that reports deletions. */
  deletionFeed?: DeletionFeed;
  /** `x-read-tombstone`: the item GET answers 2xx with a tombstone for a deleted record. */
  readTombstone?: Tombstone;
}

/** A parsed Tombstone Object (draft Deletion Feeds extension, §4.3). */
interface Tombstone {
  field: string;
  values: (string | number | boolean)[];
}

/**
 * Parses a Tombstone Object: `field` a non-empty string, `values` a
 * non-empty list of strings, numbers and booleans. Undefined otherwise.
 */
function parseTombstone(value: unknown): Tombstone | undefined {
  if (!isRecord(value)) return undefined;
  const { field, values } = value;
  if (
    typeof field !== 'string' ||
    field === '' ||
    !Array.isArray(values) ||
    !values.length ||
    !values.every((v) => ['string', 'number', 'boolean'].includes(typeof v))
  )
    return undefined;
  return { field, values: values as (string | number | boolean)[] };
}

/** Whether the value at the marker's field equals one of its values (same JSON type). */
function isTombstone(
  item: Record<string, unknown>,
  tombstone: Tombstone,
): boolean {
  const marker = readNestedField(item, tombstone.field);
  return tombstone.values.some((v) => v === marker);
}

/** A parsed Deletion Feed Object (draft Deletion Feeds extension). */
interface DeletionFeed {
  operationId: string;
  /** Path template of the feed operation. */
  path: string;
  operation: OperationObject;
  /** Dot-path to the items array; `''` for the body itself. */
  itemsField: string;
  /** Dot-path to the identity of the record an item is about. */
  idField: string;
  cursor?: {
    parameter: string;
    responseField: string;
    expiredStatuses: number[];
  };
  tombstone?: Tombstone;
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
  /** The earliest time to send it again (a throttling answer's), stored; see `StoredWrite.notBefore`. */
  notBefore?: number;
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
  /** Failed because a complete refresh no longer returned the record. */
  missingRecord?: MissingRecordFailure;
  /** A create answered 2xx whose identity could not be determined; stored. */
  unbound?: boolean;
  /**
   * An update's body format, fixed when it was made (absent: `record`, the
   * full record): stored, so a restart under a document that now declares
   * another format does not reinterpret its changes.
   */
  updateBody?: 'mergePatch';
  /** A compound create's follow-up update (§4.7); stored. */
  followUp?: StoredFollowUp;
  /**
   * In flight when a complete read lacked its record (`holdMissing` skipped
   * it): if it stays queued after its response, it is held. Not stored.
   */
  holdIfQueued?: boolean;
}

type WriteOutcome =
  | { status: 'succeeded'; resolvedId: string }
  | { status: 'retry'; delayMs: number }
  | { status: 'uncertain' }
  | { status: 'gaveUp' }
  | { status: 'blocked' }
  /** Not sent: the client was blocked while the write was being stored. */
  | { status: 'held' };

/** The server answered with a non-2xx status. */
class HttpStatusError extends Error {
  /** When the response arrived, in milliseconds since the epoch. */
  readonly receivedAt = Date.now();
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
  // Only space, tab, CR and LF are stripped, as for the Throttling roles.
  const value = headers['retry-after']?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!value) return undefined;
  // Delay-seconds up to 2^53 − 1, or an HTTP-date in one of its exact
  // forms (RFC 9110 §5.6.7); anything else, such as "1.5" or a date with a
  // no-break space, is unusable.
  const date = /^\d+$/.test(value) ? undefined : parseHttpDate(value);
  const ms = /^\d+$/.test(value)
    ? Number.isSafeInteger(Number(value))
      ? Number(value) * 1000
      : NaN
    : date !== undefined
      ? date - Date.now()
      : NaN;
  return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

/** setTimeout's largest delay (about 24.8 days); a larger one fires at once. */
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
 * sending means nothing went out, so those keep the ordinary retry path. A
 * throttling signal declared for a 5xx does not change this: the Throttling
 * extension says such a response may follow partial processing and that
 * "not applied" is only an inference, so a create answered that way is
 * still uncertain.
 */
function mayHaveApplied(error: unknown): boolean {
  if (error instanceof NotSentError) return false;
  if (error instanceof HttpStatusError)
    return error.status >= 500 && error.status !== 503;
  return true;
}

/** JSON values equal in structure, whatever the order of object keys. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => deepEqual(value, b[i]))
    );
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  );
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

/** A parsed Completeness Object (draft Collection Completeness extension, §4.1). */
interface Completeness {
  absent: 'deleted' | 'removed';
  /** §4.4; only from a Collection Object; any value means `unavailable`. */
  parentAbsent?: 'unavailable';
}

/**
 * A collection's raw Completeness Object (draft Collection Completeness
 * extension, §4.1): from its CRUD Causality Collection Object, which covers
 * the collection's own fixed `listQuery`/`listBody` (or
 * `x-list-query`/`x-list-body`), else from the operation that lists it
 * (its list path's operation, or one whose `x-crud` is a `list` of this
 * collection), which covers only a read that adds nothing to the
 * operation's request (no fixed query or body), since several collections
 * may share that operation. `onCollection`: it came from the Collection
 * Object.
 */
function rawCompleteness(
  document: OpenApiDocument,
  collection: ReadCollection,
  evenWithFixedReads = false,
): { declared: Record<string, unknown>; onCollection: boolean } | undefined {
  const resources = document.components?.['crudResources'];
  const resource = isRecord(resources)
    ? resources[collection.resource]
    : undefined;
  const collections = isRecord(resource) ? resource['collections'] : undefined;
  const definition = isRecord(collections)
    ? collections[collection.name]
    : undefined;
  if (isRecord(definition) && definition['x-completeness'] !== undefined) {
    const declared = definition['x-completeness'];
    return isRecord(declared) ? { declared, onCollection: true } : undefined;
  }
  const fixed =
    Object.keys(collection.listQuery).length > 0 ||
    Object.keys(collection.listBody).length > 0;
  if (fixed && !evenWithFixedReads) return undefined;
  const operation =
    document.paths[collection.url]?.[
      collection.method === 'POST' ? 'post' : 'get'
    ];
  let declared = operation?.['x-completeness'];
  if (declared === undefined)
    for (const item of Object.values(document.paths))
      for (const method of ['get', 'post'] as const) {
        const listing = item?.[method];
        const crud = listing?.['x-crud'];
        if (
          declared === undefined &&
          isRecord(crud) &&
          crud['action'] === 'list' &&
          crud['resource'] === collection.resource &&
          crud['collection'] === collection.name
        )
          declared = listing?.['x-completeness'];
      }
  return isRecord(declared) ? { declared, onCollection: false } : undefined;
}

/**
 * The Completeness Object of a collection (`rawCompleteness`), parsed. A
 * declaration whose `absent` is not `deleted` or `removed` is ignored as a
 * whole (§7), apart from its `notFound`, which `resourceNotFound` still
 * counts. `parentAbsent` counts only on the Collection Object, and any
 * value means `unavailable` (§7, 0.2.0 has no `deleted` cascade).
 */
function declaredCompleteness(
  document: OpenApiDocument,
  collection: ReadCollection,
): Completeness | undefined {
  const raw = rawCompleteness(document, collection);
  if (!raw) return undefined;
  const absent = raw.declared['absent'];
  if (absent !== 'deleted' && absent !== 'removed') return undefined;
  return {
    absent,
    ...(raw.onCollection && raw.declared['parentAbsent'] !== undefined
      ? { parentAbsent: 'unavailable' as const }
      : {}),
  };
}

/**
 * Internal, exported for tests: §4.3: the `notFound` (or, with `field`,
 * the 0.3.0 `gone`) a resource states, through any of its collections
 * (after the reference `resource_not_found`): the one value they state,
 * `unavailable` when they state different ones or one this client does not
 * recognise, undefined when none states it. A `notFound` stated beside an
 * `absent` the client does not recognise still counts.
 */
export function resourceNotFound(
  document: OpenApiDocument,
  collections: ReadCollection[],
  resource: string,
  field: 'notFound' | 'gone' = 'notFound',
): 'deleted' | 'unavailable' | undefined {
  const stated = new Set<string>();
  for (const collection of collections) {
    if (collection.resource !== resource) continue;
    // A `notFound` on the list operation counts even for a collection with
    // fixed reads: it says what the resource's read means, and counting it
    // can only make a 404 `unavailable`, the safe reading.
    const raw = rawCompleteness(document, collection, true);
    if (raw && raw.declared[field] !== undefined)
      stated.add(raw.declared[field] === 'deleted' ? 'deleted' : 'unavailable');
  }
  if (!stated.size) return undefined;
  return stated.size === 1 && stated.has('deleted') ? 'deleted' : 'unavailable';
}

/**
 * The draft Deletion Feeds extension's `x-deletion-feed` for a collection:
 * from its CRUD Causality Collection Object, else from its list operation.
 * A declaration that does not parse, or names no GET operation of the
 * document, is ignored.
 */
function declaredDeletionFeed(
  document: OpenApiDocument,
  collection: ReadCollection,
): DeletionFeed | undefined {
  const resources = document.components?.['crudResources'];
  const resource = isRecord(resources)
    ? resources[collection.resource]
    : undefined;
  const collections = isRecord(resource) ? resource['collections'] : undefined;
  const definition = isRecord(collections)
    ? collections[collection.name]
    : undefined;
  const list =
    document.paths[collection.url]?.[
      collection.method === 'POST' ? 'post' : 'get'
    ];
  const declared =
    isRecord(definition) && definition['x-deletion-feed'] !== undefined
      ? definition['x-deletion-feed']
      : list?.['x-deletion-feed'];
  if (!isRecord(declared)) return undefined;
  const text = (value: unknown): value is string =>
    typeof value === 'string' && value !== '';
  const { operationId, envelope, cursor, tombstone, idField } = declared;
  if (!text(operationId)) return undefined;
  const found = Object.entries(document.paths).find(
    ([, item]) => item?.get?.operationId === operationId,
  );
  if (!found) return undefined;
  const feed: DeletionFeed = {
    operationId,
    path: found[0],
    operation: found[1].get as OperationObject,
    itemsField: '',
    idField: collection.idField,
  };
  if (envelope !== undefined) {
    if (!isRecord(envelope)) return undefined;
    const field = envelope['itemsField'];
    // Omitted, null or "" mean the body root (Pagination Schemes §4.4.2);
    // another non-string does not parse.
    if (field !== undefined && field !== null && typeof field !== 'string')
      return undefined;
    feed.itemsField = field ?? '';
  }
  if (idField !== undefined) {
    if (!text(idField)) return undefined;
    feed.idField = idField;
  }
  if (cursor !== undefined) {
    if (!isRecord(cursor)) return undefined;
    const { parameter, responseField, expiredStatuses = [] } = cursor;
    if (
      !text(parameter) ||
      !text(responseField) ||
      !Array.isArray(expiredStatuses) ||
      !expiredStatuses.every((status) => Number.isInteger(status))
    )
      return undefined;
    feed.cursor = {
      parameter,
      responseField,
      expiredStatuses: expiredStatuses as number[],
    };
  }
  if (tombstone !== undefined) {
    const parsed = parseTombstone(tombstone);
    if (!parsed) return undefined;
    feed.tombstone = parsed;
  }
  return feed;
}

/**
 * The draft Deletion Feeds extension's `x-read-tombstone` for a
 * collection's resource: from its CRUD Resource Object, else from the GET
 * operation of its item URL. Every collection of the resource shares it. A
 * declaration that does not parse is ignored; when the resource's does not
 * parse, the operation's applies.
 */
function declaredReadTombstone(
  document: OpenApiDocument,
  collection: ReadCollection,
): Tombstone | undefined {
  const resources = document.components?.['crudResources'];
  const resource = isRecord(resources)
    ? resources[collection.resource]
    : undefined;
  const read = collection.itemUrl
    ? document.paths[collection.itemUrl]?.get
    : undefined;
  return (
    parseTombstone(
      isRecord(resource) ? resource['x-read-tombstone'] : undefined,
    ) ?? parseTombstone(read?.['x-read-tombstone'])
  );
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
        if (method === 'post' && crud['action'] === 'create') {
          route.createPath = path;
          const declared = legacy
            ? undefined
            : createDeclaration(document, crud);
          if (declared) route.create = declared;
          // A compound create (CRUD Causality 0.5.0 §4.7): fail closed when
          // its follow-ups cannot be made, rather than create without them.
          if (!legacy && crud['followUps'] !== undefined) {
            try {
              const followUps = parseFollowUps(document, crud, path);
              if (!declared)
                throw new Error(
                  'declares followUps on a create whose resource has no usable identity',
                );
              if (followUps) declared.followUps = followUps;
            } catch (error) {
              route.createRefused = `declares a compound create this client cannot make: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
        }
        if (method === 'delete' && crud['action'] === 'delete')
          route.deletePath = path;
      }
    }
    const updateOperation =
      route.updateMethod && item
        ? item[route.updateMethod === 'PUT' ? 'put' : 'patch']
        : undefined;
    const updateCrud = updateOperation?.['x-crud'];
    // A legacy document (no `components.crudResources`) keeps the full
    // record whatever its operations declare.
    if (
      !legacy &&
      isRecord(updateCrud) &&
      updateCrud['action'] === 'update' &&
      updateCrud['resource'] === collection.resource &&
      updateCrud['mode'] === 'patch'
    ) {
      const format = updateCrud['patchFormat'];
      if (format === 'jsonMergePatch') {
        route.updateBody = 'mergePatch';
        const content = updateOperation?.requestBody?.content ?? {};
        route.updateContentType = Object.keys(content).some(
          (type) =>
            type.split(';')[0]?.trim().toLowerCase() ===
            'application/merge-patch+json',
        )
          ? 'application/merge-patch+json'
          : 'application/json';
      } else if (format === 'jsonPatch')
        route.updateRefused = `declares its ${route.updateMethod} update with patchFormat jsonPatch (RFC 6902), which this client does not send`;
      // `custom`, or no patchFormat: the full record, as before.
    }
    const completeness = declaredCompleteness(document, collection);
    if (completeness?.absent === 'deleted') route.absentMeansDeleted = true;
    if (completeness?.absent === 'removed') route.absentRemoved = true;
    const notFound = resourceNotFound(
      document,
      collections,
      collection.resource,
    );
    if (notFound) route.notFound = notFound;
    const gone = resourceNotFound(
      document,
      collections,
      collection.resource,
      'gone',
    );
    if (gone) route.gone = gone;
    // §7: under an unrecognised `absent`, a 410 is classified by a
    // recognised `gone`, then a recognised `notFound`, a 404 by a recognised
    // `notFound`, else either is `unavailable`, never the `deleted` default.
    // A declaration with no `absent` counts as unrecognised too. Unlike the
    // reference `declarations_of`, the list operation's declaration counts
    // even for a collection with fixed reads (as in resourceNotFound): it
    // can only make a 404 `unavailable`, the safe reading.
    const rawOwn = rawCompleteness(document, collection, true);
    const ownAbsent = rawOwn?.declared['absent'];
    if (rawOwn && ownAbsent !== 'deleted' && ownAbsent !== 'removed')
      route.unrecognisedAbsent = true;
    if (completeness?.parentAbsent)
      route.parentAbsent = completeness.parentAbsent;
    const feed = declaredDeletionFeed(document, collection);
    if (feed) route.deletionFeed = feed;
    const readTombstone = declaredReadTombstone(document, collection);
    if (readTombstone) route.readTombstone = readTombstone;
    if (item?.get) route.itemReadable = true;
    const header =
      route.createPath && declaredIdempotencyHeader(document, route.createPath);
    if (header) route.idempotencyHeader = header;
    return route;
  });
}

/**
 * The created record with its identity fields set from what identified it.
 * A body value equal as text (a number the URL gave as a string) is kept.
 */
function withIdentity(
  record: Record<string, unknown>,
  identity: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...record };
  for (const [field, value] of Object.entries(identity))
    if (merged[field] === undefined || String(merged[field]) !== String(value))
      merged[field] = value;
  return merged;
}

/**
 * A record with an update's changes applied, as the route's update body
 * format defines: a JSON Merge Patch for `mergePatch`, else the changes
 * over the record.
 */
function applyChanges(
  body: UpdateBody,
  base: Record<string, unknown> | undefined,
  changes: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return body === 'mergePatch'
    ? mergePatchRecord(base, changes)
    : { ...base, ...changes };
}

type UpdateBody = 'record' | 'mergePatch';

/** The body format an update was made with. */
function writeBody(write: { updateBody?: 'mergePatch' }): UpdateBody {
  return write.updateBody ?? 'record';
}

/** The body format the route's update operation declares now. */
function routeBody(route: ClientRoute): UpdateBody | 'refused' {
  return route.updateRefused ? 'refused' : (route.updateBody ?? 'record');
}

/** Whether a stored update was made for another body format than the route's now. */
function bodyMismatch(write: QueuedWrite): boolean {
  return write.type === 'update' && writeBody(write) !== routeBody(write.route);
}

/**
 * The changes of a failed or retried update without what a later write
 * sets: by top-level field, or, when both are merge patches, by nested
 * member. A later create or delete sets everything.
 */
function withoutSetBy(
  write: QueuedWrite,
  later: QueuedWrite,
): Record<string, unknown> {
  const changes = write.changes ?? {};
  if (later.type !== 'update') return {};
  const set = later.changes ?? {};
  if (writeBody(write) === 'mergePatch' && writeBody(later) === 'mergePatch')
    return withoutPatched(changes, set);
  const left = { ...changes };
  for (const field of Object.keys(set)) delete left[field];
  return left;
}

const missingSources: ReadonlySet<string> = new Set<MissingRecord['source']>([
  'declaration',
  'feed',
  'read',
  'parent',
  'none',
]);

/** Whether a stored mark's `source` is one this client knows. */
function isMissingSource(value: unknown): value is MissingRecord['source'] {
  return typeof value === 'string' && missingSources.has(value);
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
  // The root x-throttling (draft Throttling extension): header roles and
  // the signals that make a response a rate-limit refusal.
  const throttling = declaredThrottling(doc);
  /** Buckets a quotaExhausted answer declared exhausted, by identifier ('*' when unnamed), until (ms). */
  const pausedBuckets = new Map<string, number>();
  /** The running sync's read budget, for what is left of its time while a read waits out a pause. */
  let activeBudget: Budget | undefined;
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
  const model = discoverReadModel(doc, legacy);
  const routes = clientRoutes(doc, model.collections);
  for (const route of routes) {
    // A selection that narrows the read past the collection's own fixed
    // query makes it no longer the read the declaration speaks of: a record
    // it leaves out may exist, so a GET decides instead.
    const narrowed = (options.selection?.query_overrides ?? []).some(
      (override) =>
        override.path === route.collection.url &&
        Object.entries(override.values).some(
          ([name, value]) => route.collection.listQuery[name] !== asText(value),
        ),
    );
    if (narrowed) delete route.absentMeansDeleted;
    if (options.idempotencyKeyHeader === false) delete route.idempotencyHeader;
    else if (options.idempotencyKeyHeader && route.createPath)
      route.idempotencyHeader = options.idempotencyKeyHeader;
  }
  const byResource = new Map(routes.map((r) => [r.collection.name, r]));
  if (byResource.size !== routes.length)
    throw new Error('Collection names must be unique across resources');
  // §4.4: the nested collections that declare parentAbsent, by the
  // collection whose records supply their path variable (`param`). The
  // declaration needs exactly one parent resource; with more it is ignored.
  // A variable a constant fixes has no parent object to go missing.
  // Nested scopes whose parent is concluded gone, until a complete read of
  // the scope (the parent returned): new writes into them are concluded at
  // once. In memory only: after a restart, a member's failed writes still
  // carry `missingRecord`, but a member without writes is not marked.
  const goneParents = new Map<string, Evidence>();
  const nestedUnder = new Map<
    string,
    { route: ClientRoute; param: string }[]
  >();
  for (const route of routes) {
    if (!route.parentAbsent) continue;
    const parents = new Map<string, { param: string; collection: string }[]>();
    for (const param of route.collection.contextParams) {
      const provider = model.providers.get(param);
      const resource = model.collections.find(
        (c) => c.name === provider?.collection,
      )?.resource;
      if (!provider || !resource || resource === route.collection.resource)
        continue;
      parents.set(resource, [
        ...(parents.get(resource) ?? []),
        { param, collection: provider.collection },
      ]);
    }
    const [parent] = [...parents];
    if (!parent || parents.size !== 1) {
      delete route.parentAbsent;
      continue;
    }
    for (const { param, collection } of parent[1]) {
      if (options.constants && param in options.constants) continue;
      nestedUnder.set(collection, [
        ...(nestedUnder.get(collection) ?? []),
        { route, param },
      ]);
    }
  }
  const confirmed = new Map<string, Map<string, Record<string, unknown>>>();
  const lastSyncedItems = new Map<string, Record<string, unknown>[]>();
  const conditionalCache = new Map<string, TransportResponse>();
  /** Per scope, the user-defined members of the latest complete read's records, by id. */
  const runtimeMembersByScope = new Map<string, Map<string, RuntimeMembers>>();
  const writeQueues = new Map<string, QueuedWrite[]>();
  /** Failed updates and deletes per record, oldest first. Failed creates stay parked in their queue. */
  const gaveUpWrites = new Map<string, QueuedWrite[]>();
  const draining = new Set<string>();
  /**
   * Per record key: ends the backoff wait of the write at the head of the
   * queue early, for when that write is taken out of the queue meanwhile.
   */
  const wakers = new Map<string, () => void>();
  const revisions = new Map<string, number>();
  /** Like `revisions`, per record: settles during a read, by record key. */
  const recordRevisions = new Map<string, number>();
  let syncing: Promise<SyncResult> | undefined;
  const retry = {
    baseDelayMs: options.retry?.baseDelayMs ?? 200,
    maxDelayMs: options.retry?.maxDelayMs ?? 30000,
    maxRetryAfterMs: Math.min(
      options.retry?.maxRetryAfterMs ?? 3_600_000,
      MAX_TIMER_MS,
    ),
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
  /** Deletion feed cursors, by scope; stored in the outbox. */
  const feedCursors = new Map<string, StoredFeedCursor>();
  /**
   * Tombstones a deletion feed reported, by scope, for records with
   * unsettled writes; stored in the outbox (only for such records).
   */
  const feedTombstones = new Map<
    string,
    { resource: string; context: Record<string, string>; ids: Set<string> }
  >();
  /**
   * Records concluded `unavailable` (Collection Completeness 0.2.0 §4.3), by
   * record key: their last known values stay visible, marked (the report),
   * until a later read settles them (a complete read or a GET that returns
   * them, or evidence of deletion); a discard of their writes falls back to
   * them, and a new update or delete of them is held. Stored in the outbox.
   */
  const keptMarks = new Map<
    string,
    {
      scope: string;
      resource: string;
      context: Record<string, string>;
      id: string;
      record: Record<string, unknown>;
      detail: string;
      source?: MissingRecord['source'];
      presence: PresenceMarkValue;
      lastSeen?: string;
      /**
       * A check concluded the record deleted or present elsewhere: the mark
       * goes once the removal is told (`rebuildTelling`), and stays if the
       * handler throws, so the record is checked again.
       */
      clearing?: true;
      /**
       * The app has been told a mark of this record (or the mark was
       * restored from storage, whose changes were told or lost with the
       * process): dropping it is then told as `present` (`dropMark`).
       */
      told?: true;
    }
  >();
  /**
   * When a read last returned each record (the start of that sync), in
   * memory; a mark takes it as `lastSeen` when it is set.
   */
  const seenAt = new Map<string, string>();
  /**
   * Mark changes not told yet, the latest per record (`changeKey`): told at
   * the end of a sync, and kept for the next one when that does not happen
   * (the sync throws, or the handler does), so none is lost.
   */
  const untoldMarks = new Map<string, PresenceChange>();
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
      ...(write.missingRecord ? { missingRecord: write.missingRecord } : {}),
      ...(write.unbound ? { unbound: true as const } : {}),
      ...(write.updateBody ? { updateBody: write.updateBody } : {}),
      ...(write.notBefore !== undefined ? { notBefore: write.notBefore } : {}),
      ...(write.followUp ? { type: 'followUp', followUp: write.followUp } : {}),
    };
  }

  /** The kept unavailable records, grouped by collection and context. */
  function storedUnavailable(): { unavailable?: StoredUnavailable[] } {
    const byScope = new Map<string, StoredUnavailable>();
    for (const kept of keptMarks.values()) {
      let entry = byScope.get(kept.scope);
      if (!entry)
        byScope.set(
          kept.scope,
          (entry = {
            resource: kept.resource,
            context: kept.context,
            unavailable: {},
          }),
        );
      entry.unavailable[kept.id] = {
        record: kept.record,
        detail: kept.detail,
        ...(kept.presence !== 'unavailable' ? { presence: kept.presence } : {}),
        ...(kept.source ? { source: kept.source } : {}),
        ...(kept.lastSeen ? { lastSeen: kept.lastSeen } : {}),
      };
    }
    return byScope.size ? { unavailable: [...byScope.values()] } : {};
  }

  /**
   * Stored tombstones, of records that still have unsettled writes; the
   * others are dropped from memory too.
   */
  function storedFeedTombstones(): {
    feedTombstones?: StoredFeedTombstones[];
  } {
    const entries: StoredFeedTombstones[] = [];
    for (const [scope, { resource, context, ids }] of feedTombstones) {
      for (const id of ids) if (!unsettled(scope, id)) ids.delete(id);
      if (ids.size) entries.push({ resource, context, tombstones: [...ids] });
    }
    return entries.length ? { feedTombstones: entries } : {};
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
        ...(feedCursors.size ? { feedCursors: [...feedCursors.values()] } : {}),
        ...storedFeedTombstones(),
        ...storedUnavailable(),
        ...storedThrottlingPauses(),
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
      type: stored.type === 'followUp' ? 'update' : stored.type,
      ...(stored.followUp ? { followUp: stored.followUp } : {}),
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
      ...(stored.missingRecord ? { missingRecord: stored.missingRecord } : {}),
      ...(stored.unbound ? { unbound: true } : {}),
      ...(stored.updateBody ? { updateBody: stored.updateBody } : {}),
      ...(stored.notBefore !== undefined
        ? { notBefore: stored.notBefore }
        : {}),
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
    feedCursors.clear();
    feedTombstones.clear();
    keptMarks.clear();
    unrestorable = outbox.unrestorable;
    for (const entry of outbox.unavailable) {
      const route = byResource.get(entry.resource);
      if (!route) {
        unrestorable.push(entry);
        continue;
      }
      const scope = scopeFor(route, entry.context);
      for (const [id, mark] of Object.entries(entry.unavailable))
        keptMarks.set(keyFor(scope, id), {
          scope,
          resource: entry.resource,
          context: entry.context,
          id,
          record: mark.record,
          detail: mark.detail,
          // An unknown value (a later client's) is read as unavailable, the
          // safe reading: kept, writes held, not checked again by itself.
          presence:
            mark.presence === 'unconfirmed' || mark.presence === 'deleted'
              ? mark.presence
              : 'unavailable',
          // A source this client does not know (a later client's) is
          // dropped rather than passed on as one of ours.
          ...(isMissingSource(mark.source) ? { source: mark.source } : {}),
          ...(mark.lastSeen ? { lastSeen: mark.lastSeen } : {}),
          told: true,
        });
    }
    for (const entry of outbox.feedTombstones) {
      const route = byResource.get(entry.resource);
      if (route)
        feedTombstones.set(scopeFor(route, entry.context), {
          resource: entry.resource,
          context: entry.context,
          ids: new Set(entry.tombstones),
        });
      else unrestorable.push(entry);
    }
    for (const entry of outbox.feedCursors) {
      const route = byResource.get(entry.resource);
      if (route) feedCursors.set(scopeFor(route, entry.context), entry);
      else unrestorable.push(entry);
    }
    // Exhausted buckets outlive the process: a pause still in the future is
    // kept, so no write (nor read) counted against the bucket goes out early.
    pausedBuckets.clear();
    for (const entry of outbox.throttlingPauses)
      if (entry.until > Date.now())
        pausedBuckets.set(entry.bucket ?? '*', entry.until);
    // Under onAuthFailure 'retry' nothing blocks: a stored block (from a
    // client with 'block') is dropped and its writes resume.
    authBlock =
      options.onAuthFailure === 'retry' ? undefined : outbox.authBlock;
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
    let changed =
      outbox.rebuild.length > 0 ||
      (outbox.authBlock !== undefined && !authBlock);
    for (const entry of outbox.records) {
      const route = byResource.get(entry.resource);
      if (!route) {
        unrestorable.push(entry);
        continue;
      }
      const scope = scopeFor(route, entry.context);
      const key = keyFor(scope, entry.id);
      // An update stored for another body format than the document now
      // declares fails below, with the writes queued before it; behind a
      // create that cannot be, so the record's writes stay unrestorable.
      let staleAt = -1;
      entry.queue.forEach((stored, at) => {
        if (
          stored.type === 'update' &&
          (stored.updateBody ?? 'record') !== routeBody(route)
        )
          staleAt = at;
      });
      if (entry.queue.slice(0, staleAt + 1).some((w) => w.type === 'create')) {
        unrestorable.push(entry);
        continue;
      }
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
      // Not sent or replayed under a body format it was not made for: it
      // fails, and so does every write queued before it, since a failed
      // write is never newer than a queued one.
      let stale = -1;
      queue.forEach((write, at) => {
        if (bodyMismatch(write)) stale = at;
      });
      if (stale >= 0) {
        for (const write of queue.splice(0, stale + 1)) {
          write.state = 'failed';
          write.lastError = bodyMismatch(write)
            ? `This update was made for a ${writeBody(write)} body and the document now declares ${routeBody(write.route)}; discard it`
            : 'Queued before an update made for another body format, which failed on restore';
          delete write.lastStatus;
          failed.push(write);
        }
        changed = true;
      }
      // An update that had already failed says why it cannot be retried.
      for (const write of failed) {
        const message = `This update was made for a ${writeBody(write)} body and the document now declares ${routeBody(write.route)}; discard it`;
        if (bodyMismatch(write) && write.lastError !== message) {
          write.lastError = message;
          delete write.lastStatus;
          changed = true;
        }
      }
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
    const key = keyFor(scope, id);
    // An unavailable record keeps its last known values (§4.3).
    let value = remote(scope).get(id) ?? keptMarks.get(key)?.record;
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
          ...applyChanges(
            writeBody(write),
            value ?? write.lastKnown ?? lastKnownFor(scope, id),
            write.changes,
          ),
          [write.route.collection.idField]: id,
        };
      else value = undefined;
    }
    if (value) await storage.put(scope, id, value);
    else {
      await storage.delete(scope, id);
      seenAt.delete(key);
    }
  }

  function target(path: string, context: Record<string, string>): URL {
    const url = new URL(upstream);
    url.pathname =
      upstream.pathname.replace(/\/$/, '') + bindPath(path, context);
    return url;
  }

  /**
   * `received`, when given, gets the response's headers (lower-cased); with
   * `lenient`, a 2xx body that is not JSON reads as no body.
   */
  async function requestJson(
    request: TransportRequest,
    received?: { headers?: Record<string, string>; lenient?: boolean },
  ): Promise<unknown> {
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
    if (received)
      received.headers = Object.fromEntries(
        Object.entries(response.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      );
    try {
      return response.body ? JSON.parse(response.body) : undefined;
    } catch {
      if (received?.lenient) return undefined;
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
      // The provider accepted a write to the record: a tombstone a feed
      // reported for it earlier no longer says it is deleted, and the record
      // is no longer kept as unavailable (a delete removed it; any other
      // 2xx showed it readable).
      feedTombstones.get(write.scope)?.ids.delete(id);
      // A delete the app made itself is not told back as `present`.
      dropMark(key, remote(write.scope).get(id), write.type !== 'delete');
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
    // A compound create's follow-up (§4.7.2 steps 4-6): what is still
    // missing is worked out now, against the confirmed record (the create's
    // answer, or what a later read showed), so one that already applied is
    // settled without a request.
    let followUp:
      | { declared: FollowUp; url: URL; init: TransportRequest }
      | undefined;
    if (write.followUp) {
      const declared = route.create?.followUps?.find(
        (f) =>
          f.operation === write.followUp!.operation &&
          f.field === write.followUp!.field,
      );
      if (!declared) {
        write.followUp.reason = 'notSent';
        write.lastError = `The document no longer declares follow-up ${write.followUp.operation} for ${write.followUp.field}; not sent`;
        return { status: 'gaveUp' };
      }
      const created =
        remote(write.scope).get(write.id) ??
        write.lastKnown ??
        lastKnownFor(write.scope, write.id);
      const missing = missingValue(declared, write.followUp.planned, created);
      if (missing === NOTHING_MISSING) return settled(write, write.id);
      const request = followUpRequest(
        declared,
        write.followUp.planned,
        created,
        missing,
        write.context,
      );
      if (!request) {
        write.followUp.reason = 'notSent';
        write.lastError = `Follow-up ${declared.operation} for ${declared.field} could not be filled: a bound value resolves to nothing (CRUD Causality §4.7.2); not sent`;
        return { status: 'gaveUp' };
      }
      let url: URL;
      try {
        url = target(declared.path, request.path);
      } catch (error) {
        write.followUp.reason = 'notSent';
        write.lastError = `Follow-up ${declared.operation} for ${declared.field} could not be filled: ${error instanceof Error ? error.message : String(error)}; not sent`;
        return { status: 'gaveUp' };
      }
      for (const [name, value] of Object.entries(request.query))
        url.searchParams.set(name, value);
      followUp = {
        declared,
        url,
        init: {
          url,
          method: declared.method,
          headers: {
            ...(request.body !== undefined
              ? { 'content-type': 'application/json' }
              : {}),
            ...request.header,
          },
          ...(request.body !== undefined
            ? { body: JSON.stringify(request.body) }
            : {}),
        },
      };
    }
    // Taken when the request leaves, after the store below.
    let epoch = authEpoch;
    let sentAfterRenewal = false;
    /** A response other than a refusal of the credentials sent at `epoch`. */
    const accepted = (): void => {
      if (epoch === authEpoch) afterRenewal = false;
    };
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
      // Blocked by another write while this one was being stored.
      if (authBlock) {
        write.sending = false;
        return { status: 'held' };
      }
      epoch = authEpoch;
      sentAfterRenewal = afterRenewal;
      if (followUp) {
        // The answer is not the record (GitHub's lists the issue's labels):
        // nothing is merged; the next read shows the field.
        await requestJson(followUp.init, { lenient: true });
        delete write.followUp!.reason;
      } else if (write.type === 'delete') {
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
                ...applyChanges(
                  writeBody(write),
                  remote(write.scope).get(write.id) ??
                    write.lastKnown ??
                    lastKnownFor(write.scope, write.id),
                  write.changes,
                ),
                [idField]: write.id,
              };
        // A declared create: generated fields are the server's to set.
        const declared = write.type === 'create' ? route.create : undefined;
        const received: {
          headers?: Record<string, string>;
          lenient?: boolean;
        } = declared ? { lenient: true } : {};
        // A merge patch carries the changes alone; `data` is still the
        // record they make, which the response is merged over.
        const body =
          write.type === 'update' && writeBody(write) === 'mergePatch'
            ? (write.changes ?? {})
            : declared
              ? createBody(declared, data as Record<string, unknown>)
              : data;
        const result = await requestJson(
          {
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
              'content-type':
                write.type === 'update' && writeBody(write) === 'mergePatch'
                  ? (route.updateContentType ?? 'application/json')
                  : 'application/json',
              ...(write.idempotencyKey && route.idempotencyHeader
                ? { [route.idempotencyHeader]: write.idempotencyKey }
                : {}),
            },
            body: JSON.stringify(body),
          },
          received,
        );
        // CRUD Causality §4.3.2: the identity from the declared url source
        // (read back through the identity template) or the body's bound
        // fields. Without one the record exists but is unbound: never sent
        // again (uncertain, and resolveWrite retry refuses it).
        let identity: Record<string, unknown> | undefined;
        if (declared) {
          identity = createdIdentity(declared, result, received.headers ?? {});
          const id =
            identity?.[idField] ??
            (isRecord(result) ? result[idField] : undefined);
          if (!identity || id === undefined || id === null || id === '') {
            write.unbound = true;
            throw new UnusableResponseError(
              'Create response does not identify the created record as its x-crud declares (CRUD Causality §4.3.2); the record is unbound and is not sent again',
            );
          }
        } else if (write.type === 'create' && !isRecord(result)) {
          throw new UnusableResponseError('Create response has no record');
        }
        // An update's response may hold only some fields: merge it over the
        // record that was sent (the edit included), not over the copy from
        // before the edit, which would revert it.
        const record = identity
          ? withIdentity(
              isRecord(result)
                ? result
                : createBody(declared, data as Record<string, unknown>),
              identity,
            )
          : isRecord(result)
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
      accepted();
      return settled(write, resolvedId);
    } catch (error) {
      // Throttling under the document's x-throttling (a matching signal, or
      // a 429), with the earliest retry time; decided once per response.
      const throttled =
        error instanceof HttpStatusError
          ? classifyThrottling(throttling, {
              status: error.status,
              headers: error.headers,
              body: error.body,
              receivedAt: error.receivedAt,
            })
          : undefined;
      // The earliest retry time holds the write whatever path its class
      // takes below (uncertain, blocked, failed, retried): set it here, so
      // that a resolveWrite retry or authRenewed() never sends it earlier.
      if (throttled?.retryAt !== undefined)
        write.notBefore = Math.max(write.notBefore ?? 0, throttled.retryAt);
      // An exhausted bucket holds every write counted against it: until the
      // answer's time, or, without one, at least the client's base backoff,
      // whatever path the write's class takes below (the retry path extends
      // it to this write's own backoff).
      if (throttled?.meaning === 'quotaExhausted')
        pauseBucket(
          throttled.bucket,
          throttled.retryAt ?? Date.now() + retry.baseDelayMs,
        );
      const classified =
        error instanceof HttpStatusError
          ? classify(write, error, sentAfterRenewal, throttled)
          : undefined;
      let failureClass: WriteFailureClass = classified?.result ?? 'retry';
      // Any answer but a refusal shows the credentials were accepted; a 403
      // failed only because of the renewal is still a refusal.
      if (
        (classified && !classified.refused) ||
        error instanceof UnusableResponseError
      )
        accepted();
      if (failureClass === 'auth' && options.onAuthFailure === 'retry')
        failureClass = 'retry';
      // A create that may have been applied (a classifier calling a 5xx
      // `auth`) is not resent after a renewal without a usable key: the
      // `retry` path below makes it uncertain.
      if (
        failureClass === 'auth' &&
        write.type === 'create' &&
        mayHaveApplied(error) &&
        !usableKey(write)
      )
        failureClass = 'retry';
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
        if (epoch !== authEpoch)
          return {
            status: 'retry',
            // Not before a throttling answer's time, though (a custom
            // classifier may call a throttled response auth).
            delayMs: Math.max(0, (throttled?.retryAt ?? 0) - Date.now()),
          };
        write.lastError = message;
        if (status !== undefined) write.lastStatus = status;
        return { status: 'blocked' };
      }
      write.attempts += 1;
      write.lastError = message;
      if (status === undefined) delete write.lastStatus;
      else write.lastStatus = status;
      if (failureClass === 'permanent') {
        // A refused follow-up leaves its create partly applied (§4.7.2 step 6).
        if (write.followUp) write.followUp.reason = 'refused';
        return { status: 'gaveUp' };
      }
      // A follow-up whose outcome is unknown is not sent again before the
      // record is read back (§4.7.2 step 6): it waits for a complete read of
      // its collection, and is sent then only if the field is still missing.
      // A throttled answer is a refusal to wait out, not an unknown outcome.
      if (write.followUp && !throttled && mayHaveApplied(error)) {
        write.followUp.reason = 'unknown';
        write.awaitingRefresh = true;
        return { status: 'retry', delayMs: 0 };
      }
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
      const backoff = Math.min(
        retry.baseDelayMs * 2 ** (write.attempts - 1),
        retry.maxDelayMs,
      );
      if (throttled) {
        // The earliest retry time of the Throttling extension: the write is
        // never sent before it (nor below the backoff, so a time already
        // past cannot make a tight loop). It is stored with the write
        // (`notBefore`), so a restart or a resolveWrite retry keeps it. A
        // wait longer than retry.maxRetryAfterMs is not cut short: the write
        // gives up instead, as the extension allows, and resolveWrite can
        // retry it (which waits out the stored time, or fails again).
        const now = Date.now();
        const notBefore = Math.max(throttled.retryAt ?? 0, now + backoff);
        write.notBefore = notBefore;
        // A quotaExhausted answer without a time pauses its bucket until
        // this write's own backoff (the consumer's floor), not only the base
        // backoff set above.
        if (throttled.meaning === 'quotaExhausted' && !throttled.retryAt)
          pauseBucket(throttled.bucket, notBefore);
        const wait = notBefore - now;
        if (wait > retry.maxRetryAfterMs) {
          write.lastError = `${message}; the API asks to wait until ${new Date(
            notBefore,
          ).toISOString()}, longer than retry.maxRetryAfterMs (${retry.maxRetryAfterMs} ms); not retried`;
          return { status: 'gaveUp' };
        }
        return {
          status: 'retry',
          delayMs: Math.min(wait, MAX_TIMER_MS),
        };
      }
      const asked =
        error instanceof HttpStatusError
          ? retryAfterMs(error.headers)
          : undefined;
      // A Retry-After on another retryable answer (a 503, say) only
      // lengthens the wait (never below the backoff, so "0", a past date or
      // a fast clock cannot make a tight loop), up to retry.maxRetryAfterMs.
      return {
        status: 'retry',
        delayMs: Math.min(
          Math.max(backoff, Math.min(asked ?? 0, retry.maxRetryAfterMs)),
          MAX_TIMER_MS,
        ),
      };
    }
  }

  /**
   * Holds back every write counted against `bucket` (all writes when the
   * signal names none) until `until`: a `quotaExhausted` answer says the
   * bucket refuses every request until it resets, not only the one sent.
   */
  function pauseBucket(bucket: string | undefined, until: number): void {
    const key = bucket ?? '*';
    pausedBuckets.set(key, Math.max(pausedBuckets.get(key) ?? 0, until));
  }

  /** The pauses still in the future, for the outbox. */
  function storedThrottlingPauses(): {
    throttlingPauses?: StoredThrottlingPause[];
  } {
    const now = Date.now();
    const pauses = [...pausedBuckets]
      .filter(([, until]) => until > now)
      .map(([key, until]) => ({ bucket: key === '*' ? null : key, until }));
    return pauses.length ? { throttlingPauses: pauses } : {};
  }

  /** How long a request to `operation` must wait for its exhausted buckets; 0 when none. */
  function pauseForOperation(operation: OperationObject | undefined): number {
    return Math.max(0, pausedUntil(operation) - Date.now());
  }

  /** When the exhausted buckets `operation` counts against reset (ms since the epoch); 0 when none is paused. */
  function pausedUntil(operation: OperationObject | undefined): number {
    if (!pausedBuckets.size) return 0;
    const now = Date.now();
    for (const [key, until] of pausedBuckets)
      if (until <= now) pausedBuckets.delete(key);
    let until = pausedBuckets.get('*') ?? 0;
    for (const bucket of throttling
      ? operationBuckets(throttling, operation)
      : [])
      until = Math.max(until, pausedBuckets.get(bucket) ?? 0);
    return until;
  }

  /** How long a write must wait for an exhausted bucket its operation counts against; 0 when none. */
  function pauseFor(write: QueuedWrite): number {
    return pauseForOperation(writeOperation(write));
  }

  /** The OpenAPI operation a write is sent to, for its bucket selection. */
  function writeOperation(write: QueuedWrite): OperationObject | undefined {
    const { route } = write;
    if (write.type === 'create')
      return route.createPath ? doc.paths[route.createPath]?.post : undefined;
    if (write.type === 'delete')
      return route.deletePath ? doc.paths[route.deletePath]?.delete : undefined;
    const item = route.collection.itemUrl
      ? doc.paths[route.collection.itemUrl]
      : undefined;
    return route.updateMethod === 'PATCH' ? item?.patch : item?.put;
  }

  /**
   * The class of a failed write, and whether the response refused the
   * credentials: classified `auth`, or, for a request sent after a renewal,
   * classified `auth` by the same classifier with `afterRenewal: false` (a
   * 403 made `permanent` by the renewal rule). For such a request a custom
   * classifier is called twice.
   */
  function classify(
    write: QueuedWrite,
    error: HttpStatusError,
    sentAfterRenewal: boolean,
    throttled: ThrottlingVerdict | undefined,
  ): { result: WriteFailureClass; refused: boolean } {
    const followUpMethod = write.followUp
      ? write.route.create?.followUps?.find(
          (f) => f.operation === write.followUp!.operation,
        )?.method
      : undefined;
    const failure: WriteFailure = {
      type: write.type,
      method:
        followUpMethod ??
        (write.type === 'create'
          ? 'POST'
          : write.type === 'delete'
            ? 'DELETE'
            : (write.route.updateMethod as 'PUT' | 'PATCH')),
      status: error.status,
      headers: { ...error.headers },
      body: error.body,
      resource: write.route.collection.name,
      id: write.id,
      afterRenewal: sentAfterRenewal,
      ...(throttled ? { throttling: throttled } : {}),
      signalsDeclared: throttling?.signals !== undefined,
      ...(write.followUp
        ? {
            followUp: {
              operation: write.followUp.operation,
              field: write.followUp.field,
            },
          }
        : {}),
    };
    let result = classOf(failure);
    if (result === 'satisfied' && write.type !== 'delete') result = 'permanent';
    const refused =
      result === 'auth' ||
      (sentAfterRenewal &&
        classOf({ ...failure, afterRenewal: false }) === 'auth');
    return { result, refused };
  }

  /** The classifier in use, falling back to the default. */
  function classOf(failure: WriteFailure): WriteFailureClass {
    if (options.classifyWriteFailure) {
      try {
        const custom = options.classifyWriteFailure({
          ...failure,
          headers: { ...failure.headers },
        });
        if (FAILURE_CLASSES.has(custom)) return custom;
      } catch {
        // Falls back to the default classification.
      }
    }
    return defaultWriteFailureClass(failure);
  }

  /** The follow-up writes of a settled compound create, in order (§4.7.2 step 4). */
  function followUpWrites(create: QueuedWrite, id: string): QueuedWrite[] {
    const planned = create.data ?? {};
    return (create.route.create?.followUps ?? [])
      .filter((f) => missingValue(f, planned, undefined) !== NOTHING_MISSING)
      .map((f) => ({
        route: create.route,
        scope: create.scope,
        context: create.context,
        id,
        type: 'update' as const,
        changes: {},
        attempts: 0,
        state: 'pending' as const,
        seq: nextSeq++,
        followUp: { operation: f.operation, field: f.field, planned },
        ...(create.confirmedId !== undefined ? { awaitingRefresh: true } : {}),
      }));
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
        // An exhausted bucket (a quotaExhausted signal) holds back every
        // write counted against it until it resets, and a write's own stored
        // `notBefore` (a throttling answer's time, kept across restarts and
        // resolveWrite retries) holds it back too. A hold longer than
        // retry.maxRetryAfterMs fails the write with a lastError saying why,
        // as the write's own answer would, instead of waiting unseen.
        let outcome: WriteOutcome;
        const held = Math.max(
          pauseFor(write),
          (write.notBefore ?? 0) - Date.now(),
        );
        if (held > retry.maxRetryAfterMs) {
          const until = new Date(Date.now() + held).toISOString();
          write.lastError = `Held until ${until} by a rate limit the API declared exhausted, longer than retry.maxRetryAfterMs (${retry.maxRetryAfterMs} ms); not sent`;
          outcome = { status: 'gaveUp' };
        } else if (held > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(held, MAX_TIMER_MS));
            if (typeof timer.unref === 'function') timer.unref();
            wakers.set(key, () => {
              clearTimeout(timer);
              resolve();
            });
          });
          wakers.delete(key);
          continue;
        } else {
          outcome = await attemptWrite(write);
        }
        write.sending = false;
        // Its record went missing while it was in flight. Answered without
        // settling (a retry, a refused credential, not sent), it is not
        // resent on the stale copy: it waits for a sync to check the record.
        if (write.holdIfQueued) {
          delete write.holdIfQueued;
          if (
            outcome.status === 'retry' ||
            outcome.status === 'blocked' ||
            outcome.status === 'held'
          )
            write.awaitingRefresh = true;
        }
        if (outcome.status === 'held') {
          await persistLater();
          // The check at the top stops here while blocked; an authRenewed()
          // during the store finds this queue draining, so go on here.
          continue;
        }
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
          // As for 'held': stops at the top unless renewed meanwhile.
          continue;
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
            wakers.set(key, () => {
              clearTimeout(timer);
              resolve();
            });
          });
          wakers.delete(key);
          continue;
        }
        queue.shift();
        if (outcome.status === 'gaveUp') {
          write.state = 'failed';
          gaveUpWrites.set(key, [...(gaveUpWrites.get(key) ?? []), write]);
          // §4.7.2 step 6: the create is partly applied; the later
          // follow-ups of the same create are not sent in this attempt (they
          // may depend on this one). Writes the app queued after the create
          // go on as usual.
          if (write.followUp)
            while (queue[0]?.followUp && queue[0].state === 'pending') {
              const next = queue.shift() as QueuedWrite;
              next.state = 'failed';
              next.followUp!.reason = 'notSent';
              next.lastError = `Not sent: follow-up ${write.followUp.operation} for ${write.followUp.field} of the same create did not apply`;
              gaveUpWrites.set(key, [...(gaveUpWrites.get(key) ?? []), next]);
            }
        } else {
          supersede(key, write);
          rebase(queue, write, outcome.resolvedId);
          // A compound create that is bound (§4.7.2 step 3): its follow-ups go
          // first, before writes the app queued after the create. After a
          // resolveWrite confirm the created object is not known, so they
          // wait for it to be read back.
          if (write.type === 'create' && write.route.create?.followUps)
            queue.unshift(...followUpWrites(write, outcome.resolvedId));
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
          // The create's follow-ups go first (§4.7.2 step 4), ahead of writes
          // already queued under the server's id, but never ahead of a head
          // another worker may have in flight.
          const followUps = rest.filter((w) => w.followUp);
          const at = existing.length && draining.has(key) ? 1 : 0;
          existing.splice(at, 0, ...followUps);
          existing.push(...rest.filter((w) => !w.followUp));
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
  /**
   * Whether `later` (settled, or queued ahead) makes a failed follow-up
   * moot: a delete of the record, or an app update that sets the
   * follow-up's field. The match is on the field's first path segment, as
   * updates change top-level fields: an update of `meta` supersedes a
   * follow-up of `meta.tags`, which may drop a follow-up whose nested value
   * the update left alone, the cautious direction (nothing sent over the
   * app's edit).
   */
  function supersedesFollowUp(
    followUp: QueuedWrite,
    later: QueuedWrite,
  ): boolean {
    const top = followUp.followUp!.field.split('.')[0] as string;
    return (
      later.type === 'delete' ||
      (later.type === 'update' &&
        !later.followUp &&
        Object.hasOwn(later.changes ?? {}, top))
    );
  }

  function supersede(key: string, settled: QueuedWrite): void {
    const failed = gaveUpWrites.get(key);
    if (!failed) return;
    const left = failed.filter((write) => {
      if (write.type !== 'update') return false;
      // A failed follow-up has no changes of its own: it stays until a
      // settled write sets its field (or deletes the record).
      if (write.followUp) return !supersedesFollowUp(write, settled);
      write.changes = withoutSetBy(write, settled);
      return Object.keys(write.changes).length > 0;
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
      // A merge patch's value is the field after the patch (`null`: the
      // field is absent): applied to the write's own base, and to the value
      // the queued writes before it leave. Failed writes are not chained:
      // the provider did not apply them.
      const ours = new Map<string, unknown[]>();
      const latest = new Map<string, unknown>();
      const failed = new Set(gaveUpWrites.get(key) ?? []);
      const expected = new Map<QueuedWrite, Map<string, unknown[]>>();
      for (const write of writes) {
        if (write.scope !== scope || write.type !== 'update') continue;
        const after = new Map<string, unknown[]>();
        for (const [field, local] of Object.entries(write.changes ?? {})) {
          if (writeBody(write) !== 'mergePatch') {
            after.set(field, [local]);
          } else {
            const values = [patchedField(write.base?.[field], local)];
            if (latest.has(field))
              values.push(patchedField(latest.get(field), local));
            after.set(field, values);
          }
          const values = after.get(field) as unknown[];
          ours.set(field, [...(ours.get(field) ?? []), ...values]);
          if (!failed.has(write)) latest.set(field, values[values.length - 1]);
        }
        expected.set(write, after);
      }
      // Any value one of this client's writes gives the field, earlier or
      // later, is not a remote change.
      for (const [write, after] of expected)
        checkConflicts(write, records.get(write.id), ours, after);
    }
  }

  /** `after`: each changed field's possible values once this write applies. */
  function checkConflicts(
    write: QueuedWrite,
    next: Record<string, unknown> | undefined,
    ours: Map<string, unknown[]>,
    after: Map<string, unknown[]>,
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
        after.get(field)?.some((own) => sameValue(own, value)) ||
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

  /** Whether a GET operation pages, or declares an x-pagination that cannot be applied. */
  function paginated(operation: OperationObject | undefined): boolean {
    try {
      return (
        resolveEffectiveScheme(doc, operation ?? { responses: {} }) !==
        undefined
      );
    } catch {
      return true;
    }
  }

  /** The operation a read request goes to; a POST list read (listMethod POST) is its path's post. */
  function readOperation(
    request: TransportRequest,
  ): OperationObject | undefined {
    const path = request.url.pathname.slice(
      upstream.pathname.replace(/\/$/, '').length,
    );
    const matched = findRoute(Object.keys(doc.paths), path);
    return matched
      ? doc.paths[matched.template]?.[
          request.method === 'POST' ? 'post' : 'get'
        ]
      : undefined;
  }

  /**
   * A read counts against the same buckets as a write: it waits out an
   * exhausted bucket (a quotaExhausted answer to any request) within what
   * `remainingMs` says is left of the read's own time, else stops with
   * RetryBeyondDeadline. Checked again after each sleep, in case another
   * answer extended the pause meanwhile; a pause that did not move is taken
   * as waited out (the `sleep` option may return early, in tests).
   */
  async function waitOutPauses(
    operation: OperationObject | undefined,
    remainingMs: () => number,
  ): Promise<void> {
    let sleptUntil = 0;
    for (;;) {
      // The pause's own end, not now plus what is left of it: a clock tick
      // between two readings must not look like a pause that moved later.
      const until = pausedUntil(operation);
      const paused = until - Date.now();
      if (paused <= 0) return;
      if (until <= sleptUntil) return;
      const remaining = remainingMs();
      if (paused > remaining)
        throw new RetryBeyondDeadline(
          `A rate limit the API declared exhausted holds this request until ${new Date(until).toISOString()}, longer than the read's remaining time (${remaining} ms)`,
        );
      await (options.sleep ?? defaultSleep)(paused);
      sleptUntil = until;
    }
  }

  /** A read's own quotaExhausted answer pauses the bucket for every request, writes included. */
  async function noteReadThrottling(
    response: TransportResponse,
    receivedAt: number,
  ): Promise<void> {
    const throttled = classifyThrottling(throttling, {
      status: response.status,
      headers: lowerCaseHeaders(response.headers),
      body: response.body,
      receivedAt,
    });
    if (throttled?.meaning !== 'quotaExhausted') return;
    // Without a time and a bucket window, the client's base backoff is the
    // floor, as for a write.
    pauseBucket(
      throttled.bucket,
      throttled.retryAt ?? receivedAt + retry.baseDelayMs,
    );
    await persistLater();
  }

  const readLimitMs =
    options.limits?.timeoutMs ?? DEFAULT_READ_LIMITS.timeoutMs;

  const conditionalTransport: Transport = async (request) => {
    const operation = readOperation(request);
    // A paginated operation is not cached conditionally. An explicit
    // x-pagination that cannot be applied counts as paginated here; the read
    // itself fails on it (walkPages).
    const cacheable = request.method === 'GET' && !paginated(operation);
    const key = request.url.href;
    const cached = cacheable ? conditionalCache.get(key) : undefined;
    const headers = { ...request.headers };
    if (cached?.headers['etag'])
      headers['if-none-match'] = cached.headers['etag'];
    if (cached?.headers['last-modified'])
      headers['if-modified-since'] = cached.headers['last-modified'];
    // What is left of the read's time: the running sync's budget (this
    // transport serves only sync()), else the whole limit.
    await waitOutPauses(
      operation,
      () => activeBudget?.remainingMs() ?? readLimitMs,
    );
    const raw = await readTransport({ ...request, headers });
    const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
    await noteReadThrottling(response, Date.now());
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
      // The head's backoff wait (if it was between retries) ends with it:
      // the queue goes on, or the drain stops, without waiting it out.
      if (at === 0) wakers.get(key)?.();
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

  /** What a sync learned about one missing record. */
  interface Evidence {
    evidence: MissingRecordEvidence;
    source: MissingRecord['source'];
    status?: number;
    record?: Record<string, unknown>;
    /** Why, for `lastError`. */
    detail: string;
  }

  /** Per-sync bookkeeping of deletion feeds. */
  interface SyncRound {
    /** Feeds to read at the end of the sync, after every evidence GET. */
    feeds: {
      route: ClientRoute;
      scope: string;
      context: Record<string, string>;
    }[];
    /**
     * Missing records of collections with a feed that this sync's GETs did
     * not decide: unchecked (budget spent, `found` absent) or `unknown`.
     */
    undecided: {
      scope: string;
      context: Record<string, string>;
      id: string;
      found?: Evidence;
      /** `recordRevisions` when the check began. */
      revision: number;
      previous: Record<string, unknown> | undefined;
      /** A record without writes (`missingRecordChecks: 'all'`). */
      vanished?: true;
      /**
       * A tombstone stored from an earlier feed read: `deleted` unless this
       * sync's complete feed read has a later item about the record that
       * is not a tombstone.
       */
      stored?: true;
    }[];
    /** A stored tombstone was dropped: the outbox is stored at the end. */
    tombstonesChanged: boolean;
    /**
     * Record keys whose stored tombstone this sync dropped because a read
     * returned the record (list or `filtered` GET): the feed read at the
     * end does not store a tombstone for them again.
     */
    superseded: Set<string>;
    /** `recordRevisions` when the sync began. */
    startedRecords: Map<string, number>;
    /**
     * Ids this sync's read returned, per scope (collection and bound
     * context): a member is exempt from its parent's mark only when this
     * read returned it under the same identity, parent included.
     */
    returned: Map<string, Set<string>>;
    /** Presence changes this sync told (`onPresence`). */
    presence: PresenceChange[];
    /** Records without writes looked up so far (`maxMissingRecordChecks`). */
    lookups: number;
    /** The first error a presence handler threw; `sync()` rejects with it. */
    presenceError?: unknown;
    /** Scopes whose read was not applied because the handler threw. */
    skipped: Set<string>;
  }

  /** A record a sync may rebuild, with what it knows about why. */
  interface RebuildTarget {
    scope: string;
    id: string;
    route: ClientRoute;
    context: Record<string, string>;
    found?: Evidence;
  }

  /** A presence change's record identity, for keeping one per record. */
  function changeKey(change: PresenceChange): string {
    return JSON.stringify([change.collection, change.context, change.id]);
  }

  /**
   * Tells the app `removing` (records about to be removed), or, called with
   * none at the end of the sync, the mark changes held until then. Mark
   * changes are held to the end so each record is told once per sync, with
   * its latest change; a removal drops a held change of the same record. True
   * when told: the caller may then remove them. On an error the changes are
   * not recorded and the error is kept for `sync()`.
   */
  async function tell(
    round: SyncRound,
    removing: PresenceChange[],
  ): Promise<boolean> {
    // Removals are told at once and replace a held change of the same
    // record; held mark changes (one per record, the latest: a record marked
    // unconfirmed and settled in the same sync is told only as settled) are
    // told at the end of the sync.
    const changes = removing.length ? removing : [...untoldMarks.values()];
    if (!changes.length) return true;
    try {
      await options.onPresence?.(changes.map((c) => structuredClone(c)));
    } catch (error) {
      round.presenceError ??= error;
      return false;
    }
    if (removing.length)
      for (const change of removing) untoldMarks.delete(changeKey(change));
    else {
      untoldMarks.clear();
      for (const change of changes) {
        const route = byResource.get(change.collection);
        const mark =
          route &&
          keptMarks.get(
            keyFor(scopeFor(route, change.context ?? {}), change.id),
          );
        if (mark && change.presence !== 'present') mark.told = true;
      }
    }
    round.presence.push(...changes);
    return true;
  }

  /** A presence change for a record of `route`'s collection. */
  function presenceChange(
    route: ClientRoute,
    context: Record<string, string>,
    id: string,
    presence: PresenceChange['presence'],
    source: MissingRecord['source'],
    record: Record<string, unknown> | undefined,
    pruned: boolean,
  ): PresenceChange {
    return {
      collection: route.collection.name,
      ...(Object.keys(context).length ? { context: { ...context } } : {}),
      id,
      presence,
      source,
      ...(record ? { record: structuredClone(record) } : {}),
      pruned,
    };
  }

  /**
   * Marks a record the local copy keeps although a read did not return it;
   * a new or changed mark is a presence change of the running sync.
   */
  function setMark(
    route: ClientRoute,
    context: Record<string, string>,
    id: string,
    presence: PresenceMarkValue,
    record: Record<string, unknown>,
    detail: string,
    source: MissingRecord['source'],
  ): void {
    const scope = scopeFor(route, context);
    const key = keyFor(scope, id);
    const before = keptMarks.get(key);
    const lastSeen = before?.lastSeen ?? seenAt.get(key);
    keptMarks.set(key, {
      scope,
      resource: route.collection.name,
      context: { ...context },
      id,
      record: structuredClone(record),
      detail,
      source,
      presence,
      ...(lastSeen ? { lastSeen } : {}),
      ...(before?.told ? { told: true as const } : {}),
    });
    if (before?.presence !== presence) {
      const change = presenceChange(
        route,
        context,
        id,
        presence,
        source,
        record,
        false,
      );
      untoldMarks.delete(changeKey(change));
      untoldMarks.set(changeKey(change), change);
    }
  }

  /**
   * Drops a record's mark outside `tell` and `setMark` (a write settled on
   * it, or a check settled a clearing mark): a held change of it is dropped
   * too, and, when the app has been told a mark of the record and
   * `tellPresent` holds, replaced by a `present` change with `record`.
   */
  function dropMark(
    key: string,
    record: Record<string, unknown> | undefined,
    tellPresent = true,
  ): void {
    const mark = keptMarks.get(key);
    if (!mark) return;
    keptMarks.delete(key);
    const route = byResource.get(mark.resource);
    if (!route) return;
    const change = presenceChange(
      route,
      mark.context,
      mark.id,
      'present',
      'read',
      record ?? mark.record,
      false,
    );
    untoldMarks.delete(changeKey(change));
    if (mark.told && tellPresent) untoldMarks.set(changeKey(change), change);
  }

  /**
   * Rebuilds records, telling the app first about each one the rebuild
   * removes from the local copy (no confirmed copy, no kept mark, no stored
   * write, but a stored record now). If the handler throws, those records
   * are left as they are (the next complete read tells again) and the error
   * is kept for `sync()`.
   */
  async function rebuildTelling(
    targets: RebuildTarget[],
    round: SyncRound,
  ): Promise<void> {
    const removing: PresenceChange[] = [];
    // The scope of each change in `removing`, by position.
    const removingScopes: string[] = [];
    const held = new Set<string>();
    for (const target of targets) {
      const key = keyFor(target.scope, target.id);
      const mark = keptMarks.get(key);
      const stays =
        remote(target.scope).has(target.id) ||
        allWrites().some(
          (w) =>
            w.scope === target.scope &&
            w.id === target.id &&
            w.durable !== false,
        );
      // A clearing mark on a record that stays is settled.
      if (mark?.clearing && stays)
        dropMark(
          key,
          target.found?.record ?? remote(target.scope).get(target.id),
        );
      if (stays || (mark && !mark.clearing)) continue;
      const stored = await storage.get(target.scope, target.id);
      if (!stored) continue;
      held.add(key);
      removing.push({
        collection: target.route.collection.name,
        ...(Object.keys(target.context).length
          ? { context: { ...target.context } }
          : {}),
        id: target.id,
        presence: target.found?.evidence === 'deleted' ? 'deleted' : 'removed',
        source: target.found?.source ?? 'read',
        // A `filtered` check carries the record as just read; else the
        // values the local copy held.
        record: target.found?.record ?? stored,
        pruned: true,
      });
      removingScopes.push(target.scope);
    }
    const told = removing.length ? await tell(round, removing) : true;
    // Told: the clearing marks of the removed records go. Not told: they
    // stay, not clearing any more: an `unconfirmed` mark is checked again
    // by a later sync; an `unavailable` or `deleted` one stays until a read
    // settles it.
    for (const target of targets) {
      const key = keyFor(target.scope, target.id);
      const mark = keptMarks.get(key);
      if (!mark?.clearing || !held.has(key)) continue;
      if (told) keptMarks.delete(key);
      else delete mark.clearing;
    }
    // A write queued, or a confirmed copy set, while the app was told keeps
    // the record: told, but not removed after all.
    if (told)
      removing.forEach((change, at) => {
        const scope = removingScopes[at] as string;
        if (
          remote(scope).has(change.id) ||
          allWrites().some((w) => w.scope === scope && w.id === change.id)
        )
          change.pruned = false;
      });
    for (const target of targets)
      if (told || !held.has(keyFor(target.scope, target.id)))
        await rebuild(target.scope, target.id);
  }

  function feedEvidence(route: ClientRoute): Evidence {
    return {
      evidence: 'deleted',
      source: 'feed',
      detail: `the deletion feed ${route.deletionFeed?.operationId} reports it deleted`,
    };
  }

  /**
   * Fails the held updates at the head of a missing record's queue, oldest
   * first, on `deleted` or `unknown` evidence. True when one failed.
   */
  function failMissing(
    scope: string,
    id: string,
    found: Evidence,
    previous: Record<string, unknown> | undefined,
    released: Set<QueuedWrite>,
  ): boolean {
    const key = keyFor(scope, id);
    // Also holds updates queued while the record was being checked.
    holdMissing(key);
    let failed = false;
    for (let head = evidenceHead(key); head; head = evidenceHead(key)) {
      // A held delete is sent unless the record is unavailable: a deleted
      // or missing record answers it 404 (settled), an existing one is
      // deleted as asked. A record kept as unavailable stays held on an
      // `unknown` answer: only `deleted` or `filtered` (which clear the
      // mark) release it, and `unavailable` fails it.
      if (
        head.type === 'delete' &&
        keptMarks.has(key) &&
        found.evidence === 'unknown'
      )
        break;
      if (head.type === 'delete' && found.evidence !== 'unavailable') {
        delete head.awaitingRefresh;
        delete head.refreshMisses;
        released.add(head);
        failed = true;
        // Between retries: sent now that the read has decided.
        wakers.get(key)?.();
        continue;
      }
      failWrite(head, missingMessage(head, found), previous);
      head.missingRecord =
        found.evidence === 'filtered' ? 'unknown' : found.evidence;
      if (found.status !== undefined) head.lastStatus = found.status;
      released.add(head);
      failed = true;
    }
    // §4.3: nothing queued for an unavailable record is sent without a
    // decision, deletes included. The rest of the queue fails in order (a
    // failed write stays older than every queued one); a create is parked
    // in place, as a refused create is, and holds back what follows it. A
    // head in flight, not yet stored, or already parked ends this.
    if (found.evidence === 'unavailable')
      for (;;) {
        const head = writeQueues.get(key)?.[0];
        if (
          !head ||
          head.sending ||
          head.durable === false ||
          head.state !== 'pending'
        )
          break;
        if (head.type === 'create') {
          head.state = 'failed';
          head.lastError = missingMessage(head, found);
          delete head.awaitingRefresh;
        } else failWrite(head, missingMessage(head, found), previous);
        head.missingRecord = 'unavailable';
        if (found.status !== undefined) head.lastStatus = found.status;
        released.add(head);
        failed = true;
        if (head.type === 'create') break;
      }
    return failed;
  }

  /**
   * A new write into a nested scope whose parent is concluded gone
   * (`goneParents`): concluded at once with the parent's conclusion, so it
   * is not sent on a record the client cannot read.
   */
  async function concludeNew(
    scope: string,
    id: string,
    found: Evidence,
  ): Promise<void> {
    const released = new Set<QueuedWrite>();
    if (
      failMissing(
        scope,
        id,
        found,
        remote(scope).get(id) ?? lastKnownFor(scope, id),
        released,
      )
    ) {
      await persistLater();
      await rebuild(scope, id);
    }
  }

  function missingMessage(write: QueuedWrite, found: Evidence): string {
    if (found.evidence === 'deleted')
      return `Record ${write.id} was deleted at the provider (${found.detail}); not sent`;
    if (found.evidence === 'unavailable')
      return `Record ${write.id} is unavailable at the provider (${found.detail}); not sent without a decision: retry or discard it with resolveWrite`;
    return `Record ${write.id} is not in the refreshed collection ${write.route.collection.name} (filtered or deleted remotely; ${found.detail}); not sent, to avoid a partial update`;
  }

  /**
   * Holds the updates of a record a complete read lacked: each queued update
   * up to the record's first create, apart from one in flight, waits
   * (`awaitingRefresh`) instead of being sent on the last known copy.
   */
  function holdMissing(key: string): void {
    for (const write of writeQueues.get(key) ?? []) {
      if (write.type === 'create') return;
      // A delete waits too: it is not sent for a record that may be
      // unavailable (§4.3, §7) before its read says what became of it.
      if (write.sending) write.holdIfQueued = true;
      else write.awaitingRefresh = true;
    }
  }

  /**
   * The update a missing record's evidence may fail: the head of the
   * record's queue, held, stored, pending and not in flight. A write behind
   * an earlier unsettled one is never failed: that would make a failed write
   * newer than a queued one, which a settle then drops.
   */
  function evidenceHead(key: string): QueuedWrite | undefined {
    const head = writeQueues.get(key)?.[0];
    return head &&
      (head.type === 'update' || head.type === 'delete') &&
      head.awaitingRefresh &&
      head.state === 'pending' &&
      !head.sending &&
      head.durable !== false
      ? head
      : undefined;
  }

  /**
   * Reads the collection's deletion feed once (`x-deletion-feed`), through
   * the sync's budget, from the stored cursor, and returns the ids whose
   * last item in the read is a tombstone (`tombstones`), and those whose
   * last item is not one (`others`). Its items count against
   * `limits.maxRecords` on their own, from 0. A read that does not
   * complete (a non-2xx page, a body without the declared items or cursor,
   * the budget or record limit spent) yields no ids and leaves the cursor
   * as it was, apart from a declared expired status: its body's cursor
   * replaces the stored one, else the stored one is dropped. A changed
   * cursor is stored in the outbox. A complete read also updates the stored
   * tombstones of records with unsettled writes (`feedTombstones`).
   */
  async function readFeed(
    route: ClientRoute,
    scope: string,
    context: Record<string, string>,
    budget: Budget,
    round: SyncRound,
  ): Promise<{
    complete: boolean;
    tombstones: Set<string>;
    others: Set<string>;
  }> {
    const incomplete = {
      complete: false,
      tombstones: new Set<string>(),
      others: new Set<string>(),
    };
    const feed = route.deletionFeed as DeletionFeed;
    const stored = feedCursors.get(scope);
    const cursor =
      feed.cursor && stored?.operation === feed.operationId
        ? stored.cursor
        : undefined;
    let changed = false;
    const setCursor = (value: unknown): void => {
      if (typeof value === 'string' || Number.isFinite(value)) {
        const text = String(value);
        if (stored?.operation === feed.operationId && stored.cursor === text)
          return;
        feedCursors.set(scope, {
          resource: route.collection.name,
          context: { ...context },
          operation: feed.operationId,
          cursor: text,
        });
        changed = true;
      } else if (feedCursors.delete(scope)) changed = true;
    };
    const last = new Map<string, boolean>();
    let body: unknown;
    let count = 0;
    const feedOutcome: WalkOutcome = { complete: false };
    try {
      for await (const page of walkPages({
        document: doc,
        operation: feed.operation,
        budget,
        upstream,
        path: bindPath(feed.path, context),
        method: 'GET',
        query:
          cursor !== undefined && feed.cursor
            ? { [feed.cursor.parameter]: cursor }
            : {},
        body: {},
        itemsField: feed.itemsField,
        // Items that are not objects are skipped, as the README says.
        skipNonObjects: true,
        // The whole item is its identity (Pagination Schemes §4.4.5, "else
        // the whole item"): a change list may name one record in several
        // items, so the record id would refuse a valid feed.
        identity: (item) => JSON.stringify(item),
        outcome: feedOutcome,
      })) {
        body = page.body;
        count += page.items.length;
        // As for a collection read: more items than the limit is incomplete.
        if (count > budget.limits.maxRecords)
          throw new BudgetExhausted(
            `Deletion feed read exceeds ${budget.limits.maxRecords} records`,
          );
        for (const item of page.items) {
          const id = asText(readNestedField(item, feed.idField));
          if (!id) continue;
          // The last item about a record decides: oldest first (§4.1).
          last.set(id, !feed.tombstone || isTombstone(item, feed.tombstone));
        }
      }
    } catch (error) {
      if (
        error instanceof PageStatusError &&
        feed.cursor?.expiredStatuses.includes(error.status)
      ) {
        let refused: unknown;
        try {
          refused = JSON.parse(error.body);
        } catch {
          refused = undefined;
        }
        setCursor(
          isRecord(refused)
            ? readNestedField(refused, feed.cursor.responseField)
            : undefined,
        );
        if (changed) await persistLater();
      }
      return incomplete;
    }
    // A feed read that ended without an error but not completely (a short
    // page whose end is not documented, say) gives no tombstones and leaves
    // the cursor where it was.
    if (!feedOutcome.complete) return incomplete;
    if (feed.cursor) {
      const next = isRecord(body)
        ? readNestedField(body, feed.cursor.responseField)
        : undefined;
      // Without the next cursor the read does not have the declared shape.
      if (typeof next !== 'string' && !Number.isFinite(next)) return incomplete;
      setCursor(next);
    }
    const tombstones = new Set(
      [...last].filter(([, tomb]) => tomb).map(([id]) => id),
    );
    const others = new Set(
      [...last].filter(([, tomb]) => !tomb).map(([id]) => id),
    );
    // Kept for the next sync (and a restart), only for records with
    // unsettled writes; a later item that is not a tombstone removes one.
    for (const [id, tomb] of last) {
      const ids = storedTombstones(scope, route, context);
      const key = keyFor(scope, id);
      // Not after this sync saw the record exist: a read returned it, or a
      // write to it settled (which also drops a stored tombstone).
      const current =
        !round.superseded.has(key) &&
        (recordRevisions.get(key) ?? 0) ===
          (round.startedRecords.get(key) ?? 0);
      if (tomb && current && unsettled(scope, id)) {
        if (!ids.has(id)) changed = true;
        ids.add(id);
      } else if (ids.delete(id)) changed = true;
    }
    if (changed) await persistLater();
    return { complete: true, tombstones, others };
  }

  /** Whether the record has queued or failed writes. */
  function unsettled(scope: string, id: string): boolean {
    const key = keyFor(scope, id);
    return writeQueues.has(key) || gaveUpWrites.has(key);
  }

  /** The stored tombstone ids of a scope, created empty. */
  function storedTombstones(
    scope: string,
    route: ClientRoute,
    context: Record<string, string>,
  ): Set<string> {
    let entry = feedTombstones.get(scope);
    if (!entry) {
      entry = {
        resource: route.collection.name,
        context: { ...context },
        ids: new Set(),
      };
      feedTombstones.set(scope, entry);
    }
    return entry.ids;
  }

  /**
   * Finds out whether a record a complete read lacked was deleted: from the
   * document's declaration, else with a GET of the record within the sync's
   * budget. Undefined when the budget is spent (not checked).
   */
  async function findEvidence(
    route: ClientRoute,
    context: Record<string, string>,
    id: string,
    budget: Budget,
  ): Promise<Evidence | undefined> {
    if (route.absentMeansDeleted)
      return {
        evidence: 'deleted',
        source: 'declaration',
        detail: `the API document declares that a record missing from a complete read of ${route.collection.name} was deleted`,
      };
    if (options.missingRecordChecks === 'none')
      return {
        evidence: 'unknown',
        source: 'none',
        detail: 'not checked: missingRecordChecks is none',
      };
    if (!route.itemReadable || !route.collection.itemUrl)
      return {
        evidence: 'unknown',
        source: 'none',
        detail: 'not checked: the document declares no GET for the record',
      };
    let response: TransportResponse;
    let path = route.collection.itemUrl;
    try {
      const url = target(route.collection.itemUrl, {
        ...context,
        [route.collection.itemParam ?? 'id']: id,
      });
      path = url.pathname;
      response = await budget.send({ url, method: 'GET', headers: {} });
    } catch (error) {
      // The budget is spent, or a 429 asks to wait past its deadline.
      if (
        error instanceof BudgetExhausted ||
        error instanceof RetryBeyondDeadline
      )
        return undefined;
      return {
        evidence: 'unknown',
        source: 'read',
        detail: `GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const { status } = response;
    // Rate-limited after the budget's own 429 retries: not checked.
    if (status === 429) return undefined;
    // §4.3 of the Collection Completeness draft: what the status means is
    // the resource's stated `notFound`, through any collection, `deleted`
    // by default; since 0.3.0 a 410 means its stated `gone`, else the same.
    // Under the route's own unrecognised `absent` (§7), what neither
    // classifies is `unavailable`, not the `deleted` default.
    const stated =
      status === 410 ? (route.gone ?? route.notFound) : route.notFound;
    const meaning =
      stated ?? (route.unrecognisedAbsent ? 'unavailable' : undefined);
    const named = status === 410 && route.gone ? 'gone' : 'notFound';
    if (status === 404 || status === 410)
      return meaning === 'unavailable'
        ? {
            evidence: 'unavailable',
            source: 'read',
            status,
            detail:
              stated === undefined
                ? `GET ${path} answered ${status}; the collection's x-completeness has no recognised absent value and the resource states no ${status === 410 ? 'gone or notFound' : 'notFound'}, so the record is unavailable, not deleted`
                : `GET ${path} answered ${status}, which the API document declares means the record is unavailable to this caller (x-completeness ${named}: unavailable), not that it was deleted`,
          }
        : {
            evidence: 'deleted',
            source: 'read',
            status,
            detail: `GET ${path} answered ${status}`,
          };
    if (status >= 200 && status < 300) {
      let body: unknown;
      try {
        body = response.body ? JSON.parse(response.body) : undefined;
      } catch {
        body = undefined;
      }
      const idField = route.collection.idField;
      const record =
        isRecord(body) &&
        body[idField] !== undefined &&
        body[idField] !== null &&
        String(body[idField]) === id
          ? body
          : undefined;
      // `x-read-tombstone`: the read answers 2xx for a deleted record, with
      // a marker. Not stored: the next check reads the record again.
      const tombstone = route.readTombstone;
      if (record && tombstone && isTombstone(record, tombstone))
        return {
          evidence: 'deleted',
          source: 'read',
          status,
          detail: `GET ${path} answered ${status} with a tombstone: ${tombstone.field} is ${JSON.stringify(readNestedField(record, tombstone.field))}`,
        };
      if (record)
        return {
          evidence: 'filtered',
          source: 'read',
          status,
          record,
          detail: `GET ${path} answered ${status} with the record`,
        };
      return {
        evidence: 'unknown',
        source: 'read',
        status,
        detail: `GET ${path} answered ${status} without the record`,
      };
    }
    return {
      evidence: 'unknown',
      source: 'read',
      status,
      detail: `GET ${path} answered ${status}`,
    };
  }

  function reportMissing(
    route: ClientRoute,
    context: Record<string, string>,
    id: string,
    found: Evidence,
    lastKnown?: Record<string, unknown>,
  ): void {
    const record =
      found.record ??
      (found.evidence === 'unavailable' ? lastKnown : undefined);
    const scope = scopeFor(route, context);
    const key = keyFor(scope, id);
    const kept = keptMarks.get(key);
    const values = record ?? lastKnown ?? kept?.record;
    // §4.3: an unavailable record keeps its last known values, marked,
    // until a later read settles it; deletion or a 2xx read settles it.
    // Under retainDeleted a deleted record is kept too, marked deleted. An
    // unknown answer leaves an unconfirmed mark as it is.
    if (found.evidence === 'unavailable' && values)
      setMark(
        route,
        context,
        id,
        'unavailable',
        values,
        found.detail,
        found.source,
      );
    else if (found.evidence === 'deleted' && options.retainDeleted && values)
      setMark(
        route,
        context,
        id,
        'deleted',
        values,
        found.detail,
        found.source,
      );
    else if (found.evidence === 'deleted' || found.evidence === 'filtered') {
      if (kept) kept.clearing = true;
    } else if (kept && kept.presence === 'unconfirmed')
      kept.detail = found.detail;
    try {
      options.onMissingRecord?.({
        resource: route.collection.name,
        id,
        ...(Object.keys(context).length ? { context: { ...context } } : {}),
        evidence: found.evidence,
        source: found.source,
        ...(found.status !== undefined ? { status: found.status } : {}),
        ...(record ? { record: structuredClone(record) } : {}),
      });
    } catch {
      // A failing callback does not stop the sync.
    }
  }

  /**
   * The scopes (bound contexts) of nested collection `route` whose `param`
   * is `parentId`, among the confirmed records and the unsettled writes,
   * each with its context.
   */
  function nestedScopes(
    route: ClientRoute,
    param: string,
    parentId: string,
  ): { scope: string; context: Record<string, string> }[] {
    const params = route.collection.contextParams;
    const index = params.indexOf(param);
    const found = new Map<string, Record<string, string>>();
    for (const scope of [
      ...confirmed.keys(),
      ...allWrites().map((w) => w.scope),
    ]) {
      if (found.has(scope)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(scope);
      } catch {
        continue;
      }
      if (
        !Array.isArray(parsed) ||
        parsed[0] !== route.collection.name ||
        !Array.isArray(parsed[1]) ||
        parsed[1][index] !== parentId
      )
        continue;
      const values = parsed[1] as string[];
      found.set(
        scope,
        Object.fromEntries(params.map((p, i) => [p, values[i] as string])),
      );
    }
    return [...found].map(([scope, context]) => ({ scope, context }));
  }

  /**
   * Whether this sync checks record `id` of `route`, which a complete read
   * lacks and which has no writes: never under `missingRecordChecks:
   * 'none'` or without a way to check (no item GET, unless the declaration
   * decides); else for `absent: removed` collections, under `'all'`, and
   * for a record whose nested collections declare `parentAbsent`.
   */
  function lookupPlanned(route: ClientRoute, id: string): boolean {
    if (options.missingRecordChecks === 'none') return false;
    if (
      !route.absentMeansDeleted &&
      !(route.itemReadable && route.collection.itemUrl)
    )
      return false;
    return (
      Boolean(route.absentRemoved) ||
      options.missingRecordChecks === 'all' ||
      nestedUnder.has(route.collection.name) ||
      nestedWritesUnder(route, id)
    );
  }

  /**
   * Whether a nested collection declaring `parentAbsent` has unsettled
   * writes under record `id` of `route`: then the record's fate decides
   * theirs, so it is checked even without writes of its own.
   */
  function nestedWritesUnder(route: ClientRoute, id: string): boolean {
    return (nestedUnder.get(route.collection.name) ?? []).some(
      ({ route: nested, param }) =>
        nestedScopes(nested, param, id).some(({ scope }) =>
          allWrites().some((w) => w.scope === scope),
        ),
    );
  }

  /**
   * Collection Completeness §4.4: once record `id` of `route` is concluded
   * deleted or unavailable (`found`), the members last read under it in
   * each nested collection declaring `parentAbsent` are concluded
   * `unavailable`, never `deleted`, without being read (the spec's
   * `members_of_gone_parent`; 0.2.0 has no deleted cascade). Each is
   * reported (`source: 'parent'`) and its held updates fail as for any
   * missing record. A member a write settled on during this sync is left
   * to a later sync, and so is one this sync's read of the same nested
   * collection returned under another parent (it moved, and is present).
   * Nothing is pruned.
   * Returns the members whose writes failed, for rebuilding.
   */
  function applyParentAbsent(
    route: ClientRoute,
    id: string,
    found: Evidence,
    round: SyncRound,
    released: Set<QueuedWrite>,
  ): RebuildTarget[] {
    const touched: RebuildTarget[] = [];
    if (found.evidence !== 'deleted' && found.evidence !== 'unavailable')
      return touched;
    for (const { route: nested, param } of nestedUnder.get(
      route.collection.name,
    ) ?? []) {
      const evidence: MissingRecordEvidence = 'unavailable';
      for (const { scope, context } of nestedScopes(nested, param, id)) {
        const conclusion: Evidence = {
          evidence,
          source: 'parent',
          detail: `its parent ${route.collection.resource} ${id} of ${route.collection.name} was concluded ${found.evidence}: ${found.detail}`,
        };
        goneParents.set(scope, conclusion);
        const members = new Set([
          ...remote(scope).keys(),
          ...allWrites()
            .filter((w) => w.scope === scope)
            .map((w) => w.id),
        ]);
        for (const member of members) {
          const key = keyFor(scope, member);
          if (
            (round.startedRecords.get(key) ?? 0) !==
              (recordRevisions.get(key) ?? 0) ||
            round.returned.get(scope)?.has(member)
          )
            continue;
          const lastKnown =
            remote(scope).get(member) ?? lastKnownFor(scope, member);
          reportMissing(nested, context, member, conclusion, lastKnown);
          if (failMissing(scope, member, conclusion, lastKnown, released))
            touched.push({
              scope,
              id: member,
              route: nested,
              context,
              found: conclusion,
            });
        }
      }
    }
    return touched;
  }

  /**
   * After a complete read of `scope`: releases its held updates whose
   * records the read returned fresh (`isFresh`: no write to the record
   * settled during it), and deals with the records it did not return.
   * With `apply`, the read was not applied to the whole collection, so the
   * fresh records are taken over (and checked for conflicts) here.
   * `previous` holds the confirmed records from before the read.
   *
   * A record with unsettled writes that the read lacks (and that no write
   * settled on during it) has its queued updates held (`holdMissing`). When
   * the first of them is the head of its record's queue and not in flight,
   * the record is checked (`findEvidence`): `deleted` and `unknown` fail
   * that update and every held update after it, keeping the last confirmed
   * record for a retry; `filtered` takes over the returned record and
   * releases them. Held updates behind an earlier unsettled write, and
   * records the budget did not cover, wait for a later sync. `vanished`
   * lists records without writes that this read dropped; they are checked
   * only with `missingRecordChecks: 'all'`.
   */
  async function releaseRefreshed(
    read: {
      route: ClientRoute;
      scope: string;
      context: Record<string, string>;
      budget: Budget;
      sync: SyncRound;
    },
    records: Map<string, Record<string, unknown>>,
    previous: Map<string, Record<string, unknown>>,
    isFresh: (id: string) => boolean,
    apply: boolean,
    released: Set<QueuedWrite>,
    vanished: string[] = [],
  ): Promise<void> {
    const { route, scope, context, budget, sync } = read;
    const missing = new Set<string>();
    for (const write of allWrites())
      if (
        write.scope === scope &&
        write.durable !== false &&
        !records.has(write.id) &&
        isFresh(write.id)
      )
        missing.add(write.id);
    // Held before any request below, so nothing is sent on a stale copy
    // while the evidence is being read.
    for (const id of missing) holdMissing(keyFor(scope, id));
    // Taken before the checks: a write that settles on a record from
    // here on (during a GET, or the feed read at the end of the sync)
    // leaves it to a later sync.
    const revisionAtCheck = new Map<string, number>();
    for (const id of missing) {
      const key = keyFor(scope, id);
      revisionAtCheck.set(key, recordRevisions.get(key) ?? 0);
    }
    // Read once per sync, at its end, after every evidence GET
    // (`finishFeeds`); not needed when the declaration already settles
    // every missing record.
    const feedRead = Boolean(
      route.deletionFeed &&
        !route.absentMeansDeleted &&
        options.missingRecordChecks !== 'none',
    );
    if (feedRead) sync.feeds.push({ route, scope, context });
    // A record this read returns exists: a stored tombstone for it is stale.
    const stored = feedTombstones.get(scope)?.ids;
    if (stored)
      for (const id of records.keys())
        if (stored.delete(id)) {
          sync.tombstonesChanged = true;
          sync.superseded.add(keyFor(scope, id));
        }

    // Undecided by this sync's GETs: the feed read at the end may decide.
    // A tombstone there is positive evidence of deletion, so it also stands
    // over an `unavailable` answer; without one, that answer applies.
    const undecided = (found: Evidence | undefined): boolean =>
      feedRead &&
      (!found ||
        found.evidence === 'unknown' ||
        found.evidence === 'unavailable');
    const evidence = new Map<string, Evidence>();
    for (const id of missing) {
      const key = keyFor(scope, id);
      if (!evidenceHead(key)) continue;
      // A tombstone kept from an earlier feed read: no GET; this sync's feed
      // read, at its end, confirms it or drops it (`finishFeeds`).
      if (feedRead && stored?.has(id)) {
        sync.undecided.push({
          scope,
          context,
          id,
          revision: revisionAtCheck.get(key) ?? 0,
          previous: previous.get(id),
          stored: true,
        });
        continue;
      }
      const found = await findEvidence(route, context, id, budget);
      if (undecided(found)) {
        sync.undecided.push({
          scope,
          context,
          id,
          ...(found ? { found } : {}),
          revision: revisionAtCheck.get(key) ?? 0,
          previous: previous.get(id),
        });
        continue;
      }
      if (!found) continue;
      evidence.set(id, found);
      reportMissing(
        route,
        context,
        id,
        found,
        previous.get(id) ?? lastKnownFor(scope, id),
      );
    }
    const fresh = new Map<string, Record<string, unknown>>();
    const touchedIds = new Set<string>();
    // What concluded each touched record, for telling before a removal.
    const foundById = new Map<string, Evidence>();
    // Members of nested collections concluded with this read's records.
    const nested: RebuildTarget[] = [];
    for (const [id, found] of evidence) {
      const key = keyFor(scope, id);
      // A write to the record settled while it was checked: a later sync
      // decides on a newer read.
      if ((recordRevisions.get(key) ?? 0) !== revisionAtCheck.get(key))
        continue;
      if (found.evidence === 'filtered' && found.record) {
        fresh.set(id, found.record);
        // It exists: a stored tombstone for it is stale.
        if (stored?.delete(id)) {
          sync.tombstonesChanged = true;
          sync.superseded.add(key);
        }
        continue;
      }
      if (failMissing(scope, id, found, previous.get(id), released))
        touchedIds.add(id);
      foundById.set(id, found);
      nested.push(...applyParentAbsent(route, id, found, sync, released));
    }
    const taken = new Map<string, Record<string, unknown>>();
    for (const write of allWrites()) {
      if (write.scope !== scope || !write.awaitingRefresh) continue;
      if (!isFresh(write.id)) continue;
      const record = records.get(write.id) ?? fresh.get(write.id);
      // Missing, and not settled above: it waits for a later sync.
      if (!record) continue;
      released.add(write);
      touchedIds.add(write.id);
      if (apply || fresh.has(write.id)) taken.set(write.id, record);
      delete write.awaitingRefresh;
      delete write.refreshMisses;
    }
    // Records without writes: checked under 'all', or when the writes of a
    // nested collection declaring parentAbsent depend on their fate.
    const limit = options.maxMissingRecordChecks ?? 50;
    for (const id of vanished) {
      if (writeQueues.has(keyFor(scope, id))) continue;
      // Over this sync's limit: the record stays unconfirmed and is checked
      // first by the next sync. A declaration decides without a request,
      // and only a check that makes a request counts.
      if (!route.absentMeansDeleted && lookupPlanned(route, id)) {
        if (sync.lookups >= limit) {
          const mark = keptMarks.get(keyFor(scope, id));
          if (mark?.presence === 'unconfirmed')
            mark.detail = `not checked yet: over this sync's limit of ${limit} checks (maxMissingRecordChecks)`;
          continue;
        }
        sync.lookups += 1;
      }
      const revision = recordRevisions.get(keyFor(scope, id)) ?? 0;
      const found = await findEvidence(route, context, id, budget);
      if (undecided(found))
        sync.undecided.push({
          scope,
          context,
          id,
          ...(found ? { found } : {}),
          revision,
          previous: previous.get(id),
          vanished: true,
        });
      else if (found) {
        // A write to it settled during the GET: a later sync decides.
        if ((recordRevisions.get(keyFor(scope, id)) ?? 0) !== revision)
          continue;
        reportMissing(route, context, id, found, previous.get(id));
        // Kept with its last known values when unavailable (§4.3); a
        // conclusion that clears a kept mark removes the record again
        // (told first).
        touchedIds.add(id);
        foundById.set(id, found);
        nested.push(...applyParentAbsent(route, id, found, sync, released));
      }
    }
    if (!touchedIds.size && !nested.length) return;
    if (taken.size) {
      for (const [id, record] of taken) {
        remote(scope).set(id, record);
        setLastKnown(keyFor(scope, id), record);
      }
      detectConflicts(scope, taken);
    }
    await persistLater();
    await rebuildTelling(
      [
        ...[...touchedIds].map((id): RebuildTarget => {
          const found = foundById.get(id);
          return { scope, id, route, context, ...(found ? { found } : {}) };
        }),
        ...nested,
      ],
      sync,
    );
    const scopes = new Set([scope, ...nested.map((member) => member.scope)]);
    for (const [key, queue] of writeQueues)
      if (queue[0] && scopes.has(queue[0].scope) && !draining.has(key))
        void drainQueue(key);
  }

  /**
   * At the end of a sync, after every collection read and evidence GET:
   * reads each collection's deletion feed from the budget left, and settles
   * the missing records the GETs left undecided. A tombstone makes one
   * `deleted` (`source: 'feed'`), as does a stored one (`stored`) unless
   * this complete read has a later item about the record that is not a
   * tombstone (then it stays held, for a GET next sync); without one, an
   * `unknown` GET answer fails it as `unknown`, and an unchecked one stays
   * held.
   */
  async function finishFeeds(
    round: SyncRound,
    budget: Budget,
    released: Set<QueuedWrite>,
  ): Promise<void> {
    const touched: RebuildTarget[] = [];
    for (const { route, scope, context } of round.feeds) {
      const feed = await readFeed(route, scope, context, budget, round);
      for (const record of round.undecided) {
        if (record.scope !== scope) continue;
        // A write to the record settled since the check began: a later
        // sync decides on a newer read.
        if (
          (recordRevisions.get(keyFor(scope, record.id)) ?? 0) !==
          record.revision
        )
          continue;
        // A stored tombstone stands unless this complete read has a later
        // item about the record that is not one; then the next sync reads it.
        const found =
          feed.tombstones.has(record.id) ||
          (record.stored && !(feed.complete && feed.others.has(record.id)))
            ? feedEvidence(route)
            : record.found;
        if (!found) continue;
        reportMissing(
          route,
          record.context,
          record.id,
          found,
          record.previous ?? lastKnownFor(scope, record.id),
        );
        if (
          (!record.vanished &&
            failMissing(scope, record.id, found, record.previous, released)) ||
          record.vanished
        )
          touched.push({
            scope,
            id: record.id,
            route,
            context: record.context,
            found,
          });
        touched.push(
          ...applyParentAbsent(route, record.id, found, round, released),
        );
      }
    }
    if (!touched.length && !round.tombstonesChanged) return;
    await persistLater();
    await rebuildTelling(touched, round);
    for (const [key, queue] of writeQueues)
      if (queue.length && !draining.has(key)) void drainQueue(key);
  }

  /**
   * A restored update that `limit` syncs in a row did not release (its
   * collection never read completely, or a write to it kept settling)
   * fails, so it is listed and can be retried or discarded.
   */
  const REFRESH_MISS_LIMIT = 3;
  async function countRefreshMisses(
    released: Set<QueuedWrite>,
    skipped: Set<string> = new Set(),
  ): Promise<void> {
    // While blocked, no write could be sent anyway (and reads likely fail
    // for the same reason): waiting does not count.
    if (authBlock) return;
    let changed = false;
    for (const write of allWrites()) {
      if (!write.awaitingRefresh || released.has(write)) continue;
      // Its collection's read was not applied (a presence handler threw).
      if (skipped.has(write.scope)) continue;
      // Only the head: failing a write behind unsettled ones would make a
      // failed write newer than queued ones, which a settle then drops.
      if (writeQueues.get(keyFor(write.scope, write.id))?.[0] !== write)
        continue;
      write.refreshMisses = (write.refreshMisses ?? 0) + 1;
      changed = true;
      if (write.refreshMisses < REFRESH_MISS_LIMIT) continue;
      failWrite(
        write,
        `Waiting for a complete refresh of ${write.route.collection.name}: ${REFRESH_MISS_LIMIT} syncs did not read this record completely, or did not check whether it was deleted`,
      );
    }
    if (!changed) return;
    await persistLater();
    for (const [key, queue] of writeQueues)
      if (queue.length && !draining.has(key)) void drainQueue(key);
  }

  /**
   * A snapshot read without error but not completely (`notComplete`):
   * its records are added to, or updated in, the confirmed copy; nothing
   * is removed, no absent record is held, checked or reported missing, and
   * no deletion feed is read or moved. Skipped for a scope a write settled
   * on during the read, and per record for a record one settled on.
   */
  async function upsertIncomplete(
    snapshot: CollectionSnapshot,
    started: Map<string, number>,
    startedRecords: Map<string, number>,
    changed: Set<string>,
    round: SyncRound,
  ): Promise<IncompleteRead> {
    const route = byResource.get(snapshot.collection.name) as ClientRoute;
    const context = contextFor(route, snapshot.pathParams);
    const scope = scopeFor(route, context);
    const report: IncompleteRead = {
      collection: route.collection.name,
      context: { ...context },
      reason: snapshot.notComplete ?? 'not complete',
    };
    if ((started.get(scope) ?? 0) !== (revisions.get(scope) ?? 0))
      return report;
    const before = remote(scope);
    const updated = new Map<string, Record<string, unknown>>();
    const stored = feedTombstones.get(scope)?.ids;
    for (const item of snapshot.items) {
      const id = String(item[route.collection.idField]);
      const key = keyFor(scope, id);
      if ((startedRecords.get(key) ?? 0) !== (recordRevisions.get(key) ?? 0))
        continue;
      // As in a complete read: a record this read returns exists, so an
      // update held for it in flight is not held any more, and a stored
      // feed tombstone for it is stale.
      for (const write of writeQueues.get(key) ?? []) delete write.holdIfQueued;
      if (stored?.delete(id)) {
        round.tombstonesChanged = true;
        round.superseded.add(key);
      }
      if (sameValue(before.get(id), item)) continue;
      updated.set(id, item);
    }
    if (!updated.size) return report;
    confirmed.set(scope, new Map([...before, ...updated]));
    // A later complete read must compare against the confirmed copy, not
    // the last complete snapshot, so that it can still prune.
    lastSyncedItems.delete(scope);
    for (const write of allWrites()) {
      const record = write.scope === scope ? updated.get(write.id) : undefined;
      if (record) setLastKnown(keyFor(scope, write.id), record);
    }
    detectConflicts(scope, updated);
    for (const id of updated.keys()) await rebuild(scope, id);
    changed.add(route.collection.name);
    if (writeQueues.size || gaveUpWrites.size) await persistLater();
    return report;
  }

  async function performSync(): Promise<SyncResult> {
    await whenRestored();
    // The records this sync's reads return were seen at its start.
    const readAt = new Date().toISOString();
    const started = new Map(revisions);
    const startedRecords = new Map(recordRevisions);
    const released = new Set<QueuedWrite>();
    // One budget for the read and the GETs of records it no longer returns.
    const budget = new Budget(
      conditionalTransport,
      options.limits,
      options.sleep,
      throttling,
    );
    activeBudget = budget;
    let result: Awaited<ReturnType<typeof readCollections>>;
    try {
      result = await readCollections(doc, {
        transport: conditionalTransport,
        constants: options.constants ?? {},
        legacy,
        budget,
        ...(options.selection ? { selection: options.selection } : {}),
        ...(options.ranges ? { ranges: options.ranges } : {}),
      });
    } finally {
      activeBudget = undefined;
    }
    const round: SyncRound = {
      feeds: [],
      undecided: [],
      tombstonesChanged: false,
      superseded: new Set(),
      startedRecords,
      returned: new Map(),
      presence: [],
      lookups: 0,
      skipped: new Set(),
    };
    let keptSettled = false;
    for (const snapshot of result.collections) {
      const route = byResource.get(snapshot.collection.name) as ClientRoute;
      const scope = scopeFor(route, contextFor(route, snapshot.pathParams));
      const idField = snapshot.collection.idField;
      const ids = round.returned.get(scope) ?? new Set();
      for (const item of snapshot.items) {
        const id = String(item[idField]);
        ids.add(id);
        seenAt.set(keyFor(scope, id), readAt);
        // A read that returns a marked record settles its mark: told as
        // `present` if the app was told a mark of it, else its held change
        // is just dropped (`dropMark`).
        if (keptMarks.has(keyFor(scope, id))) {
          dropMark(keyFor(scope, id), item);
          keptSettled = true;
        }
      }
      round.returned.set(scope, ids);
    }
    if (keptSettled) await persistLater();
    const changed = new Set<string>();
    const incomplete: IncompleteRead[] = [];
    for (const snapshot of result.collections) {
      if (!snapshot.complete) {
        if (snapshot.notComplete !== undefined && snapshot.error === undefined)
          incomplete.push(
            await upsertIncomplete(
              snapshot,
              started,
              startedRecords,
              changed,
              round,
            ),
          );
        continue;
      }
      const route = byResource.get(snapshot.collection.name) as ClientRoute;
      const context = contextFor(route, snapshot.pathParams);
      const scope = scopeFor(route, context);
      // Read completely: its parent is back, and so are its members.
      goneParents.delete(scope);
      if (snapshot.runtimeMembers) {
        const members = new Map<string, RuntimeMembers>();
        snapshot.items.forEach((item, i) => {
          const interpreted = snapshot.runtimeMembers?.[i];
          if (interpreted)
            members.set(String(item[route.collection.idField]), interpreted);
        });
        runtimeMembersByScope.set(scope, members);
      }
      const previous = lastSyncedItems.get(scope);
      const differs = hasChanges(
        previous,
        snapshot.items,
        route.collection.idField,
      );
      const records = new Map(
        snapshot.items.map((item) => [
          String(item[route.collection.idField]),
          item,
        ]),
      );
      const read = { route, scope, context, budget, sync: round };
      // Records no write settled on during the read are still fresh.
      const isFresh = (id: string): boolean =>
        (startedRecords.get(keyFor(scope, id)) ?? 0) ===
        (recordRevisions.get(keyFor(scope, id)) ?? 0);
      // Updates of records this read lacks stop being sent now, before the
      // awaits below; releaseRefreshed decides about them. A record it
      // returns is no longer missing: an in-flight update an earlier read
      // marked (holdIfQueued) goes on as usual after its response.
      for (const write of allWrites()) {
        if (write.scope !== scope || !isFresh(write.id)) continue;
        if (records.has(write.id)) delete write.holdIfQueued;
        else holdMissing(keyFor(scope, write.id));
      }
      const persisted = differs ? await storage.list(scope) : [];
      // A write acknowledged after this read began is newer than this snapshot.
      if ((started.get(scope) ?? 0) !== (revisions.get(scope) ?? 0)) {
        if (differs) changed.add(route.collection.name);
        await releaseRefreshed(
          read,
          records,
          remote(scope),
          isFresh,
          true,
          released,
        );
        continue;
      }
      const vanished: string[] = [];
      let confirmedBefore = remote(scope);
      if (differs) {
        // A reused adapter can contain records from before this client instance.
        const persistedById = new Map(
          persisted.map((item) => [
            String(item[route.collection.idField]),
            item,
          ]),
        );
        const before = new Set([
          ...remote(scope).keys(),
          ...persistedById.keys(),
        ]);
        const written = new Set(
          allWrites()
            .filter((w) => w.scope === scope)
            .map((w) => w.id),
        );
        // Tell before prune. A record this read lacks (no writes) is, by
        // its collection's declaration: deleted (`absent: deleted`; removed,
        // or kept marked under retainDeleted), kept marked `unconfirmed`
        // until a check settles it (`absent: removed`, or wherever a check
        // will be made), or removed. Removals are told first; if the app's
        // handler fails, this read is not applied.
        const pruning: PresenceChange[] = [];
        const recheck: string[] = [];
        const lookups: string[] = [];
        for (const id of before) {
          if (records.has(id) || written.has(id)) continue;
          const mark = keptMarks.get(keyFor(scope, id));
          if (mark) {
            if (mark.presence === 'unconfirmed' && lookupPlanned(route, id))
              recheck.push(id);
            else if (remote(scope).has(id) && lookupPlanned(route, id))
              lookups.push(id);
            continue;
          }
          const last = remote(scope).get(id) ?? persistedById.get(id);
          const planned = lookupPlanned(route, id);
          if (route.absentMeansDeleted) {
            if (planned) lookups.push(id);
            if (options.retainDeleted && last) {
              setMark(
                route,
                context,
                id,
                'deleted',
                last,
                `the API document declares that a record missing from a complete read of ${route.collection.name} was deleted`,
                'declaration',
              );
              continue;
            }
            pruning.push(
              presenceChange(
                route,
                context,
                id,
                'deleted',
                'declaration',
                last,
                true,
              ),
            );
          } else if (last && (planned || route.absentRemoved)) {
            setMark(
              route,
              context,
              id,
              'unconfirmed',
              last,
              planned
                ? 'not returned by a complete read; not checked yet'
                : 'not returned by a complete read; the record cannot be checked',
              'read',
            );
            if (planned) lookups.push(id);
          } else
            pruning.push(
              presenceChange(route, context, id, 'removed', 'read', last, true),
            );
        }
        vanished.push(...recheck, ...lookups);
        if (pruning.length) {
          if (!(await tell(round, pruning))) {
            round.skipped.add(scope);
            continue;
          }
          // A write that settled while the app was told is newer than this
          // snapshot: take the stale path (records upserted, nothing
          // removed); what was told and not removed is told again by a
          // later read that still lacks it.
          if ((started.get(scope) ?? 0) !== (revisions.get(scope) ?? 0)) {
            // Told, but not removed by this read.
            for (const change of pruning) change.pruned = false;
            changed.add(route.collection.name);
            await releaseRefreshed(
              read,
              records,
              remote(scope),
              isFresh,
              true,
              released,
            );
            continue;
          }
          // A write the app queued while it was told keeps its record: not
          // removed, so not `pruned` after all.
          for (const change of pruning)
            if (
              allWrites().some((w) => w.scope === scope && w.id === change.id)
            ) {
              change.pruned = false;
              written.add(change.id);
            }
        }
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
        for (const id of before) {
          // A record whose writes are all still being stored was not told
          // and is not removed here: its own enqueue rebuilds it.
          if (
            !records.has(id) &&
            written.has(id) &&
            allWrites().every(
              (w) => w.scope !== scope || w.id !== id || w.durable === false,
            )
          )
            continue;
          await rebuild(scope, id);
        }
        changed.add(route.collection.name);
        // A write that settled during the rebuild invalidated this snapshot.
        if ((started.get(scope) ?? 0) === (revisions.get(scope) ?? 0))
          lastSyncedItems.set(scope, snapshot.items);
        // Confirmed records and conflict bases of pending writes moved on.
        if (writeQueues.size || gaveUpWrites.size) await persistLater();
      }
      // An unchanged read rebuilds nothing, but unconfirmed records are
      // still checked.
      if (!differs)
        for (const mark of keptMarks.values())
          if (
            mark.scope === scope &&
            mark.presence === 'unconfirmed' &&
            !records.has(mark.id) &&
            !writeQueues.has(keyFor(scope, mark.id)) &&
            lookupPlanned(route, mark.id)
          )
            vanished.push(mark.id);
      // isFresh: a write that settled on a record during the rebuild above
      // makes this read too old to judge that record.
      await releaseRefreshed(
        read,
        records,
        confirmedBefore,
        isFresh,
        false,
        released,
        vanished,
      );
    }
    await finishFeeds(round, budget, released);
    await countRefreshMisses(released, round.skipped);
    // The marks set or cleared on records the sync keeps, told at its end;
    // not after the handler already threw in this sync (they wait, with any
    // held from a sync that threw, for the next one).
    if (round.presenceError === undefined) await tell(round, []);
    if (keptMarks.size || round.presence.length) await persistLater();
    if (round.presenceError !== undefined) throw round.presenceError;
    // A describer that could not be read (whatever the status: a 401 or
    // 403 here is not an auth block) or that the budget left unread leaves
    // its items without a class, not their collection incomplete: a
    // warning, not a failed sync. readCollections appends those entries
    // last, so the collection failures are the ones before them.
    const warnings = result.describerErrors ?? [];
    const failures = result.errors.slice(
      0,
      result.errors.length - warnings.length,
    );
    if (failures.length)
      throw new Error(`Read incomplete: ${failures.join('; ')}`);
    const coverage = result.collections.flatMap(
      (snapshot): CollectionCoverage[] => {
        if (!snapshot.coverage) return [];
        const route = byResource.get(snapshot.collection.name) as ClientRoute;
        const context = contextFor(route, snapshot.pathParams);
        return [
          {
            collection: snapshot.collection.name,
            ...(Object.keys(context).length ? { context } : {}),
            ...snapshot.coverage,
          },
        ];
      },
    );
    return {
      changed: [...changed],
      incomplete,
      ...(result.describers ? { describers: result.describers } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(round.presence.length ? { presence: round.presence } : {}),
      ...(coverage.length ? { coverage } : {}),
    };
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
    runtimeMembers(resource, id, context): RuntimeMembers | undefined {
      const route = resolveRoute(resource);
      return runtimeMembersByScope
        .get(scopeFor(route, contextFor(route, context)))
        ?.get(id);
    },
    async create(resource, data, supplied): Promise<Record<string, unknown>> {
      await whenRestored();
      const route = resolveRoute(resource);
      if (!route.createPath)
        throw new Error(`Resource ${resource} declares no create operation`);
      if (route.createRefused)
        throw new Error(`Resource ${resource} ${route.createRefused}`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.createPath, context);
      const id =
        data[route.collection.idField] === undefined
          ? crypto.randomUUID()
          : String(data[route.collection.idField]);
      const record = { ...data, [route.collection.idField]: id };
      // Into a nested scope whose parent is concluded gone (its members
      // are unavailable): not sent without a decision (parked, like a
      // refused create).
      const gone = goneParents.get(scope);
      const held = gone !== undefined;
      await enqueue({
        route,
        scope,
        context,
        id,
        type: 'create',
        data: record,
        ...(held ? { awaitingRefresh: true } : {}),
        ...(route.idempotencyHeader
          ? { idempotencyKey: crypto.randomUUID() }
          : {}),
      });
      if (gone && held) await concludeNew(scope, id, gone);
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
      if (route.updateRefused)
        throw new Error(`Resource ${resource} ${route.updateRefused}`);
      const context = contextFor(route, supplied);
      const scope = scopeFor(route, context);
      target(route.collection.itemUrl, {
        ...context,
        [route.collection.itemParam ?? 'id']: id,
      });
      const existing = await storage.get(scope, id);
      const key = keyFor(scope, id);
      const failed = gaveUpWrites.get(key);
      // The record's last update failed because a refresh no longer had it,
      // and nothing confirmed it since: this one waits for the next refresh
      // and is checked like that one, rather than sent on the last copy.
      const stillMissing =
        !remote(scope).has(id) &&
        Boolean(failed?.some((w) => w.missingRecord)) &&
        !writeQueues.get(key)?.some((w) => w.type === 'create');
      // Its parent is concluded gone and the collection not read since: the
      // record is still there locally (nothing is pruned), so the edit is
      // held and concluded like the record's earlier writes were.
      const gone = goneParents.get(scope);
      // A record kept as unavailable (§4.3; no writes left, or never had
      // any): the edit waits for the next refresh, which checks it again.
      const kept = keptMarks.has(key);
      // The visible record carries failed changes; seeding from it would send
      // them implicitly. With failed writes, seed from their last known record.
      const seed = failed
        ? lastKnownFor(scope, id)
        : writeQueues.has(key)
          ? undefined
          : existing;
      if (!remote(scope).has(id) && seed) remote(scope).set(id, seed);
      const record = {
        ...applyChanges(routeBody(route) as UpdateBody, existing, data),
        [route.collection.idField]: id,
      };
      const confirmedRecord = remote(scope).get(id);
      await enqueue({
        route,
        scope,
        context,
        id,
        type: 'update',
        changes: data,
        ...(route.updateBody === 'mergePatch'
          ? { updateBody: 'mergePatch' as const }
          : {}),
        ...(stillMissing || gone || kept ? { awaitingRefresh: true } : {}),
        ...(confirmedRecord
          ? {
              base: Object.fromEntries(
                Object.keys(data).map((f) => [f, confirmedRecord[f]]),
              ),
            }
          : {}),
      });
      if (gone) await concludeNew(scope, id, gone);
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
      // Into a gone parent's scope: held and concluded at once, as an
      // update is. Of a record kept as unavailable: held until the next
      // refresh checks it (§4.3: not sent without a decision).
      const gone = goneParents.get(scope);
      const kept = keptMarks.has(keyFor(scope, id));
      await enqueue({
        route,
        scope,
        context,
        id,
        type: 'delete',
        ...(gone || kept ? { awaitingRefresh: true } : {}),
      });
      if (gone) await concludeNew(scope, id, gone);
    },
    presence(resource): PresenceMark[] {
      const name = resource
        ? resolveRoute(resource).collection.name
        : undefined;
      return [...keptMarks.values()]
        .filter((mark) => !name || mark.resource === name)
        .map((mark) => ({
          collection: mark.resource,
          ...(Object.keys(mark.context).length
            ? { context: { ...mark.context } }
            : {}),
          id: mark.id,
          presence: mark.presence,
          ...(mark.source ? { source: mark.source } : {}),
          detail: mark.detail,
          record: structuredClone(mark.record),
          ...(mark.lastSeen ? { lastSeen: mark.lastSeen } : {}),
        }));
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
          ...(write.missingRecord && write.state === 'failed'
            ? { missingRecord: write.missingRecord }
            : {}),
          ...(write.unbound && write.state === 'uncertain'
            ? { unbound: true as const }
            : {}),
          ...(write.followUp
            ? {
                followUp: {
                  operation: write.followUp.operation,
                  field: write.followUp.field,
                  ...(write.followUp.reason
                    ? { reason: write.followUp.reason }
                    : {}),
                },
              }
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
        if (resolution.action === 'retry' && head.unbound)
          throw new Error(
            `The create of record ${id} of ${resource} succeeded but did not identify the record (unbound); confirm it with the server's id, or discard it`,
          );
        if (resolution.action === 'confirm') {
          head.confirmedId = resolution.id;
          delete head.unbound;
        }
        if (head.state === 'failed') head.attempts = 0;
        // Describes the failure, which this retry leaves behind.
        delete head.missingRecord;
        head.state = 'pending';
        await persistLater();
        if (!draining.has(key)) void drainQueue(key);
        return;
      }
      // Discarding a blocked write drops it (a create with the writes queued
      // behind it); the block stays. It is resent only by authRenewed().
      if (queue && head?.state === 'blocked') {
        if (resolution.action === 'discard') {
          if (head.type === 'create') queue.splice(0);
          else queue.shift();
          if (!queue.length) writeQueues.delete(key);
          await persistLater();
          await rebuild(scope, id);
          if (queue.length && !draining.has(key)) void drainQueue(key);
          return;
        }
        if (resolution.action === 'confirm')
          throw new Error('Only an uncertain create can be confirmed');
      }
      // A blocked write waits for authRenewed(), not for a refresh.
      const waiting =
        queue?.filter((w) => w.awaitingRefresh && w.state === 'pending') ?? [];
      if (queue && waiting.length && !failed) {
        // A restored update waiting for a refresh: send it now, or drop it.
        if (resolution.action === 'confirm')
          throw new Error('Only an uncertain create can be confirmed');
        // A follow-up whose outcome is unknown is read back before it is
        // sent again (§4.7.2 step 6): a retry would skip that.
        if (
          resolution.action === 'retry' &&
          waiting.some((w) => w.followUp?.reason === 'unknown')
        )
          throw new Error(
            `The follow-up of record ${id} of ${resource} has an unknown outcome and waits for a read of the record before it is sent again (CRUD Causality §4.7.2); sync() reads it, or discard it`,
          );
        const sleeper = queue[0];
        // Retrying sends now: an in-flight write marked for holding is not
        // held after its response either.
        if (resolution.action === 'retry')
          for (const write of queue) delete write.holdIfQueued;
        for (const write of waiting) {
          delete write.awaitingRefresh;
          delete write.refreshMisses;
          if (resolution.action === 'discard')
            queue.splice(queue.indexOf(write), 1);
        }
        // A discarded head that was between retries: its drain goes on now.
        if (sleeper && queue[0] !== sleeper) wakers.get(key)?.();
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
        const stale = failed.find(bodyMismatch);
        if (stale)
          throw new Error(
            `The failed update of record ${id} of ${resource} was made for a ${writeBody(stale)} body and the document now declares ${routeBody(route)}; discard it`,
          );
        // Newer queued writes are sent first; a retried older write must not
        // overwrite what they set.
        const newer = queue ?? [];
        const retried = failed.flatMap((write): QueuedWrite[] => {
          if (newer.length && write.type === 'delete') return [];
          // A follow-up has no changes for withoutSetBy to strip: a newer
          // queued delete, or a newer update that sets its field, supersedes
          // it, as supersede() does for settled writes (§4.7.2 step 6: the
          // app's own edit of the field wins).
          if (
            write.followUp &&
            newer.some((later) => supersedesFollowUp(write, later))
          )
            return [];
          let changes = { ...write.changes };
          for (const later of newer)
            changes = withoutSetBy({ ...write, changes }, later);
          // A follow-up has no changes of its own: what it sends is worked
          // out again when it is sent (§4.7.2 step 4).
          if (
            write.type === 'update' &&
            !write.followUp &&
            !Object.keys(changes).length
          )
            return [];
          const again: QueuedWrite = {
            ...write,
            changes,
            attempts: 0,
            state: 'pending',
            // Queued behind newer writes now, so newer in order too.
            seq: nextSeq++,
          };
          // Describes the failure, which this retry leaves behind.
          delete again.missingRecord;
          if (again.followUp) {
            again.followUp = { ...again.followUp };
            // One whose outcome is unknown (failed later by the refresh-miss
            // limit or a missing record) is still read back before it is
            // sent again (§4.7.2 step 6).
            if (again.followUp.reason === 'unknown') {
              again.awaitingRefresh = true;
              delete again.refreshMisses;
            } else delete again.followUp.reason;
          }
          return [again];
        });
        if (!retried.length)
          throw new Error(
            `The failed writes for record ${id} of ${resource} are superseded by queued writes; discard them or wait for those to settle`,
          );
        const pending = queue ?? [];
        // Retrying sends now: updates waiting for a refresh stop waiting,
        // except a follow-up whose outcome is unknown, which is read back.
        for (const write of pending) {
          if (write.followUp?.reason === 'unknown') continue;
          delete write.awaitingRefresh;
          delete write.refreshMisses;
          delete write.holdIfQueued;
        }
        pending.push(...retried);
        writeQueues.set(key, pending);
        // Dropped before the drain starts: a retried write held past
        // retry.maxRetryAfterMs fails again before the drain's first await,
        // and must not be dropped along with the writes it replaces.
        gaveUpWrites.delete(key);
        if (!draining.has(key)) void drainQueue(key);
      } else {
        gaveUpWrites.delete(key);
      }
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
      // The Collection Object's envelope applies to its own list operation,
      // as in sync() (#384). Several collections may share one list URL with
      // different fixed reads (CRUD Causality 0.4.0 §4.2.1): of those whose
      // fixed query and body this call sends, the ones fixing the most values
      // apply; when that leaves none, or several with different envelopes, no
      // Collection envelope is applied (the scheme's own, or the heuristic,
      // is).
      const sends = (
        fixed: Record<string, unknown>,
        given: Record<string, unknown>,
      ): boolean =>
        Object.entries(fixed).every(([key, value]) =>
          deepEqual(given[key], value),
        );
      const candidates = routes.filter(
        (r) =>
          r.collection.url === template &&
          r.collection.method === method &&
          sends(r.collection.listQuery, pagination.query ?? {}) &&
          sends(r.collection.listBody, pagination.body ?? {}),
      );
      const fixedCount = (r: (typeof routes)[number]): number =>
        Object.keys(r.collection.listQuery).length +
        Object.keys(r.collection.listBody).length;
      const most = Math.max(-1, ...candidates.map(fixedCount));
      const envelopes = new Set(
        candidates
          .filter((r) => fixedCount(r) === most)
          .map((r) => r.collection.itemsField),
      );
      const envelope = envelopes.size === 1 ? [...envelopes][0] : undefined;
      const deadline = Date.now() + readLimitMs;
      return paginateOperation(doc, {
        ...pagination,
        ...(envelope === undefined ? {} : { itemsField: envelope }),
        path: template,
        // The exhausted buckets hold paginate()'s requests too, within its
        // own read limit (not a sync's budget, even while one runs).
        transport: async (request) => {
          await waitOutPauses(readOperation(request), () =>
            Math.max(0, deadline - Date.now()),
          );
          const response = await readTransport(request);
          await noteReadThrottling(response, Date.now());
          return response;
        },
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
