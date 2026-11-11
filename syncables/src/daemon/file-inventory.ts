import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { nodeHash } from '../postgres/json-graph.js';
import { createCachingTransport } from '../postgres/transport.js';
import { Budget, BudgetExhausted } from '../read/pages.js';
import {
  classifyThrottling,
  type ThrottlingVerdict,
} from '../throttling/throttling.js';
import { itemSubject } from './config.js';
import {
  FILE_RESOURCE,
  InventoryCredentialError,
  InventoryCursorExpired,
  InventoryReadError,
  inventoryAccount,
  inventoryPage,
  localInventory,
  type InventoryChange,
  type InventoryCursor,
  type InventoryFile,
} from './file-inventory-sources.js';
import {
  DAEMON_READ_LIMITS,
  SOURCE_ID,
  SOURCE_JSON,
  SyncRetryError,
  publishCollection,
  sourceClass,
  sourceRecord,
  sourceSchemas,
  type CollectionPublicationOptions,
  type CollectionSyncResult,
} from './sync.js';

type Options = Omit<CollectionPublicationOptions, 'auth'> & {
  owner: string;
  fetch: typeof fetch;
};
interface Stage {
  id: string;
  authorization_context: string;
  strategy: 'bootstrap' | 'delta';
  cursor: InventoryCursor;
  sequence: number;
}

function cursorKey(cursor: InventoryCursor): string {
  return nodeHash(
    JSON.stringify([
      cursor.phase,
      'start' in cursor ? cursor.start : null,
      'token' in cursor ? (cursor.token ?? null) : null,
    ]),
  );
}

/** Index ancestor paths so a Dropbox tombstone can remove an entire subtree. */
class DropboxPaths {
  private readonly descendants = new Map<string, Set<string>>();

  constructor(private readonly files: Map<string, InventoryFile>) {
    for (const path of files.keys()) this.index(path, true);
  }

  private index(path: string, add: boolean): void {
    for (
      let end = path.lastIndexOf('/');
      end > 0;
      end = path.lastIndexOf('/', end - 1)
    ) {
      const parent = path.slice(0, end);
      if (add) {
        let paths = this.descendants.get(parent);
        if (!paths) this.descendants.set(parent, (paths = new Set()));
        paths.add(path);
      } else {
        const paths = this.descendants.get(parent);
        paths?.delete(path);
        if (paths?.size === 0) this.descendants.delete(parent);
      }
    }
  }

  private remove(path: string): void {
    if (this.files.delete(path)) this.index(path, false);
  }

  apply(change: InventoryChange): void {
    const path = 'file' in change ? change.file.id : change.remove;
    this.remove(path);
    if ('file' in change || change.subtree)
      for (const child of this.descendants.get(path) ?? []) this.remove(child);
    if ('file' in change) {
      this.files.set(path, change.file);
      this.index(path, true);
    }
  }
}

export function inventoryFiles(rows: string[]): Map<string, InventoryFile> {
  const result = new Map<string, InventoryFile>();
  for (const raw of rows) {
    const row = JSON.parse(raw) as Record<string, unknown>;
    if (typeof row[SOURCE_ID] === 'string') {
      const file = row[SOURCE_JSON] as InventoryFile;
      result.set(file.id, file);
    }
  }
  return result;
}

async function publishFiles(
  options: Options,
  files: Map<string, InventoryFile>,
  expected: string | undefined,
  authorizationContext: string,
  run: string,
  strategy: CollectionSyncResult['strategy'],
  nextToken?: string,
): Promise<CollectionSyncResult> {
  const { owner, prepared } = options;
  const { source } = prepared;
  const resources = sourceSchemas(prepared);
  const classId = sourceClass(prepared);
  for (const file of files.values()) {
    const subject = itemSubject(owner, source, FILE_RESOURCE, file.id);
    resources.set(
      subject,
      sourceRecord(subject, file.id, classId, JSON.stringify(file)),
    );
  }
  return publishCollection(
    {
      ...options,
      auth: { owner, connection: source.connection, authorizationContext },
    },
    {
      expected,
      resources,
      resource: FILE_RESOURCE,
      strategy,
      records: files.size,
      run,
      nextToken,
    },
  );
}

export async function syncFileInventory(
  options: Options,
): Promise<CollectionSyncResult | undefined> {
  const { owner, prepared, archive, store, signal } = options;
  const { scope, source } = prepared;
  const files = source.fileInventory;
  if (!files) throw new Error('File inventory configuration is required');
  const limits = {
    ...DAEMON_READ_LIMITS,
    ...(files.provider === 'icloud-drive' ? { maxRecords: 250_000 } : {}),
    ...source.readLimits,
  };
  const expected = await store.head(scope);
  if (files.provider === 'icloud-drive') {
    const deadline = Date.now() + limits.timeoutMs;
    const check = (): void => {
      signal?.throwIfAborted();
      if (Date.now() > deadline)
        throw new InventoryReadError(
          'iCloud Drive scan timed out. Increase readLimits.timeoutMs and retry.',
        );
    };
    const records = new Map<string, InventoryFile>();
    for await (const file of localInventory(files.directory, check)) {
      records.set(file.id, file);
      if (records.size > limits.maxRecords)
        throw new InventoryReadError(
          'iCloud Drive scan exceeded readLimits.maxRecords. Increase it and retry.',
        );
    }
    check();
    const authorizationContext = 'local-directory';
    const run = await archive.createRun(
      { owner, connection: source.connection, authorizationContext },
      'iCloud Drive directory scan',
    );
    await archive.finishRun(owner, run);
    return publishFiles(
      options,
      records,
      expected,
      authorizationContext,
      run,
      'full',
    );
  }

  const cloud = await inventoryAccount(
    files,
    options.fetch,
    archive.maxBodyBytes,
    signal,
  );
  const auth = {
    owner,
    connection: source.connection,
    authorizationContext: cloud.account,
  };
  const previous = expected ? await store.context(scope, expected) : {};
  if (expected && previous.authorizationContext !== cloud.account)
    throw new InventoryCredentialError(
      'Token belongs to a different provider account. Use a different collection account label.',
    );
  const prior =
    typeof previous.syncToken === 'string' ? previous.syncToken : undefined;
  const initial: InventoryCursor =
    files.provider === 'dropbox'
      ? { phase: 'dropbox' }
      : { phase: 'google-start' };
  const start: InventoryCursor = !prior
    ? initial
    : files.provider === 'dropbox'
      ? { phase: 'dropbox', token: prior }
      : { phase: 'google-changes', token: prior };
  const { pool } = archive;
  await pool.query(
    'DELETE FROM syncables_cache.file_inventory_stages WHERE owner=$1 AND scope=$2 AND base_revision IS DISTINCT FROM $3',
    [owner, scope, expected ?? null],
  );
  const stage = (
    await pool.query<Stage>(
      `INSERT INTO syncables_cache.file_inventory_stages
       (id,owner,scope,base_revision,authorization_context,strategy,cursor)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(owner,scope) DO UPDATE SET scope=EXCLUDED.scope
     RETURNING id,authorization_context,strategy,cursor,sequence`,
      [
        randomUUID(),
        owner,
        scope,
        expected ?? null,
        cloud.account,
        prior ? 'delta' : 'bootstrap',
        JSON.stringify(start),
      ],
    )
  ).rows[0];
  if (stage.authorization_context !== cloud.account)
    throw new InventoryCredentialError(
      'Token belongs to a different provider account. Use a different collection account label.',
    );

  const run = await archive.createRun(
    auth,
    'File inventory ' + stage.strategy + ' for ' + source.name,
  );
  let finished = false;
  let verdict: ThrottlingVerdict | undefined;
  const firstSequence = stage.sequence;
  const live = createCachingTransport({
    archive,
    scope: auth,
    run,
    mode: 'live',
    upstream: (request) => cloud.send(request, budget.remainingMs()),
    onResponse: ({ response }) => {
      verdict = classifyThrottling(undefined, {
        ...response,
        receivedAt: Date.now(),
      });
    },
  });
  const budget: Budget = new Budget(live, limits, (ms) =>
    sleep(ms, undefined, { signal }),
  );
  let count = 0;
  try {
    while (stage.cursor.phase !== 'done' && count < limits.maxRecords) {
      signal?.throwIfAborted();
      let page;
      try {
        page = await inventoryPage(
          stage.cursor,
          (request) => budget.send(request),
          Math.min(1000, limits.maxRecords - count),
        );
      } catch (error) {
        if (error instanceof InventoryCursorExpired) {
          // Keep the published head while a fresh baseline is built.
          const reset = await pool.query(
            `WITH restarted AS (
               UPDATE syncables_cache.file_inventory_stages
               SET strategy='bootstrap', cursor=$1, sequence=0
               WHERE id=$2 AND sequence=$3 RETURNING id
             ), cleared AS (
               DELETE FROM syncables_cache.file_inventory_pages WHERE stage IN (SELECT id FROM restarted)
             ) SELECT id FROM restarted`,
            [JSON.stringify(initial), stage.id, stage.sequence],
          );
          if (!reset.rowCount)
            throw new InventoryReadError('File inventory checkpoint changed');
          break;
        }
        if (
          error instanceof BudgetExhausted &&
          stage.sequence > firstSequence &&
          !(verdict?.retryAt && verdict.retryAt > Date.now())
        )
          break;
        throw error;
      }
      if (cursorKey(page.next) === cursorKey(stage.cursor))
        throw new InventoryReadError('Provider repeated an inventory cursor');
      // Save entries and their next cursor together. A lost response can safely be replayed.
      const saved = await pool.query(
        `WITH advanced AS (
           UPDATE syncables_cache.file_inventory_stages SET cursor=$1, sequence=sequence+1
           WHERE id=$2 AND sequence=$3 RETURNING id
         ) INSERT INTO syncables_cache.file_inventory_pages(stage,sequence,cursor_key,changes)
           SELECT id,$3,$4,$5 FROM advanced`,
        [
          JSON.stringify(page.next),
          stage.id,
          stage.sequence,
          cursorKey(stage.cursor),
          JSON.stringify(page.changes),
        ],
      );
      if (!saved.rowCount)
        throw new InventoryReadError('File inventory checkpoint changed');
      stage.cursor = page.next;
      stage.sequence++;
      count += page.count;
    }
    await archive.finishRun(owner, run);
    finished = true;
    if (stage.cursor.phase !== 'done') return undefined;

    if (
      stage.strategy === 'delta' &&
      expected &&
      options.message === undefined &&
      stage.cursor.token === prior &&
      typeof previous.records === 'number'
    ) {
      const changed = await pool.query(
        "SELECT 1 FROM syncables_cache.file_inventory_pages WHERE stage=$1 AND changes<>'[]'::jsonb LIMIT 1",
        [stage.id],
      );
      if (!changed.rowCount) {
        await pool
          .query(
            'DELETE FROM syncables_cache.file_inventory_stages WHERE id=$1',
            [stage.id],
          )
          .catch(() => {});
        return {
          revision: expected,
          run,
          records: previous.records,
          strategy: 'delta',
        };
      }
    }
    const records =
      stage.strategy === 'delta' && expected
        ? inventoryFiles(await store.list(scope, expected))
        : new Map<string, InventoryFile>();
    const paths =
      files.provider === 'dropbox' ? new DropboxPaths(records) : undefined;
    for (let offset = 0; offset < stage.sequence; offset += 32) {
      signal?.throwIfAborted();
      const pages = await pool.query<{ changes: InventoryChange[] }>(
        'SELECT changes FROM syncables_cache.file_inventory_pages WHERE stage=$1 AND sequence>=$2 AND sequence<$3 ORDER BY sequence',
        [stage.id, offset, offset + 32],
      );
      for (const { changes } of pages.rows) {
        for (const change of changes) {
          if (paths) paths.apply(change);
          else if ('file' in change) records.set(change.file.id, change.file);
          else records.delete(change.remove);
        }
      }
    }
    const result = await publishFiles(
      options,
      records,
      expected,
      cloud.account,
      run,
      stage.strategy,
      stage.cursor.token,
    );
    // A crash after publish leaves an obsolete stage, which the next run replaces by head.
    await pool
      .query('DELETE FROM syncables_cache.file_inventory_stages WHERE id=$1', [
        stage.id,
      ])
      .catch(() => {});
    return result;
  } catch (error) {
    if (!finished) await archive.finishRun(owner, run, false).catch(() => {});
    if (verdict?.retryAt !== undefined && verdict.retryAt > Date.now())
      throw new SyncRetryError(verdict.retryAt);
    throw error;
  }
}
