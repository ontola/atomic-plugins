import type { Readable } from 'node:stream';
import { listConnections, type Connection } from '../cli/auth.js';
import type { PostgresArchive } from '../postgres/archive.js';
import { DaemonAuth, type DeviceCredentials } from './auth.js';
import type { CollectionConfig, DaemonConfig } from './config.js';
import {
  checkGrantBinding,
  parseConnectionGrant,
  readConnectionGrant,
  validateGrantExpiry,
  type ConnectionGrant,
  type ConnectionGrantBinding,
  type ConnectionGrantStore,
} from './connection-grants.js';

export const INTERACTIVE_GRANT_BINDING_PREFIX =
  'SYNCABLES_CONNECTION_GRANT_BINDING ';

export function validateInteractiveGrantOptions(
  command: string | undefined,
  values: Record<string, unknown>,
): void {
  if (
    values['connection-grant-stdin'] &&
    (!values.interactive ||
      !['sync', 'send'].includes(command ?? '') ||
      values.write ||
      values.manage)
  )
    throw new Error(
      '--connection-grant-stdin requires interactive sync or send without --write or --manage',
    );
}

/** Copies on both boundaries; only opaque, validated grants enter this map. */
export class MemoryConnectionGrants implements ConnectionGrantStore {
  private readonly values = new Map<string, Readonly<ConnectionGrant>>();
  private key(binding: ConnectionGrantBinding): string {
    return JSON.stringify([
      binding.issuer,
      binding.owner,
      binding.clientId,
      binding.sessionId,
      binding.connectionId,
    ]);
  }
  async get(
    binding: ConnectionGrantBinding,
  ): Promise<ConnectionGrant | undefined> {
    const stored = this.values.get(this.key(binding));
    if (!stored) return undefined;
    const value = parseConnectionGrant(stored);
    checkGrantBinding(value, binding);
    validateGrantExpiry(value.expiresAt);
    return Object.freeze(value);
  }
  async set(input: ConnectionGrant): Promise<void> {
    const value = parseConnectionGrant(input);
    validateGrantExpiry(value.expiresAt);
    this.values.set(this.key(value), Object.freeze(value));
  }
  clear(): void {
    // JavaScript strings cannot be zeroed; drop every retained reference.
    this.values.clear();
  }
}

export function interactiveGrantConnection(
  sources: CollectionConfig[],
): Connection {
  if (
    !sources.length ||
    sources.some(
      (source) =>
        source.local ||
        source.fileInventory ||
        source.connection.startsWith('local-index:'),
    )
  )
    throw new Error(
      'Select only remote collections for a stdin connection grant',
    );
  const first = sources[0];
  if (
    sources.some(
      (source) =>
        source.connection !== first.connection ||
        source.platform !== first.platform,
    )
  )
    throw new Error(
      'A stdin grant requires exactly one selected connection and platform',
    );
  return { connection_id: first.connection, platform: first.platform };
}

/** Explicit opt-in only: a new login, bounded stdin import and final revocation. */
export async function withInteractiveConnectionGrant<T>(
  options: {
    config: DaemonConfig;
    archive: PostgresArchive;
    connection: Connection;
    write: boolean;
    input: Readable;
    report: (message: string) => void;
    fetch?: typeof fetch;
  },
  action: (
    auth: DaemonAuth,
    session: DeviceCredentials,
    connection: Connection,
    grant: string,
  ) => Promise<T>,
): Promise<T> {
  if ((options.input as Readable & { isTTY?: boolean }).isTTY)
    throw new Error('Pipe the owner-issued connection grant through stdin');
  const grants = new MemoryConnectionGrants();
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const auth = new DaemonAuth(
    options.config,
    options.archive,
    undefined,
    fetchImpl,
    grants,
    true,
  );
  const run = async (): Promise<T> => {
    await auth.login(options.report, options.write);
    const session = await auth.session();
    const available = await listConnections(session, fetchImpl);
    if (
      available.owner !== options.config.owner ||
      !available.connections.some(
        (connection) =>
          connection.connection_id === options.connection.connection_id &&
          connection.platform === options.connection.platform,
      )
    )
      throw new Error(
        'Selected connection is not approved for this owner and platform',
      );
    options.report(
      INTERACTIVE_GRANT_BINDING_PREFIX +
        JSON.stringify({
          version: 1,
          issuer: session.issuer,
          owner: session.owner,
          clientId: session.clientId,
          sessionId: session.sessionId,
          connectionId: options.connection.connection_id,
          platform: options.connection.platform,
        }),
    );
    const envelope = await readConnectionGrant(options.input);
    if (envelope.connectionId !== options.connection.connection_id)
      throw new Error('Grant does not match the selected connection');
    await auth.importConnectionGrant(envelope);
    const grant = await auth.connectionGrant(
      options.connection.connection_id,
      session,
    );
    if (!grant) throw new Error('A sealed connection grant is required');
    return await action(auth, session, options.connection, grant);
  };
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await auth.logout();
  } catch {
    if (outcome.ok)
      outcome = {
        ok: false,
        error: new Error('Ephemeral device session revocation failed'),
      };
    else {
      try {
        options.report('Ephemeral device session revocation failed');
      } catch {
        /* Preserve the operation failure if stderr is unavailable. */
      }
    }
  } finally {
    grants.clear();
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
