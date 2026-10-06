// @wc-ignore-file
/**
 * The view's state machine: find this app's Todoist connection, provision the
 * drive (once), import on open and on "Sync now". Nothing runs while the view
 * is closed, and nothing is written to Todoist.
 *
 * A sync that Todoist rate-limits (`TodoistRateLimited`, after `read.ts` has
 * waited out what it could) ends in an `error` state that says when Todoist
 * allows the next try. When that is within `MAX_AUTO_RETRY_MS`, the
 * controller retries once at that time, at most `MAX_AUTO_RETRIES` times in
 * a row; after that, or for a longer wait, the sync stops and the view says
 * when to try again. Every wait honours `Retry-After`; none is unbounded.
 */
import { type Drive, lastSync, OtherTable, provision } from './drive.js';
import { TodoistError, TodoistRateLimited } from './read.js';
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

type Connection = { connectionId: string; platform: string };

/** What every state that shows the table carries. */
interface Listed {
  tasks: TaskRow[];
  /** The App's last complete read (`todoist-last-sync`), ISO 8601, if any. */
  lastGood?: string;
}

export interface RateLimited {
  /** When Todoist allows the next try, in milliseconds since the epoch. */
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
      /** Todoist's HTTP status, when the error was its answer. */
      status?: number;
      rateLimited?: RateLimited;
      connection?: Connection;
    } & Listed);

/** Longest `Retry-After` the controller waits for by itself. */
export const MAX_AUTO_RETRY_MS = 15 * 60_000;
/** Automatic retries in a row before the sync stops instead. */
export const MAX_AUTO_RETRIES = 3;

const PRESENCE_WORDS: Record<string, string> = {
  completed: 'completed',
  deleted: 'deleted',
  unavailable: 'unavailable',
  unconfirmed: 'unconfirmed',
};

/** "5 tasks (5 added, 0 updated, 0 unchanged); 4 active, 1 completed". */
export function describeSummary(s: SyncSummary): string {
  const counts = `${s.total} task${s.total === 1 ? '' : 's'} (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged)`;
  const presence = [`${s.presence.active} active`];

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
    ? { error: `Todoist is rate-limiting; retrying at ${time}.` }
    : {
        error: 'Todoist is rate-limiting; the sync stopped.',
        nextStep: `Try again after ${time}.`,
      };
}

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
      return 'This is another Issue table. The Todoist app imports only into its own table.';
    case 'disconnected':
      return 'Not connected. Connect Todoist to import your active tasks (read-only).';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'syncing':
      return 'Importing tasks…';
    case 'synced':
      return `Last synced ${state.at.toLocaleTimeString()}: ${describeSummary(state.summary)}`;

    case 'error': {
      if (state.rateLimited) {
        const words = rateLimitWords(state.rateLimited, options);

        return `${words.error}${words.nextStep ? ` ${words.nextStep}` : ''} Tasks imported earlier are kept.`;
      }

      return `Refresh failed: ${state.message} Tasks imported earlier are kept.`;
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
  let state: ViewState = { kind: 'loading' };
  let drive: Drive | undefined;
  let lastGood: string | undefined;
  /** The automatic retry waiting for Todoist's `Retry-After`, if any. */
  let retryHandle: unknown;
  let autoRetries = 0;
  /** After `dispose()`: no new timer, whatever a sync still in flight finds. */
  let disposed = false;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const tasks = () => ('tasks' in state ? state.tasks : []);
  const listed = (rows: TaskRow[]): Listed => ({
    tasks: rows,
    ...(lastGood ? { lastGood } : {}),
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

  /** The table's rows and the App's last complete read, as the drive has them now. */
  const reread = async (): Promise<Listed> => {
    if (!drive) return listed(tasks());
    lastGood = await lastSync(store, drive).catch(() => lastGood);

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
     * One pass. A pass the person starts ("Sync now") cancels an automatic
     * retry that is waiting and counts as a fresh start for the retry cap.
     */
    async sync(
      connection = 'connection' in state ? state.connection : undefined,
      { automatic = false } = {},
    ): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (!connection || state.kind === 'syncing') return;
      cancelRetry();
      if (!automatic) autoRetries = 0;
      const d = await ready();
      if (!d) return;
      set({ kind: 'syncing', connection, ...listed(tasks()) });

      try {
        const summary = await syncTasks(
          store,
          relayGet(proxy, connection),
          d,
          syncOptions,
        );
        autoRetries = 0;
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
          error instanceof TodoistError && error.status !== undefined
            ? { status: error.status }
            : {};

        if (error instanceof TodoistRateLimited) {
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
