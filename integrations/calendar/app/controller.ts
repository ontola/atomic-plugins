// @wc-ignore-file
/**
 * The Calendar app's state machine. Everything the views draw comes from
 * `controller.snapshot()`; everything they do goes through a method here.
 * `describe()`, `classify()`, `banner()` and `pill()` are pure, so the copy
 * for every state is unit-tested without a DOM (design #89, §3 and §5.12).
 *
 * Reads run on open and on "Sync now". Writes to Google happen only from
 * `send()`, which the Review sheet calls; local edits, discards and conflict
 * choices only change rows, and the next preview lists them for review.
 */
import type { Projection } from '../adapter.js';
import { adopt } from './adopt.js';
import type { CalEvent } from './events.js';
import { listCalendars, PLATFORM, type CalendarEntry } from './relay.js';
import type { ConnectionReference, PluginStore } from './store.js';
import {
  bindingOf,
  bindTable,
  chooseCalendar,
  chosenCalendar,
  DEFAULT_COLOR,
  discard,
  ensureRowAccess,
  hasRowAccess,
  keepAsLocal,
  layout,
  readEvents,
  refresh,
  removeLocal,
  resolveConflict,
  saveLocal,
  saveMeta,
  send,
  tableName,
  tableOf,
  unbindTable,
  type CalendarMeta,
  type Choice,
  type Conflict,
  type ImportSummary,
  type Outcome,
  type PendingEdit,
} from './sync.js';
import { errorStack, report } from './report.js';

/** What went wrong, in the terms the banners use (DESIGN.md §5.12). */
export interface Problem {
  kind:
    | 'reauth'
    | 'forbidden'
    | 'not-found'
    | 'rate-limited'
    | 'network'
    | 'too-many-events'
    | 'uncertain'
    /** The integration proxy itself refused, before Google was asked. */
    | 'refused'
    | 'other';
  /** The raw message, shown under "Details". */
  message: string;
  status?: number;
  /** Seconds, from `retry-after`. */
  retryAfter?: number;
}

export type ViewState =
  | { kind: 'loading' }
  /**
   * Shown as the view of a table that isn't this app's own (any `event-v1`
   * table, through the host's "+ Add view") and isn't synced: its events are
   * drawn, read only. "Sync this table to Google Calendar" (#177 §6.2 item
   * 14) is offered when the host can ask for "Allow editing" and reach the
   * proxy (`canSync`).
   */
  | {
      kind: 'local';
      canSync: boolean;
      /** Waiting for the person to answer the host's "Allow editing" bar. */
      asking?: boolean;
      /** Why the last "Sync this table" stopped, or why syncing is paused. */
      reason?: string;
    }
  /** The host has no proxy relay (atomic-server#1657 not in this build). */
  | { kind: 'no-relay' }
  | { kind: 'disconnected' }
  | { kind: 'connecting' }
  | { kind: 'choosing'; calendars: CalendarEntry[] }
  | {
      kind: 'refreshing';
      /** List pages of events read so far in this scan. */
      pages?: number;
      /** The previous result, still valid while this one runs. */
      summary?: ImportSummary;
    }
  | { kind: 'ready'; at: Date; summary: ImportSummary; outcomes: Outcome[] }
  | {
      kind: 'sending';
      summary: ImportSummary;
      /** Per reviewed edit: undefined not started, 'sending', or its outcome. */
      progress: Array<'sending' | Outcome | undefined>;
    }
  | {
      kind: 'error';
      message: string;
      /** The relay has no usable connection left: offer Connect. */
      reconnect: boolean;
      problem: Problem;
      /** When it failed, for the sync-status card's "Sync failed 4 min ago". */
      failedAt: Date;
      /**
       * What failed: a read (listing calendars, a refresh, the setup writes
       * around them), or the send of reviewed edits. The card shows a failed
       * read as the last sync, and a failed send as a problem over the last
       * good sync.
       */
      phase: 'read' | 'send';
      outcomes?: Outcome[];
      /** The last good result; its rows stay on screen under the banner. */
      summary?: ImportSummary;
      at?: Date;
    };

/** What the `local` state says, in the banner and to screen readers. */
export const LOCAL_NOTE =
  'This table isn’t synced with Google Calendar. Its events are shown here, read only.';

/** The `local` state's offer, when the host can do it (`canSync`). */
export const SYNC_NOTE =
  'Sync it to keep it and one Google calendar in step: Google’s events are added as rows, and edits made here are sent after you review them. Rows already here stay here only. The app asks you to allow it to edit this table’s rows and to keep each event’s Google id, ETag and sync baseline on its row.';

/** The `local` state on a table that is bound but whose grant was taken back. */
export const PAUSED_NOTE =
  'Syncing with Google Calendar is paused: this app may no longer edit this table’s rows, or keep its Google ids on them. Allow editing again to go on.';

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function describe(state: ViewState): string {
  switch (state.kind) {
    case 'loading':
      return 'Loading…';
    case 'local':
      return state.reason
        ? `${LOCAL_NOTE} ${state.reason}`
        : state.canSync
          ? `${LOCAL_NOTE} ${SYNC_NOTE}`
          : LOCAL_NOTE;
    case 'no-relay':
      return 'This host cannot reach the integration proxy for apps yet, so nothing was fetched.';
    case 'disconnected':
      return 'Not connected. Connect Google Calendar to import one calendar.';
    case 'connecting':
      return 'Waiting for you to confirm the connection…';
    case 'choosing':
      return 'Choose the calendar to import. Recurring events aren’t imported yet.';
    case 'refreshing':
      return state.pages
        ? `Reading your calendar… (page ${state.pages})`
        : 'Reading your calendar…';
    case 'sending':
      return `Sending ${plural(state.summary.review.length, 'change')} to Google…`;

    case 'ready': {
      const s = state.summary;
      const parts = [
        `Last refreshed ${state.at.toLocaleTimeString()}: ${plural(s.total, 'event')} (${s.added} added, ${s.updated} updated, ${s.unchanged} unchanged).`,
        `Not imported: ${s.skipped.recurring} recurring, ${s.skipped.cancelled} cancelled${s.skipped.unreadable ? `, ${s.skipped.unreadable} unreadable` : ''}.`,
      ];
      if (s.conflicts.length)
        parts.push(`${plural(s.conflicts.length, 'conflict')} left as is.`);
      if (s.review.length)
        parts.push(`${plural(s.review.length, 'change')} to review.`);
      if (s.invalid.length)
        parts.push(
          `${plural(s.invalid.length, 'row')} can’t be sent as edited.`,
        );
      if (s.localOnly)
        parts.push(
          `${plural(s.localOnly, 'row')} made here won’t be sent: creating events isn’t supported.`,
        );
      if (s.unmapped.length)
        parts.push(
          `${plural(s.unmapped.length, 'column')} the app doesn’t send (${s.unmapped.map(u => u.column).join(', ')}) ${s.unmapped.length === 1 ? 'is' : 'are'} kept here only.`,
        );

      return parts.join(' ');
    }

    case 'error':
      return `Failed: ${state.message}`;
  }
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Relay refusals that mean "this connection is spent", not "Google said no".
 * An error carrying a provider status is Google's answer (the adapter's own
 * message also says "reconnect"), never a spent connection.
 */
const spent = (error: unknown) =>
  typeof (error as { status?: unknown } | undefined)?.status !== 'number' &&
  /connect again|reconnect/i.test(message(error));

/** Maps a failed read or write to a banner kind (DESIGN.md §5.12). */
export function classify(error: unknown): Problem {
  const text = message(error);
  const e = (error ?? {}) as {
    status?: unknown;
    retryAfter?: unknown;
    reconnect?: unknown;
  };
  const status =
    typeof e.status === 'number'
      ? e.status
      : Number(/returned (\d{3})\b/.exec(text)?.[1]) || undefined;
  const base = { message: text, ...(status ? { status } : {}) };
  if (/may or may not have applied/.test(text))
    return { kind: 'uncertain', ...base };
  if (
    e.reconnect === true ||
    spent(error) ||
    status === 401 ||
    // Proxy refusals relay.ts reports without "Connect again": a capability
    // that ran out even after the frame's own retry, or a retired scheme.
    /refused the request \((capability_expired|unsupported_authorization)\b/.test(
      text,
    )
  )
    return { kind: 'reauth', ...base };
  if (/The integration proxy refused/.test(text))
    return { kind: 'refused', ...base };
  if (status === 403) return { kind: 'forbidden', ...base };
  if (status === 404 || status === 410) return { kind: 'not-found', ...base };

  if (status === 429) {
    const seconds = Number(e.retryAfter);

    return {
      kind: 'rate-limited',
      ...base,
      ...(Number.isFinite(seconds) && seconds > 0
        ? { retryAfter: Math.ceil(seconds) }
        : {}),
    };
  }

  if (/at most [\d,]+ events per scan/.test(text))
    return { kind: 'too-many-events', ...base };
  if (
    (status && status >= 500) ||
    /fetch|network|timed? ?out|did not answer/i.test(text)
  )
    return { kind: 'network', ...base };

  return { kind: 'other', ...base };
}

export interface BannerCopy {
  tone: 'neg' | 'warn' | 'info';
  /** `alert` only when the person must act (401/403), otherwise `status`. */
  role: 'alert' | 'status';
  title: string;
  body: string;
  action?: { label: string; does: 'reconnect' | 'retry' };
}

const UNCHANGED = 'Nothing here was changed.';

/** The banner for a problem, in the design's copy. */
export function banner(
  problem: Problem,
  calendar = 'this calendar',
  secondsLeft = problem.retryAfter,
): BannerCopy {
  switch (problem.kind) {
    case 'reauth':
      return {
        tone: 'neg',
        role: 'alert',
        title: 'Google access has expired.',
        body: UNCHANGED,
        action: { label: 'Reconnect', does: 'reconnect' },
      };
    case 'forbidden':
      return {
        tone: 'neg',
        role: 'alert',
        title: `Google refused access to ${calendar}.`,
        body: `You may have lost access to this calendar. ${UNCHANGED}`,
        action: { label: 'Retry', does: 'retry' },
      };
    case 'not-found':
      return {
        tone: 'neg',
        role: 'status',
        title: `Calendar ${calendar} no longer exists or isn’t shared with you.`,
        body: UNCHANGED,
        action: { label: 'Retry', does: 'retry' },
      };
    case 'rate-limited':
      return {
        tone: 'warn',
        role: 'status',
        title: secondsLeft
          ? `Google is limiting requests. Retrying in ${secondsLeft} s.`
          : 'Google is limiting requests.',
        body: UNCHANGED,
        action: { label: 'Retry now', does: 'retry' },
      };
    case 'network':
      return {
        tone: 'info',
        role: 'status',
        title: 'Couldn’t reach Google.',
        body: UNCHANGED,
        action: { label: 'Retry', does: 'retry' },
      };
    case 'too-many-events':
      return {
        tone: 'warn',
        role: 'status',
        title: `${calendar} has more than 25,000 events, so the import stopped.`,
        body: UNCHANGED,
      };
    case 'uncertain':
      return {
        tone: 'warn',
        role: 'alert',
        title: 'Google may or may not have applied the last change.',
        body: 'The rest were not sent. Sync to see what Google has now.',
        action: { label: 'Sync now', does: 'retry' },
      };
    case 'refused':
      return {
        tone: 'neg',
        role: 'alert',
        title: 'The integration proxy refused this request.',
        body: `Google was not asked. ${UNCHANGED}`,
        action: { label: 'Retry', does: 'retry' },
      };
    case 'other':
      return {
        tone: 'neg',
        role: 'status',
        title: 'Something went wrong while syncing.',
        body: UNCHANGED,
        action: { label: 'Retry', does: 'retry' },
      };
  }
}

export interface Snapshot {
  state: ViewState;
  /** The imported calendar, once chosen. */
  meta?: CalendarMeta;
  events: CalEvent[];
  /** The last complete preview, even while a new one runs or after an error. */
  summary?: ImportSummary;
  at?: Date;
  /** Rows edited here and not sent, known without a preview. */
  pending: number;
  /** Local changes since the last preview: Review needs a fresh one first. */
  stale: boolean;
  /** Host operations this host has (pin 007869464 and later). */
  can: { openExternal: boolean; openResource: boolean; disconnect: boolean };
  /**
   * Whether the table is the app's own. On another table it syncs through a
   * row grant, which never deletes a row, so "Remove local copy" isn't
   * offered there.
   */
  own: boolean;
  /** The name of a table that isn't the app's own, for the setup copy. */
  table?: string;
}

export interface Pill {
  text: string;
  tone: 'muted' | 'accent' | 'warn' | 'neg';
  busy?: boolean;
  /** What pressing it opens. */
  opens?: 'review' | 'conflicts' | 'details';
}

const clock = (at: Date) =>
  at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "4 min ago", "just now", or "at 14:16" for anything older than an hour. */
export function syncedAgo(at: Date, now = new Date()): string {
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  return `at ${clock(at)}`;
}

/** How many changes the header's primary action offers to review. */
export function reviewCount(snapshot: Snapshot): number {
  const planned = snapshot.stale ? 0 : (snapshot.summary?.review.length ?? 0);

  return Math.max(planned, snapshot.pending);
}

/** The status pill (DESIGN.md §3): text always accompanies colour. */
export function pill(snapshot: Snapshot, now = new Date()): Pill {
  const { state, summary, at } = snapshot;
  if (state.kind === 'local')
    return state.asking
      ? { text: 'Waiting for you…', tone: 'accent', busy: true }
      : { text: 'Not synced', tone: 'muted' };
  if (state.kind === 'refreshing' || state.kind === 'loading')
    return { text: 'Syncing…', tone: 'accent', busy: true };
  if (state.kind === 'sending')
    return { text: 'Sending…', tone: 'accent', busy: true };

  if (state.kind === 'error')
    return state.problem.kind === 'reauth' || state.reconnect
      ? { text: 'Reconnect needed', tone: 'neg', opens: 'details' }
      : { text: 'Error', tone: 'neg', opens: 'details' };

  const conflicts = summary?.conflicts.length ?? 0;
  if (conflicts)
    return {
      text: plural(conflicts, 'conflict'),
      tone: 'warn',
      opens: 'conflicts',
    };
  const review = reviewCount(snapshot);
  if (review)
    return { text: `${review} to review`, tone: 'accent', opens: 'review' };

  return {
    text: at ? `Synced ${syncedAgo(at, now)}` : 'Not synced yet',
    tone: 'muted',
  };
}

export function createController(
  store: PluginStore,
  render: (state: ViewState) => void,
  options: { maxPages?: number } = {},
) {
  let state: ViewState = { kind: 'loading' };
  /** Newest last; a spent one is dropped and the next one tried. */
  let connections: ConnectionReference[] = [];
  let calendarId: string | undefined;
  let meta: CalendarMeta | undefined;
  let events: CalEvent[] = [];
  let last: { summary: ImportSummary; at: Date } | undefined;
  let stale = false;
  /** Whether the table is the app's own; decided on load. */
  let own = true;
  /** The name of a table that isn't the app's own. */
  let foreign: string | undefined;

  const set = (next: ViewState) => {
    state = next;
    render(state);
  };

  /** Re-renders the same state, after rows or the last summary changed. */
  const touch = () => render(state);

  /** Runs `op` with a usable connection, falling back past spent ones. */
  async function withConnection<T>(
    op: (connectionId: string) => Promise<T>,
  ): Promise<T> {
    for (;;) {
      const connection = connections.at(-1);
      if (!connection)
        throw Object.assign(new Error('Reconnect Google Calendar.'), {
          reconnect: true,
        });

      try {
        return await op(connection.connectionId);
      } catch (error) {
        if (!spent(error)) throw error;
        connections = connections.slice(0, -1);
      }
    }
  }

  const fail = (
    error: unknown,
    outcomes?: Outcome[],
    phase: 'read' | 'send' = 'read',
  ) => {
    const problem = classify(error);
    report('error', message(error), {
      problem: problem.kind,
      ...(problem.status ? { status: problem.status } : {}),
      stack: errorStack(error),
    });
    set({
      kind: 'error',
      message: message(error),
      reconnect:
        connections.length === 0 ||
        (error as { reconnect?: boolean }).reconnect === true ||
        spent(error),
      problem,
      failedAt: new Date(),
      phase,
      ...(outcomes ? { outcomes } : {}),
      ...(last ? { summary: last.summary, at: last.at } : {}),
    });
  };

  const reload = async () => {
    if (!meta) return;
    events = await readEvents(store, meta, last?.summary.conflicts ?? []);
  };

  /** The `local` state: the table's events, read only, with the offer to sync. */
  const showLocal = async (reason?: string) => {
    meta = {
      summary: foreign ?? (await tableName(store)),
      color: DEFAULT_COLOR,
      accessRole: 'reader',
    };
    last = undefined;
    events = [];
    // A `reader` role: every event is read only until the table is synced.
    await reload();
    set({
      kind: 'local',
      canSync:
        !!store.proxy &&
        typeof store.requestRowAccess === 'function' &&
        typeof store.rowAccess === 'function',
      ...(reason ? { reason } : {}),
    });
  };

  /** Adds the calendar's name, colour and account when an older install lacks them. */
  const backfillMeta = async (proxy: NonNullable<PluginStore['proxy']>) => {
    try {
      const calendars = await withConnection(id => listCalendars(proxy, id));
      const calendar = calendars.find(c => c.id === calendarId);
      if (!calendar) return;
      const account = calendars.find(c => c.primary)?.id;
      meta = {
        summary: calendar.summary,
        color: calendar.backgroundColor ?? DEFAULT_COLOR,
        accessRole: calendar.accessRole,
        ...(account ? { account } : {}),
      };
      await saveMeta(store, meta);
      await reload();
      touch();
    } catch {
      // Display only: the fallback name and colour stay.
    }
  };

  /** Drops a handled conflict from the last preview. */
  const settle = async (conflict: Conflict) => {
    stale = true;

    if (last) {
      const summary = {
        ...last.summary,
        conflicts: last.summary.conflicts.filter(c => c !== conflict),
      };
      last = { ...last, summary };
      if (state.kind === 'ready' || state.kind === 'error')
        state = { ...state, summary };
    }

    await reload();
    touch();
  };

  const controller = {
    state: () => state,

    snapshot(): Snapshot {
      return {
        state,
        ...(meta ? { meta } : {}),
        events,
        ...(last ? { summary: last.summary, at: last.at } : {}),
        pending: events.filter(e => e.pending).length,
        stale,
        can: {
          openExternal: typeof store.openExternal === 'function',
          openResource: typeof store.openResource === 'function',
          disconnect: typeof store.proxy?.disconnect === 'function',
        },
        own,
        ...(foreign ? { table: foreign } : {}),
      };
    },

    /**
     * Finds this app's connection and calendar, and starts one refresh when
     * both are known. Resolves once that is decided, not when the refresh
     * ends, so the host sees the view as rendered straight away.
     */
    async load(): Promise<{ refreshing?: Promise<void> }> {
      // First open of 0.2.0 moves the app's own table onto event-v1.
      const adopted = await adopt(store);
      own = adopted.own;

      if (!own) {
        foreign = await tableName(store);
        // Not synced until "Sync this table" made a binding; paused when the
        // grant no longer covers the rows and the app's row extras.
        const bound = !!(await bindingOf(store, await layout(store)));
        if (!bound) return (await showLocal(), {});
        if (!(await hasRowAccess(store)))
          return (await showLocal(PAUSED_NOTE), {});
      }

      const proxy = store.proxy;
      if (!proxy) return (set({ kind: 'no-relay' }), {});
      connections = await proxy.connections({ platform: PLATFORM });
      if (!connections.length) return (set({ kind: 'disconnected' }), {});
      const chosen = await chosenCalendar(store);

      if (!chosen) {
        await controller.listCalendars();

        return {};
      }

      calendarId = chosen.id;
      meta = chosen.meta ?? {
        summary: 'Google Calendar',
        color: DEFAULT_COLOR,
        accessRole: 'owner',
      };
      await reload();
      const refreshing = controller.refresh();

      return {
        refreshing: chosen.meta
          ? refreshing
          : refreshing.then(() => backfillMeta(proxy)),
      };
    },

    /**
     * "Sync this table to Google Calendar", on a table that isn't the app's
     * own: asks for "Allow editing" (with the row extras) when the grant
     * doesn't cover them, keeps the choice as a binding under the App, then
     * goes on as on the app's own table: connect, choose a calendar, import.
     * Nothing is written to the table or its rows before the person allowed
     * it, and nothing reaches Google before they choose a calendar.
     */
    async syncTable(): Promise<void> {
      if (state.kind !== 'local' || state.asking || !state.canSync) return;
      set({ ...state, asking: true });
      let answer: Awaited<ReturnType<typeof ensureRowAccess>>;

      try {
        answer = await ensureRowAccess(store);
      } catch (error) {
        answer = { status: 'denied', reason: message(error) };
      }

      if (answer.status !== 'granted')
        return set({
          kind: 'local',
          canSync: true,
          reason: `Not synced: ${answer.reason.replace(/\.?$/, '.')}`,
        });

      try {
        await bindTable(store);
      } catch (error) {
        return fail(error);
      }

      await controller.load();
    },

    /**
     * "Not now" on a table that isn't the app's own, before a calendar was
     * chosen: back to not synced. The grant stays; the host's tab menu
     * takes it back.
     */
    async notNow(): Promise<void> {
      if (own) return;
      await unbindTable(store);
      await controller.load();
    },

    async listCalendars(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'refreshing' });

      try {
        const calendars = await withConnection(id => listCalendars(proxy, id));
        set({ kind: 'choosing', calendars });
      } catch (error) {
        fail(error);
      }
    },

    async choose(id: string): Promise<void> {
      if (state.kind !== 'choosing') return;
      const calendar = state.calendars.find(c => c.id === id);
      if (!calendar) return;
      const account = state.calendars.find(c => c.primary)?.id;

      try {
        meta = await chooseCalendar(store, calendar, account);
        calendarId = calendar.id;
      } catch (error) {
        return fail(error);
      }

      await controller.refresh();
    },

    async connect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      set({ kind: 'connecting' });

      try {
        // Connecting a new account navigates away and reloads this view;
        // picking an existing one resolves `connected`, with no reload.
        const result = await proxy.connect({ platform: PLATFORM });
        if (result?.status === 'connected') await controller.load();
        else set({ kind: 'disconnected' });
      } catch (error) {
        fail(error);
      }
    },

    /** The frame can't dismiss the host's bar; this only stops waiting for it. */
    cancelConnect(): void {
      if (state.kind === 'connecting') set({ kind: 'disconnected' });
    },

    async refresh(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy) return set({ kind: 'no-relay' });
      if (
        state.kind === 'refreshing' ||
        state.kind === 'sending' ||
        state.kind === 'local'
      )
        return;
      // A grant taken back since the view opened: say so instead of failing
      // on the first write.
      if (!own && !(await hasRowAccess(store)))
        return void (await showLocal(PAUSED_NOTE));
      if (!calendarId) return controller.listCalendars();
      set({ kind: 'refreshing', ...(last ? { summary: last.summary } : {}) });

      try {
        const summary = await withConnection(id =>
          refresh(store, proxy, id, {
            ...options,
            onPage: pages => {
              if (state.kind === 'refreshing') set({ ...state, pages });
            },
          }),
        );
        stale = false;
        last = { summary, at: new Date() };
        report(summary.unreadable.length ? 'warn' : 'info', 'Sync finished', {
          total: summary.total,
          added: summary.added,
          updated: summary.updated,
          unchanged: summary.unchanged,
          skipped: summary.skipped,
          conflicts: summary.conflicts.length,
          review: summary.review.length,
          unreadable: summary.unreadable.map(({ id, reason }) => ({
            id,
            reason,
          })),
        });
        await reload();
        set({ kind: 'ready', at: last.at, summary, outcomes: [] });
      } catch (error) {
        await reload().catch(() => {});
        fail(error);
      }
    },

    /** Makes sure the review list reflects the rows, previewing again if needed. */
    async prepareReview(): Promise<void> {
      if (stale || !last || state.kind === 'error') await controller.refresh();
    },

    /** Sends the reviewed edits of the current preview; nothing else. */
    async send(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy || state.kind !== 'ready' || !state.summary.review.length)
        return;
      const { summary, at } = state;
      const progress: Array<'sending' | Outcome | undefined> =
        summary.review.map(() => undefined);
      set({ kind: 'sending', summary, progress: [...progress] });
      let outcomes: Outcome[];

      try {
        outcomes = await withConnection(id =>
          send(
            store,
            proxy,
            id,
            summary.calendarId,
            summary.review,
            (index, outcome) => {
              progress[index] = outcome ?? 'sending';
              if (state.kind === 'sending')
                set({ ...state, progress: [...progress] });
            },
          ),
        );
      } catch (error) {
        await reload().catch(() => {});

        return fail(error, undefined, 'send');
      }

      // The reviewed plan is used up either way: whatever was not sent is
      // reviewed again from a fresh preview.
      last = { at, summary: { ...summary, review: [] } };
      await reload();
      const uncertain = outcomes.find(o => o.status === 'uncertain');
      if (uncertain && uncertain.status === 'uncertain')
        return fail(new Error(uncertain.message), outcomes, 'send');
      set({ kind: 'ready', at, summary: last.summary, outcomes });
    },

    /** A local edit from the drawer. Nothing is sent. */
    async saveEvent(subject: string, value: Projection): Promise<void> {
      await saveLocal(store, subject, value);
      stale = true;
      await reload();
      touch();
    },

    /** Review sheet "Discard": the row takes Google's value again. */
    async discard(pending: PendingEdit): Promise<void> {
      await discard(store, pending);

      if (last) {
        const summary = {
          ...last.summary,
          review: last.summary.review.filter(p => p !== pending),
        };
        last = { ...last, summary };
        if (state.kind === 'ready') state = { ...state, summary };
      }

      await reload();
      touch();
    },

    /** "Open in Google Calendar": the host asks, then opens it in a new tab. */
    async openLink(
      event: CalEvent,
    ): Promise<'opened' | 'cancelled' | 'unavailable'> {
      if (!event.link || !store.openExternal) return 'unavailable';

      return (await store.openExternal(event.link)).status;
    },

    /**
     * Shows this app's table in the host (Month, DESIGN.md §11 decision 1:
     * the host table's own Calendar view draws the month), or one row of it.
     */
    async openInHost(subject?: string): Promise<boolean> {
      if (!store.openResource) return false;
      await store.openResource(subject ?? (await tableOf(store)));

      return true;
    },

    /**
     * Stops this app using Google Calendar: only this app's delegation is
     * taken off; the connection stays for other apps, and the rows stay.
     */
    async disconnect(): Promise<void> {
      const proxy = store.proxy;
      if (!proxy?.disconnect) return;

      try {
        await proxy.disconnect({ platform: PLATFORM });
      } catch (error) {
        return fail(error);
      }

      connections = [];
      set({ kind: 'disconnected' });
    },

    async resolve(
      conflict: Conflict,
      choices: Partial<Record<keyof Projection, Choice>>,
    ): Promise<void> {
      await resolveConflict(store, conflict, choices);
      await settle(conflict);
    },

    async keepAsLocal(conflict: Conflict): Promise<void> {
      if (!conflict.subject) return;
      await keepAsLocal(store, conflict.subject);
      await settle(conflict);
    },

    async removeLocal(conflict: Conflict): Promise<void> {
      if (!conflict.subject || !own) return;
      await removeLocal(store, conflict.subject);
      await settle(conflict);
    },
  };

  return controller;
}

export type Controller = ReturnType<typeof createController>;
