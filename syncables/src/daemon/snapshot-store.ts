import type {
  AtomicSnapshot,
  CheckoutResult,
  SnapshotRevision,
} from './git-store.js';

/** Snapshot history, independent of its export format. */
export interface SnapshotStore {
  initialize(): Promise<void>;
  head(scope: string): Promise<string | undefined>;
  commit(
    snapshot: AtomicSnapshot,
    expected?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  resolveRevision(scope: string, revision?: string): Promise<string>;
  list(scope: string, revision?: string): Promise<string[]>;
  context(scope: string, revision?: string): Promise<Record<string, unknown>>;
  resource(
    scope: string,
    subject: string,
    revision?: string,
  ): Promise<string | undefined>;
  resolve(
    scope: string,
    subject: string,
    at?: string,
  ): Promise<{ commit: string; resource: string | undefined }>;
  historyEntries(
    scope: string,
    subject?: string,
    at?: string,
  ): Promise<SnapshotRevision[]>;
  tag(scope: string, name: string, revision?: string): Promise<string>;
  checkout(
    scope: string,
    collection: string,
  ): Promise<CheckoutResult | undefined>;
}
