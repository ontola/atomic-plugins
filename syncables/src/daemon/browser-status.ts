// @wc-ignore-file
import { listConnections, type Session } from '../cli/auth.js';
import { alias, collectionScope, type CollectionConfig } from './config.js';
import type { JobStatus } from './runner.js';
import { isSyncAuthError } from './sync-errors.js';

export interface BrowserCollectionStatus {
  alias: string;
  connectionId: string;
  platform: string;
  state:
    | 'not-synced'
    | 'synced'
    | 'pending'
    | 'syncing'
    | 'auth-error'
    | 'sync-error'
    | 'checkout-blocked';
  hasSnapshot: boolean;
  lastSyncedAt: string | null;
  lastAttemptAt: string | null;
  lastFailureAt: string | null;
  nextAttemptAt: string | null;
  error: string | null;
}
export interface BrowserConnectionStatus {
  id: string;
  platform: string;
  label: string;
  availability: 'approved' | 'not-approved' | 'unknown';
  collections: BrowserCollectionStatus[];
  lastSyncedAt: string | null;
}
export interface BrowserStatus {
  checkedAt: string;
  discovery: {
    state: 'available' | 'auth-required' | 'unavailable';
    message: string | null;
  };
  connections: BrowserConnectionStatus[];
  collections: BrowserCollectionStatus[];
}
function date(value: Date | null | undefined): string | null {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : null;
}
/** Never attribute a previous connection/query's sync history to a changed config. */
export function browserJobMatches(
  job: JobStatus,
  owner: string,
  source: CollectionConfig,
): boolean {
  try {
    const scope: unknown = JSON.parse(job.scope);
    return (
      Array.isArray(scope) &&
      typeof scope[6] === 'string' &&
      collectionScope(owner, source, scope[6]) === job.scope
    );
  } catch {
    return false;
  }
}
/** Only safe, explicit status fields cross into the browser; no session objects. */
export async function loadBrowserStatus(options: {
  owner: string;
  collections: CollectionConfig[];
  jobs: () => Promise<JobStatus[]>;
  hasSnapshot: (alias: string) => Promise<boolean>;
  session: () => Promise<Session>;
  fetch?: typeof fetch;
}): Promise<BrowserStatus> {
  const jobs = await options.jobs();
  const collections = await Promise.all(
    options.collections.map(
      async (source): Promise<BrowserCollectionStatus> => {
        const name = alias(source),
          job = jobs.find(
            (entry) =>
              entry.alias === name &&
              browserJobMatches(entry, options.owner, source),
          );
        const hasSnapshot = await options.hasSnapshot(name);
        let state: BrowserCollectionStatus['state'] = hasSnapshot
          ? 'synced'
          : 'not-synced';
        let error: string | null = null;
        if (job?.state === 'working') state = 'syncing';
        else if (
          job?.state === 'checkout-blocked' ||
          job?.error_kind === 'checkout'
        ) {
          state = 'checkout-blocked';
          error =
            'Snapshot saved, but the working folder needs attention. Run checkout to retry.';
        } else if (job?.state === 'failed' || job?.last_error) {
          if (
            job.error_kind === 'auth' ||
            (!job.error_kind &&
              /authorization needs attention/i.test(job.last_error ?? ''))
          ) {
            state = 'auth-error';
            error =
              'Authorization needs attention. Sign in again or check approved connections.';
          } else {
            state = 'sync-error';
            error = hasSnapshot
              ? 'Sync did not finish. The last saved snapshot is still available.'
              : 'Sync did not finish. No snapshot has been saved yet.';
          }
        }
        if (job?.state === 'pending' && !error) state = 'pending';
        return {
          alias: name,
          connectionId: source.connection,
          platform: source.platform,
          state,
          hasSnapshot,
          lastSyncedAt: date(job?.last_success_at),
          lastAttemptAt: date(job?.last_attempt_at),
          lastFailureAt: date(job?.last_failure_at),
          nextAttemptAt: date(job?.next_due),
          error,
        };
      },
    ),
  );
  let discovery: BrowserStatus['discovery'];
  const remote: { connection_id: string; platform: string; label?: string }[] =
    [];
  try {
    const session = await options.session();
    const found = await listConnections(session, options.fetch);
    if (found.owner !== options.owner)
      throw new Error('Login required: owner mismatch');
    remote.push(...found.connections);
    discovery = { state: 'available', message: null };
  } catch (error) {
    discovery = isSyncAuthError(error)
      ? {
          state: 'auth-required',
          message:
            'Sign in with syncables login --config FILE, or restart the UI with --interactive. Only connections approved for SyncD are available.',
        }
      : {
          state: 'unavailable',
          message:
            'Could not check remote connections. Local snapshots are still available. Retry to check again.',
        };
  }
  const entries = new Map<string, BrowserConnectionStatus>();
  const key = (id: string, platform: string): string =>
    JSON.stringify([id, platform]);
  for (const connection of remote)
    entries.set(key(connection.connection_id, connection.platform), {
      id: connection.connection_id,
      platform: connection.platform,
      label: connection.label || connection.platform,
      availability: 'approved',
      collections: [],
      lastSyncedAt: null,
    });
  for (const collection of collections) {
    const id = key(collection.connectionId, collection.platform);
    if (!entries.has(id))
      entries.set(id, {
        id: collection.connectionId,
        platform: collection.platform,
        label: collection.platform,
        availability:
          discovery.state === 'available' ? 'not-approved' : 'unknown',
        collections: [],
        lastSyncedAt: null,
      });
    const connection = entries.get(id)!;
    connection.collections.push(collection);
    if (
      collection.lastSyncedAt &&
      (!connection.lastSyncedAt ||
        collection.lastSyncedAt > connection.lastSyncedAt)
    )
      connection.lastSyncedAt = collection.lastSyncedAt;
  }
  return {
    checkedAt: new Date().toISOString(),
    discovery,
    connections: [...entries.values()],
    collections,
  };
}
