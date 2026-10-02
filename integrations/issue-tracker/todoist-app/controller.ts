// @wc-ignore-file
/**
 * The view's state machine: find this app's Todoist connection, provision the
 * drive (once), import on open and on "Sync now". Nothing runs while the view
 * is closed, and nothing is written to Todoist.
 */
import { type Drive, OtherTable, provision } from './drive.js';
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

export type ViewState =
  | { kind: 'loading' }
  /** The host has no proxy client for apps (atomic-server#1657 not in this build). */
  | { kind: 'no-relay' }
  /** Added as a view of another Issue table: the app shows nothing of its own. */
  | { kind: 'other-table' }
  | { kind: 'disconnected'; tasks: TaskRow[] }
  | { kind: 'connecting'; tasks: TaskRow[] }
  | { kind: 'syncing'; connection: Connection; tasks: TaskRow[] }
  | {
      kind: 'synced';
      connection: Connection;
      at: Date;
      summary: SyncSummary;
      tasks: TaskRow[];
    }
  | {
      kind: 'error';
      message: string;
      connection?: Connection;
      tasks: TaskRow[];
    };

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

export function describe(state: ViewState): string {
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
    case 'error':
      return `Refresh failed: ${state.message} Tasks imported earlier are kept.`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  options: SyncOptions = {},
) {
  let state: ViewState = { kind: 'loading' };
  let drive: Drive | undefined;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  const tasks = () => ('tasks' in state ? state.tasks : []);

  /** Provisions once; `OtherTable` is a state, anything else an error. */
  const ready = async (): Promise<Drive | undefined> => {
    if (drive) return drive;

    try {
      drive = await provision(store);
    } catch (error) {
      if (error instanceof OtherTable) set({ kind: 'other-table' });
      else set({ kind: 'error', message: message(error), tasks: tasks() });

      return undefined;
    }

    return drive;
  };

  const listed = async (): Promise<TaskRow[]> =>
    drive ? listTasks(store, drive).catch(() => tasks()) : tasks();

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
      const rows = await listed();
      const [connection] = await proxy.connections({ platform: PLATFORM });
      if (!connection) return (set({ kind: 'disconnected', tasks: rows }), {});

      return { syncing: controller.sync(connection) };
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting', tasks: tasks() });

      try {
        // Connecting a new account sends the page away and this view reloads;
        // picking an existing connection resolves here with no reload.
        const result = await proxy.connect({ platform: PLATFORM });
        if (result.status === 'connected') await controller.sync(result);
        else set({ kind: 'disconnected', tasks: tasks() });
      } catch (error) {
        set({ kind: 'error', message: message(error), tasks: tasks() });
      }
    },

    async sync(
      connection = 'connection' in state ? state.connection : undefined,
    ): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (!connection || state.kind === 'syncing') return;
      const d = await ready();
      if (!d) return;
      set({ kind: 'syncing', connection, tasks: tasks() });

      try {
        const summary = await syncTasks(
          store,
          relayGet(proxy, connection),
          d,
          options,
        );
        set({
          kind: 'synced',
          connection,
          at: new Date(),
          summary,
          tasks: await listed(),
        });
      } catch (error) {
        set({
          kind: 'error',
          connection,
          message: message(error),
          tasks: await listed(),
        });
      }
    },
  };

  return controller;
}
