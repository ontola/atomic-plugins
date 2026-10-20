import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import type { TransportRequest, TransportResponse } from '../read/transport.js';
import { encode, decode, type Payload } from './codec.js';
import {
  cleanHeaders,
  requestIdentity,
  scopeValues,
  type ArchiveScope,
} from './identity.js';
import { SCHEMA } from './schema.js';
import { indexJson, renderJson } from './json-graph.js';

export interface Attempt {
  id: string;
  run: string;
  scope: ArchiveScope;
  key: string;
  cacheKey: string;
}

export interface ResponseHead {
  id: string;
  observedAt: Date;
  response: Pick<TransportResponse, 'status' | 'headers'>;
}

export interface StoredResponse extends ResponseHead {
  id: string;
  observedAt: Date;
  response: TransportResponse;
}

export interface Run {
  id: string;
  connection: string;
  authorization_context: string;
  reason: string;
  state: 'recording' | 'complete' | 'failed';
  next_sequence: number;
}

export class PostgresArchive {
  readonly pool: pg.Pool;
  readonly maxBodyBytes: number;

  constructor(
    connectionString: string,
    options: { maxBodyBytes?: number } = {},
  ) {
    const url = new URL(connectionString);
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['', 'localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    )
      throw new Error(
        'Use a local PostgreSQL connection for the laptop archive',
      );
    const hostOverride = url.searchParams.get('host');
    if (
      hostOverride &&
      !hostOverride.startsWith('/') &&
      !['localhost', '127.0.0.1', '::1'].includes(hostOverride)
    )
      throw new Error('PostgreSQL host override must also be local');
    this.maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBodyBytes) || this.maxBodyBytes < 1)
      throw new Error('Invalid archive body limit');
    this.pool = new pg.Pool({
      connectionString,
      max: 8,
      connectionTimeoutMillis: 5000,
    });
    this.pool.on('error', () => {
      /* Active operations report failures; idle disconnects must not crash the CLI. */
    });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async transaction<T>(
    body: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async initialize(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('syncables_cache_schema'))",
      );
      await client.query(
        'CREATE SCHEMA IF NOT EXISTS syncables_cache; CREATE TABLE IF NOT EXISTS syncables_cache.version (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL)',
      );
      const current = await client.query(
        'SELECT version FROM syncables_cache.version',
      );
      if (current.rows.length && current.rows[0].version !== 1)
        throw new Error('Unsupported local archive schema version');
      await client.query(SCHEMA);
    });
  }

  async createRun(scope: ArchiveScope, reason: string): Promise<string> {
    scopeValues(scope);
    if (!reason) throw new Error('An archive run requires a request reason');
    const id = randomUUID();
    await this.pool.query(
      'INSERT INTO syncables_cache.runs(owner,id,connection,authorization_context,reason) VALUES($1,$2,$3,$4,$5)',
      [scope.owner, id, scope.connection, scope.authorizationContext, reason],
    );
    return id;
  }

  async finishRun(owner: string, id: string, success = true): Promise<void> {
    await this.transaction(async (client) => {
      const run = await client.query(
        'SELECT state FROM syncables_cache.runs WHERE owner=$1 AND id=$2 FOR UPDATE',
        [owner, id],
      );
      if (run.rows[0]?.state !== 'recording')
        throw new Error('Archive run is missing or already finished');
      const pending = await client.query(
        "SELECT 1 FROM syncables_cache.attempts WHERE owner=$1 AND run=$2 AND outcome='pending' LIMIT 1",
        [owner, id],
      );
      if (success && pending.rowCount)
        throw new Error('Cannot complete a run with pending requests');
      await client.query(
        'UPDATE syncables_cache.runs SET state=$3,finished_at=clock_timestamp() WHERE owner=$1 AND id=$2',
        [owner, id, success ? 'complete' : 'failed'],
      );
    });
  }

  async runs(owner: string): Promise<Run[]> {
    const result = await this.pool.query(
      'SELECT id,connection,authorization_context,reason,state,next_sequence FROM syncables_cache.runs WHERE owner=$1 ORDER BY started_at DESC',
      [owner],
    );
    return result.rows as Run[];
  }

  async stats(
    owner: string,
  ): Promise<{ payloads: string; raw_bytes: string; stored_bytes: string }> {
    const result = await this.pool.query(
      'SELECT count(*) AS payloads,coalesce(sum(raw_bytes),0)::text AS raw_bytes,coalesce(sum(octet_length(data)),0)::text AS stored_bytes FROM syncables_cache.payloads WHERE owner=$1',
      [owner],
    );
    return result.rows[0] as {
      payloads: string;
      raw_bytes: string;
      stored_bytes: string;
    };
  }

  async run(owner: string, id: string): Promise<Run> {
    const result = await this.pool.query(
      'SELECT id,connection,authorization_context,reason,state,next_sequence FROM syncables_cache.runs WHERE owner=$1 AND id=$2',
      [owner, id],
    );
    if (!result.rows.length)
      throw new Error('Recorded run not found for this owner');
    return result.rows[0] as Run;
  }

  async begin(
    scope: ArchiveScope,
    run: string,
    request: TransportRequest,
  ): Promise<Attempt> {
    scopeValues(scope);
    const identity = requestIdentity(request);
    const id = randomUUID();
    await this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE syncables_cache.runs SET next_sequence=next_sequence+1 WHERE owner=$1 AND id=$2 AND connection=$3 AND authorization_context=$4 AND state='recording' RETURNING next_sequence-1 AS sequence",
        [scope.owner, run, scope.connection, scope.authorizationContext],
      );
      if (!result.rows.length)
        throw new Error('Recording run does not match the authenticated scope');
      await client.query(
        'INSERT INTO syncables_cache.attempts(owner,id,run,sequence,connection,authorization_context,request_key,cache_key,request_url,request) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          scope.owner,
          id,
          run,
          result.rows[0].sequence,
          scope.connection,
          scope.authorizationContext,
          identity.key,
          identity.cacheKey,
          request.url.href,
          identity.request,
        ],
      );
    });
    return { id, run, scope, key: identity.key, cacheKey: identity.cacheKey };
  }

  async claim(
    scope: ArchiveScope,
    key: string,
    leaseMs: number,
  ): Promise<string | undefined> {
    const token = randomUUID();
    const result = await this.pool.query(
      `INSERT INTO syncables_cache.leases(owner,connection,authorization_context,request_key,token,expires_at)
      VALUES($1,$2,$3,$4,$5,clock_timestamp()+$6*interval '1 millisecond')
      ON CONFLICT(owner,connection,authorization_context,request_key) DO UPDATE SET token=EXCLUDED.token,expires_at=EXCLUDED.expires_at
      WHERE syncables_cache.leases.expires_at<=clock_timestamp() RETURNING token`,
      [...scopeValues(scope), key, token, leaseMs],
    );
    return result.rows.length ? token : undefined;
  }

  async release(
    scope: ArchiveScope,
    key: string,
    token: string,
  ): Promise<void> {
    await this.pool.query(
      'DELETE FROM syncables_cache.leases WHERE owner=$1 AND connection=$2 AND authorization_context=$3 AND request_key=$4 AND token=$5',
      [...scopeValues(scope), key, token],
    );
  }

  async latest(
    scope: ArchiveScope,
    key: string,
  ): Promise<StoredResponse | undefined> {
    const result = await this.pool.query(
      `SELECT a.id,a.observed_at,a.status,a.headers,p.hash,p.codec,p.raw_bytes,p.data
      FROM syncables_cache.heads h JOIN syncables_cache.attempts a ON a.owner=h.owner AND a.id=h.attempt
      JOIN syncables_cache.payloads p ON p.owner=a.owner AND p.hash=a.payload_hash
      WHERE h.owner=$1 AND h.connection=$2 AND h.authorization_context=$3 AND h.cache_key=$4`,
      [...scopeValues(scope), key],
    );
    if (!result.rows.length) return undefined;
    return this.hydrate(result.rows[0]);
  }

  async head(
    scope: ArchiveScope,
    key: string,
  ): Promise<ResponseHead | undefined> {
    const result = await this.pool.query(
      `SELECT a.id,a.observed_at,a.status,a.headers FROM syncables_cache.heads h
      JOIN syncables_cache.attempts a ON a.owner=h.owner AND a.id=h.attempt
      WHERE h.owner=$1 AND h.connection=$2 AND h.authorization_context=$3 AND h.cache_key=$4`,
      [...scopeValues(scope), key],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          observedAt: row.observed_at,
          response: { status: row.status, headers: row.headers },
        }
      : undefined;
  }

  async responseById(scope: ArchiveScope, id: string): Promise<StoredResponse> {
    const result = await this.pool.query(
      `SELECT a.id,a.observed_at,a.status,a.headers,p.hash,p.codec,p.raw_bytes,p.data
      FROM syncables_cache.attempts a JOIN syncables_cache.payloads p ON p.owner=a.owner AND p.hash=a.payload_hash
      WHERE a.owner=$1 AND a.connection=$2 AND a.authorization_context=$3 AND a.id=$4 AND a.outcome='response'`,
      [...scopeValues(scope), id],
    );
    if (!result.rows.length)
      throw new Error('Cached response not found in this authenticated scope');
    return this.hydrate(result.rows[0]);
  }

  private async hydrate(row: Record<string, unknown>): Promise<StoredResponse> {
    const payload: Payload = {
      hash: row.hash as string,
      codec: row.codec as Payload['codec'],
      rawBytes: row.raw_bytes as number,
      bytes: row.data as Buffer,
    };
    return {
      id: row.id as string,
      observedAt: row.observed_at as Date,
      response: {
        status: row.status as number,
        headers: row.headers as Record<string, string>,
        body: await decode(payload, this.maxBodyBytes),
      },
    };
  }

  async response(
    attempt: Attempt,
    response: TransportResponse,
    lease: string,
  ): Promise<void> {
    const payload = await encode(response.body, this.maxBodyBytes);
    const headers = cleanHeaders(response.headers);
    let root: string | null = null;
    let indexingError: string | null = null;
    const nodes: Payload[] = [];
    // 304 bodies are empty: their effective body's graph belongs to the
    // original response. Non-JSON/error text stays replayable as raw text.
    try {
      const graph = indexJson(response.body, { maxBytes: this.maxBodyBytes });
      for (const bytes of graph.nodes.values())
        nodes.push(await encode(bytes, this.maxBodyBytes));
      root = graph.root;
    } catch {
      nodes.length = 0;
      indexingError = 'Response is not indexable JSON within graph limits';
    }
    await this.transaction(async (client) => {
      await client.query(
        'INSERT INTO syncables_cache.payloads(owner,hash,codec,raw_bytes,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [
          attempt.scope.owner,
          payload.hash,
          payload.codec,
          payload.rawBytes,
          payload.bytes,
        ],
      );
      let effective: string | null =
        response.status === 200 ? payload.hash : null;
      if (response.status === 304) {
        const previous = await client.query(
          `SELECT a.payload_hash,a.headers,a.request FROM syncables_cache.heads h
          JOIN syncables_cache.attempts a ON a.owner=h.owner AND a.id=h.attempt
          WHERE h.owner=$1 AND h.connection=$2 AND h.authorization_context=$3 AND h.cache_key=$4`,
          [...scopeValues(attempt.scope), attempt.cacheKey],
        );
        const own = await client.query(
          'SELECT request FROM syncables_cache.attempts WHERE owner=$1 AND id=$2',
          [attempt.scope.owner, attempt.id],
        );
        const current = previous.rows[0];
        if (
          current &&
          headers.etag &&
          current.headers.etag === headers.etag &&
          own.rows[0]?.request.headers['if-none-match'] === headers.etag
        )
          effective = current.payload_hash as string;
      }
      const saved = await client.query(
        `UPDATE syncables_cache.attempts SET outcome='response',origin='upstream',status=$3,headers=$4,payload_hash=$5,effective_payload_hash=$6,observed_at=clock_timestamp()
        WHERE owner=$1 AND id=$2 AND outcome='pending' RETURNING ordinal`,
        [
          attempt.scope.owner,
          attempt.id,
          response.status,
          headers,
          payload.hash,
          effective,
        ],
      );
      if (!saved.rows.length)
        throw new Error('Request outcome is already settled');
      // Insert bounded batches rather than one network round trip per node.
      for (let offset = 0; offset < nodes.length; offset += 500) {
        const batch = nodes.slice(offset, offset + 500);
        await client.query(
          `INSERT INTO syncables_cache.json_nodes(owner,hash,codec,raw_bytes,data)
          SELECT $1,* FROM unnest($2::text[],$3::text[],$4::integer[],$5::bytea[])
          ON CONFLICT DO NOTHING`,
          [
            attempt.scope.owner,
            batch.map((n) => n.hash),
            batch.map((n) => n.codec),
            batch.map((n) => n.rawBytes),
            batch.map((n) => n.bytes),
          ],
        );
      }
      await client.query(
        'INSERT INTO syncables_cache.json_responses(owner,attempt,root_hash,indexing_error) VALUES($1,$2,$3,$4)',
        [attempt.scope.owner, attempt.id, root, indexingError],
      );
      const claim = await client.query(
        'SELECT 1 FROM syncables_cache.leases WHERE owner=$1 AND connection=$2 AND authorization_context=$3 AND request_key=$4 AND token=$5 AND expires_at>clock_timestamp() FOR UPDATE',
        [...scopeValues(attempt.scope), attempt.key, lease],
      );
      if (response.status === 200 && claim.rows.length)
        await client.query(
          `INSERT INTO syncables_cache.heads(owner,connection,authorization_context,cache_key,attempt,ordinal) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(owner,connection,authorization_context,cache_key) DO UPDATE SET attempt=EXCLUDED.attempt,ordinal=EXCLUDED.ordinal
          WHERE EXCLUDED.ordinal>syncables_cache.heads.ordinal`,
          [
            ...scopeValues(attempt.scope),
            attempt.cacheKey,
            attempt.id,
            saved.rows[0].ordinal,
          ],
        );
    });
  }

  async cacheHit(attempt: Attempt, source: StoredResponse): Promise<void> {
    const result = await this.pool.query(
      `UPDATE syncables_cache.attempts target SET outcome='response',origin='cache',source_attempt=source.id,status=source.status,headers=source.headers,payload_hash=source.payload_hash,effective_payload_hash=source.effective_payload_hash,observed_at=source.observed_at
      FROM syncables_cache.attempts source WHERE target.owner=$1 AND target.id=$2 AND target.outcome='pending' AND source.owner=target.owner AND source.id=$3
      AND source.connection=target.connection AND source.authorization_context=target.authorization_context AND source.cache_key=target.cache_key AND source.outcome='response'`,
      [attempt.scope.owner, attempt.id, source.id],
    );
    if (!result.rowCount)
      throw new Error(
        'Cached response does not match this authenticated scope',
      );
  }

  async failure(attempt: Attempt, dispatched = true): Promise<void> {
    await this.pool.query(
      "UPDATE syncables_cache.attempts SET outcome='error',origin=$3 WHERE owner=$1 AND id=$2 AND outcome='pending'",
      [attempt.scope.owner, attempt.id, dispatched ? 'upstream' : null],
    );
  }

  async recorded(
    owner: string,
    run: string,
    sequence: number,
  ): Promise<{
    request: { url: string; method: 'GET'; headers: Record<string, string> };
    key: string;
    origin: string;
    outcome: string;
    response?: TransportResponse;
  }> {
    const result = await this.pool.query(
      `SELECT a.*,p.hash,p.codec,p.raw_bytes,p.data FROM syncables_cache.attempts a
      LEFT JOIN syncables_cache.payloads p ON p.owner=a.owner AND p.hash=a.payload_hash
      WHERE a.owner=$1 AND a.run=$2 AND a.sequence=$3`,
      [owner, run, sequence],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Replay is missing a recorded request');
    if (row.outcome === 'pending')
      throw new Error('Replay request has no durable outcome');
    return {
      request: row.request,
      key: row.request_key,
      origin: row.origin ?? 'not-sent',
      outcome: row.outcome,
      ...(row.outcome === 'response'
        ? { response: (await this.hydrate(row)).response }
        : {}),
    };
  }

  /** Reads a response graph inside its recorded owner/run namespace. */
  async jsonResponse(
    owner: string,
    run: string,
    sequence: number,
  ): Promise<{
    root: string | null;
    indexingError: string | null;
    json?: string;
  }> {
    const result = await this.pool.query(
      `SELECT j.root_hash,j.indexing_error FROM syncables_cache.attempts a
      LEFT JOIN syncables_cache.json_responses j ON j.owner=a.owner AND j.attempt=coalesce(a.source_attempt,a.id)
      WHERE a.owner=$1 AND a.run=$2 AND a.sequence=$3 AND a.outcome='response'`,
      [owner, run, sequence],
    );
    if (!result.rows.length)
      throw new Error('Response not found for this owner/run');
    const root = result.rows[0].root_hash as string | null;
    const indexingError = result.rows[0].indexing_error as string | null;
    if (!root)
      return {
        root: null,
        indexingError:
          indexingError ??
          'Response predates JSON indexing or has no JSON body',
      };
    const json = await renderJson(
      root,
      async (hash) => {
        const node = await this.pool.query(
          'SELECT hash,codec,raw_bytes,data FROM syncables_cache.json_nodes WHERE owner=$1 AND hash=$2',
          [owner, hash],
        );
        const row = node.rows[0];
        if (!row) throw new Error('Missing archived JSON node');
        return decode(
          {
            hash: row.hash,
            codec: row.codec,
            rawBytes: row.raw_bytes,
            bytes: row.data,
          },
          this.maxBodyBytes,
        );
      },
      { maxBytes: this.maxBodyBytes },
    );
    return { root, indexingError, json };
  }
}
