import { isRecord } from '../read/model.js';
import type {
  AuthBlock,
  PendingWriteState,
  PendingWriteType,
  WriteConflict,
} from './client.js';

/**
 * The durable outbox: one record, `{ version, records, rebuild }` (plus
 * `feedCursors`, `feedTombstones` and `authBlock` when set), kept in a
 * reserved namespace of the client's `StorageAdapter`. The whole outbox is
 * one record so that every transition (a write settling, an id remap moving
 * follow-up writes) is a single `put`, which an adapter can make atomic.
 */
export const OUTBOX_VERSION = 1;
export const DEFAULT_OUTBOX_NAMESPACE = 'syncables:outbox';
export const OUTBOX_RECORD_ID = 'outbox';

/** One queued or failed write, as stored. */
export interface StoredWrite {
  type: PendingWriteType;
  data?: Record<string, unknown>;
  changes?: Record<string, unknown>;
  attempts: number;
  lastError?: string;
  /** The HTTP status of the most recent failure. */
  lastStatus?: number;
  state: PendingWriteState;
  base?: Record<string, unknown>;
  conflicts?: WriteConflict[];
  idempotencyKey?: string;
  confirmedId?: string;
  /**
   * Set before the request is handed to the transport and cleared once its
   * outcome is stored. Found on restart, it means the process stopped while
   * the request may have been in flight.
   */
  sending?: true;
  /** Syncs that ran without releasing a restored update waiting for one. */
  refreshMisses?: number;
  /** The order in which the write was queued. */
  seq?: number;
  /** A failed update whose record a complete refresh no longer returned. */
  missingRecord?: 'deleted' | 'unknown';
  /**
   * Added within version 1: an update made as a JSON Merge Patch (absent:
   * the full record, as every update before). A client from before this
   * field ignores it and would send such an update as a full record.
   */
  updateBody?: 'mergePatch';
}

/** The writes of one record (collection, bound context, id), oldest first. */
export interface StoredRecordWrites {
  resource: string;
  context: Record<string, string>;
  id: string;
  /** The confirmed remote record the pending writes are replayed on. */
  confirmed?: Record<string, unknown>;
  /**
   * Without `confirmed`: the last confirmed copy, kept when a refresh no
   * longer returned the record. Stored once here, not per write.
   */
  lastKnown?: Record<string, unknown>;
  failed: StoredWrite[];
  queue: StoredWrite[];
}

/**
 * A record whose visible copy must be rebuilt from `confirmed` (absent: no
 * remote record) plus any pending writes. Written when a create settles
 * under another id, cleared once both visible records are rebuilt.
 */
export interface StoredRebuild {
  resource: string;
  context: Record<string, string>;
  id: string;
  confirmed?: Record<string, unknown>;
}

/**
 * The cursor of a collection's deletion feed (`x-deletion-feed`), per
 * collection and bound context: what the next feed read sends. `operation`
 * is the feed's `operationId`; a cursor for another operation is not sent.
 */
export interface StoredFeedCursor {
  resource: string;
  context: Record<string, string>;
  operation: string;
  cursor: string;
}

/**
 * Ids a collection's deletion feed reported with a tombstone, per collection
 * and bound context, kept only for records that have unsettled writes: the
 * next sync uses them before it reads such a record.
 */
export interface StoredFeedTombstones {
  resource: string;
  context: Record<string, string>;
  tombstones: string[];
}

export interface OutboxDocument {
  version: typeof OUTBOX_VERSION;
  records: StoredRecordWrites[];
  rebuild: StoredRebuild[];
  /** Added within version 1; absent in an outbox without feed cursors. */
  feedCursors: StoredFeedCursor[];
  /** Added within version 1; absent in an outbox without stored tombstones. */
  feedTombstones: StoredFeedTombstones[];
  /**
   * Entries this version cannot restore (malformed, or for a collection the
   * current document does not have). They are written back unchanged.
   */
  unrestorable: unknown[];
  /**
   * Present while the client sends no writes because the server refused its
   * credentials; cleared by `authRenewed()`. Writes in `blocked` state wait
   * for it.
   */
  authBlock?: AuthBlock;
}

const TYPES = new Set(['create', 'update', 'delete']);
const STATES = new Set(['pending', 'uncertain', 'failed', 'blocked']);

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((v) => typeof v === 'string')
  );
}

function isStoredWrite(value: unknown): value is StoredWrite {
  return (
    isRecord(value) &&
    TYPES.has(value['type'] as string) &&
    STATES.has(value['state'] as string) &&
    typeof value['attempts'] === 'number' &&
    (value['data'] === undefined || isRecord(value['data'])) &&
    (value['changes'] === undefined || isRecord(value['changes'])) &&
    (value['base'] === undefined || isRecord(value['base'])) &&
    (value['conflicts'] === undefined || Array.isArray(value['conflicts'])) &&
    (value['lastStatus'] === undefined ||
      typeof value['lastStatus'] === 'number') &&
    (value['idempotencyKey'] === undefined ||
      typeof value['idempotencyKey'] === 'string') &&
    (value['confirmedId'] === undefined ||
      typeof value['confirmedId'] === 'string') &&
    (value['refreshMisses'] === undefined ||
      typeof value['refreshMisses'] === 'number') &&
    (value['seq'] === undefined || typeof value['seq'] === 'number') &&
    (value['missingRecord'] === undefined ||
      value['missingRecord'] === 'deleted' ||
      value['missingRecord'] === 'unknown') &&
    (value['updateBody'] === undefined ||
      value['updateBody'] === 'mergePatch') &&
    // A per-write lastKnown came from unreleased commits of #312; such an entry
    // has no usable base, so it is kept as unrestorable rather than sent.
    value['lastKnown'] === undefined
  );
}

function isTarget(
  value: unknown,
): value is { resource: string; context: Record<string, string>; id: string } {
  return (
    isRecord(value) &&
    typeof value['resource'] === 'string' &&
    typeof value['id'] === 'string' &&
    isStringMap(value['context']) &&
    (value['confirmed'] === undefined || isRecord(value['confirmed']))
  );
}

export function isStoredRecordWrites(
  value: unknown,
): value is StoredRecordWrites {
  return (
    isTarget(value) &&
    ((value as Record<string, unknown>)['lastKnown'] === undefined ||
      isRecord((value as Record<string, unknown>)['lastKnown'])) &&
    Array.isArray((value as Record<string, unknown>)['failed']) &&
    Array.isArray((value as Record<string, unknown>)['queue']) &&
    [
      ...((value as Record<string, unknown>)['failed'] as unknown[]),
      ...((value as Record<string, unknown>)['queue'] as unknown[]),
    ].every(isStoredWrite)
  );
}

export function isStoredRebuild(value: unknown): value is StoredRebuild {
  return isTarget(value);
}

export function isStoredFeedTombstones(
  value: unknown,
): value is StoredFeedTombstones {
  return (
    isRecord(value) &&
    typeof value['resource'] === 'string' &&
    isStringMap(value['context']) &&
    Array.isArray(value['tombstones']) &&
    value['tombstones'].every((id) => typeof id === 'string') &&
    value['id'] === undefined
  );
}

export function isStoredFeedCursor(value: unknown): value is StoredFeedCursor {
  return (
    isRecord(value) &&
    typeof value['resource'] === 'string' &&
    isStringMap(value['context']) &&
    typeof value['operation'] === 'string' &&
    typeof value['cursor'] === 'string' &&
    // Not a record entry: those carry an id.
    value['id'] === undefined
  );
}

function isAuthBlock(value: unknown): value is AuthBlock {
  return (
    isRecord(value) &&
    typeof value['status'] === 'number' &&
    typeof value['lastError'] === 'string' &&
    typeof value['resource'] === 'string' &&
    typeof value['id'] === 'string' &&
    (value['context'] === undefined || isStringMap(value['context']))
  );
}

export function emptyOutbox(): OutboxDocument {
  return {
    version: OUTBOX_VERSION,
    records: [],
    rebuild: [],
    feedCursors: [],
    feedTombstones: [],
    unrestorable: [],
  };
}

/**
 * Reads a stored outbox record. A missing record (storage written before the
 * outbox existed, or never written to) is an empty outbox. A record of
 * another version is refused rather than overwritten: a newer syncables may
 * have written writes this one cannot represent. Entries that do not parse
 * are kept aside and written back unchanged.
 */
/** The stored outbox has a version this client does not read. */
export class OutboxVersionError extends Error {}

export function readOutbox(value: unknown): OutboxDocument {
  if (value === undefined) return emptyOutbox();
  const raw = JSON.parse(JSON.stringify(value)) as unknown;
  if (!isRecord(raw) || raw['version'] !== OUTBOX_VERSION)
    throw new OutboxVersionError(
      `The stored syncables outbox has version ${JSON.stringify(isRecord(raw) ? raw['version'] : raw)}; this client reads version ${OUTBOX_VERSION}. It is left unchanged; no writes are restored or accepted.`,
    );
  const outbox = emptyOutbox();
  const list = (name: string): unknown[] =>
    Array.isArray(raw[name]) ? (raw[name] as unknown[]) : [];
  for (const entry of list('records'))
    if (isStoredRecordWrites(entry)) outbox.records.push(entry);
    else outbox.unrestorable.push(entry);
  for (const entry of list('rebuild'))
    if (isStoredRebuild(entry)) outbox.rebuild.push(entry);
    else outbox.unrestorable.push(entry);
  for (const entry of list('feedCursors'))
    if (isStoredFeedCursor(entry)) outbox.feedCursors.push(entry);
    else outbox.unrestorable.push(entry);
  for (const entry of list('feedTombstones'))
    if (isStoredFeedTombstones(entry)) outbox.feedTombstones.push(entry);
    else outbox.unrestorable.push(entry);
  // Entries set aside earlier are tried again: the document may have
  // regained their collection. Malformed ones stay set aside.
  for (const entry of list('unrestorable'))
    if (isStoredRecordWrites(entry)) outbox.records.push(entry);
    else if (isStoredRebuild(entry)) outbox.rebuild.push(entry);
    else if (isStoredFeedCursor(entry)) outbox.feedCursors.push(entry);
    else if (isStoredFeedTombstones(entry)) outbox.feedTombstones.push(entry);
    else outbox.unrestorable.push(entry);
  // Added within version 1: an outbox without it was not blocked. A
  // malformed one still blocks, so writes wait for authRenewed().
  if (raw['authBlock'] !== undefined)
    outbox.authBlock = isAuthBlock(raw['authBlock'])
      ? raw['authBlock']
      : {
          status: 0,
          lastError: 'Stored authentication block could not be read',
          resource: '',
          id: '',
        };
  return outbox;
}
