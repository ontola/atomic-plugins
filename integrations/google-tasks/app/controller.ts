// @wc-ignore-file
/**
 * The view's state machine: find this app's Google Tasks connection,
 * provision the drive (once), import on open, on "Sync now" and after the
 * person ticks or unticks a task list. Nothing runs while the view is
 * closed, and nothing is written to Google.
 *
 * A sync that Google rate-limits (`GoogleRateLimited`, after `read.ts` has
 * waited out what it could) ends in an `error` state that says when to try
 * again. When that is within `MAX_AUTO_RETRY_MS`, the controller retries
 * once at that time, at most `MAX_AUTO_RETRIES` times in a row; after that,
 * or for a longer wait, the sync stops and the view says when to try again.
 * Every wait is bounded; a "Sync now" cancels a waiting retry, and nothing
 * is scheduled while a sync is busy or after `dispose()`.
 */
import {
  chosenLists,
  type Drive,
  lastSync,
  OtherTable,
  provision,
  recordChosenLists,
} from './drive.js';
import { GoogleError, GoogleRateLimited } from './read.js';
import type { PluginStore } from './store.js';
import {
  listTasks,
  PLATFORM,
  relayGet,
  syncTasks,
  type SyncOptions,
  type SyncSummary,
  type TaskRow,
} from './sync.js';
import type { TaskListEntry } from './tasks.js';

type Connection = { connectionId: string; platform: string };

/** What every state that shows the table carries. */
export interface Listed {
  tasks: TaskRow[];
  /** The App's last complete read (`google-tasks-last-sync`), ISO 8601 UTC, if any. */
  lastGood?: string;
  /** The person's task lists, as the last read listed them; `[]` before one. */
  lists: TaskListEntry[];
  /** The lists the person ticked, by id (`google-tasks-lists` on the App). */
  chosen: string[];
}

export interface RateLimited {
  /** When to try again, in milliseconds since the epoch. */
  retryAt: number;
  /** Whether the controller retries by itself at `retryAt`. */
  retrying: boolean;
}

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy client for apps (atomic-server#1657 not in this build). */
  | { kind: 'no-relay' }
  /** Added as a view of another Issue table: the app shows nothing of its own. */
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
  | ({
      kind: 'error';
      message: string;
      /** When it failed, in milliseconds since the epoch. */
      at: number;
      /** Google's HTTP status, when the error was its answer. */
      status?: number;
      rateLimited?: RateLimited;
      connection?: Connection;
    } & Listed);

/** Longest wait the controller sits out by itself. */
export const MAX_AUTO_RETRY_MS = 15 * 60_000;
/** Automatic retries in a row before the sync stops instead. */
export const MAX_AUTO_RETRIES = 3;

const PRESENCE_WORDS: Record<string, string> = {
  deleted: 'deleted',
  unavailable: 'unavailable',
  unconfirmed: 'unconfirmed',
};

/** "5 tasks (5 added, 0 updated, 0 unchanged); 4 present, 1 deleted." */
export function describeSummary(s: SyncSummary): string {
  if (!s.chosen.length)
    return `No task list chosen yet; ${s.lists.length} list${s.lists.length === 1 ? '' : 's'} found. Tick the lists to import.`;
  const counts = `${s.total} task${s.total === 1 ? '' : 's'} (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged)`;
  const presence = [`${s.presence.present} present`];

  for (const [key, word] of Object.entries(PRESENCE_WORDS)) {
    const n = s.presence[key as keyof SyncSummary['presence']];
    if (n) presence.push(`${n} ${word}`);
  }

  const partial = s.complete
    ? ''
    : ' The read was partial, so no missing task was checked.';

  return `${counts}; ${presence.join(', ')}.${partial}`;
}

/** "14:05", in the person's locale and time zone (tests pin both). */
export function clockTime(
  at: number,
  options: { locale?: string; timeZone?: string } = {},
): string {
  return new Date(at).toLocaleTimeString(options.locale, {
    hour: '2-digit',
    minute: '2-digit',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  });
}

/**
 * The rate-limit sentence, as the card and the status line say it: the
 * retry the controller will make by itself, or that the sync stopped and
 * when to try again.
 */
export function rateLimitWords(
  limited: RateLimited,
  options: { locale?: string; timeZone?: string } = {},
): { error: string; nextStep?: string } {
  const time = clockTime(limited.retryAt, options);

  return limited.retrying
    ? { error: `Google Tasks is rate-limiting; retrying at ${time}.` }
    : {
        error: 'Google Tasks is rate-limiting; the sync stopped.',
        nextStep: `Try again after ${time}.`,
      };
}

/** Whether any row of the table came from Google: only then is anything "kept". */
export const imported = (state: ViewState): boolean =>
  'tasks' in state && state.tasks.some(t => t.taskId);

/** The one `role="status"` text (visually hidden; the card shows the rest). */
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
      return 'This is another Issue table. The Google Tasks app imports only into its own table.';
    case 'disconnected':
      return 'Not connected. Connect Google Tasks to import the task lists you choose (read-only).';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'syncing':
      return 'Importing tasks…';
    case 'synced':
      return `Last synced ${state.at.toLocaleTimeString()}: ${describeSummary(state.summary)}`;

    case 'error': {
      const kept = imported(state) ? ' Tasks imported earlier are kept.' : '';

      if (state.rateLimited) {
        const words = rateLimitWords(state.rateLimited, options);

        return `${words.error}${words.nextStep ? ` ${words.nextStep}` : ''}${kept}`;
      }

      return `Refresh failed: ${state.message}${kept}`;
    }
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export interface ControllerOptions extends SyncOptions {
  /** The clock, in milliseconds; tests pin it. */
  clock?: () => number;
  /** The timer for an automatic retry; tests replace it. */
  timer?: {
    set(run: () => void, ms: number): unknown;
    clear(handle: unknown): void;
  };
}

const defaultTimer: NonNullable<ControllerOptions['timer']> = {
  set: (run, ms) => setTimeout(run, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  options: ControllerOptions = {},
) {
  const { clock = Date.now, timer = defaultTimer, ...syncOptions } = options;
  const now = syncOptions.now ?? (() => new Date(clock()).toISOString());
  let state: ViewState = { kind: 'loading' };
  let drive: Drive | undefined;
  let lastGood: string | undefined;
  let lists: TaskListEntry[] = [];
  let chosen: string[] = [];
  /** The automatic retry waiting for Google's `Retry-After`, if any. */
  let retryHandle: unknown;
  let autoRetries = 0;
  /** After `dispose()`: no new timer, whatever a sync still in flight finds. */
  let disposed = false;
  /**
   * Set synchronously when a pass starts, before its first `await`, so two
   * "Sync now" presses in one tick run one pass, not two (the `syncing`
   * state follows a little later, after provisioning).
   */
  let busy = false;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const tasks = () => ('tasks' in state ? state.tasks : []);
  const listed = (rows: TaskRow[]): Listed => ({
    tasks: rows,
    ...(lastGood ? { lastGood } : {}),
    lists,
    chosen,
  });

  /** Provisions once; `OtherTable` is a state, anything else an error. */
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
          ...listed(tasks()),
        });

      return undefined;
    }

    return drive;
  };

  /**
   * The table's rows, the App's last complete read and its chosen lists, as
   * the drive has them now. Read before any state renders, so a table that
   * holds imported rows never reads "Not synced yet".
   */
  const reread = async (): Promise<Listed> => {
    if (!drive) return listed(tasks());
    lastGood = await lastSync(store, drive, clock()).catch(() => lastGood);
    chosen = await chosenLists(store, drive).catch(() => chosen);

    return listed(await listTasks(store, drive).catch(() => tasks()));
  };

  const cancelRetry = () => {
    if (retryHandle !== undefined) timer.clear(retryHandle);
    retryHandle = undefined;
  };

  const controller = {
    state: () => state,

    /**
     * Finds this app's connection, then starts one sync. Resolves once that
     * is known, not when the sync ends.
     */
    async load(): Promise<{ syncing?: Promise<void> }> {
      const proxy = store.proxy;
      if (!proxy) return (set({ kind: 'no-relay' }), {});
      if (!(await ready())) return {};
      const rows = await reread();
      let connection: Connection | undefined;

      try {
        [connection] = await proxy.connections({ platform: PLATFORM });
      } catch (error) {
        // Asking the host for the connection failed: a visible error state,
        // never "Loading…" for good. Rows imported earlier are still listed.
        set({
          kind: 'error',
          message: `Could not load: ${message(error)}`,
          at: clock(),
          ...rows,
        });

        return {};
      }

      if (!connection) return (set({ kind: 'disconnected', ...rows }), {});

      return { syncing: controller.sync(connection) };
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting', ...listed(tasks()) });

      try {
        // Connecting a new account sends the page away and this view reloads;
        // picking an existing connection resolves here with no reload.
        const result = await proxy.connect({ platform: PLATFORM });
        if (result.status === 'connected') await controller.sync(result);
        else set({ kind: 'disconnected', ...listed(tasks()) });
      } catch (error) {
        set({
          kind: 'error',
          message: message(error),
          at: clock(),
          ...listed(tasks()),
        });
      }
    },

    /**
     * Records the task lists to import on the App, then syncs when there is
     * a connection. Ignored while a sync is running (the checkboxes are
     * disabled then).
     */
    async chooseLists(ids: string[]): Promise<void> {
      if (busy || state.kind === 'loading') return;
      const d = await ready();
      if (!d) return;

      try {
        await recordChosenLists(store, d, ids);
      } catch (error) {
        return set({
          kind: 'error',
          message: `Could not save the chosen task lists: ${message(error)}`,
          at: clock(),
          ...('connection' in state && state.connection
            ? { connection: state.connection }
            : {}),
          ...listed(tasks()),
        });
      }

      chosen = ids;
      const connection = 'connection' in state ? state.connection : undefined;
      if (connection) await controller.sync(connection);
      else set({ ...state, ...listed(tasks()) } as ViewState);
    },

    /**
     * One pass. A pass the person starts ("Sync now") cancels an automatic
     * retry that is waiting and counts as a fresh start for the retry cap.
     */
    async sync(
      connection = 'connection' in state ? state.connection : undefined,
      { automatic = false } = {},
    ): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (!connection || busy) return;
      busy = true;

      try {
        await controller.pass(connection, automatic);
      } finally {
        busy = false;
      }
    },

    /** The body of `sync`, with `busy` held by the caller. */
    async pass(connection: Connection, automatic: boolean): Promise<void> {
      const proxy = store.proxy!;
      cancelRetry();
      if (!automatic) autoRetries = 0;
      const d = await ready();
      if (!d) return;
      set({ kind: 'syncing', connection, ...listed(tasks()) });

      try {
        const summary = await syncTasks(store, relayGet(proxy, connection), d, {
          ...syncOptions,
          now,
        });
        autoRetries = 0;
        lists = summary.lists;
        set({
          kind: 'synced',
          connection,
          at: new Date(clock()),
          summary,
          ...(await reread()),
        });
      } catch (error) {
        const at = clock();
        const rows = await reread();
        const status =
          error instanceof GoogleError && error.status !== undefined
            ? { status: error.status }
            : {};

        if (error instanceof GoogleRateLimited) {
          const wait = Math.max(0, error.retryAt - at);
          const retrying =
            !disposed &&
            wait <= MAX_AUTO_RETRY_MS &&
            autoRetries < MAX_AUTO_RETRIES;

          if (retrying) {
            autoRetries++;
            retryHandle = timer.set(() => {
              retryHandle = undefined;
              void controller.sync(connection, { automatic: true });
            }, wait);
          }

          return set({
            kind: 'error',
            connection,
            message: error.message,
            at,
            ...status,
            rateLimited: { retryAt: error.retryAt, retrying },
            ...rows,
          });
        }

        set({
          kind: 'error',
          connection,
          message: message(error),
          at,
          ...status,
          ...rows,
        });
      }
    },

    /**
     * Stops an automatic retry that is waiting, and keeps a sync still in
     * flight from scheduling one. The host has no teardown hook for a view
     * yet (the frame is simply discarded), so `main.ts` cannot call this;
     * tests do.
     */
    dispose(): void {
      disposed = true;
      cancelRetry();
    },
  };

  return controller;
}
