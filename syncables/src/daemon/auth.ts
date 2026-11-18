import { keychainCommand } from './keychain.js';
import { ConnectionGrantAuthError } from './sync-errors.js';
import {
  checkGrantBinding,
  KeychainConnectionGrants,
  parseConnectionGrant,
  validateGrantExpiry,
  type ConnectionGrantStore,
} from './connection-grants.js';
import { nodeHash } from '../postgres/json-graph.js';
import { deviceLogin, listConnections, type Session } from '../cli/auth.js';
import type { PoolClient } from 'pg';
import type { PostgresArchive } from '../postgres/archive.js';
import type { DaemonConfig } from './config.js';

export interface DeviceCredentials extends Session {
  refreshToken: string;
  expiresAt: number;
  tokenEndpoint: string;
  sessionId: string;
  clientId: string;
  owner: string;
}
export interface CredentialStore {
  get(): Promise<DeviceCredentials | undefined>;
  set(value: DeviceCredentials): Promise<void>;
  delete(): Promise<void>;
}
/** macOS secrets enter security's stdin, never argv, PostgreSQL or a file. */
export class KeychainCredentials implements CredentialStore {
  private readonly account: string;
  constructor(config: DaemonConfig) {
    this.account = nodeHash(
      JSON.stringify([config.issuer, config.clientId, config.owner]),
    );
  }
  async get(): Promise<DeviceCredentials | undefined> {
    try {
      return JSON.parse(
        Buffer.from(
          (
            await keychainCommand([
              'find-generic-password',
              '-s',
              'syncables-daemon',
              '-a',
              this.account,
              '-w',
            ])
          ).trim(),
          'base64',
        ).toString('utf8'),
      ) as DeviceCredentials;
    } catch {
      return undefined;
    }
  }
  async set(value: DeviceCredentials): Promise<void> {
    const secret = Buffer.from(JSON.stringify(value)).toString('base64');
    await keychainCommand(
      ['-i'],
      `add-generic-password -U -s syncables-daemon -a ${this.account} -w ${secret}\n`,
    );
    // security's interactive process exit status is not sufficient to prove
    // a subcommand succeeded: require a readback before accepting rotation.
    const stored = await this.get();
    if (stored?.refreshToken !== value.refreshToken)
      throw new Error('Keychain did not persist the session');
  }
  async delete(): Promise<void> {
    await keychainCommand([
      'delete-generic-password',
      '-s',
      'syncables-daemon',
      '-a',
      this.account,
    ]).catch((error: unknown) => {
      if ((error as { code?: number }).code !== 44) throw error;
    });
  }
}
export class DaemonAuth {
  private value: DeviceCredentials | undefined;
  private refreshing: Promise<DeviceCredentials> | undefined;
  private pendingEphemeralRevocation: string | undefined;
  constructor(
    private readonly config: DaemonConfig,
    private readonly archive: PostgresArchive,
    private readonly credentials?: CredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly grants:
      | ConnectionGrantStore
      | undefined = credentials instanceof KeychainCredentials
      ? new KeychainConnectionGrants()
      : undefined,
    private readonly retainEphemeralRevocation = false,
  ) {
    if (retainEphemeralRevocation && credentials)
      throw new Error('Ephemeral cleanup cannot use persistent credentials');
  }
  async login(
    report: (message: string) => void,
    write = false,
    manage = false,
  ): Promise<void> {
    let grant: Omit<DeviceCredentials, 'owner'> | undefined;
    const session = await deviceLogin(
      {
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        scope:
          'connections:read proxy:read' +
          (write ? ' proxy:write' : '') +
          (manage ? ' connections:manage sessions:manage' : '') +
          (this.config.collections.some((c) => c.notifications)
            ? ' notifications:consume'
            : ''),
      },
      {
        fetch: this.fetchImpl,
        report,
        onAuthorized: (fields) => {
          grant = fields;
          // This token must remain revocable if later consent/discovery checks
          // fail. It never becomes a usable session before owner verification.
          if (this.retainEphemeralRevocation)
            this.pendingEphemeralRevocation = fields.refreshToken;
        },
      },
    );
    if (write && !session.scope?.split(' ').includes('proxy:write'))
      throw new Error('Server did not approve proxy:write');
    if (
      manage &&
      !['connections:manage', 'sessions:manage'].every((scope) =>
        session.scope?.split(' ').includes(scope),
      )
    )
      throw new Error('Server did not approve management permissions');
    const discovered = await listConnections(session, this.fetchImpl);
    if (discovered.owner !== this.config.owner)
      throw new Error(
        'Authenticated owner does not match daemon configuration',
      );
    if (!grant) throw new Error('Device grant has no refresh/session metadata');
    const value = { ...grant, owner: discovered.owner };
    await this.withAuthLock(async (client) => {
      if (this.credentials) await this.credentials.set(value);
      if (this.credentials)
        await client.query(
          'DELETE FROM syncables_cache.device_login_required WHERE owner=$1 AND issuer=$2 AND client_id=$3',
          [this.config.owner, this.config.issuer, this.config.clientId],
        );
      this.value = value;
      this.pendingEphemeralRevocation = undefined;
    });
  }
  private validate(value: DeviceCredentials | undefined): DeviceCredentials {
    if (
      !value ||
      value.owner !== this.config.owner ||
      value.issuer !== this.config.issuer ||
      value.clientId !== this.config.clientId ||
      !value.sessionId ||
      !value.accessToken ||
      !value.refreshToken ||
      !Number.isFinite(value.expiresAt)
    )
      throw new Error('Login required; run syncables login');
    const token = new URL(value.tokenEndpoint);
    if (
      token.origin !== this.config.issuer ||
      token.username ||
      token.password ||
      token.hash ||
      token.search
    )
      throw new Error('Invalid stored token endpoint');
    return value;
  }
  async session(): Promise<DeviceCredentials> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.withAuthLock((client) => this.sessionLocked(client));
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async withAuthLock<T>(
    action: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    // Serialize across foreground commands/daemon, then reload the newest
    // Keychain value under the lock to avoid consumed-refresh-token reuse.
    const key = JSON.stringify([
      this.config.owner,
      this.config.issuer,
      this.config.clientId,
    ]);
    const client = await this.archive.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', [
        'syncables-auth',
        key,
      ]);
      return await action(client);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [
          'syncables-auth',
          key,
        ])
        .catch(() => {});
      client.release();
    }
  }
  private async sessionLocked(client: PoolClient): Promise<DeviceCredentials> {
    if (this.credentials) {
      const guard = await client.query(
        'SELECT 1 FROM syncables_cache.device_login_required WHERE owner=$1 AND issuer=$2 AND client_id=$3',
        [this.config.owner, this.config.issuer, this.config.clientId],
      );
      if (guard.rowCount)
        throw new Error('Login required after interrupted refresh or logout');
    }
    this.value = this.validate(
      this.credentials ? await this.credentials.get() : this.value,
    );
    if (this.value.expiresAt > Date.now() + 60_000) return this.value;
    const old = this.value;
    // Commit before sending a rotating token: a crash/lost response must
    // not let any later process reload and reuse the possibly consumed token.
    if (this.credentials)
      await client.query(
        'INSERT INTO syncables_cache.device_login_required(owner,issuer,client_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
        [this.config.owner, this.config.issuer, this.config.clientId],
      );
    try {
      const response = await this.fetchImpl(old.tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        body: new URLSearchParams({
          client_id: old.clientId,
          grant_type: 'refresh_token',
          refresh_token: old.refreshToken,
        }),
      });
      if (!response.ok) throw new Error('Refresh refused');
      const token = (await response.json()) as Record<string, unknown>;
      if (
        typeof token.access_token !== 'string' ||
        !token.access_token ||
        typeof token.refresh_token !== 'string' ||
        !token.refresh_token ||
        typeof token.expires_in !== 'number' ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in <= 0 ||
        typeof token.token_type !== 'string' ||
        token.token_type.toLowerCase() !== 'bearer' ||
        token.session_id !== old.sessionId ||
        token.owner !== old.owner
      )
        throw new Error('Invalid refresh response');
      if (
        typeof token.scope === 'string' &&
        token.scope
          .split(' ')
          .some(
            (scope) =>
              !(old.scope ?? 'connections:read proxy:read')
                .split(' ')
                .includes(scope),
          )
      )
        throw new Error('Refresh attempted to widen the approved scope');
      const next = {
        ...old,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        ...(typeof token.scope === 'string' ? { scope: token.scope } : {}),
      };
      if (this.credentials) await this.credentials.set(next);
      if (this.credentials)
        await client.query(
          'DELETE FROM syncables_cache.device_login_required WHERE owner=$1 AND issuer=$2 AND client_id=$3',
          [this.config.owner, this.config.issuer, this.config.clientId],
        );
      this.value = next;
      return next;
    } catch {
      // A lost response may have consumed the old refresh token. Never retry
      // it: clear local state and require another explicit device login.
      this.value = undefined;
      await this.credentials?.delete().catch(() => {});
      throw new Error('Login required after failed or uncertain refresh');
    }
  }
  async importConnectionGrant(envelope: unknown): Promise<void> {
    const grant = parseConnectionGrant(envelope);
    validateGrantExpiry(grant.expiresAt);
    const store = this.grants;
    if (!store)
      throw new Error(
        'Connection grant import requires a configured grant store',
      );
    const { issuer, owner, clientId } = this.config;
    if (
      grant.issuer !== issuer ||
      grant.owner !== owner ||
      grant.clientId !== clientId
    )
      throw new Error(
        'Connection grant does not match the current configuration',
      );
    await this.withAuthLock(async (client) => {
      const session = await this.sessionLocked(client);
      checkGrantBinding(grant, {
        ...session,
        connectionId: grant.connectionId,
      });
      const available = await listConnections(session, this.fetchImpl);
      if (
        available.owner !== owner ||
        !available.connections.some(
          (connection) => connection.connection_id === grant.connectionId,
        )
      )
        throw new Error(
          'Connection is not approved for the current device session',
        );
      validateGrantExpiry(grant.expiresAt);
      await store.set(grant);
    });
  }
  async connectionGrant(
    connectionId: string,
    forSession?: DeviceCredentials,
  ): Promise<string | undefined> {
    if (!this.grants) return undefined;
    const session = forSession
      ? this.validate(forSession)
      : await this.session();
    const { issuer, owner, clientId, sessionId } = session;
    const binding = { issuer, owner, clientId, sessionId, connectionId };
    const stored = await this.grants.get(binding).catch((error: unknown) => {
      if (error instanceof ConnectionGrantAuthError) throw error;
      throw new ConnectionGrantAuthError('keychain');
    });
    if (!stored) return undefined;
    try {
      const grant = parseConnectionGrant(stored);
      checkGrantBinding(grant, binding);
      validateGrantExpiry(grant.expiresAt);
      return grant.grant;
    } catch (error) {
      if (error instanceof ConnectionGrantAuthError) throw error;
      throw new ConnectionGrantAuthError('invalid');
    }
  }
  async authorizationContext(): Promise<string> {
    return (await this.session()).sessionId;
  }
  async logout(): Promise<void> {
    // No persistent session exists in this opt-in mode. Cleanup must still
    // reach the issuer if the local archive/lock service has just failed.
    if (this.retainEphemeralRevocation) {
      await this.logoutLocked();
      return;
    }
    await this.withAuthLock(async (client) => {
      if (this.credentials)
        await client.query(
          'INSERT INTO syncables_cache.device_login_required(owner,issuer,client_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [this.config.owner, this.config.issuer, this.config.clientId],
        );
      await this.logoutLocked();
    });
  }
  private async logoutLocked(): Promise<void> {
    const value = this.credentials ? await this.credentials.get() : this.value;
    const token = value?.refreshToken ?? this.pendingEphemeralRevocation;
    this.value = undefined;
    this.pendingEphemeralRevocation = undefined;
    await this.credentials?.delete();
    if (token) {
      const response = await this.fetchImpl(
        new URL('/oauth/device/revoke', this.config.issuer),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            client_id: this.config.clientId,
            token,
          }),
        },
      );
      if (!response.ok)
        throw new Error('Local credentials removed; server revocation failed');
    }
  }
}
