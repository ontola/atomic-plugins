import type { Pool, PoolClient } from 'pg';
import { indexJson, renderJson, nodeHash } from '../postgres/json-graph.js';
import { encode, decode } from '../postgres/codec.js';
import {
  validateCommitMessage,
  type AtomicSnapshot,
  type SnapshotRevision,
  type CheckoutResult,
} from './git-store.js';
import type { SnapshotStore } from './snapshot-store.js';
import { materialize } from './materialize.js';

export const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_revisions (
 owner text NOT NULL, id text NOT NULL, scope text NOT NULL,
 parents text[] NOT NULL, resources jsonb NOT NULL, context_text text NOT NULL,
 message text NOT NULL, author text NOT NULL, committer text NOT NULL,
 git_headers text, PRIMARY KEY(owner,id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_members (
 owner text NOT NULL, revision text NOT NULL, subject text NOT NULL, root_hash text NOT NULL,
 PRIMARY KEY(owner,revision,subject),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_revisions(owner,id),
 FOREIGN KEY(owner,root_hash) REFERENCES syncables_cache.json_nodes(owner,hash)
);
CREATE INDEX IF NOT EXISTS snapshot_subject ON syncables_cache.snapshot_members(owner,subject,revision);
CREATE INDEX IF NOT EXISTS snapshot_scope ON syncables_cache.snapshot_revisions(owner,scope);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_refs (
 owner text NOT NULL, scope text NOT NULL, name text NOT NULL, revision text NOT NULL,
 PRIMARY KEY(owner,scope,name),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_revisions(owner,id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_imports (
 owner text NOT NULL, source text NOT NULL, git_id text NOT NULL, revision text NOT NULL,
 PRIMARY KEY(owner,source,git_id),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_revisions(owner,id)
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_import_refs (
 owner text NOT NULL, source text NOT NULL, name text NOT NULL, target text NOT NULL,
 PRIMARY KEY(owner,source,name)
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_git_tags (
 owner text NOT NULL, scope text NOT NULL, name text NOT NULL, headers text NOT NULL,
 PRIMARY KEY(owner,scope,name)
);
`;
export interface HistoryRevision {
  id: string;
  scope: string;
  parents: string[];
  resources: Record<string, string>;
  context_text: string;
  message: string;
  author: string;
  committer: string;
  git_headers: string | null;
}
export interface ImportRevision {
  gitId: string;
  snapshot: AtomicSnapshot;
  parents: string[];
  contextText: string;
  headers: string;
  author: string;
  committer: string;
  message: string;
}
export interface ImportRef {
  name: string;
  gitId: string;
  scope: string;
  tagHeaders?: string;
}
const LIMIT = 16 * 1024 * 1024;
export function scopeRef(scope: string): string {
  return 'refs/heads/s-' + nodeHash(scope);
}
export function validateHistoryRef(name: string): void {
  if (
    !/^refs\/(heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/.test(name) ||
    name.includes('..') ||
    name.includes('//') ||
    name.endsWith('/') ||
    name
      .split('/')
      .some((p) => p.startsWith('.') || p.endsWith('.') || p.endsWith('.lock'))
  )
    throw new Error('Invalid snapshot ref');
}

/** PostgreSQL owns history; Git is needed only by the import/export adapter. */
export class PostgresHistoryStore implements SnapshotStore {
  constructor(
    readonly pool: Pool,
    readonly owner: string,
    readonly checkoutDirectory: string,
  ) {}
  async initialize(): Promise<void> {
    await this.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('syncables-history-schema'))",
      );
      await client.query(`CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_version (
        singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), version integer NOT NULL
      )`);
      const current = (
        await client.query(
          'SELECT version FROM syncables_cache.snapshot_version',
        )
      ).rows[0];
      if (current) {
        if (current.version !== 1)
          throw new Error('Unsupported snapshot history schema version');
        return;
      }
      await client.query(HISTORY_SCHEMA);
      await client.query(
        'INSERT INTO syncables_cache.snapshot_version VALUES(true,1)',
      );
    });
  }
  private async transaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  private async save(
    client: PoolClient,
    snapshot: AtomicSnapshot,
    parents: string[],
    metadata?: Omit<ImportRevision, 'snapshot' | 'parents' | 'gitId'>,
  ): Promise<string> {
    if (
      !snapshot.scope ||
      snapshot.scope.length > 8192 ||
      snapshot.resources.size > 50_000
    )
      throw new Error('Invalid snapshot scope or size');
    if (snapshot.context.owner !== this.owner)
      throw new Error('Snapshot owner mismatch');
    const resources: Record<string, string> = Object.create(null);
    const nodes = new Map<string, string>();
    let total = 0;
    for (const [subject, text] of [...snapshot.resources].sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      total += Buffer.byteLength(text);
      if (total > LIMIT)
        throw new Error('Data snapshot exceeds the 16 MiB stage limit');
      const graph = indexJson(text, { maxBytes: LIMIT });
      const data = JSON.parse(text) as Record<string, unknown>;
      if (
        !data ||
        Array.isArray(data) ||
        data['@id'] !== subject ||
        !/^(https?:\/\/|urn:)/.test(subject) ||
        Object.keys(data).some(
          (key) => key !== '@id' && !/^(https?:\/\/|urn:)/.test(key),
        )
      )
        throw new Error('Invalid JSON-AD resource');
      resources[subject] = graph.root;
      for (const [hash, bytes] of graph.nodes) nodes.set(hash, bytes);
    }
    const contextText =
      metadata?.contextText ??
      JSON.stringify({
        format: 'syncables-json-ad-git',
        version: 1,
        scope: snapshot.scope,
        context: snapshot.context,
      });
    const context = indexJson(contextText);
    for (const [hash, bytes] of context.nodes) nodes.set(hash, bytes);
    // Same owner/hash namespace as archived HTTP JSON, including nested item nodes.
    const packed = await Promise.all(
      [...nodes]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(async ([hash, bytes]) => ({
          hash,
          value: await encode(bytes, LIMIT),
        })),
    );
    for (let offset = 0; offset < packed.length; offset += 500) {
      const batch = packed.slice(offset, offset + 500);
      await client.query(
        `INSERT INTO syncables_cache.json_nodes(owner,hash,codec,raw_bytes,data) VALUES ${batch.map((_, i) => `($${i * 5 + 1},$${i * 5 + 2},$${i * 5 + 3},$${i * 5 + 4},$${i * 5 + 5})`).join(',')} ON CONFLICT DO NOTHING`,
        batch.flatMap(({ hash, value }) => [
          this.owner,
          hash,
          value.codec,
          value.rawBytes,
          value.bytes,
        ]),
      );
    }
    const now = Math.floor(Date.now() / 1000);
    const author =
      metadata?.author ?? `Syncables <syncables@localhost> ${now} +0000`;
    const committer = metadata?.committer ?? author;
    const message =
      metadata?.message ??
      (snapshot.message ?? 'Syncables Atomic Data snapshot').trim() + '\n';
    const revision = {
      scope: snapshot.scope,
      parents,
      resources,
      context_text: contextText,
      message,
      author,
      committer,
      git_headers: metadata?.headers ?? null,
    };
    const id = nodeHash(JSON.stringify(['syncables-snapshot', 1, revision]));
    await client.query(
      `INSERT INTO syncables_cache.snapshot_revisions(owner,id,scope,parents,resources,context_text,message,author,committer,git_headers) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        this.owner,
        id,
        revision.scope,
        parents,
        resources,
        contextText,
        message,
        author,
        committer,
        revision.git_headers,
      ],
    );
    const entries = Object.entries(resources);
    for (let offset = 0; offset < entries.length; offset += 500) {
      const batch = entries.slice(offset, offset + 500);
      await client.query(
        `INSERT INTO syncables_cache.snapshot_members(owner,revision,subject,root_hash) VALUES ${batch.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4})`).join(',')} ON CONFLICT DO NOTHING`,
        batch.flatMap(([subject, root]) => [this.owner, id, subject, root]),
      );
    }
    return id;
  }
  async head(scope: string): Promise<string | undefined> {
    return (
      await this.pool.query(
        'SELECT revision FROM syncables_cache.snapshot_refs WHERE owner=$1 AND scope=$2 AND name=$3',
        [this.owner, scope, scopeRef(scope)],
      )
    ).rows[0]?.revision as string | undefined;
  }
  async commit(
    snapshot: AtomicSnapshot,
    expected?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (snapshot.message !== undefined)
      validateCommitMessage(snapshot.message, 32768);
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
        [this.owner, 'snapshot-head:' + snapshot.scope],
      );
      const current = (
        await client.query(
          'SELECT revision FROM syncables_cache.snapshot_refs WHERE owner=$1 AND scope=$2 AND name=$3',
          [this.owner, snapshot.scope, scopeRef(snapshot.scope)],
        )
      ).rows[0]?.revision as string | undefined;
      if (current !== expected)
        throw new Error('Data snapshot changed; refresh before publishing');
      if (signal?.aborted) throw new Error('Data snapshot publication stopped');
      const id = await this.save(client, snapshot, current ? [current] : []);
      if (current && snapshot.message === undefined) {
        const rows = (
          await client.query(
            'SELECT resources,context_text FROM syncables_cache.snapshot_revisions WHERE owner=$1 AND id=ANY($2::text[]) ORDER BY id',
            [this.owner, [current, id]],
          )
        ).rows;
        if (
          rows.length === 2 &&
          JSON.stringify(rows[0]) === JSON.stringify(rows[1])
        )
          return current;
      }
      if (signal?.aborted) throw new Error('Data snapshot publication stopped');
      await client.query(
        'INSERT INTO syncables_cache.snapshot_refs(owner,scope,name,revision) VALUES($1,$2,$3,$4) ON CONFLICT(owner,scope,name) DO UPDATE SET revision=EXCLUDED.revision',
        [this.owner, snapshot.scope, scopeRef(snapshot.scope), id],
      );
      return id;
    });
  }
  async revision(id: string): Promise<HistoryRevision> {
    const row = (
      await this.pool.query(
        'SELECT id,scope,parents,resources,context_text,message,author,committer,git_headers FROM syncables_cache.snapshot_revisions WHERE owner=$1 AND id=$2',
        [this.owner, id],
      )
    ).rows[0] as HistoryRevision | undefined;
    if (!row) throw new Error('Unknown snapshot revision');
    return row;
  }
  async refs(
    scope: string,
  ): Promise<{ name: string; revision: string; headers?: string }[]> {
    return (
      await this.pool.query(
        'SELECT r.name,r.revision,t.headers FROM syncables_cache.snapshot_refs r LEFT JOIN syncables_cache.snapshot_git_tags t USING(owner,scope,name) WHERE r.owner=$1 AND r.scope=$2 ORDER BY r.name',
        [this.owner, scope],
      )
    ).rows as { name: string; revision: string; headers?: string }[];
  }
  async ancestry(id: string): Promise<HistoryRevision[]> {
    const result: HistoryRevision[] = [];
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visited.has(id)) return;
      visited.add(id);
      const r = await this.revision(id);
      for (const parent of r.parents) await visit(parent);
      result.push(r);
    };
    await visit(id);
    return result;
  }
  async resolveRevision(scope: string, revision?: string): Promise<string> {
    const refs = await this.refs(scope);
    let id = revision ?? (await this.head(scope));
    if (id?.startsWith('tag:'))
      id = refs.find(
        (r) => r.name === 'refs/tags/s-' + nodeHash(scope) + '/' + id!.slice(4),
      )?.revision;
    else if (id)
      id =
        (
          await this.pool.query(
            'SELECT revision FROM syncables_cache.snapshot_imports WHERE owner=$1 AND git_id=$2 ORDER BY source LIMIT 1',
            [this.owner, id],
          )
        ).rows[0]?.revision ?? id;
    if (!id || !/^[a-f0-9]{64}$/.test(id))
      throw new Error('Use a full revision ID or tag:NAME');
    const found = await this.pool.query(
      `WITH RECURSIVE reachable(id) AS (
      SELECT revision FROM syncables_cache.snapshot_refs WHERE owner=$1 AND scope=$2
      UNION SELECT unnest(r.parents) FROM syncables_cache.snapshot_revisions r JOIN reachable a ON r.id=a.id WHERE r.owner=$1 AND r.scope=$2
    ) SELECT 1 FROM reachable WHERE id=$3 LIMIT 1`,
      [this.owner, scope, id],
    );
    if (found.rowCount) return id;
    throw new Error('Revision does not belong to this data scope');
  }
  async render(root: string): Promise<string> {
    return renderJson(
      root,
      async (hash) => {
        const row = (
          await this.pool.query(
            'SELECT codec,raw_bytes,data FROM syncables_cache.json_nodes WHERE owner=$1 AND hash=$2',
            [this.owner, hash],
          )
        ).rows[0];
        if (!row) throw new Error('Missing snapshot object');
        return decode(
          { hash, codec: row.codec, rawBytes: row.raw_bytes, bytes: row.data },
          LIMIT,
        );
      },
      { maxBytes: LIMIT },
    );
  }
  async list(scope: string, at?: string): Promise<string[]> {
    const r = await this.revision(await this.resolveRevision(scope, at));
    return Promise.all(
      Object.values(r.resources).map((root) => this.render(root)),
    );
  }
  async context(scope: string, at?: string): Promise<Record<string, unknown>> {
    const r = await this.revision(await this.resolveRevision(scope, at));
    return (JSON.parse(r.context_text) as { context: Record<string, unknown> })
      .context;
  }
  async resource(
    scope: string,
    subject: string,
    at?: string,
  ): Promise<string | undefined> {
    const r = await this.revision(await this.resolveRevision(scope, at));
    const root = r.resources[subject];
    return root ? this.render(root) : undefined;
  }
  async resolve(
    scope: string,
    subject: string,
    at?: string,
  ): Promise<{ commit: string; resource: string | undefined }> {
    const commit = await this.resolveRevision(scope, at);
    return { commit, resource: await this.resource(scope, subject, commit) };
  }
  async history(
    scope: string,
    subject?: string,
    at?: string,
  ): Promise<string[]> {
    return (await this.historyEntries(scope, subject, at)).map((r) => r.commit);
  }
  async historyEntries(
    scope: string,
    subject?: string,
    at?: string,
  ): Promise<SnapshotRevision[]> {
    if (!(await this.head(scope))) return [];
    const revisions = await this.ancestry(
      await this.resolveRevision(scope, at),
    );
    const map = new Map(revisions.map((r) => [r.id, r]));
    return revisions
      .reverse()
      .filter(
        (r) =>
          !subject ||
          (r.parents.length === 0
            ? r.resources[subject] !== undefined
            : r.parents.some(
                (p) => map.get(p)?.resources[subject] !== r.resources[subject],
              )),
      )
      .map((r) => ({
        commit: r.id,
        parents: r.parents,
        date: new Date(
          Number(r.author.match(/ (\d+) [+-]\d{4}$/)?.[1] ?? 0) * 1000,
        ).toISOString(),
        message: r.message.trimEnd(),
      }));
  }
  async tag(scope: string, name: string, at?: string): Promise<string> {
    const ref = 'refs/tags/s-' + nodeHash(scope) + '/' + name;
    validateHistoryRef(ref);
    const id = await this.resolveRevision(scope, at);
    await this.pool.query(
      'INSERT INTO syncables_cache.snapshot_refs(owner,scope,name,revision) VALUES($1,$2,$3,$4)',
      [this.owner, scope, ref, id],
    );
    return id;
  }
  async checkout(
    scope: string,
    collection: string,
  ): Promise<CheckoutResult | undefined> {
    const id = await this.head(scope);
    if (!id) return undefined;
    const revision = await this.revision(id);
    const files = new Map<string, string>();
    for (const [subject, root] of Object.entries(revision.resources))
      files.set('r-' + nodeHash(subject) + '.json', await this.render(root));
    files.set('context.json', revision.context_text);
    const directory = await materialize(
      this.checkoutDirectory,
      collection,
      this.owner,
      scope,
      id,
      files,
    );
    return { directory, revision: id };
  }
  /** Publish an entire legacy DAG and its refs in one transaction. Re-running never rewinds newer PostgreSQL heads. */
  async importHistory(
    source: string,
    revisions: ImportRevision[],
    refs: ImportRef[],
    sourceRefs: { name: string; target: string }[],
  ): Promise<Map<string, string>> {
    return this.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',
        [this.owner, 'import:' + source],
      );
      const existing = (
        await client.query(
          'SELECT name,target FROM syncables_cache.snapshot_import_refs WHERE owner=$1 AND source=$2 ORDER BY name',
          [this.owner, source],
        )
      ).rows;
      if (
        existing.length &&
        JSON.stringify(existing) !== JSON.stringify(sourceRefs)
      )
        throw new Error(
          'Legacy refs changed since import; refusing to overwrite PostgreSQL history',
        );
      const map = new Map<string, string>();
      for (const r of revisions) {
        const parents = r.parents.map((p) => {
          const id = map.get(p);
          if (!id) throw new Error('Import parent is missing');
          return id;
        });
        const id = await this.save(client, r.snapshot, parents, r);
        map.set(r.gitId, id);
        await client.query(
          'INSERT INTO syncables_cache.snapshot_imports(owner,source,git_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [this.owner, source, r.gitId, id],
        );
      }
      for (const ref of refs) {
        const id = map.get(ref.gitId);
        if (!id) throw new Error('Import ref is missing');
        validateHistoryRef(ref.name);
        const old = (
          await client.query(
            'SELECT revision FROM syncables_cache.snapshot_refs WHERE owner=$1 AND scope=$2 AND name=$3',
            [this.owner, ref.scope, ref.name],
          )
        ).rows[0];
        if (old && !existing.length)
          throw new Error(
            'PostgreSQL ref already exists; migration will not overwrite it',
          );
        if (!existing.length) {
          await client.query(
            'INSERT INTO syncables_cache.snapshot_refs(owner,scope,name,revision) VALUES($1,$2,$3,$4)',
            [this.owner, ref.scope, ref.name, id],
          );
          if (ref.tagHeaders)
            await client.query(
              'INSERT INTO syncables_cache.snapshot_git_tags(owner,scope,name,headers) VALUES($1,$2,$3,$4)',
              [this.owner, ref.scope, ref.name, ref.tagHeaders],
            );
        }
      }
      if (
        (
          await client.query(
            "SELECT to_regclass('syncables_cache.daemon_jobs') AS table_name",
          )
        ).rows[0].table_name
      ) {
        await client.query(
          `UPDATE syncables_cache.daemon_jobs j SET revision=r.revision FROM syncables_cache.snapshot_refs r WHERE j.owner=$1 AND r.owner=j.owner AND r.scope=j.scope AND r.name='refs/heads/s-' || encode(sha256(convert_to(j.scope,'UTF8')),'hex')`,
          [this.owner],
        );
      }
      for (const r of sourceRefs)
        await client.query(
          'INSERT INTO syncables_cache.snapshot_import_refs(owner,source,name,target) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [this.owner, source, r.name, r.target],
        );
      return map;
    });
  }
}
