import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { isRecord } from '../read/model.js';
import { sameJson, replaceOf, replaceBlock } from '../client/replace.js';
import type { Transport } from '../read/transport.js';
import { proxyRequest, type Session, type Connection } from '../cli/auth.js';
import type { PreparedCollection } from './sync.js';
import { WriteModel, mergeEdit } from './write-model.js';

type Value = Record<string, unknown>;
export interface LocalEdit {
  id: string;
  action: 'create' | 'replace' | 'delete';
  target: string | null;
  revision: string | null;
  baseline: Value | null;
  desired: Value | null;
  state:
    | 'queued'
    | 'creating'
    | 'uncertain'
    | 'retiring'
    | 'confirmed'
    | 'conflict'
    | 'failed'
    | 'cancelled';
  observed: Value | null;
  sent: Value | null;
  created_id: string | null;
  error: string | null;
}
export const EDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS syncables_cache.local_edits (
 owner text NOT NULL, scope text NOT NULL, id uuid NOT NULL,
 action text NOT NULL CHECK(action IN ('create','replace','delete')),
 target text, revision text, baseline jsonb, desired jsonb,
 state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','creating','uncertain','retiring','confirmed','conflict','failed','cancelled')), observed jsonb, sent jsonb,
 created_id text, error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(owner,scope,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS local_edits_active_target
 ON syncables_cache.local_edits(owner,scope,target)
 WHERE target IS NOT NULL AND state NOT IN ('confirmed','cancelled');
`;

/** Shares the pull scheduler's owner/collection lock. Loss of the DB session aborts HTTP. */
export async function withEditLock<T>(
  pool: Pool,
  owner: string,
  prepared: PreparedCollection,
  work: (edits: LocalEdits, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const client = await pool.connect();
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  client.on('error', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let locked = false;
  try {
    await client.query(EDIT_SCHEMA);
    locked = (
      await client.query(
        'SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS held',
        [owner, prepared.scope],
      )
    ).rows[0].held as boolean;
    if (!locked) throw new Error('Collection already syncing or sending');
    controller.signal.throwIfAborted();
    return await work(
      new LocalEdits(client, owner, prepared, controller.signal),
      controller.signal,
    );
  } finally {
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1),hashtext($2))', [
          owner,
          prepared.scope,
        ])
        .catch(() => {});
    client.off('error', stop);
    signal?.removeEventListener('abort', stop);
    client.release();
  }
}

/** Desired edits and receipts stay separate from accepted provider snapshots. */
export class LocalEdits {
  private readonly model: WriteModel;
  constructor(
    private readonly db: PoolClient,
    private readonly owner: string,
    private readonly prepared: PreparedCollection,
    private readonly signal: AbortSignal,
  ) {
    this.model = new WriteModel(prepared);
  }
  private enabled(): void {
    if (this.prepared.source.writes?.enabled !== true)
      throw new Error('Provider writes disabled for this collection');
    this.signal.throwIfAborted();
  }
  async list(): Promise<LocalEdit[]> {
    return (
      await this.db.query(
        'SELECT id,action,target,revision,baseline,desired,state,observed,sent,created_id,error FROM syncables_cache.local_edits WHERE owner=$1 AND scope=$2 ORDER BY created_at,id',
        [this.owner, this.prepared.scope],
      )
    ).rows as LocalEdit[];
  }
  private async find(id: string): Promise<LocalEdit> {
    const edit = (await this.list()).find((row) => row.id === id.toLowerCase());
    if (!edit) throw new Error('Unknown edit in this owner/collection');
    return edit;
  }
  async enqueue(input: {
    id?: string;
    action: LocalEdit['action'];
    target?: string;
    revision?: string;
    baseline?: Value;
    desired?: Value;
    owned?: boolean;
  }): Promise<LocalEdit> {
    this.enabled();
    const id = (input.id ?? randomUUID()).toLowerCase();
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        id,
      )
    )
      throw new Error('Use a UUID edit ID');
    if (
      input.action === 'create' &&
      (input.target !== undefined ||
        input.baseline !== undefined ||
        input.revision !== undefined)
    )
      throw new Error('A create must not name an existing item');
    const desired =
      input.action === 'delete'
        ? null
        : this.model.payload(input.desired ?? {}, true);
    if (
      Buffer.byteLength(JSON.stringify([input.baseline, desired])) >
      1024 * 1024
    )
      throw new Error('Edit exceeds 1 MiB');
    // Reusing an explicit UUID is idempotent only for identical user intent.
    const prior = (await this.list()).find((row) => row.id === id);
    if (prior) {
      if (
        prior.action !== input.action ||
        prior.target !== (input.target ?? null) ||
        prior.revision !== (input.revision ?? null) ||
        !sameJson(prior.desired, desired) ||
        !sameJson(prior.baseline, input.baseline ?? null)
      )
        throw new Error('Edit ID already names another intent');
      return prior;
    }
    if (input.action !== 'create') {
      if (
        !input.target ||
        !input.baseline ||
        !input.revision ||
        this.model.id(input.baseline) !== input.target
      )
        throw new Error(
          'Pin an accepted snapshot and matching item before editing',
        );
      if (
        (await this.list()).some(
          (row) => row.target === input.target && row.state === 'confirmed',
        )
      )
        throw new Error(
          'Item was already retired; pull and edit its new identity',
        );
      this.model.itemPath(input.target, 'delete');
    }
    if (input.action === 'replace') {
      if (
        !this.prepared.source.writes?.allowReplacement ||
        input.owned !== true
      )
        throw new Error(
          'Replacement requires allowReplacement and explicit --owned attestation',
        );
      this.replacementAllowed(input.baseline!);
    }
    await this.db.query(
      'INSERT INTO syncables_cache.local_edits(owner,scope,id,action,target,revision,baseline,desired) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        this.owner,
        this.prepared.scope,
        id,
        input.action,
        input.target ?? null,
        input.revision ?? null,
        input.baseline ?? null,
        desired,
      ],
    );
    return this.find(id);
  }
  private replacementAllowed(record: Value): void {
    const replace = replaceOf(this.prepared.document, this.model.resource);
    if (!replace || 'refused' in replace)
      throw new Error('Resource has no usable replacement declaration');
    const block = replaceBlock(replace, record);
    if (block) throw new Error('Replacement blocked: ' + block.field);
  }
  private async update(
    id: string,
    fields: Partial<
      Pick<LocalEdit, 'state' | 'observed' | 'sent' | 'created_id' | 'error'>
    >,
  ): Promise<void> {
    this.signal.throwIfAborted();
    const entries = Object.entries(fields);
    await this.db.query(
      `UPDATE syncables_cache.local_edits SET ${entries.map(([key], index) => key + '=$' + (index + 4)).join(',')},updated_at=clock_timestamp() WHERE owner=$1 AND scope=$2 AND id=$3`,
      [
        this.owner,
        this.prepared.scope,
        id,
        ...entries.map(([, value]) => value),
      ],
    );
  }
  async cancel(id: string): Promise<void> {
    const edit = await this.find(id);
    if (
      !['queued', 'failed', 'conflict'].includes(edit.state) ||
      edit.created_id
    )
      throw new Error('Cannot cancel a dispatched or partially applied edit');
    await this.update(id, { state: 'cancelled', error: null });
  }
  /** Explicitly retain both items after a partial replacement; never deletes either. */
  async keepBoth(id: string): Promise<void> {
    const edit = await this.find(id);
    if (
      edit.action !== 'replace' ||
      !edit.created_id ||
      !['retiring', 'conflict'].includes(edit.state)
    )
      throw new Error('No partial replacement to retain');
    await this.update(id, {
      state: 'cancelled',
      error: 'Both items retained by explicit user resolution',
    });
  }
  private async read(
    transport: Transport,
    session: Session,
    connection: Connection,
    id: string,
  ): Promise<Value | undefined> {
    this.signal.throwIfAborted();
    const response = await transport({
      ...proxyRequest(session, connection, this.model.itemPath(id, 'get')),
      purpose: 'precondition',
    });
    if ([404, 410].includes(response.status)) return undefined;
    if (response.status < 200 || response.status >= 300)
      throw new Error(
        'Precondition read refused (HTTP ' + response.status + ')',
      );
    const value: unknown = JSON.parse(response.body);
    if (!isRecord(value) || this.model.id(value) !== id)
      throw new Error('Precondition read returned a different identity');
    return value;
  }
  private destination(session: Session, connection: Connection): void {
    if (
      connection.connection_id !== this.prepared.source.connection ||
      connection.platform !== this.prepared.source.platform ||
      !session.scope?.split(' ').includes('proxy:read') ||
      !session.scope.split(' ').includes('proxy:write')
    )
      throw new Error(
        'Read/write grant for the configured connection required',
      );
  }
  /** Adopt an explicitly identified successful create; never resend an ambiguous POST. */
  async adopt(
    id: string,
    createdId: string,
    transport: Transport,
    session: Session,
    connection: Connection,
  ): Promise<void> {
    this.enabled();
    this.destination(session, connection);
    const edit = await this.find(id);
    if (
      !['creating', 'uncertain'].includes(edit.state) ||
      !edit.sent ||
      edit.action === 'delete' ||
      createdId === edit.target
    )
      throw new Error('Edit is not an adoptable create');
    const remote = await this.read(transport, session, connection, createdId);
    if (!remote || !sameJson(this.model.payload(remote), edit.sent))
      throw new Error('Created item does not match the recorded request');
    if (
      (await this.list()).some(
        (row) =>
          row.id !== id &&
          (row.created_id === createdId || row.target === createdId),
      )
    )
      throw new Error('Created identity already belongs to another edit');
    await this.update(id, {
      created_id: createdId,
      state: edit.action === 'replace' ? 'retiring' : 'confirmed',
      error: null,
    });
  }
  async send(
    transport: Transport,
    session: Session,
    connection: Connection,
  ): Promise<LocalEdit[]> {
    this.enabled();
    this.destination(session, connection);
    // Interrupted creates stay uncertain even if the crash happened before dispatch.
    // Losing availability is preferable to a duplicated non-idempotent create.
    for (const edit of await this.list()) {
      this.signal.throwIfAborted();
      if (edit.state === 'creating') {
        await this.update(edit.id, {
          state: 'uncertain',
          error:
            'Interrupted create; identify the created item before adopting',
        });
        continue;
      }
      if (!['queued', 'retiring'].includes(edit.state)) continue;
      if (edit.state === 'retiring') {
        await this.retire(edit, transport, session, connection);
        continue;
      }
      let observed: Value | undefined;
      let sent = edit.desired;
      try {
        if (edit.action !== 'create') {
          observed = await this.read(
            transport,
            session,
            connection,
            edit.target!,
          );
          if (!observed) {
            await this.update(edit.id, {
              state: edit.action === 'delete' ? 'confirmed' : 'conflict',
              error:
                edit.action === 'delete' ? null : 'Original no longer exists',
            });
            continue;
          }
          if (edit.action === 'delete') {
            if (!sameJson(observed, edit.baseline))
              throw new Error('Original changed since the pinned snapshot');
          } else {
            if (!this.prepared.source.writes?.allowReplacement)
              throw new Error('Replacement permission disabled');
            this.replacementAllowed(observed);
            sent = mergeEdit(
              this.model.payload(edit.baseline!),
              edit.desired!,
              this.model.payload(observed),
            );
          }
        }
      } catch {
        await this.update(edit.id, {
          state: 'conflict',
          error:
            'Precondition unavailable, changed or replacement blocked; inspect and queue a new edit',
        });
        continue;
      }
      if (edit.action === 'delete') {
        await this.update(edit.id, {
          state: 'retiring',
          observed: observed!,
          error: null,
        });
        await this.retire(
          { ...edit, state: 'retiring', observed: observed! },
          transport,
          session,
          connection,
        );
        continue;
      }
      if (
        edit.action === 'replace' &&
        sameJson(sent, this.model.payload(observed!))
      ) {
        await this.update(edit.id, {
          state: 'cancelled',
          error: 'No writable changes remain',
        });
        continue;
      }
      // This commit is the boundary after which a POST may have reached the provider.
      await this.update(edit.id, {
        state: 'creating',
        observed: observed ?? null,
        sent,
        error: null,
      });
      let response;
      try {
        this.signal.throwIfAborted();
        response = await transport({
          ...proxyRequest(session, connection, this.model.createPath),
          method: 'POST',
          body: JSON.stringify(sent),
          purpose: 'write',
        });
      } catch {
        await this.update(edit.id, {
          state: 'uncertain',
          error: 'Create response unavailable; do not resend',
        });
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        const uncertain = response.status >= 500 || response.status === 408;
        await this.update(edit.id, {
          state: uncertain ? 'uncertain' : 'failed',
          error: 'Create answered HTTP ' + response.status,
        });
        continue;
      }
      let createdId: string;
      try {
        const created: unknown = JSON.parse(response.body);
        if (!isRecord(created)) throw new Error('Not an object');
        createdId = this.model.id(created);
        if (
          createdId === edit.target ||
          (await this.list()).some(
            (row) =>
              row.id !== edit.id &&
              (row.created_id === createdId || row.target === createdId),
          )
        )
          throw new Error('Identity collision');
      } catch {
        await this.update(edit.id, {
          state: 'uncertain',
          error:
            'Create succeeded without a usable new identity; adopt it explicitly',
        });
        continue;
      }
      // Do not move this receipt after DELETE: recovery depends on its durability.
      await this.update(edit.id, {
        created_id: createdId,
        state: edit.action === 'replace' ? 'retiring' : 'confirmed',
        error: null,
      });
      if (edit.action === 'replace')
        await this.retire(
          {
            ...edit,
            observed: observed!,
            sent,
            created_id: createdId,
            state: 'retiring',
          },
          transport,
          session,
          connection,
        );
    }
    return this.list();
  }
  private async retire(
    edit: LocalEdit,
    transport: Transport,
    session: Session,
    connection: Connection,
  ): Promise<void> {
    try {
      const remote = await this.read(
        transport,
        session,
        connection,
        edit.target!,
      );
      if (!remote) {
        await this.update(edit.id, { state: 'confirmed', error: null });
        return;
      }
      if (!sameJson(remote, edit.observed)) {
        await this.update(edit.id, {
          state: 'conflict',
          error: 'Original changed after creation; both items retained',
        });
        return;
      }
      if (edit.action === 'replace') {
        if (!this.prepared.source.writes?.allowReplacement)
          throw new Error('Replacement permission disabled');
        // Before deleting an original, prove the durably identified replacement still exists.
        const created = await this.read(
          transport,
          session,
          connection,
          edit.created_id!,
        );
        if (!created || !sameJson(this.model.payload(created), edit.sent))
          throw new Error('Replacement missing or changed');
        this.replacementAllowed(remote);
      }
      this.signal.throwIfAborted();
      const response = await transport({
        ...proxyRequest(
          session,
          connection,
          this.model.itemPath(edit.target!, 'delete'),
        ),
        method: 'DELETE',
        purpose: 'write',
      });
      if (
        (response.status >= 200 && response.status < 300) ||
        [404, 410].includes(response.status)
      )
        await this.update(edit.id, { state: 'confirmed', error: null });
      else
        await this.update(edit.id, {
          error:
            'Delete answered HTTP ' + response.status + '; receipt retained',
        });
    } catch {
      await this.update(edit.id, {
        error:
          'Retirement incomplete; receipt retained for the next explicit send',
      });
    }
  }
}
