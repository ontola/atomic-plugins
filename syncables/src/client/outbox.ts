import { isRecord } from '../read/model.js';
import type {
  PendingWriteState,
  PendingWriteType,
  WriteConflict,
} from './client.js';

/**
 * The durable outbox: one record, `{ version, records, rebuild }`, kept in a
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

export interface OutboxDocument {
  version: typeof OUTBOX_VERSION;
  records: StoredRecordWrites[];
  rebuild: StoredRebuild[];
  /**
   * Entries this version cannot restore (malformed, or for a collection the
   * current document does not have). They are written back unchanged.
   */
  unrestorable: unknown[];
}

const TYPES = new Set(['create', 'update', 'delete']);
const STATES = new Set(['pending', 'uncertain', 'failed']);

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
    (value['idempotencyKey'] === undefined ||
      typeof value['idempotencyKey'] === 'string') &&
    (value['confirmedId'] === undefined ||
      typeof value['confirmedId'] === 'string') &&
    (value['refreshMisses'] === undefined ||
      typeof value['refreshMisses'] === 'number') &&
    (value['seq'] === undefined || typeof value['seq'] === 'number') &&
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

export function emptyOutbox(): OutboxDocument {
  return {
    version: OUTBOX_VERSION,
    records: [],
    rebuild: [],
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
  // Entries set aside earlier are tried again: the document may have
  // regained their collection. Malformed ones stay set aside.
  for (const entry of list('unrestorable'))
    if (isStoredRecordWrites(entry)) outbox.records.push(entry);
    else if (isStoredRebuild(entry)) outbox.rebuild.push(entry);
    else outbox.unrestorable.push(entry);
  return outbox;
}
