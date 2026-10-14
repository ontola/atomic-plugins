// @wc-ignore-file
/**
 * The view's state machine: find this app's Google Keep connection,
 * provision the drive (once), then sync on open, on "Sync now" and every
 * `INTERVAL_MS` for as long as the view is open, in whichever browser has
 * it open. A pass first takes the lease (lease.ts); when another browser
 * holds it, this one skips the pass and says so, and tries again at the
 * next tick. Nothing runs while no one has the view open: the host runs a
 * drive app only in its frame.
 *
 * A rate limit (`GoogleRateLimited`) ends in an `error` state that says when
 * to try again; the next tick no earlier than that tries again. A
 * connection to another Google account than the table's
 * (`AccountMismatch`) stops the timer: it would only fail again.
 */
import {
  type Drive,
  lastPass,
  lastSync,
  OtherTable,
  provision,
} from './drive.js';
import { acquire, newHolder, release, type LeaseOptions } from './lease.js';
import { GoogleError, GoogleRateLimited } from './read.js';
import type { PluginStore } from './store.js';
import {
  AccountMismatch,
  deleteRemoved,
  keepMine,
  keepTheirs,
  listNotes,
  type NoteRow,
  PLATFORM,
  relayCall,
  restoreRemoved,
  syncNotes,
  type SyncOptions,
  type SyncSummary,
} from './sync.js';

type Connection = { connectionId: string; platform: string };

export interface Listed {
  notes: NoteRow[];
  lastGood?: string;
  lastPass?: string;
  /** Notes whose row was deleted here, as the last pass of this page found them. */
  removedHere: { id: string; title: string }[];
}

export type ViewState =
  | { kind: 'loading' }
  | { kind: 'no-relay' }
  | { kind: 'other-table' }
  | ({ kind: 'disconnected' } & Listed)
  | ({ kind: 'connecting' } & Listed)
  | ({ kind: 'syncing'; connection: Connection } & Listed)
  | ({
      kind: 'synced';
      connection: Connection;
      at: Date;
      summary: SyncSummary;
    } & Listed)
  /** Another open browser holds the lease and syncs; this one waits. */
  | ({ kind: 'elsewhere'; connection: Connection } & Listed)
  | ({
      kind: 'error';
      message: string;
      at: number;
      status?: number;
      /** When to try again after a rate limit, in ms since the epoch. */
      retryAt?: number;
      /** The connection is to another Google account than the table's. */
      mismatch?: boolean;
      connection?: Connection;
    } & Listed);

/** How often an open view syncs. */
export const INTERVAL_MS = 60_000;

/** "3 notes added, 1 updated; 2 sent to Keep." */
export function describeSummary(s: SyncSummary): string {
  const parts = [
    `${s.total} note${s.total === 1 ? '' : 's'} (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged)`,
  ];
  const sent = s.created + s.replaced;
  if (sent) parts.push(`${sent} sent to Google Keep`);
  if (s.conflicts) parts.push(`${s.conflicts} in conflict`);
  if (s.blocked.length) parts.push(`${s.blocked.length} not sent`);
  if (s.failed.length) parts.push(`${s.failed.length} failed`);
  if (s.waiting) parts.push(`${s.waiting} waiting for the next sync`);

  return `${parts.join('; ')}.${s.complete ? '' : ' The read was partial, so no missing note was checked.'}`;
}

export const clockTime = (
  at: number,
  options: { locale?: string; timeZone?: string } = {},
) =>
  new Date(at).toLocaleTimeString(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });

/** The one `role="status"` text. */
export function describe(
  state: ViewState,
  options: { locale?: string; timeZone?: string } = {},
): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet.';
    case 'other-table':
      return 'This is another table. The Google Keep app syncs only its own table.';
    case 'disconnected':
      return 'Not connected. Connect Google Keep to sync your notes both ways.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'syncing':
      return 'Syncing with Google Keep…';
    case 'elsewhere':
      return 'Another open browser is syncing this table with Google Keep right now.';
    case 'synced':
      return `Last synced ${state.at.toLocaleTimeString()}: ${describeSummary(state.summary)}`;
    case 'error':
      return state.retryAt
        ? `Google Keep is rate-limiting; trying again after ${clockTime(state.retryAt, options)}.`
        : `Sync failed: ${state.message}`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface ControllerOptions extends SyncOptions {
  clock?: () => number;
  timer?: {
    every(run: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
  lease?: LeaseOptions;
  holder?: string;
}

const defaultTimer: NonNullable<ControllerOptions['timer']> = {
  every: (run, ms) => setInterval(run, ms),
  clear: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  options: ControllerOptions = {},
) {
  const {
    clock = Date.now,
    timer = defaultTimer,
    lease: leaseOptions = {},
    holder = newHolder(),
    ...syncOptions
  } = options;
  const now = syncOptions.now ?? (() => new Date(clock()).toISOString());
  let state: ViewState = { kind: 'loading' };
  let drive: Drive | undefined;
  let lastGood: string | undefined;
  let lastPassAt: string | undefined;
  let removedHere: Listed['removedHere'] = [];
  let ticking: unknown;
  let notBefore = 0;
  let busy = false;
  let disposed = false;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const notes = () => ('notes' in state ? state.notes : []);
  const listed = (rows: NoteRow[]): Listed => ({
    notes: rows,
    ...(lastGood ? { lastGood } : {}),
    ...(lastPassAt ? { lastPass: lastPassAt } : {}),
    removedHere,
  });
  const connection = () =>
    'connection' in state ? state.connection : undefined;

  const ready = async (): Promise<Drive | undefined> => {
    if (drive) return drive;

    try {
      drive = await provision(store);
    } catch (error) {
      if (error instanceof OtherTable) set({ kind: 'other-table' });
      else
        set({
          kind: 'error',
          message: message(error),
          at: clock(),
          ...listed(notes()),
        });

      return undefined;
    }

    return drive;
  };

  const reread = async (): Promise<Listed> => {
    if (!drive) return listed(notes());
    lastGood = await lastSync(store, drive, clock()).catch(() => lastGood);
    lastPassAt = await lastPass(store, drive, clock()).catch(() => lastPassAt);

    return listed(await listNotes(store, drive).catch(() => notes()));
  };

  const stopTicking = () => {
    if (ticking !== undefined) timer.clear(ticking);
    ticking = undefined;
  };

  const startTicking = () => {
    if (ticking !== undefined || disposed) return;
    ticking = timer.every(() => {
      if (clock() >= notBefore)
        void controller.sync(undefined, { automatic: true });
    }, INTERVAL_MS);
  };

  const controller = {
    state: () => state,

    async load(): Promise<{ syncing?: Promise<void> }> {
      const proxy = store.proxy;
      if (!proxy) return (set({ kind: 'no-relay' }), {});
      if (!(await ready())) return {};
      const rows = await reread();
      let found: Connection | undefined;

      try {
        [found] = await proxy.connections({ platform: PLATFORM });
      } catch (error) {
        set({
          kind: 'error',
          message: `Could not load: ${message(error)}`,
          at: clock(),
          ...rows,
        });

        return {};
      }

      if (!found) return (set({ kind: 'disconnected', ...rows }), {});

      return { syncing: controller.sync(found) };
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting', ...listed(notes()) });

      try {
        const result = await proxy.connect({ platform: PLATFORM });
        if (result.status === 'connected') await controller.sync(result);
        else set({ kind: 'disconnected', ...listed(notes()) });
      } catch (error) {
        set({
          kind: 'error',
          message: message(error),
          at: clock(),
          ...listed(notes()),
        });
      }
    },

    async sync(
      using = connection(),
      { automatic = false } = {},
    ): Promise<void> {
      if (!store.proxy) return set({ kind: 'no-relay' });
      if (!using || busy || disposed) return;
      busy = true;
      if (!automatic) notBefore = 0;

      try {
        await controller.pass(using);
      } finally {
        busy = false;
      }
    },

    async pass(using: Connection): Promise<void> {
      const d = await ready();
      if (!d) return;
      set({ kind: 'syncing', connection: using, ...listed(notes()) });
      let held = false;

      try {
        held = await acquire(store, d, holder, { now: clock, ...leaseOptions });

        if (!held) {
          set({ kind: 'elsewhere', connection: using, ...(await reread()) });
          startTicking();

          return;
        }

        const summary = await syncNotes(
          store,
          relayCall(store.proxy!, using),
          d,
          {
            ...syncOptions,
            now,
          },
        );
        removedHere = summary.removedHere;
        set({
          kind: 'synced',
          connection: using,
          at: new Date(clock()),
          summary,
          ...(await reread()),
        });
        startTicking();
      } catch (error) {
        const at = clock();
        const rows = await reread();
        const status =
          error instanceof GoogleError && error.status !== undefined
            ? { status: error.status }
            : {};

        if (error instanceof AccountMismatch) {
          stopTicking();

          return set({
            kind: 'error',
            connection: using,
            message: error.message,
            at,
            mismatch: true,
            ...rows,
          });
        }

        if (error instanceof GoogleRateLimited) {
          notBefore = error.retryAt;
          startTicking();

          return set({
            kind: 'error',
            connection: using,
            message: error.message,
            at,
            ...status,
            retryAt: error.retryAt,
            ...rows,
          });
        }

        startTicking();
        set({
          kind: 'error',
          connection: using,
          message: message(error),
          at,
          ...status,
          ...rows,
        });
      } finally {
        if (held) await release(store, d, holder).catch(() => undefined);
      }
    },

    /** Settles a conflict, then syncs. */
    async resolve(subject: string, side: 'mine' | 'theirs'): Promise<void> {
      const d = await ready();
      if (!d || busy) return;
      await (side === 'mine' ? keepMine : keepTheirs)(store, d, subject);
      const using = connection();
      if (using) await controller.sync(using);
      else set({ ...state, ...(await reread()) } as ViewState);
    },

    /** Brings a note whose row was deleted here back as a row at the next pass. */
    async restore(id: string): Promise<void> {
      const d = await ready();
      if (!d || busy) return;
      await restoreRemoved(store, d, id);
      removedHere = removedHere.filter(r => r.id !== id);
      const using = connection();
      if (using) await controller.sync(using);
    },

    /** Deletes a note in Keep for good, on the person's explicit request. */
    async deleteInKeep(id: string): Promise<void> {
      const using = connection();
      if (!using || !store.proxy || busy) return;

      try {
        await deleteRemoved(relayCall(store.proxy, using), id);
        removedHere = removedHere.filter(r => r.id !== id);
        set({ ...state, ...listed(notes()) } as ViewState);
      } catch (error) {
        set({
          kind: 'error',
          connection: using,
          message: message(error),
          at: clock(),
          ...listed(notes()),
        });
      }
    },

    dispose(): void {
      disposed = true;
      stopTicking();
    },
  };

  return controller;
}
