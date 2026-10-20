import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { PostgresArchive } from '../postgres/archive.js';
import {
  listConnections,
  proxyReadTransport,
  proxyRequest,
  type Session,
} from '../cli/auth.js';
import { upstreamOf } from '../read/model.js';
import {
  syncCollection,
  prepareCollection,
  type PreparedCollection,
  type CollectionSyncResult,
  SyncRetryError,
} from './sync.js';
import { alias, selectedCollections, type DaemonConfig } from './config.js';
import type { GitAtomicStore } from './git-store.js';

export interface RunnerAuth {
  session(): Promise<Session>;
  authorizationContext(): Promise<string>;
}
export interface JobStatus {
  alias: string;
  scope: string;
  state: string;
  revision: string | null;
  last_error: string | null;
  next_due: Date;
  generation: string;
  completed: string;
}
export const JOB_SCHEMA = `
CREATE TABLE IF NOT EXISTS syncables_cache.daemon_jobs (
 owner text NOT NULL, alias text NOT NULL, scope text NOT NULL,
 state text NOT NULL DEFAULT 'pending', revision text, last_error text,
 generation bigint NOT NULL DEFAULT 1, completed bigint NOT NULL DEFAULT 0,
 failures integer NOT NULL DEFAULT 0, next_due timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner,alias)
);
CREATE TABLE IF NOT EXISTS syncables_cache.daemon_inbox (
 owner text NOT NULL, alias text NOT NULL, delivery text NOT NULL,
 body bytea NOT NULL, received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner,alias,delivery)
);
`;
export async function jobStatuses(
  archive: PostgresArchive,
  owner: string,
): Promise<JobStatus[]> {
  await archive.pool.query(JOB_SCHEMA);
  return (
    await archive.pool.query(
      'SELECT alias,scope,state,revision,last_error,next_due,generation,completed FROM syncables_cache.daemon_jobs WHERE owner=$1 ORDER BY alias',
      [owner],
    )
  ).rows as JobStatus[];
}
export class DaemonRunner {
  private prepared: PreparedCollection[] = [];
  constructor(
    readonly config: DaemonConfig,
    readonly archive: PostgresArchive,
    readonly store: GitAtomicStore,
    readonly auth: RunnerAuth,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly message?: string,
  ) {}
  async initialize(): Promise<void> {
    await this.archive.initialize();
    await this.store.initialize();
    await this.archive.pool.query(JOB_SCHEMA);
    this.prepared = await Promise.all(
      this.config.collections.map((c) =>
        prepareCollection(this.config.owner, c),
      ),
    );
    for (const p of this.prepared)
      await this.archive.pool.query(
        `INSERT INTO syncables_cache.daemon_jobs(owner,alias,scope) VALUES($1,$2,$3)
      ON CONFLICT(owner,alias) DO UPDATE SET scope=EXCLUDED.scope,
      generation=CASE WHEN daemon_jobs.scope<>EXCLUDED.scope THEN daemon_jobs.generation+1 ELSE daemon_jobs.generation END,
      next_due=CASE WHEN daemon_jobs.scope<>EXCLUDED.scope THEN clock_timestamp() ELSE daemon_jobs.next_due END`,
        [this.config.owner, alias(p.source), p.scope],
      );
  }
  async trigger(
    name: string,
    delivery: string,
    body: Buffer,
  ): Promise<boolean> {
    if (!this.prepared.some((p) => alias(p.source) === name))
      throw new Error('Unknown webhook collection');
    if (
      !delivery ||
      delivery.length > 200 ||
      [...delivery].some((c) => c.charCodeAt(0) < 32) ||
      body.length > 1024 * 1024
    )
      throw new Error('Invalid webhook delivery');
    const client = await this.archive.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        'INSERT INTO syncables_cache.daemon_inbox(owner,alias,delivery,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING delivery',
        [this.config.owner, name, delivery, body],
      );
      if (inserted.rowCount)
        await client.query(
          "UPDATE syncables_cache.daemon_jobs SET generation=generation+1,next_due=clock_timestamp(),state='pending' WHERE owner=$1 AND alias=$2",
          [this.config.owner, name],
        );
      await client.query('COMMIT');
      return !!inserted.rowCount;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  async sync(
    selectors: string[] = [],
    signal?: AbortSignal,
    dueOnly = false,
  ): Promise<
    { alias: string; result?: CollectionSyncResult; error?: string }[]
  > {
    const selected = new Set(
      selectedCollections(this.config, selectors).map(alias),
    );
    const results: {
      alias: string;
      result?: CollectionSyncResult;
      error?: string;
    }[] = [];
    for (const p of this.prepared) {
      const name = alias(p.source);
      if (!selected.has(name) || signal?.aborted) continue;
      const client = await this.archive.pool.connect();
      let locked = false;
      const controller = new AbortController();
      const stopped = (): void => controller.abort();
      signal?.addEventListener('abort', stopped, { once: true });
      if (signal?.aborted) stopped();
      client.on('error', stopped);
      try {
        locked = (
          await client.query(
            'SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS held',
            [this.config.owner, p.scope],
          )
        ).rows[0].held as boolean;
        if (!locked) {
          if (!dueOnly)
            results.push({ alias: name, error: 'Collection already syncing' });
          continue;
        }
        const job = (
          await client.query(
            'SELECT generation,failures,next_due<=clock_timestamp() AS due FROM syncables_cache.daemon_jobs WHERE owner=$1 AND alias=$2 AND scope=$3',
            [this.config.owner, name, p.scope],
          )
        ).rows[0];
        if (!job || (dueOnly && !job.due)) continue;
        await client.query(
          "UPDATE syncables_cache.daemon_jobs SET state='working' WHERE owner=$1 AND alias=$2",
          [this.config.owner, name],
        );
        try {
          const session = await this.auth.session();
          const connections = await listConnections(session, this.fetchImpl);
          if (connections.owner !== this.config.owner)
            throw new Error('Login required: owner mismatch');
          const connection = connections.connections.find(
            (c) =>
              c.connection_id === p.source.connection &&
              c.platform === p.source.platform,
          );
          if (!connection)
            throw new Error(
              'Login required: collection connection is not approved',
            );
          const authorizationContext = await this.auth.authorizationContext();
          const upstream = upstreamOf(p.document);
          const result = await syncCollection({
            prepared: p,
            archive: this.archive,
            store: this.store,
            auth: {
              owner: this.config.owner,
              connection: connection.connection_id,
              authorizationContext,
            },
            upstream: async (input) => {
              if (input.url.origin !== upstream.origin)
                throw new Error('Source request escaped its declared API');
              const fresh = await this.auth.session();
              const request = proxyRequest(
                fresh,
                connection,
                input.url.pathname + input.url.search,
              );
              return proxyReadTransport(
                fresh,
                connection,
                this.fetchImpl,
              )({ ...request, headers: input.headers });
            },
            signal: controller.signal,
            trigger: dueOnly ? 'scheduled' : 'manual',
            ...(this.message === undefined ? {} : { message: this.message }),
          });
          await client.query(
            `UPDATE syncables_cache.daemon_jobs SET completed=$3,revision=$4,last_error=NULL,failures=0,
            state=CASE WHEN generation=$3 THEN 'idle' ELSE 'pending' END,
            next_due=CASE WHEN generation<>$3 THEN clock_timestamp() WHEN $5=0 THEN 'infinity'::timestamptz ELSE clock_timestamp()+$5*interval '1 second' END
            WHERE owner=$1 AND alias=$2`,
            [
              this.config.owner,
              name,
              job.generation,
              result.revision,
              p.source.pollSeconds,
            ],
          );
          results.push({ alias: name, result });
        } catch (error) {
          const message =
            error instanceof Error &&
            /login|401|403|connection.*refused/i.test(error.message)
              ? 'Authorization needs attention; run login or check approved connections'
              : 'Sync did not finish; next attempt resumes from the published snapshot';
          const retry = Math.min(
            300,
            5 * 2 ** Math.min(Number(job.failures), 6),
          );
          const nextDue =
            error instanceof SyncRetryError && error.blocked
              ? 'infinity'
              : new Date(
                  Math.max(
                    Date.now() + retry * 1000,
                    error instanceof SyncRetryError ? (error.retryAt ?? 0) : 0,
                  ),
                ).toISOString();
          await client.query(
            "UPDATE syncables_cache.daemon_jobs SET state='failed',last_error=$3,failures=failures+1,next_due=$4::timestamptz WHERE owner=$1 AND alias=$2",
            [this.config.owner, name, message, nextDue],
          );
          results.push({ alias: name, error: message });
        }
      } finally {
        signal?.removeEventListener('abort', stopped);
        if (locked)
          await client
            .query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [
              this.config.owner,
              p.scope,
            ])
            .catch(() => {});
        client.removeListener('error', stopped);
        client.release();
      }
    }
    return results;
  }
  private async webhook(token: string): Promise<Server | undefined> {
    if (!this.config.webhookPort) return undefined;
    if (token.length < 32)
      throw new Error('Set SYNCABLES_WEBHOOK_TOKEN to at least 32 characters');
    const digest = (value: string): Buffer =>
      createHash('sha256').update(value).digest();
    const expected = digest('Bearer ' + token);
    const server = createServer(async (req, res) => {
      res.setHeader('cache-control', 'no-store');
      if (
        req.method !== 'POST' ||
        !timingSafeEqual(digest(req.headers.authorization ?? ''), expected)
      ) {
        res.writeHead(403).end();
        return;
      }
      try {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        if (!path.startsWith('/webhooks/')) {
          res.writeHead(404).end();
          return;
        }
        const name = decodeURIComponent(path.slice('/webhooks/'.length));
        const id = req.headers['x-syncables-delivery-id'];
        if (typeof id !== 'string') {
          res.writeHead(400).end();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) {
            res.writeHead(413).end();
            return;
          }
          chunks.push(chunk as Buffer);
        }
        await this.trigger(name, id, Buffer.concat(chunks));
        res.writeHead(204).end();
      } catch {
        res.writeHead(503).end();
      }
    });
    server.requestTimeout = 10_000;
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(this.config.webhookPort, '127.0.0.1', done);
    });
    return server;
  }
  async daemon(
    signal: AbortSignal,
    report: (result: unknown) => void,
    selectors: string[] = [],
    webhookToken = '',
  ): Promise<void> {
    const client = await this.archive.pool.connect();
    let server: Server | undefined;
    let locked = false;
    let lostLock = false;
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    const disconnected = (): void => {
      lostLock = true;
      controller.abort();
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    client.on('error', disconnected);
    try {
      locked = (
        await client.query(
          'SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS held',
          ['syncables-daemon', this.config.owner],
        )
      ).rows[0].held as boolean;
      if (!locked) throw new Error('A daemon already owns this local account');
      server = await this.webhook(webhookToken);
      report({
        daemon: 'running',
        webhookPort: this.config.webhookPort ?? null,
      });
      while (!controller.signal.aborted) {
        try {
          for (const result of await this.sync(
            selectors,
            controller.signal,
            true,
          ))
            report(result);
        } catch {
          report({
            daemon: 'waiting',
            error: 'Local database unavailable; retrying',
          });
        }
        if (controller.signal.aborted) break;
        await new Promise<void>((done) => {
          const stop = (): void => {
            clearTimeout(timer);
            controller.signal.removeEventListener('abort', stop);
            done();
          };
          const timer = setTimeout(stop, 1000);
          controller.signal.addEventListener('abort', stop, { once: true });
          if (controller.signal.aborted) stop();
        });
      }
      if (lostLock)
        throw new Error(
          'Daemon lost its database lock; restart after PostgreSQL recovers',
        );
    } finally {
      if (server)
        await new Promise<void>((done) => {
          server!.close(() => done());
          server!.closeAllConnections();
        });
      if (locked)
        await client
          .query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [
            'syncables-daemon',
            this.config.owner,
          ])
          .catch(() => {});
      signal.removeEventListener('abort', stop);
      client.removeListener('error', disconnected);
      client.release();
    }
  }
}
