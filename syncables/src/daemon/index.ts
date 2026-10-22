/** Experimental, local-only Versioned Atomic Data storage. */
export {
  GitAtomicStore,
  CheckoutBlockedError,
  type CheckoutResult,
  type AtomicSnapshot,
  type SnapshotRevision,
} from './git-store.js';
