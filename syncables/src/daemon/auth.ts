import { spawn } from 'node:child_process';
import { nodeHash } from '../postgres/json-graph.js';
import { deviceLogin, listConnections, type Session } from '../cli/auth.js';
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
  private async command(args: string[], input = ''): Promise<string> {
    if (process.platform !== 'darwin')
      throw new Error(
        'Persistent credentials require macOS Keychain; use --interactive for a foreground test',
      );
    return new Promise<string>((done, reject) => {
      const child = spawn('/usr/bin/security', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      const timer = setTimeout(() => child.kill(), 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024) child.kill();
        else chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('Keychain access failed'));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        return code === 0
          ? done(Buffer.concat(chunks).toString('utf8'))
          : reject(
              Object.assign(
                new Error('Keychain item unavailable or access refused'),
                { code },
              ),
            );
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async get(): Promise<DeviceCredentials | undefined> {
    try {
      return JSON.parse(
        Buffer.from(
          (
            await this.command([
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
    await this.command(
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
    await this.command([
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
  private refreshing: Promise<Session> | undefined;
  constructor(
    private readonly config: DaemonConfig,
    private readonly archive: PostgresArchive,
    private readonly credentials?: CredentialStore,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}
  async login(report: (message: string) => void): Promise<void> {
    let grant: Omit<DeviceCredentials, 'owner'> | undefined;
    const session = await deviceLogin(
      {
        issuer: this.config.issuer,
        clientId: this.config.clientId,
        scope: 'connections:read proxy:read',
      },
      {
        fetch: this.fetchImpl,
        report,
        onAuthorized: (fields) => {
          grant = fields;
        },
      },
    );
    const discovered = await listConnections(session, this.fetchImpl);
    if (discovered.owner !== this.config.owner)
      throw new Error(
        'Authenticated owner does not match daemon configuration',
      );
    if (!grant) throw new Error('Device grant has no refresh/session metadata');
    const value = { ...grant, owner: discovered.owner };
    const client = await this.archive.pool.connect();
    const key = JSON.stringify([
      this.config.owner,
      this.config.issuer,
      this.config.clientId,
    ]);
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', [
        'syncables-auth',
        key,
      ]);
      if (this.credentials) await this.credentials.set(value);
      if (this.credentials)
        await client.query(
          'DELETE FROM syncables_cache.device_login_required WHERE owner=$1 AND issuer=$2 AND client_id=$3',
          [this.config.owner, this.config.issuer, this.config.clientId],
        );
      this.value = value;
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
  async session(): Promise<Session> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.getSession();
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }
  private async getSession(): Promise<Session> {
    // Serialize across foreground commands/daemon, then reload the newest
    // Keychain value under the lock to avoid consumed-refresh-token reuse.
    const client = await this.archive.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', [
        'syncables-auth',
        JSON.stringify([
          this.config.owner,
          this.config.issuer,
          this.config.clientId,
        ]),
      ]);
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
        const next = {
          ...old,
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: Date.now() + token.expires_in * 1000,
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
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [
          'syncables-auth',
          JSON.stringify([
            this.config.owner,
            this.config.issuer,
            this.config.clientId,
          ]),
        ])
        .catch(() => {});
      client.release();
    }
  }
  async authorizationContext(): Promise<string> {
    await this.session();
    return this.value!.sessionId;
  }
  async logout(): Promise<void> {
    const client = await this.archive.pool.connect();
    const key = JSON.stringify([
      this.config.owner,
      this.config.issuer,
      this.config.clientId,
    ]);
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1),hashtext($2))', [
        'syncables-auth',
        key,
      ]);
      if (this.credentials)
        await client.query(
          'INSERT INTO syncables_cache.device_login_required(owner,issuer,client_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [this.config.owner, this.config.issuer, this.config.clientId],
        );
      await this.logoutLocked();
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
  private async logoutLocked(): Promise<void> {
    const value = this.credentials ? await this.credentials.get() : this.value;
    this.value = undefined;
    await this.credentials?.delete();
    if (value) {
      const response = await this.fetchImpl(
        new URL('/oauth/device/revoke', this.config.issuer),
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          body: new URLSearchParams({
            client_id: this.config.clientId,
            token: value.refreshToken,
          }),
        },
      );
      if (!response.ok)
        throw new Error('Local credentials removed; server revocation failed');
    }
  }
}
