// @wc-ignore-file
import type { OpenApiDocument } from 'syncables/browser';
import { localChanges, type Conflicts, type RowChange } from './changes.js';
import { classifyFailure, type ProviderFailure } from './errors.js';
import {
  loadRecord,
  loadSchema,
  saveRecord,
  toRecord,
  type Schema,
  type SyncRecord,
} from './record.js';
import { loadRows, type Row } from './rows.js';
import {
  discardChange,
  resolveConflict,
  sendChanges,
  type SendOutcome,
} from './send.js';
import type { PluginStore } from './store.js';
import {
  NOTION_DOCUMENT,
  syncNotion,
  type SyncProgress,
  type SyncResult,
} from './sync.js';
import { PLATFORM, syncablesTransport } from './transport.js';

/** A sync older than this is repeated when the app opens (DESIGN.md §7). */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** What every state after a connection was found carries. */
export interface Connected {
  /** Absent when the connection is gone (`reauth` found on load). */
  connectionId?: string;
  /** The table's rows, as last read back from the drive. */
  rows: Row[];
  /** The last sync record that was saved, from this or an earlier open. */
  last?: SyncRecord;
  /** Rows the latest sync created or changed, for a short highlight. */
  changed?: string[];
  /**
   * Edits to synced rows not yet in Notion, found by comparing each row
   * with its baseline (`changes.ts`), with conflicts the last sync or send
   * found. Set on every state that carries rows; empty when there are none.
   */
  changes?: RowChange[];
  /** What the last Send did, per row, until the next Send or sync. */
  outcomes?: SendOutcome[];
  /** A Send is running. */
  sending?: boolean;
}

/**
 * Everything the view shows, as data, so it is testable without a DOM.
 * `main.ts` renders a `ViewState` and wires the actions.
 */
export type ViewState =
  | { kind: 'loading' }
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | ({ kind: 'ready' } & Connected)
  /** A sync over rows that stay usable. */
  | ({ kind: 'syncing'; progress: SyncProgress[] } & Connected)
  /** The first import: the table has no rows yet. */
  | ({ kind: 'importing'; progress: SyncProgress[] } & Connected)
  /** Connected, but Notion shares no database with the integration. */
  | ({ kind: 'no-databases' } & Connected)
  /** The three failure states carry `at`: when the sync that found them ended. */
  | ({ kind: 'reauth'; at: number; technical?: string } & Connected)
  /** No connection for this app, but rows from an earlier one are kept. */
  | ({ kind: 'disconnected' } & Connected)
  | ({
      kind: 'rate-limited';
      at: number;
      retryAt: number;
      pagesRead: number;
      technical: string;
    } & Connected)
  | ({
      kind: 'failed';
      at: number;
      title: string;
      message: string;
      technical: string;
    } & Connected);

export type ConnectedState = Extract<ViewState, Connected>;

export const isConnected = (state: ViewState): state is ConnectedState =>
  'rows' in state;

export const isRunning = (state: ViewState): boolean =>
  state.kind === 'syncing' ||
  state.kind === 'importing' ||
  (isConnected(state) && !!state.sending);

export interface Controller {
  state(): ViewState;
  /** Reads the connection, the stored record and the rows. Fetches nothing from Notion. */
  load(): Promise<ViewState>;
  /** Whether the last sync is unknown or older than `STALE_AFTER_MS`. */
  isStale(): boolean;
  /**
   * Asks the host to connect (or reconnect, or re-open Notion's page
   * picker). A new account navigates the page away; an existing connection
   * picked in the host's bar reloads the state; a cancel restores it.
   */
  connect(): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /**
   * Stops this app using Notion (`store.proxy.disconnect`): the delegation
   * goes, the rows and the sync record stay. Absent on older hosts.
   */
  disconnect?(): Promise<ViewState>;
  /** Re-reads the rows (after the table changed elsewhere). */
  refreshRows(): Promise<ViewState>;
  /**
   * Sends every reviewed change that can be sent (no conflict, no problem)
   * to Notion (`send.ts`). Only from `ready`, with a connection.
   */
  send(): Promise<ViewState>;
  /** Puts a row's changed fields back to the baseline. */
  discard(subject: string): Promise<ViewState>;
  /** Resolves one conflicting field: keep the row's value, or take Notion's. */
  resolve(
    subject: string,
    shortname: string,
    keep: 'mine' | 'notion',
  ): Promise<ViewState>;
}

const upstream = (doc: OpenApiDocument) =>
  new URL((doc as { servers?: { url: string }[] }).servers?.[0]?.url ?? '');

const fingerprint = (row: Row) => JSON.stringify(row.values);

export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
  sync: typeof syncNotion = syncNotion,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let schema: Schema | undefined;
  let running = false;
  let conflicts: Conflicts = new Map();

  const set = (next: ViewState) => {
    if (isConnected(next))
      next = {
        ...next,
        changes: localChanges(next.rows, next.last, conflicts),
      };
    current = next;
    onChange(next);

    return next;
  };

  const base = (): Connected =>
    isConnected(current)
      ? {
          ...(current.connectionId
            ? { connectionId: current.connectionId }
            : {}),
          rows: current.rows,
          ...(current.last ? { last: current.last } : {}),
        }
      : { rows: [] };

  const readDrive = async () => {
    schema = await loadSchema(store);
    if (!schema) return { rows: [] as Row[], last: undefined };
    const [rows, last] = await Promise.all([
      loadRows(store, schema),
      loadRecord(store, schema).catch(() => undefined),
    ]);

    return { rows, last };
  };

  return {
    state: () => current,

    isStale() {
      if (!isConnected(current) || !current.last) return true;

      return now() - current.last.at > STALE_AFTER_MS;
    },

    async load() {
      const proxy = store.proxy;
      if (!proxy || typeof proxy.connections !== 'function')
        return set({ kind: 'no-proxy' });
      const [connections, drive] = await Promise.all([
        proxy.connections({ platform: PLATFORM }),
        readDrive(),
      ]);
      const [connection] = connections;
      const kept: Connected = {
        rows: drive.rows,
        ...(drive.last ? { last: drive.last } : {}),
      };

      // Disconnected on purpose, or the delegation was removed elsewhere:
      // either way the rows stay, and connecting again resumes syncing.
      if (!connection)
        return set(
          drive.rows.length || drive.last
            ? { kind: 'disconnected', ...kept }
            : { kind: 'not-connected' },
        );

      const connected = { ...kept, connectionId: connection.connectionId };

      return set(
        drive.last && drive.last.dataSources.length === 0
          ? { kind: 'no-databases', ...connected }
          : { kind: 'ready', ...connected },
      );
    },

    async connect() {
      const proxy = store.proxy;
      if (!proxy || running) return current;
      const before = current;
      if (current.kind === 'not-connected') set({ kind: 'connecting' });
      else if (!isConnected(current)) return current;
      // Connecting a new account navigates away and comes back to a fresh
      // view; picking an existing one resolves `connected`, with no reload
      // (#54 phase 2). Cancelling returns to the state it started from.
      const result = await proxy.connect({ platform: PLATFORM });
      if (result?.status !== 'connected') return set(before);
      // Picking an existing connection does not reload the frame, so the
      // first sync (or the one after choosing other pages) starts here; a
      // new account comes back through view(), which syncs on open.
      const state = await this.load();

      return isConnected(state) && state.connectionId ? this.sync() : state;
    },

    ...(store.proxy?.disconnect
      ? {
          async disconnect() {
            const proxy = store.proxy;
            if (!proxy?.disconnect || running || !isConnected(current))
              return current;
            await proxy.disconnect({ platform: PLATFORM });

            return this.load();
          },
        }
      : {}),

    async refreshRows() {
      if (!isConnected(current) || running || !schema) return current;
      const rows = await loadRows(store, schema);

      return set({ ...current, rows });
    },

    async send() {
      const proxy = store.proxy;
      if (
        !proxy ||
        running ||
        current.kind !== 'ready' ||
        !current.connectionId ||
        !current.changes?.length
      )
        return current;
      schema ??= await loadSchema(store);
      if (!schema) return current;
      running = true;
      const outcomes: SendOutcome[] = [];
      const before = current;
      set({ ...before, sending: true, outcomes: [] });

      try {
        await sendChanges({
          store,
          proxy,
          connectionId: before.connectionId!,
          schema,
          changes: before.changes!,
          onOutcome: outcome => {
            outcomes.push(outcome);
            if (outcome.status === 'changed')
              conflicts.set(
                outcome.subject,
                new Map(Object.entries(outcome.notion)),
              );
            if (isConnected(current) && current.sending)
              set({ ...current, outcomes: [...outcomes] });
          },
        });
      } catch (error) {
        outcomes.push({
          subject: '',
          name: '',
          status: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        const rows = await loadRows(store, schema);

        return set({ ...before, rows, outcomes, sending: false });
      } finally {
        running = false;
      }
    },

    async discard(subject) {
      if (running || !isConnected(current)) return current;
      const change = current.changes?.find(c => c.subject === subject);
      schema ??= await loadSchema(store);
      if (!change || !schema) return current;
      await discardChange(store, schema, change);
      conflicts.delete(subject);

      return this.refreshRows();
    },

    async resolve(subject, shortname, keep) {
      if (running || !isConnected(current)) return current;
      const change = current.changes?.find(c => c.subject === subject);
      const field = change?.fields.find(f => f.shortname === shortname);
      schema ??= await loadSchema(store);
      if (!change || !field?.conflict || !schema) return current;
      await resolveConflict(store, schema, change, field, keep);
      const open = conflicts.get(subject);
      open?.delete(shortname);
      if (!open?.size) conflicts.delete(subject);

      return this.refreshRows();
    },

    async sync() {
      const proxy = store.proxy;
      if (!proxy || running || !isConnected(current)) return current;
      const { connectionId } = current;
      if (!connectionId) return current;
      running = true;
      const before = base();
      const kind = before.rows.length ? 'syncing' : 'importing';
      const progress: SyncProgress[] = [];
      const failures: ProviderFailure[] = [];
      const startedAt = now();
      set({ kind, ...before, progress: [] });

      const transport = syncablesTransport(
        proxy,
        connectionId,
        upstream(NOTION_DOCUMENT),
        ({ method, path, status, headers, code }) => {
          if (status >= 200 && status < 300 && !code) return;
          failures.push({
            status,
            method,
            path,
            ...(code ? { code } : {}),
            ...(headers['retry-after']
              ? { retryAfter: headers['retry-after'] }
              : {}),
            at: now(),
          });
        },
      );

      let result: SyncResult | undefined;
      let error: unknown;

      try {
        result = await sync(store, transport, undefined, {
          onProgress: event => {
            const at = progress.findIndex(
              p => p.dataSource === event.dataSource,
            );
            if (at < 0) progress.push(event);
            else progress[at] = event;
            if (current.kind === kind)
              set({ ...current, progress: [...progress] });
          },
        });
      } catch (caught) {
        error = caught;
      }

      try {
        const failure = classifyFailure(
          failures,
          error ??
            (result?.readErrors.length
              ? new Error(result.readErrors.join('; '))
              : undefined),
          now(),
        );
        let last = before.last;

        // A sync that ended in a failure state keeps the previous record: it
        // would otherwise count as fresh (no re-sync on open for 15 minutes)
        // and carry a partial schema.
        if (result && !failure) {
          last = toRecord(result, startedAt, now());

          try {
            schema ??= await loadSchema(store);
            if (schema) schema = await saveRecord(store, schema, last);
          } catch (saving) {
            last.general.push(
              `The sync record could not be saved in the drive, so it is lost on reload: ${
                saving instanceof Error ? saving.message : String(saving)
              }`,
            );
          }
        }

        // Rows written before a failure are kept, so read them back either way.
        schema = (await loadSchema(store)) ?? schema;
        const rows = schema ? await loadRows(store, schema) : before.rows;
        const previous = new Map(
          before.rows.map(r => [r.subject, fingerprint(r)]),
        );
        const changed = before.rows.length
          ? rows
              .filter(r => previous.get(r.subject) !== fingerprint(r))
              .map(r => r.subject)
          : [];
        if (result) conflicts = result.conflicts;
        const after: Connected = {
          connectionId,
          rows,
          ...(last ? { last } : {}),
          ...(changed.length ? { changed } : {}),
        };
        if (failure?.kind === 'rate-limited')
          return set({
            ...after,
            ...failure,
            at: now(),
            pagesRead: progress.reduce((n, p) => n + p.pages, 0),
          });
        if (failure) return set({ ...after, ...failure, at: now() });
        if (result && result.dataSources === 0)
          return set({ kind: 'no-databases', ...after });

        return set({ kind: 'ready', ...after });
      } finally {
        running = false;
      }
    },
  };
}
