// @wc-ignore-file
import type { LookbackDays } from '../localthought.js';
import {
  fetchSetupOptions,
  type RawNamed,
  type SetupOptions,
} from './clockifyApi.js';
import { adopt } from './adopt.js';
import {
  bindTable,
  canAskRowAccess,
  ensureRowAccess,
  hasRowAccess,
  unbindTable,
} from './binding.js';
import { readSettings, type Settings } from './config.js';
import { timesheetFromRows } from './model/rows.js';
import { projectOf, timesheetFromMirror } from './model/source.js';
import { browserTimeZone } from './model/time.js';
import type { Timesheet } from './model/types.js';
import { emptyMirror, type Mirror } from './observations.js';
import { classify, type Problem } from './problem.js';
import { atomic } from './ontology.js';
import { ensureSchema, findSchema, type CompleteSchema } from './schema.js';
import type { ConnectionReference, PluginStore } from './store.js';
import {
  heldRows,
  intentConflicts,
  loadIntents,
  openIntents,
  recordIntent,
  settledUnder,
  targetLabel,
  toSupersede,
  type IntentConflict,
  type StoredIntent,
} from './intents.js';
import {
  newObservationId,
  SESSION_DEVICE,
  syncClockify,
  type Recovered,
  type SyncResult,
} from './sync.js';
import { PLATFORM, relayTransport, type ProxyTransport } from './transport.js';
import { readMirror } from './viewData.js';
import { ObservationLog } from './observationLog.js';
import {
  blockers,
  descriptionOf,
  planRange,
  snapToMinute,
  type ClockifyProject,
  type ClockifyTimeEntry,
  type RangeTarget,
  type WriteContext,
} from '../devonian/clockify/lens/index.js';
import { rawFromCanonical, timeEntries } from './clockifyObserve.js';
import type { TimeLabel, TimelineConflict } from './timeline/types.js';
import { spanText } from './timeline/render.js';
import {
  discardChange,
  entryBoundaries,
  isCreateKey,
  localValues,
  mirrorEntry,
  planAll,
  planChange,
  readRowState,
  requestDelete,
  ROW_KEPT,
  sendChanges,
  setRowValues,
  sortChanges,
  stageRangePlan,
  type EntryValues,
  type PendingChange,
  type ProviderWon,
  type SendOutcome,
} from './writeBack.js';

/**
 * Everything the view shows, as data, so it is testable without a DOM. The
 * DOM in `main.ts` only renders a `ViewState` and wires the controls.
 */
export type ViewState =
  | { kind: 'loading' }
  /**
   * Shown as the view of a table that isn't this app's own (any
   * `time-entry-v1` table, through the host's "+ Add view") and isn't
   * synced: its rows are shown, read only. "Sync this table to Clockify"
   * (#177 §6.2 item 14) is offered when the host can ask for "Allow
   * editing" and reach the proxy (`canSync`).
   */
  | {
      kind: 'local';
      tableName: string;
      canSync: boolean;
      /** Waiting for the person to answer the host's "Allow editing" bar. */
      asking?: boolean;
      /** The table has a binding but the grant no longer covers it. */
      paused?: boolean;
      /** Why the last "Sync this table" stopped. */
      reason?: string;
    }
  /** The host has no proxy relay (atomic-server#1624 not in this build). */
  | { kind: 'no-proxy' }
  | { kind: 'not-connected' }
  | { kind: 'connecting' }
  | {
      kind: 'setup';
      connection: ConnectionReference;
      /** What was stored before, if anything: preselected in the form. */
      draft: Partial<Settings>;
      options?: SetupOptions;
      busy?: 'options' | 'saving';
      error?: string;
    }
  | {
      kind: 'ready';
      connection: ConnectionReference;
      settings: Settings;
      last?: SyncOutcome;
    }
  | {
      kind: 'syncing';
      connection: ConnectionReference;
      settings: Settings;
      progress?: SyncProgressState;
    }
  /** The app itself cannot run: no table, a broken schema, a host error. */
  | { kind: 'failed'; message: string };

export type SyncOutcome =
  | { ok: true; result: SyncResult; at: number }
  | { ok: false; error: string; at: number; problem: Problem };

/** Design frame H: which page is being read, then which row is saved. */
export type SyncProgressState =
  | { phase: 'fetch'; page: number }
  | { phase: 'save'; done: number; total: number };

/** What the views were last given to show, besides the state (#89). */
interface SheetInput {
  mirror: Mirror;
  projects?: RawNamed[];
  members?: RawNamed[];
  weekStart?: string;
  /** Display names from the last sync. */
  userName?: string;
  workspaceName?: string;
  /** The Clockify profile's zone: days are grouped as Clockify does. */
  timeZone?: string;
  /** The workspace's `forceProjects` (#123 M2: read-only reasons). */
  forceProjects?: boolean;
}

/**
 * The "Changes to send" list (#123 M3, #177 §4.3): what the rows changed,
 * what a sync had to settle for Clockify, and how the last send went.
 */
export interface ChangesState {
  review: PendingChange[];
  /** Changed here and in Clockify: Clockify's value was kept. */
  providerWon: ProviderWon[];
  /** Sends a closed frame left unconfirmed, settled by the last sync. */
  recovered: Recovered[];
  outcomes?: { at: number; results: SendOutcome[] };
  sending?: { done: number; total: number };
  /** The last edit or send could not be saved or started. */
  error?: string;
}

/** What an edit in the drawer may set. */
export type EntryEdit = Partial<
  Pick<EntryValues, 'name' | 'start' | 'end' | 'billable' | 'projectId'>
>;

/**
 * A range edit (#123 M4): "worked on P" (`projectId` null: worked, no
 * project) or "did not work" over `[from, to)`. A range typed by a person
 * snaps to whole minutes (#97 answer 7); a conflict's span is `exact`.
 */
export interface RangeRequest {
  from: number;
  to: number;
  target: RangeTarget;
  exact?: boolean;
}

export interface SettingsChoice {
  workspaceId: string;
  lookbackDays: LookbackDays;
}

export interface Controller {
  state(): ViewState;
  /** Resolves once the view knows what to show; an initial sync runs on. */
  load(): Promise<{ syncing?: Promise<ViewState> }>;
  /** The App resource changed: settings may have arrived. */
  appChanged(): Promise<{ syncing?: Promise<ViewState> }>;
  connect(): Promise<ViewState>;
  openSettings(): Promise<ViewState>;
  saveSettings(choice: SettingsChoice): Promise<ViewState>;
  sync(): Promise<ViewState>;
  /** Back from the settings form to `ready`, without saving (#89 frame M). */
  cancelSettings(): ViewState;
  /** Change only the look-back window, then sync (#89 frames I and J). */
  setLookback(days: LookbackDays): Promise<ViewState>;
  /** Ask the host to connect again after a 401 (#89 frame J). */
  reconnect(): Promise<ViewState>;
  /** Whether the host can forget the connection (`store.proxy.disconnect`). */
  canDisconnect(): boolean;
  disconnect(): Promise<ViewState>;
  /** Whether the host can open links and resources (#89 frame D). */
  canOpen(): { external: boolean; resource: boolean };
  /** Asks the host to open an http(s) link; false when it cannot. */
  openExternal(url: string): Promise<boolean>;
  /** Shows the table row of a Clockify entry in the host; false if none. */
  openRow(entryId: string): Promise<boolean>;
  /** The account and workspace names the last sync read, if any. */
  names(): { userName?: string; workspaceName?: string; timeZone?: string };
  /** The timesheet the views show, or undefined before anything was read. */
  sheet(now?: number): Timesheet | undefined;
  /** The "Changes to send" list and the last send's outcome. */
  changes(): ChangesState;
  /** Why the entry cannot be edited here; empty: it can. */
  editBlockers(entryId: string): string[];
  /** Active projects to choose from, and whether one is required. */
  projectChoices(): { projects: ClockifyProject[]; required: boolean };
  /** Saves the edit to the entry's row; it is then listed to send. */
  editEntry(entryId: string, edit: EntryEdit): Promise<void>;
  /** Asks to delete the entry in Clockify (listed to send). */
  deleteEntry(entryId: string): Promise<void>;
  /** Puts the row back as Clockify has it and drops the change; a new
   * entry not yet sent is removed. */
  discard(entryId: string): Promise<void>;
  /** Plans a range edit and stages it on the rows, to send after review.
   * False when it was refused (`changes().error` says why). */
  editRange(request: RangeRequest): Promise<boolean>;
  /** Resolves a conflict (#123 §4): `target` over its exact span. */
  resolveConflict(
    conflict: TimelineConflict,
    target: RangeTarget,
  ): Promise<boolean>;
  /** Sends the listed changes that can be sent, one at a time. */
  send(): Promise<ViewState>;
  /**
   * "Sync this table to Clockify" on a table that isn't the app's own:
   * asks for "Allow editing" (with the row extras) when the grant doesn't
   * cover them, keeps a binding under the App, then goes on as on the
   * app's own table: connect, choose a workspace, sync.
   */
  syncTable(): Promise<ViewState>;
  /** The table that isn't the app's own this view syncs, if it is one;
   * `canUndo` while "Not now" can still drop its binding. */
  syncedTable(): { name: string; canUndo: boolean } | undefined;
  /** "Not now", before a workspace was chosen: back to not synced. */
  notNow(): Promise<ViewState>;
}

/** What the `local` state says, in the banner and to screen readers. */
export const LOCAL_NOTE =
  'This table isn’t synced with Clockify. Its time entries are shown here, read only.';

/** The `local` state's offer, when the host can do it (`canSync`). */
export const SYNC_NOTE =
  'Sync it to keep it and one Clockify workspace in step: Clockify’s entries are added as rows, and edits made to them here are sent after you review them. Rows already here stay here only. The app asks you to allow it to edit this table’s rows and to keep each entry’s Clockify id and sync baseline on its row; it never deletes a row.';

/** The `local` state on a table that is bound but whose grant lapsed. */
export const PAUSED_NOTE =
  'Syncing with Clockify is paused: this app may no longer edit this table’s rows, or keep its Clockify ids on them. Allow editing again to go on.';

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Why a change waits: two range edits disagree over its time (S21). */
export const HELD_BY_CONFLICT =
  'Two range edits not sent yet disagree about this time (made apart, for example on two devices). Choose one under Conflicts first.';

/**
 * `device` names this open copy of the app: in the log, in its range edits
 * and in the send lease (#123 M5). The frame has no storage, so it is new
 * on every page load.
 */
export function createController(
  store: PluginStore,
  onChange: (state: ViewState) => void = () => {},
  now: () => number = Date.now,
  device: string = SESSION_DEVICE,
): Controller {
  let current: ViewState = { kind: 'loading' };
  let running = false;
  let input: SheetInput | undefined;
  /** As the view of another table: what its rows hold (`local`). */
  let rowsSheet: Timesheet | undefined;
  /** The name of the table, when it isn't the app's own (#177 item 14). */
  let foreign: string | undefined;
  /** Whether that table's binding has no settings yet ("Not now"). */
  let fresh = false;
  /** The binding this page subscribed to, for settings saved elsewhere. */
  let watched: string | undefined;
  let changes: ChangesState = { review: [], providerWon: [], recovered: [] };
  /** Range edits (#123 M5), as last read, and the ones written here. */
  let intents: StoredIntent[] = [];
  const written = new Set<string>();
  const timeZone = browserTimeZone();

  const refreshIntents = async (schema: CompleteSchema) => {
    try {
      intents = await loadIntents(store, schema, written);
    } catch {
      // Keep what was read before: a failed read only hides conflicts
      // until the next one.
    }
  };

  /** Open range edits that disagree, from the current list (S21). */
  const disagreements = (): IntentConflict[] =>
    intentConflicts(
      openIntents(intents, new Set(changes.review.map(c => c.subject))),
    );

  const settingsOf = (state: ViewState): Settings | undefined =>
    state.kind === 'ready' || state.kind === 'syncing'
      ? state.settings
      : state.kind === 'setup'
        ? readComplete(state.draft)
        : undefined;

  /** The log is read-only here; a failure only means nothing to show yet. */
  const readInput = async () => {
    try {
      input = { ...input, mirror: await readMirror(store, now) };
    } catch {
      input ??= { mirror: emptyMirror() };
    }
  };

  const set = (next: ViewState) => {
    current = next;
    onChange(next);

    return next;
  };

  const loadOptions = async (
    connection: ConnectionReference,
    draft: Partial<Settings>,
  ) => {
    const proxy = store.proxy!;
    set({ kind: 'setup', connection, draft, busy: 'options' });

    try {
      const options = await fetchSetupOptions(
        relayTransport(proxy, connection),
      );

      return set({ kind: 'setup', connection, draft, options });
    } catch (error) {
      return set({ kind: 'setup', connection, draft, error: message(error) });
    }
  };

  /** The `local` state: the table's rows, read only, with the offer to sync. */
  const showLocal = async (
    extra: { paused?: boolean; reason?: string } = {},
  ) => {
    const data = await store.getData();
    rowsSheet = await timesheetFromRows(store, data!.table, timeZone);
    input = undefined;
    changes = { review: [], providerWon: [], recovered: [] };

    return set({
      kind: 'local',
      tableName: foreign ?? 'Time entries',
      canSync: !!store.proxy && canAskRowAccess(store),
      ...extra,
    });
  };

  /** False, after showing the paused state, when the grant lapsed. */
  const granted = async () => {
    if (!foreign) return true;
    if (await hasRowAccess(store).catch(() => false)) return true;
    await showLocal({ paused: true });

    return false;
  };

  /** Where the settings are: the App, or the table's binding. */
  const readHome = async () => {
    const schema = await findSchema(store);
    if (!schema.home) throw new Error('This table isn’t synced with Clockify.');

    return { schema, resource: await store.getResource(schema.home) };
  };

  const controller: Controller = {
    state: () => current,

    async load() {
      try {
        // First open of 0.5.0 moves the app's own table onto time-entry-v1.
        const adopted = await adopt(store);

        if (!adopted.own) {
          const data = await store.getData();
          const table = await store.getResource(data!.table);
          const name = table.get(atomic.name);
          foreign = typeof name === 'string' && name ? name : 'Time entries';
          const schema = await findSchema(store);

          // Not synced until "Sync this table" made a binding; paused when
          // the grant no longer covers the rows and the app's extras.
          if (!schema.home) return (await showLocal(), {});
          if (!(await granted())) return {};

          if (watched !== schema.home) {
            watched = schema.home;
            store.subscribe(schema.home, () => void controller.appChanged());
          }
        }
      } catch (error) {
        set({ kind: 'failed', message: message(error) });

        return {};
      }

      const proxy = store.proxy;

      if (!proxy || typeof proxy.connections !== 'function') {
        // Entries imported earlier still show, read-only (#89 frame K).
        await readInput();
        set({ kind: 'no-proxy' });

        return {};
      }

      try {
        const [connection] = await proxy.connections({ platform: PLATFORM });

        if (!connection) {
          set({ kind: 'not-connected' });

          return {};
        }

        const { schema, resource } = await readHome();
        const read = readSettings(p => resource.get(p), schema);
        fresh = !!foreign && !read.ok && !Object.keys(read.partial).length;

        if (!read.ok) {
          await loadOptions(connection, read.partial);

          return {};
        }

        await readInput();
        set({ kind: 'ready', connection, settings: read.settings });

        return { syncing: controller.sync() };
      } catch (error) {
        set({ kind: 'failed', message: message(error) });

        return {};
      }
    },

    async appChanged() {
      // Only while waiting for settings. The host reads local-first, so on
      // open the App can come from a copy older than the settings saved
      // earlier (in this or another browser); the server's copy arrives as
      // a change. In any other state a change is this app's own write or
      // not a reason to interrupt a sync.
      if (current.kind !== 'setup' || current.busy) return {};
      const { connection } = current;

      try {
        const { schema, resource } = await readHome();
        const read = readSettings(p => resource.get(p), schema);
        if (!read.ok || current.kind !== 'setup' || current.busy) return {};
        fresh = false;
        set({ kind: 'ready', connection, settings: read.settings });

        return { syncing: controller.sync() };
      } catch {
        return {};
      }
    },

    async connect() {
      if (current.kind !== 'not-connected' || !store.proxy) return current;
      set({ kind: 'connecting' });

      try {
        // Connecting a new account navigates away and reloads this view;
        // picking an existing one resolves `connected`, with no reload.
        const result = await store.proxy.connect({ platform: PLATFORM });

        if (result?.status === 'connected') {
          await controller.load();

          return current;
        }

        return set({ kind: 'not-connected' });
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }
    },

    async openSettings() {
      if (current.kind !== 'ready' && current.kind !== 'setup') return current;
      const draft = current.kind === 'ready' ? current.settings : current.draft;

      return loadOptions(current.connection, draft);
    },

    async saveSettings(choice) {
      if (current.kind !== 'setup' || !current.options) return current;
      const { connection, options } = current;
      const draft = { ...choice, userId: options.user.id };
      set({ ...current, draft, busy: 'saving' });

      try {
        if (!options.workspaces.some(w => w.id === choice.workspaceId))
          throw new Error('Choose one of the listed workspaces');
        const schema = await ensureSchema(store);
        const home = await store.getResource(schema.home);
        home.set(schema.settings.workspaceId, choice.workspaceId);
        home.set(schema.settings.userId, options.user.id);
        home.set(schema.settings.lookbackDays, choice.lookbackDays);
        await home.save();
        fresh = false;
      } catch (error) {
        return set({
          kind: 'setup',
          connection,
          draft,
          options,
          error: message(error),
        });
      }

      set({ kind: 'ready', connection, settings: draft });

      return controller.sync();
    },

    async sync() {
      if (current.kind !== 'ready' || !store.proxy || running) return current;
      // A grant taken back since the view opened: say so instead of
      // failing on the first write.
      if (!(await granted())) return current;
      running = true;
      const { connection, settings } = current;
      set({ kind: 'syncing', connection, settings });

      const progress = (next: SyncProgressState) => {
        if (current.kind === 'syncing') set({ ...current, progress: next });
      };

      // Counts list pages as the sync reads them, for the progress line.
      const relay = relayTransport(store.proxy, connection);
      const transport: ProxyTransport = {
        request(path, query, init) {
          if (path.endsWith('/time-entries') && query?.page)
            progress({ phase: 'fetch', page: Number(query.page) });

          return relay.request(path, query, init);
        },
      };

      try {
        const schema = await ensureSchema(store);
        const result = await syncClockify(
          store,
          transport,
          settings,
          schema,
          now(),
          {
            clock: now,
            device,
            onProgress: ({ done, total }) =>
              progress({ phase: 'save', done, total }),
          },
        );
        await refreshIntents(schema);
        changes = {
          review: result.review,
          providerWon: result.providerWon,
          recovered: result.recovered,
          ...(changes.outcomes ? { outcomes: changes.outcomes } : {}),
        };
        input = {
          mirror: result.mirror,
          projects: result.projects,
          members: result.members,
          ...(result.account.weekStart
            ? { weekStart: result.account.weekStart }
            : {}),
          ...(result.account.userName
            ? { userName: result.account.userName }
            : {}),
          ...(result.account.workspaceName
            ? { workspaceName: result.account.workspaceName }
            : {}),
          ...(result.account.timeZone
            ? { timeZone: result.account.timeZone }
            : {}),
          ...(result.account.forceProjects !== undefined
            ? { forceProjects: result.account.forceProjects }
            : {}),
        };

        return set({
          kind: 'ready',
          connection,
          settings,
          last: { ok: true, result, at: now() },
        });
      } catch (error) {
        return set({
          kind: 'ready',
          connection,
          settings,
          last: {
            ok: false,
            error: message(error),
            at: now(),
            problem: classify(error, now()),
          },
        });
      } finally {
        running = false;
      }
    },

    cancelSettings() {
      if (current.kind !== 'setup' || current.busy) return current;
      const settings = readComplete(current.draft);
      if (!settings) return current;

      return set({ kind: 'ready', connection: current.connection, settings });
    },

    async setLookback(days) {
      if (current.kind !== 'ready') return current;
      const { connection } = current;
      const settings = { ...current.settings, lookbackDays: days };

      try {
        const schema = await ensureSchema(store);
        const home = await store.getResource(schema.home);
        home.set(schema.settings.lookbackDays, days);
        await home.save();
      } catch (error) {
        return set({
          ...current,
          last: {
            ok: false,
            error: message(error),
            at: now(),
            problem: classify(error, now()),
          },
        });
      }

      set({ kind: 'ready', connection, settings });

      return controller.sync();
    },

    async reconnect() {
      if (current.kind !== 'ready' || !store.proxy) return current;
      const before = current;
      set({ kind: 'connecting' });

      try {
        // As connect(): a new account reloads this view; a host that can
        // hand over an existing connection resolves `connected` instead.
        const result: unknown = await store.proxy.connect({
          platform: PLATFORM,
        });

        if ((result as { status?: unknown } | null)?.status === 'connected') {
          await controller.load();

          return current;
        }

        return set(before);
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }
    },

    canDisconnect: () => typeof store.proxy?.disconnect === 'function',

    canOpen: () => ({
      external: typeof store.openExternal === 'function',
      resource: typeof store.openResource === 'function',
    }),

    async openExternal(url) {
      if (typeof store.openExternal !== 'function') return false;

      try {
        return (await store.openExternal(url)).status === 'opened';
      } catch {
        return false;
      }
    },

    async openRow(entryId) {
      if (typeof store.openResource !== 'function') return false;

      try {
        // As the view of another table, an entry's id is its row.
        if (current.kind === 'local') {
          await store.openResource(entryId);

          return true;
        }

        const schema = await findSchema(store);
        if (!schema.row.entryId) return false;
        const subject = await rowSubject(schema as CompleteSchema, entryId);
        if (!subject) return false;
        await store.openResource(subject);

        return true;
      } catch {
        return false;
      }
    },

    async disconnect() {
      const proxy = store.proxy;
      if (typeof proxy?.disconnect !== 'function') return current;
      if (current.kind !== 'ready' && current.kind !== 'setup') return current;

      try {
        await proxy.disconnect({ platform: PLATFORM });
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }

      // Imported entries and settings stay; only the connection goes.
      return set({ kind: 'not-connected' });
    },

    names: () => ({
      ...(input?.userName ? { userName: input.userName } : {}),
      ...(input?.workspaceName ? { workspaceName: input.workspaceName } : {}),
      ...(input?.timeZone ? { timeZone: input.timeZone } : {}),
    }),

    sheet(at = now()) {
      if (current.kind === 'local') return rowsSheet;
      if (!input) return undefined;
      const settings = settingsOf(current);

      return withPending(
        timesheetFromMirror({
          mirror: input.mirror,
          ...(input.projects ? { projects: input.projects } : {}),
          ...(input.members ? { members: input.members } : {}),
          ...(settings ? { settings } : {}),
          now: at,
          // Clockify's profile zone once a sync has read it; the browser's
          // until then (and without a relay).
          timeZone: input.timeZone ?? timeZone,
          ...(input.weekStart ? { weekStart: input.weekStart } : {}),
          ...(input.forceProjects !== undefined
            ? { forceProjects: input.forceProjects }
            : {}),
        }),
      );
    },

    changes() {
      const held = heldRows(disagreements());
      if (!held.size) return changes;

      return {
        ...changes,
        review: changes.review.map(c =>
          held.has(c.subject)
            ? { ...c, blockers: [...c.blockers, HELD_BY_CONFLICT] }
            : c,
        ),
      };
    },

    editBlockers(entryId) {
      if (isCreateKey(entryId))
        return [
          'It is not in Clockify yet: it is created when you send it. Discard it to undo.',
        ];
      if (!input) return ['Nothing has been read from Clockify yet.'];
      const entry = mirrorEntry(input.mirror, entryId);
      if (!entry) return ['This entry is not in what was last read.'];

      return [
        ...(current.kind === 'ready' && store.proxy
          ? []
          : ['Connect and sync first.']),
        ...blockers(entry, writeContext()),
      ];
    },

    projectChoices: () => ({
      projects: activeProjects(),
      required: input?.forceProjects === true,
    }),

    async editEntry(entryId, edit) {
      await changeRow(entryId, async (row, schema) => {
        const local = await localValues(row, schema);
        if (!local) throw new Error('The row has no start or end.');
        const projectId =
          edit.projectId === undefined ? local.projectId : edit.projectId;
        const next: EntryValues = {
          ...local,
          ...edit,
          projectId,
          project:
            projectId === local.projectId
              ? local.project
              : (projectId &&
                  (input?.projects ?? []).find(p => p.id === projectId)
                    ?.name) ||
                null,
        };
        if (await setRowValues(row, schema, next)) await row.save();
      });
    },

    async deleteEntry(entryId) {
      await changeRow(entryId, (row, schema) =>
        requestDelete(row, schema, true),
      );
    },

    async discard(entryId) {
      if (!isCreateKey(entryId)) {
        await changeRow(entryId, (row, schema) => discardChange(row, schema));

        return;
      }

      try {
        if (running) throw new Error('Wait for the sync or send to finish.');
        const change = changes.review.find(c => c.entryId === entryId);
        const schema = await ensureSchema(store);
        if (change)
          await discardChange(await store.getResource(change.subject), schema);
        changes = {
          ...changes,
          review: changes.review.filter(c => c.entryId !== entryId),
        };
        delete changes.error;
        // A row grant never deletes: the new row stays, as the person's.
        if (change && !schema.own)
          changes = { ...changes, error: `Not sent. ${ROW_KEPT}` };
      } catch (error) {
        changes = { ...changes, error: message(error) };
      }

      onChange(current);
    },

    async editRange(request) {
      try {
        if (running) throw new Error('Wait for the sync or send to finish.');
        const settings =
          current.kind === 'ready' && store.proxy
            ? current.settings
            : undefined;
        if (!settings || !input) throw new Error('Connect and sync first.');
        const from = request.exact ? request.from : snapToMinute(request.from);
        const to = request.exact ? request.to : snapToMinute(request.to);
        const sheet = controller.sheet();
        const window = sheet?.window;
        if (!sheet || !window || from < window.from || to > window.to)
          throw new Error(
            `The range has to be inside the last ${settings.lookbackDays} days, which are what is loaded.`,
          );
        if (sheet.unknown.some(u => u.from < to && u.to > from))
          throw new Error(
            'Part of this range is not loaded from Clockify. Sync, or load older entries, first.',
          );

        const entries = timeEntries(input.mirror)
          .filter(
            r =>
              !r.deletedAt &&
              !r.absentSince &&
              (r.fields.workspaceId ?? settings.workspaceId) ===
                settings.workspaceId &&
              (r.fields.userId ?? settings.userId) === settings.userId,
          )
          .map(r => rawFromCanonical(r) as ClockifyTimeEntry);
        const projects = (input.projects ?? []) as ClockifyProject[];
        const plan = planRange(
          entries,
          { from, to, target: request.target },
          {
            ...writeContext(),
            billableDefault: id =>
              projects.find(p => p.id === id)?.billable === true,
          },
        );
        if (plan.refused.length) throw new Error(plan.refused.join(' '));
        if (!plan.steps.length)
          throw new Error(
            'Nothing to change: Clockify already says this for that range.',
          );

        const schema = await ensureSchema(store);
        // Fresh: rows and range edits may have changed elsewhere since.
        await refreshIntents(schema);
        const review = await planAll(
          store,
          schema,
          input.mirror,
          writeContext(),
        );
        // Range edits not sent yet over this range are replaced (#123 S22),
        // unless one reaches outside it.
        const open = openIntents(intents, new Set(review.map(c => c.subject)));
        const { replace, outside } = toSupersede(open, { from, to });
        if (outside.length)
          throw new Error(
            `A range edit not sent yet (${outside.map(i => spanText(i, input!.timeZone ?? timeZone)).join('; ')}) reaches outside this range. Send or discard it first, or edit a range that covers all of it.`,
          );
        const replaced = new Set(replace.flatMap(i => i.rows));
        const others = review.filter(c => !replaced.has(c.subject));

        // One change per entry at a time: an entry with an unsent change,
        // or a new entry not sent yet, in the way is refused.
        const pending = new Set(
          others.filter(c => c.kind !== 'create').map(c => c.entryId),
        );
        if (
          plan.steps.some(s => s.op !== 'create' && pending.has(s.entryId)) ||
          others.some(
            c =>
              c.kind === 'create' &&
              c.desired.start < to &&
              c.desired.end > from,
          )
        )
          throw new Error(
            'An entry in this range has a change that is not sent yet. Send or discard it first.',
          );

        // Put back what the replaced edits staged, then stage this one.
        for (const change of review.filter(c => replaced.has(c.subject)))
          await discardChange(await store.getResource(change.subject), schema);
        const rows = await stageRangePlan(
          store,
          schema,
          input.mirror,
          plan.steps,
          id => rowSubject(schema, id),
        );
        const createdAt = new Date(now()).toISOString();
        const intent = {
          v: 1 as const,
          id: newObservationId(now),
          device,
          createdAt,
          from,
          to,
          target: request.target,
          rows,
          // And the settled ones it edits over, so they stay closed (#279).
          supersedes: [
            ...replace,
            ...settledUnder(intents, open, { from, to }, rows),
          ].map(i => i.id),
        };
        const subject = await recordIntent(store, schema, intent);
        written.add(subject);
        intents = [...intents, { ...intent, subject }];
        changes = {
          ...changes,
          review: await planAll(store, schema, input.mirror, writeContext()),
        };
        delete changes.error;
        onChange(current);

        return true;
      } catch (error) {
        changes = { ...changes, error: message(error) };
        onChange(current);

        return false;
      }
    },

    resolveConflict: (conflict, target) =>
      controller.editRange({
        from: conflict.from,
        to: conflict.to,
        target,
        exact: true,
      }),

    async send() {
      if (current.kind !== 'ready' || !store.proxy || running) return current;
      const sendable = controller
        .changes()
        .review.filter(c => !c.blockers.length);
      if (!sendable.length) return current;
      if (!(await granted())) return current;
      running = true;
      const { connection, settings } = current;
      changes = {
        ...changes,
        sending: { done: 0, total: sendable.length },
      };
      delete changes.outcomes;
      delete changes.error;
      onChange(current);

      try {
        const schema = await ensureSchema(store);
        const log = await ObservationLog.open(store, schema, { clock: now });
        const results = await sendChanges(
          {
            store,
            schema,
            log,
            read: {
              transport: relayTransport(store.proxy, connection),
              workspaceId: settings.workspaceId,
              userId: settings.userId,
              ...(input?.timeZone ? { timeZone: input.timeZone } : {}),
              clock: now,
              newId: () => newObservationId(now),
              device,
            },
            write: writeContext(),
            members: input?.members ?? [],
            lease: { device, clock: now },
            ...(input?.timeZone ? { timeZone: input.timeZone } : {}),
            onProgress: (done, total) => {
              changes = { ...changes, sending: { done, total } };
              onChange(current);
            },
          },
          sendable,
        );
        input = { ...(input ?? {}), mirror: log.mirror };
        const review = await planAll(store, schema, log.mirror, writeContext());
        changes = {
          review,
          providerWon: changes.providerWon,
          recovered: [],
          outcomes: { at: now(), results },
        };
      } catch (error) {
        changes = { ...changes, error: message(error) };
        delete changes.sending;
      } finally {
        running = false;
      }

      return set(current);
    },

    async syncTable() {
      if (current.kind !== 'local' || current.asking || !current.canSync)
        return current;
      const before = current;
      set({ ...before, asking: true });
      let answer: Awaited<ReturnType<typeof ensureRowAccess>>;

      try {
        answer = await ensureRowAccess(store);
      } catch (error) {
        answer = { status: 'denied', reason: message(error) };
      }

      if (answer.status !== 'granted')
        return set({
          ...before,
          reason: `Not synced: ${answer.reason.replace(/\.?$/, '.')}`,
        });

      try {
        await bindTable(store);
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }

      await controller.load();

      return current;
    },

    syncedTable: () =>
      foreign && current.kind !== 'local'
        ? { name: foreign, canUndo: fresh }
        : undefined,

    async notNow() {
      if (!foreign || !fresh || running) return current;

      try {
        await unbindTable(store);
      } catch (error) {
        return set({ kind: 'failed', message: message(error) });
      }

      fresh = false;
      await controller.load();

      return current;
    },
  };

  /** The active projects, by name, from the last sync. */
  function activeProjects(): ClockifyProject[] {
    return ((input?.projects ?? []) as ClockifyProject[])
      .filter(
        p =>
          typeof p.id === 'string' &&
          typeof p.name === 'string' &&
          p.archived !== true,
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function writeContext(): WriteContext {
    return {
      now: now(),
      ...(input?.forceProjects !== undefined
        ? { forceProjects: input.forceProjects }
        : {}),
      projects: (input?.projects ?? []) as ClockifyProject[],
    };
  }

  /** The table row carrying this entry id (a child of the app's table). */
  async function rowSubject(schema: CompleteSchema, entryId: string) {
    const own = new Set(
      await store.query({ property: atomic.parent, value: schema.table }),
    );

    return (
      await store.query({ property: schema.row.entryId, value: entryId })
    ).find(s => own.has(s));
  }

  /**
   * Changes one entry's row, then lists what it now holds to send. Edits
   * need a synced row (it has a baseline) and a quiet moment (no sync or
   * send running).
   */
  async function changeRow(
    entryId: string,
    change: (
      row: Awaited<ReturnType<PluginStore['getResource']>>,
      schema: CompleteSchema,
    ) => Promise<void>,
  ) {
    try {
      if (running) throw new Error('Wait for the sync or send to finish.');
      const schema = await ensureSchema(store);
      const subject = await rowSubject(schema, entryId);
      if (!subject) throw new Error('This entry has no row in the table.');
      const row = await store.getResource(subject);
      if (!(await readRowState(row, schema))?.baseline)
        throw new Error('Sync first: this row has not been compared yet.');
      await change(row, schema);
      const state = await readRowState(
        await store.getResource(subject),
        schema,
      );
      const planned =
        state &&
        planChange(
          state,
          input ? mirrorEntry(input.mirror, entryId) : undefined,
          writeContext(),
          input ? entryBoundaries(input.mirror) : undefined,
        );
      changes = {
        ...changes,
        review: sortChanges([
          ...changes.review.filter(c => c.entryId !== entryId),
          ...(planned ? [planned] : []),
        ]),
      };
      delete changes.error;
    } catch (error) {
      changes = { ...changes, error: message(error) };
    }

    onChange(current);
  }

  /** Range edits made apart that disagree, as the views' conflicts. */
  function localConflicts(): TimelineConflict[] {
    return disagreements().map(c => {
      // As the sweep orders them: projects by id, no project, not worked.
      const rank = (l: TimeLabel) =>
        l.kind === 'didNotWork'
          ? '2'
          : l.projectId === null
            ? '1'
            : `0${l.projectId}`;
      const labels: TimeLabel[] = [];

      for (const i of c.intents) {
        const label = targetLabel(i.target);
        if (!labels.some(l => rank(l) === rank(label))) labels.push(label);
      }

      labels.sort((x, y) => (rank(x) < rank(y) ? -1 : 1));

      return {
        entryId: '',
        fields: [],
        kind: 'local',
        from: c.from,
        to: c.to,
        entryIds: [],
        candidates: labels,
        edits: c.intents.map(i => ({
          id: i.id,
          label: targetLabel(i.target),
          here: i.device === device,
          createdAt: Date.parse(i.createdAt),
        })),
      };
    });
  }

  /** The views show a listed change as it would be, marked not sent, and
   * range edits that disagree as conflicts. */
  function withPending(base: Timesheet): Timesheet {
    const local = localConflicts();
    const sheet = local.length
      ? { ...base, conflicts: [...base.conflicts, ...local] }
      : base;
    if (!changes.review.length) return sheet;
    const byId = new Map(changes.review.map(c => [c.entryId, c]));
    const created: Timesheet['entries'] = changes.review
      .filter(c => c.kind === 'create')
      .map(({ entryId, desired }) => {
        const project = projectOf(
          desired.projectId ?? undefined,
          input?.projects ?? [],
        );

        return {
          id: entryId,
          description: descriptionOf(desired.name),
          start: desired.start,
          end: desired.end,
          billable: desired.billable,
          ...(project ? { project } : {}),
          pending: 'create' as const,
        };
      });

    return {
      ...sheet,
      entries: [...sheet.entries, ...created].map(entry => {
        if (entry.pending === 'create') return entry;
        const change = byId.get(entry.id);
        if (!change) return entry;
        if (change.kind === 'delete') return { ...entry, pending: 'delete' };
        const { desired } = change;
        const project = projectOf(
          desired.projectId ?? undefined,
          input?.projects ?? [],
        );
        const { project: _, ...rest } = entry;

        return {
          ...rest,
          description: descriptionOf(desired.name),
          start: desired.start,
          end: desired.end,
          billable: desired.billable,
          ...(project ? { project } : {}),
          pending: 'update',
        };
      }),
    };
  }

  return controller;
}

function readComplete(draft: Partial<Settings>): Settings | undefined {
  const { workspaceId, userId, lookbackDays } = draft;

  return workspaceId && userId && lookbackDays
    ? { workspaceId, userId, lookbackDays }
    : undefined;
}

/** `90 min`, `6 h`, `1.5 h`: how much of the window no complete read covers. */
const hours = (ms: number) => {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} min`;

  return `${Math.round(minutes / 6) / 10} h`;
};

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'local':
      if (state.asking)
        return `${LOCAL_NOTE} Waiting for you to allow editing…`;
      if (state.paused) return `${LOCAL_NOTE} ${PAUSED_NOTE}`;
      if (state.reason) return `${LOCAL_NOTE} ${state.reason}`;

      return state.canSync ? `${LOCAL_NOTE} ${SYNC_NOTE}` : LOCAL_NOTE;
    case 'no-proxy':
      return 'This host cannot reach the integration proxy on behalf of an app, so this app cannot import. Nothing was fetched.';
    case 'not-connected':
      return 'Not connected. Connect a Clockify account to import your completed time entries. Nothing is written to Clockify until you send a change.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'failed':
      return `This app cannot run: ${state.message}`;

    case 'setup':
      if (state.busy === 'options')
        return 'Connected. Reading your Clockify workspaces…';
      if (state.busy === 'saving') return 'Saving settings…';
      if (state.error) return `Setup failed: ${state.error}`;

      return 'Connected. Choose the workspace and how far back to import.';

    case 'syncing':
      return `Importing the last ${state.settings.lookbackDays} days…`;

    case 'ready': {
      if (!state.last)
        return `Ready to import the last ${state.settings.lookbackDays} days of Clockify entries.`;
      if (!state.last.ok)
        return `Import failed: ${state.last.error}. Rows already in the table are kept.`;
      const { created, updated, unchanged, removed, warnings, log } =
        state.last.result;

      return (
        `Last synced ${new Date(state.last.at).toLocaleTimeString()}: ` +
        `${created} created, ${updated} updated, ${unchanged} unchanged, ` +
        `last ${state.settings.lookbackDays} days.` +
        (removed ? ` ${removed} removed (deleted in Clockify).` : '') +
        (state.last.result.kept
          ? ` ${state.last.result.kept} deleted in Clockify: kept in this table as rows of their own, no longer synced (the app may not delete its rows). Delete them there.`
          : '') +
        (log.candidates
          ? ` ${log.candidates} missing from Clockify's list, re-checked on the next sync.`
          : '') +
        (log.unknownMs ? ` ${hours(log.unknownMs)} not loaded.` : '') +
        (state.last.result.account.forceProjects
          ? ' This workspace requires a project on every entry.'
          : '') +
        (state.last.result.sendingElsewhereUntil
          ? ' Another open copy of this app is sending changes to Clockify.'
          : '') +
        (warnings.length ? ` Warnings: ${warnings.join('; ')}` : '')
      );
    }
  }
}
