import type { Pool, PoolClient } from 'pg';
import { SOURCE_ID } from './sync.js';

export const BROWSER_INDEX_SCHEMA = `
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_browser_indexes (
 owner text NOT NULL, revision text NOT NULL, total integer NOT NULL,
 PRIMARY KEY(owner,revision),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_revisions(owner,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_browser_rows (
 owner text NOT NULL, revision text NOT NULL, rank integer NOT NULL,
 subject text NOT NULL,
 PRIMARY KEY(owner,revision,rank),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_browser_indexes(owner,revision) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS syncables_cache.snapshot_browser_text (
 owner text NOT NULL, revision text NOT NULL, subject text NOT NULL, search_text text NOT NULL,
 PRIMARY KEY(owner,revision,subject),
 FOREIGN KEY(owner,revision) REFERENCES syncables_cache.snapshot_browser_indexes(owner,revision) ON DELETE CASCADE
);
`;

type Member = { subject: string; raw: string };
export type BrowserPage = { total: number; records: string[] };

export class SnapshotBrowserIndex {
  private readonly building = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly owner: string,
    private readonly members: (
      revision: string,
      db: PoolClient,
    ) => AsyncIterable<Member[]>,
    private readonly render: (roots: string[]) => Promise<string[]>,
  ) {}

  private async ready(
    revision: string,
    db: Pick<Pool, 'query'> = this.pool,
  ): Promise<number | undefined> {
    const { rows } = await db.query<{ total: number }>(
      'SELECT total FROM syncables_cache.snapshot_browser_indexes WHERE owner=$1 AND revision=$2',
      [this.owner, revision],
    );
    return rows[0]?.total;
  }

  async page(
    revision: string,
    query: string,
    page: number,
  ): Promise<BrowserPage | undefined> {
    if (this.failed.delete(revision))
      throw new Error('Could not prepare saved records');
    const indexedTotal = await this.ready(revision);
    if (indexedTotal === undefined) {
      if (!this.building.has(revision)) {
        const build = this.build(revision)
          .catch(() => {
            this.failed.add(revision);
          })
          .finally(() => {
            this.building.delete(revision);
          });
        this.building.set(revision, build);
      }
      return undefined;
    }
    const selection = `SELECT m.root_hash FROM syncables_cache.snapshot_browser_rows i
       JOIN syncables_cache.snapshot_members m USING(owner,revision,subject)`;
    const offset = (page - 1) * 25;
    const total = query
      ? Number(
          (
            await this.pool.query<{ count: string }>(
              `SELECT count(*) FROM syncables_cache.snapshot_browser_text
         WHERE owner=$1 AND revision=$2 AND strpos(search_text,$3)>0`,
              [this.owner, revision, query],
            )
          ).rows[0].count,
        )
      : indexedTotal;
    const { rows } = query
      ? await this.pool.query<{ root_hash: string }>(
          `${selection} JOIN syncables_cache.snapshot_browser_text t USING(owner,revision,subject)
         WHERE i.owner=$1 AND i.revision=$2 AND strpos(t.search_text,$3)>0
         ORDER BY i.rank LIMIT 25 OFFSET $4`,
          [this.owner, revision, query, offset],
        )
      : await this.pool.query<{ root_hash: string }>(
          `${selection} WHERE i.owner=$1 AND i.revision=$2 AND i.rank >= $3 ORDER BY i.rank LIMIT 25`,
          [this.owner, revision, offset],
        );
    return {
      total,
      records: await this.render(rows.map(({ root_hash }) => root_hash)),
    };
  }

  private async build(revision: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const {
        rows: [lock],
      } = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(hashtext($1),hashtext($2)) AS locked',
        ['syncables-browser:' + this.owner, revision],
      );
      if (lock.locked && (await this.ready(revision, client)) === undefined) {
        await client.query(
          'INSERT INTO syncables_cache.snapshot_browser_indexes(owner,revision,total) VALUES($1,$2,0)',
          [this.owner, revision],
        );
        // Text stays in PostgreSQL. Only the keys needed to assign the
        // browser's existing locale order are kept across batches.
        const order: { subject: string; key: Buffer; id: string }[] = [];
        for await (const batch of this.members(revision, client)) {
          const records = batch.flatMap(({ subject, raw }) => {
            const value = JSON.parse(raw) as Record<string, unknown>;
            if (!Object.hasOwn(value, SOURCE_ID)) return [];
            order.push({
              subject,
              key: Buffer.from(subject),
              id: String(value[SOURCE_ID]),
            });
            return [{ subject, text: raw.toLowerCase() }];
          });
          await client.query(
            `INSERT INTO syncables_cache.snapshot_browser_text(owner,revision,subject,search_text)
             SELECT $1,$2,* FROM unnest($3::text[],$4::text[])`,
            [
              this.owner,
              revision,
              records.map((r) => r.subject),
              records.map((r) => r.text),
            ],
          );
        }
        // For equal IDs, the former stable sort starts in PostgreSQL's
        // JSONB object key order (byte length, then byte order).
        order.sort(
          (a, b) =>
            a.id.localeCompare(b.id) ||
            a.key.length - b.key.length ||
            Buffer.compare(a.key, b.key),
        );
        for (let offset = 0; offset < order.length; offset += 500) {
          const batch = order.slice(offset, offset + 500);
          await client.query(
            `INSERT INTO syncables_cache.snapshot_browser_rows(owner,revision,rank,subject)
             SELECT $1,$2,* FROM unnest($3::integer[],$4::text[])`,
            [
              this.owner,
              revision,
              batch.map((_, i) => offset + i),
              batch.map((r) => r.subject),
            ],
          );
        }
        await client.query(
          'UPDATE syncables_cache.snapshot_browser_indexes SET total=$3 WHERE owner=$1 AND revision=$2',
          [this.owner, revision, order.length],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
