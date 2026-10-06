// @wc-ignore-file
/**
 * `status.ts`: the controller's snapshot mapped onto the shared sync-status
 * card's model (Q-084), for every `ViewState`, without a DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIMARY, TEAM } from '../../fixtures/google-calendar/scenario.mjs';
import { statusLines } from '../../../sync-status/card.js';
import {
  createController,
  PAUSED_NOTE,
  type Snapshot,
  type ViewState,
} from '../controller.js';
import type { CalEvent } from '../events.js';
import { fakeStore, field, OTHER_TABLE, TABLE } from '../fakeStore.js';
import { EVENT, SHARED } from '../fields.js';
import {
  IS_A,
  NAME,
  PARENT,
  type ImportSummary,
  type Outcome,
  type PendingEdit,
} from '../sync.js';
import {
  NEXT_STEP,
  PAUSED_SHORT,
  READ_ONLY_CALENDAR_NOTE,
  syncStatusFor,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const AT = new Date(NOW - 4 * MINUTE);
const META = {
  summary: 'Synthetic calendar',
  color: '#4986e7',
  accessRole: 'owner',
};
const CAN = { openExternal: true, openResource: true, disconnect: true };

// The controller stamps `new Date()` on a read and a failure; pin the clock
// (Date only) so "ago" is judged against the same NOW the mapping gets.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const summary = (over: Partial<ImportSummary> = {}): ImportSummary => ({
  calendarId: 'primary',
  total: 3,
  added: 1,
  updated: 1,
  unchanged: 1,
  skipped: { recurring: 0, cancelled: 0, unreadable: 0 },
  unreadable: [],
  conflicts: [],
  localOnly: 0,
  invalid: [],
  unmapped: [],
  review: [],
  ...over,
});

const event = (over: Partial<CalEvent> & { subject: string }): CalEvent => ({
  title: over.subject,
  description: '',
  location: '',
  start: '2026-10-06',
  end: '2026-10-07',
  allDay: true,
  pending: false,
  conflict: false,
  readOnly: false,
  calendar: { name: META.summary, color: META.color },
  day: '2026-10-06',
  endDay: undefined,
  ...over,
});

const pendingEdit = (title: string) => ({ title }) as PendingEdit;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    state: { kind: 'ready', at: AT, summary: summary(), outcomes: [] },
    calendarId: PRIMARY,
    meta: META,
    events: [],
    summary: summary(),
    at: AT,
    pending: 0,
    stale: false,
    can: CAN,
    own: true,
    ...over,
  };
}

const error = (
  kind: 'network' | 'reauth' | 'uncertain' | 'rate-limited',
  over: Partial<Extract<ViewState, { kind: 'error' }>> = {},
): ViewState => ({
  kind: 'error',
  message: 'x',
  reconnect: kind === 'reauth',
  problem: {
    kind,
    message: 'x',
    ...(kind === 'rate-limited' ? { retryAfter: 7 } : {}),
  },
  failedAt: new Date(NOW - MINUTE),
  phase: 'read',
  ...over,
});

const lines = (s: Snapshot, extra = {}) =>
  statusLines(syncStatusFor({ snapshot: s, ...extra }), NOW);

describe('syncStatusFor: the states before a sync', () => {
  it('loading: busy, nothing known yet', () => {
    const status = syncStatusFor({
      snapshot: snap({
        state: { kind: 'loading' },
        calendarId: undefined,
        summary: undefined,
        at: undefined,
        meta: undefined,
      }),
    });
    expect(status.busy).toBe('Loading…');
    expect(status.last).toBeUndefined();
    expect(status.writes).toBeUndefined();
    expect(status.rows).toBeUndefined();
  });

  it('a table that isn’t synced: read-only, its rows, not synced yet, no write queue', () => {
    const s = snap({
      state: { kind: 'local', canSync: true },
      calendarId: undefined,
      meta: { summary: 'Team events', color: '#4986e7', accessRole: 'reader' },
      summary: undefined,
      at: undefined,
      events: [event({ subject: 'a' }), event({ subject: 'b' })],
      own: false,
      table: 'Team events',
    });
    const status = syncStatusFor({ snapshot: s });
    expect(status.writeBack).toBe('read-only');
    expect(status.writeBackNote).toBeUndefined();
    expect(status.rows).toBe(2);
    expect(status.rowsScope).toBe('in this table');
    expect(status.last).toBeUndefined();
    expect(status.writes).toBeUndefined();
    expect(status.ignored).toBeUndefined();
    expect(lines(s)).toMatchObject({
      tone: 'idle',
      headline: 'Not synced yet',
      rows: '2 events in this table',
      mode: 'Read-only: edits here stay in Atomic.',
    });
  });

  it('paused (the grant taken back) and a refused "Sync this table" keep the reason', () => {
    const paused = snap({
      state: { kind: 'local', canSync: true, reason: PAUSED_NOTE },
      calendarId: undefined,
      summary: undefined,
      at: undefined,
      lastSync: new Date(NOW - 3 * 24 * HOUR),
      own: false,
    });
    expect(lines(paused)).toMatchObject({
      headline: 'Synced 3 days ago',
      mode: `Read-only: edits here stay in Atomic. ${PAUSED_SHORT}`,
    });
    expect(syncStatusFor({ snapshot: paused }).writes).toBeUndefined();
    const refused = snap({
      state: {
        kind: 'local',
        canSync: true,
        reason: 'Not synced: The person said no.',
      },
      calendarId: undefined,
      summary: undefined,
      at: undefined,
      own: false,
    });
    expect(lines(refused).mode).toBe(
      'Read-only: edits here stay in Atomic. Not synced: The person said no.',
    );
  });

  it('the first import: syncing, with the page count, nothing read yet', () => {
    const s = snap({
      state: { kind: 'refreshing' },
      summary: undefined,
      at: undefined,
    });
    expect(lines(s)).toMatchObject({ tone: 'busy', headline: 'Syncing…' });
    expect(syncStatusFor({ snapshot: s }).last).toBeUndefined();
    expect(
      syncStatusFor({
        snapshot: snap({
          state: { kind: 'refreshing', pages: 2 },
          summary: undefined,
          at: undefined,
        }),
      }).busy,
    ).toBe('Syncing… (page 2)');

    // The setup screens are not data views; the mapping still answers, and
    // without a calendar nothing is synced.
    for (const state of [
      { kind: 'no-relay' },
      { kind: 'disconnected' },
      { kind: 'connecting' },
      { kind: 'choosing', calendars: [] },
    ] as ViewState[]) {
      const status = syncStatusFor({
        snapshot: snap({
          state,
          calendarId: undefined,
          meta: undefined,
          summary: undefined,
          at: undefined,
        }),
      });
      expect(status.last).toBeUndefined();
      expect(status.writes).toBeUndefined();
      expect(status.writeBack).toBe('read-only');
    }
  });

  it('a table being set up (bound, no calendar yet) is not synced, whatever its placeholder meta says', () => {
    // After "Sync this table" the not-synced view's placeholder meta (the
    // table's name, role `reader`) is still there while calendars are listed
    // or that listing fails: the card must not read it as a view-only
    // Google calendar with write-back.
    const placeholder = {
      summary: 'Team events',
      color: '#4986e7',
      accessRole: 'reader',
    };
    const listing = snap({
      state: { kind: 'refreshing' },
      calendarId: undefined,
      meta: placeholder,
      summary: undefined,
      at: undefined,
      own: false,
      table: 'Team events',
    });
    expect(syncStatusFor({ snapshot: listing })).toMatchObject({
      writeBack: 'read-only',
      busy: 'Syncing…',
    });
    expect(syncStatusFor({ snapshot: listing }).writeBackNote).toBeUndefined();
    const failed = snap({
      state: error('network'),
      calendarId: undefined,
      meta: placeholder,
      summary: undefined,
      at: undefined,
      events: [event({ subject: 'a' })],
      own: false,
      table: 'Team events',
    });
    const status = syncStatusFor({ snapshot: failed });
    expect(status.writeBack).toBe('read-only');
    expect(status.writeBackNote).toBeUndefined();
    expect(status.writes).toBeUndefined();
    expect(status.last).toMatchObject({
      ok: false,
      error: 'Couldn’t reach Google.',
    });
    expect(lines(failed)).toMatchObject({
      headline: 'Sync failed 1 min ago',
      rows: '1 event in this table',
      mode: 'Read-only: edits here stay in Atomic.',
    });
  });
});

describe('syncStatusFor: synced', () => {
  it('ready: synced ago, the counts, the rows from the calendar, write-back after review', () => {
    const s = snap();
    const status = syncStatusFor({ snapshot: s });
    expect(status.writeBack).toBe('after-review');
    expect(status.writeBackNote).toBeUndefined();
    expect(status.last).toEqual({
      ok: true,
      at: AT.getTime(),
      counts: { added: 1, updated: 1, unchanged: 1 },
    });
    expect(status.writes).toEqual({ pending: 0 });
    expect(status.ignored).toBeUndefined();
    expect(status.problems).toBeUndefined();
    expect(lines(s)).toEqual({
      tone: 'ok',
      headline: 'Synced 4 min ago',
      counts: 'Last sync: 1 added, 1 updated, 1 unchanged',
      rows: '3 events from Synthetic calendar',
      mode: 'Edits here are sent to Google Calendar after you review them.',
    });
  });

  it('a calendar Google shares read only: still write-back after review, with the note', () => {
    const s = snap({ meta: { ...META, accessRole: 'reader' } });
    const status = syncStatusFor({ snapshot: s });
    expect(status.writeBack).toBe('after-review');
    expect(status.writeBackNote).toBe(READ_ONLY_CALENDAR_NOTE);
  });

  it('a refresh over a previous result keeps the last good sync under "Syncing…"', () => {
    const s = snap({ state: { kind: 'refreshing', summary: summary() } });
    const status = syncStatusFor({ snapshot: s });
    expect(status.busy).toBe('Syncing…');
    expect(status.last).toMatchObject({ ok: true, at: AT.getTime() });
    expect(lines(s).headline).toBe('Syncing…');
  });

  it('pending: what "Review N changes" offers; held: the rows that can’t be sent as edited', () => {
    const review = [pendingEdit('a'), pendingEdit('b')];
    const planned = snap({
      state: {
        kind: 'ready',
        at: AT,
        summary: summary({ review }),
        outcomes: [],
      },
      summary: summary({ review }),
    });
    expect(syncStatusFor({ snapshot: planned }).writes).toEqual({
      pending: 2,
    });
    // A local edit since the preview: the edited rows count, not the plan.
    expect(
      syncStatusFor({
        snapshot: { ...planned, stale: true, pending: 3 },
      }).writes,
    ).toEqual({ pending: 3 });
    // Held back whole: counted in pending (the row is edited), named apart.
    const invalid = [
      { title: 'Standup', reason: 'All day off, but Start and End are dates' },
    ];
    const held = snap({
      summary: summary({ invalid }),
      pending: 1,
      stale: true,
    });
    const status = syncStatusFor({ snapshot: held });
    expect(status.writes).toEqual({ pending: 1, held: 1 });
    expect(status.ignored).toEqual([
      {
        count: 1,
        reason:
          'can’t be sent as edited: held back whole (nothing of it is sent, and Google’s edits to it wait) until fixed in the table or with Edit.',
        items: ['Standup: All day off, but Start and End are dates'],
      },
    ]);
    // Never more held than pending.
    expect(
      syncStatusFor({
        snapshot: snap({ summary: summary({ invalid }) }),
      }).writes,
    ).toEqual({ pending: 0 });
    expect(lines(held).tone).toBe('warn');
  });

  it('sending: i of n, over the last good sync', () => {
    const review = [pendingEdit('a'), pendingEdit('b'), pendingEdit('c')];
    const s = snap({
      state: {
        kind: 'sending',
        summary: summary({ review }),
        progress: [{ status: 'sent', title: 'a' }, 'sending', undefined],
      },
    });
    const status = syncStatusFor({ snapshot: s });
    expect(status.busy).toBe('Sending 2 of 3 to Google Calendar…');
    expect(status.last).toMatchObject({ ok: true });
  });

  it('the outcomes of the last send: refused, written but not saved, 412, uncertain, not sent', () => {
    const outcomes: Outcome[] = [
      { status: 'sent', title: 'a' },
      { status: 'failed', title: 'b', message: 'Google Calendar returned 403' },
      {
        status: 'failed',
        title: 'c',
        message: 'The row could not be saved',
        written: true,
      },
      { status: 'stale', title: 'd' },
      {
        status: 'uncertain',
        title: 'e',
        message: 'may or may not have applied',
      },
      { status: 'not-sent', title: 'f' },
    ];
    // Rows c, d, e and f are still edited (their baselines did not move),
    // so the controller's `pending` is 4. The uncertain row and the written
    // row have lines of their own, so "waiting to send" counts 2: d and f.
    const s = snap({
      state: error('uncertain', { phase: 'send', outcomes }),
      pending: 4,
      stale: true,
    });
    const status = syncStatusFor({ snapshot: s });
    expect(status.writes).toEqual({
      pending: 2,
      failed: [
        { title: 'b', reason: 'Google Calendar returned 403' },
        { title: 'c', reason: 'The row could not be saved', written: true },
      ],
      uncertain: 1,
    });
    // A send is not a sync: the last good read stands, and the uncertain
    // send is the write-queue line, not a second problem. The 412 is one.
    expect(status.last).toMatchObject({ ok: true, at: AT.getTime() });
    expect(status.problems).toEqual([
      {
        lead: '1 change not written to Google Calendar.',
        text: 'Changed in Google after you reviewed it, so nothing was overwritten. Review again to see what Google has now.',
      },
    ]);
    expect(lines(s)).toMatchObject({
      tone: 'neg',
      headline: 'Synced 4 min ago',
    });
    // The same outcomes on a ready state (no uncertain one) are kept until
    // the next refresh, which starts with none.
    const kept = snap({
      state: {
        kind: 'ready',
        at: AT,
        summary: summary(),
        outcomes: outcomes.filter(o => o.status === 'stale'),
      },
    });
    const keptStatus = syncStatusFor({ snapshot: kept });
    expect(keptStatus.writes).toEqual({ pending: 0 });
    expect(keptStatus.problems).toHaveLength(1);
    expect(lines(kept).tone).toBe('warn');
    const fresh = syncStatusFor({ snapshot: snap() });
    expect(fresh.writes).toEqual({ pending: 0 });
    expect(fresh.problems).toBeUndefined();
  });

  it('a send that failed before any outcome: a problem over the last good sync', () => {
    const s = snap({ state: error('reauth', { phase: 'send' }), pending: 2 });
    const status = syncStatusFor({ snapshot: s });
    expect(status.last).toMatchObject({ ok: true });
    expect(status.problems).toEqual([
      {
        lead: 'Google access has expired.',
        text: 'Nothing here was changed.',
        tone: 'neg',
      },
    ]);
    expect(status.writes).toEqual({ pending: 2 });
    expect(lines(s).tone).toBe('neg');
  });

  it('a failed read: the banner’s title, the next step and the last good sync', () => {
    const s = snap({ state: error('network') });
    const status = syncStatusFor({ snapshot: s });
    expect(status.last).toEqual({
      ok: false,
      at: NOW - MINUTE,
      error: 'Couldn’t reach Google.',
      nextStep: NEXT_STEP.network,
      lastGood: AT.getTime(),
    });
    expect(status.rows).toBe(3);
    expect(status.problems).toBeUndefined();
    expect(lines(s)).toMatchObject({
      tone: 'neg',
      headline: 'Sync failed 1 min ago',
      rows: '3 events from Synthetic calendar',
    });
    expect(lines(s).counts).toBeUndefined();
    // The recorded time stands in for this page load's when there is none:
    // a reload, then a failed first read, still names the last good sync.
    const reloaded = snap({
      state: error('network'),
      summary: undefined,
      at: undefined,
      lastSync: new Date(NOW - 2 * 24 * HOUR),
    });
    expect(syncStatusFor({ snapshot: reloaded }).last).toMatchObject({
      ok: false,
      lastGood: NOW - 2 * 24 * HOUR,
    });
    // And before that first read finishes, it is the last sync, uncounted.
    const opening = snap({
      state: { kind: 'refreshing' },
      summary: undefined,
      at: undefined,
      lastSync: new Date(NOW - 2 * 24 * HOUR),
    });
    expect(syncStatusFor({ snapshot: opening }).last).toEqual({
      ok: true,
      at: NOW - 2 * 24 * HOUR,
    });
    // Rate limited: the plain title; the banner keeps the countdown.
    expect(
      syncStatusFor({
        snapshot: snap({ state: error('rate-limited') }),
      }).last,
    ).toMatchObject({
      error: 'Google is limiting requests.',
      nextStep: NEXT_STEP['rate-limited'],
    });
    // Reauth names the calendar's reconnect.
    expect(
      syncStatusFor({ snapshot: snap({ state: error('reauth') }) }).last,
    ).toMatchObject({
      error: 'Google access has expired.',
      nextStep: 'Reconnect Google Calendar.',
    });
    // Failed before any sync: no last good sync to name.
    const first = snap({
      state: error('network'),
      summary: undefined,
      at: undefined,
    });
    expect(syncStatusFor({ snapshot: first }).last).not.toHaveProperty(
      'lastGood',
    );
  });

  it('left out: recurring, cancelled, unreadable (named), made here', () => {
    const s = snap({
      summary: summary({
        skipped: { recurring: 2, cancelled: 1, unreadable: 1 },
        unreadable: [{ id: 'u', title: ' ', reason: 'no start' }],
        localOnly: 1,
      }),
    });
    const status = syncStatusFor({ snapshot: s });
    expect(status.ignored).toEqual([
      {
        count: 2,
        reason:
          'are recurring: not imported yet, so a series is never mapped in part.',
      },
      {
        count: 1,
        reason:
          'is cancelled in Google: counted, not imported, and never treated as a deletion here.',
      },
      {
        count: 1,
        reason:
          'has dates this app can’t read: not imported, and never treated as a deletion here.',
        items: ['(untitled)'],
      },
      {
        count: 1,
        reason:
          'was made here: kept here only, not sent to Google Calendar, since creating events isn’t supported.',
      },
    ]);
    expect(lines(s).tone).toBe('warn');
  });

  it('incomplete rows: grouped by what is missing, Open row for a lone row, never held', () => {
    const opened: string[] = [];
    const events = [
      event({
        subject: 'r1',
        title: 'Retro',
        incomplete: 'Incomplete: missing Day',
      }),
      event({
        subject: 'r2',
        title: '',
        incomplete: 'Incomplete: missing Name',
      }),
      event({
        subject: 'r3',
        title: 'Plan',
        incomplete: 'Incomplete: missing Name',
      }),
      event({ subject: 'ok', title: 'Fine' }),
    ];
    const s = snap({
      events,
      summary: summary({
        invalid: [
          { title: 'Retro', reason: 'Incomplete: missing Day' },
          { title: '', reason: 'Incomplete: missing Name' },
          { title: 'Plan', reason: 'Incomplete: missing Name' },
        ],
      }),
    });
    const status = syncStatusFor({
      snapshot: s,
      onOpenRow: subject => opened.push(subject),
    });
    expect(status.writes).toEqual({ pending: 0 });
    expect(status.ignored).toHaveLength(2);
    expect(status.ignored![0]).toMatchObject({
      count: 1,
      reason:
        'is incomplete (missing Day): drawn on no day, and nothing of it is sent to Google Calendar. Fill the column in the table.',
      items: ['Retro'],
    });
    status.ignored![0].action!.onClick();
    expect(opened).toEqual(['r1']);
    expect(status.ignored![1]).toEqual({
      count: 2,
      reason:
        'are incomplete (missing Name): nothing of them is sent to Google Calendar. Fill the column in the table.',
      items: ['(untitled)', 'Plan'],
    });
    // Without a way to the host, no action.
    expect(syncStatusFor({ snapshot: s }).ignored![0]).not.toHaveProperty(
      'action',
    );
  });

  it('conflicts need a decision, with the way to the sheet; unmapped columns are kept here only', () => {
    let opened = 0;
    const s = snap({
      summary: summary({
        conflicts: [
          { title: 'x', fields: ['title'], kind: 'both' },
          { title: 'y', fields: ['Event cancelled'], kind: 'missing-remote' },
        ],
        unmapped: [{ column: 'Description', rows: 2 }],
      }),
    });
    const status = syncStatusFor({
      snapshot: s,
      onConflicts: () => opened++,
    });
    expect(status.problems).toHaveLength(2);
    expect(status.problems![0]).toMatchObject({
      lead: '2 events need a decision.',
      text: 'Changed both here and in Google, or gone from Google: neither side is changed until you choose.',
      action: { label: 'Review conflicts', key: 'ss-conflicts' },
    });
    status.problems![0].action!.onClick();
    expect(opened).toBe(1);
    expect(status.problems![1]).toEqual({
      lead: '1 column the app doesn’t send: Description.',
      text: 'Kept here only; 2 synced events fill it.',
    });
    expect(lines(s).tone).toBe('warn');
  });
});

// ---------------------------------------------------------------- controller

type Store = ReturnType<typeof fakeStore>;

/** A row's subject by its Google event id. */
function rowOf(store: Store, eventId: string): string {
  const id = field(store, 'google-event-id');

  return [...store.resources].find(([, p]) => p[id] === eventId)![0];
}

/** Edits a row the way the host table would. */
function editRow(
  store: Store,
  eventId: string,
  fields: Record<string, unknown>,
) {
  const subject = rowOf(store, eventId);
  store.resources.set(subject, { ...store.resources.get(subject)!, ...fields });
}

async function imported(store = fakeStore()) {
  const controller = createController(store, () => {});
  await controller.load();
  await controller.choose(PRIMARY);

  return { store, controller };
}

const cardOf = (controller: ReturnType<typeof createController>) =>
  syncStatusFor({ snapshot: controller.snapshot() });

describe('syncStatusFor: driven by the controller', () => {
  it('a lost response on one of two edits: one uncertain, one waiting, never both for the same row', async () => {
    const { store, controller } = await imported();
    editRow(store, 'all-day', { [NAME]: 'All-day here' });
    editRow(store, 'timed', { [NAME]: 'Timed here' });
    await controller.refresh();
    expect(cardOf(controller).writes).toEqual({ pending: 2 });
    store.loseNextWriteResponse();
    await controller.send();
    expect(controller.state().kind).toBe('error');
    // Both rows are still edited (the uncertain row's baseline did not
    // move), but the card says each once: 1 uncertain, 1 waiting.
    expect(controller.snapshot().pending).toBe(2);
    const card = cardOf(controller);
    expect(card.writes).toEqual({ pending: 1, uncertain: 1 });
    expect(card.last).toMatchObject({ ok: true });
    expect(card.problems).toBeUndefined();

    // A read that fails does not settle the send: the uncertain line stays.
    store.throwNext('Failed to fetch');
    await controller.refresh();
    expect(controller.state()).toMatchObject({ kind: 'error', phase: 'read' });
    const unsettled = cardOf(controller);
    expect(unsettled.writes).toEqual({ pending: 1, uncertain: 1 });
    expect(unsettled.last).toMatchObject({ ok: false, lastGood: NOW });

    // The read that succeeds does: Google had applied it, so one is left.
    await controller.refresh();
    expect(cardOf(controller).writes).toEqual({ pending: 1 });
  });

  it('a hand-made table whose set-up fails after Allow editing stays read-only, without a view-only note', async () => {
    const store = fakeStore({ view: 'other' });
    store.resources.set('did:ad:hand-1', {
      [PARENT]: OTHER_TABLE,
      [IS_A]: [EVENT],
      [NAME]: 'Planning day',
      [SHARED.day]: '2026-10-06',
    });
    const controller = createController(store, () => {});
    await controller.load();
    expect(cardOf(controller)).toMatchObject({
      writeBack: 'read-only',
      rows: 1,
    });
    // "Sync this table", editing allowed, then listing calendars fails: the
    // binding exists, no calendar is chosen, the placeholder meta (role
    // `reader`) is still there.
    store.throwNext('Failed to fetch');
    await controller.syncTable();
    const snapshot = controller.snapshot();
    expect(snapshot.state.kind).toBe('error');
    expect(snapshot.meta?.accessRole).toBe('reader');
    expect(snapshot.calendarId).toBeUndefined();
    const card = cardOf(controller);
    expect(card.writeBack).toBe('read-only');
    expect(card.writeBackNote).toBeUndefined();
    expect(card.writes).toBeUndefined();
    expect(card.last).toMatchObject({
      ok: false,
      error: 'Couldn’t reach Google.',
    });
    expect(card.last).not.toHaveProperty('lastGood');
    // Retried and chosen: synced, write-back after review.
    await controller.listCalendars();
    await controller.choose(PRIMARY);
    expect(cardOf(controller)).toMatchObject({
      writeBack: 'after-review',
      rows: 3,
      rowsScope: 'from Synthetic',
    });
  });

  it('a view-only Google calendar is synced with write-back after review and the refusal note', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {});
    await controller.load();
    await controller.choose(TEAM);
    expect(cardOf(controller)).toMatchObject({
      writeBack: 'after-review',
      writeBackNote: READ_ONLY_CALENDAR_NOTE,
    });
  });

  it('the last good sync is kept on the table and named after a reload, when the read fails or the sync is paused', async () => {
    const { store } = await imported();
    const recorded =
      store.resources.get(TABLE)![field(store, 'google-last-sync')];
    expect(recorded).toBe(new Date(NOW).toISOString());

    // Two days later the app opens again and its first read fails.
    vi.setSystemTime(NOW + 2 * 24 * HOUR);
    store.throwNext('Failed to fetch');
    const reopened = createController(store, () => {});
    await (
      await reopened.load()
    ).refreshing;
    expect(reopened.state()).toMatchObject({ kind: 'error', phase: 'read' });
    const later = NOW + 2 * 24 * HOUR;
    const card = syncStatusFor({ snapshot: reopened.snapshot() });
    expect(card.last).toEqual({
      ok: false,
      at: later,
      error: 'Couldn’t reach Google.',
      nextStep: NEXT_STEP.network,
      lastGood: NOW,
    });
    expect(statusLines(card, later).headline).toBe('Sync failed just now');
    expect(card.rows).toBe(3);
  });

  it('paused: a synced hand-made table whose grant is taken back names its last sync', async () => {
    const store = fakeStore({ view: 'other' });
    const controller = createController(store, () => {});
    await controller.load();
    await controller.syncTable();
    await controller.choose(PRIMARY);
    expect(cardOf(controller)).toMatchObject({ writeBack: 'after-review' });
    store.revokeGrant();
    vi.setSystemTime(NOW + 3 * 24 * HOUR);
    const reopened = createController(store, () => {});
    await reopened.load();
    expect(reopened.state()).toMatchObject({
      kind: 'local',
      reason: PAUSED_NOTE,
    });
    const card = syncStatusFor({ snapshot: reopened.snapshot() });
    expect(card.writeBack).toBe('read-only');
    expect(card.writeBackNote).toBe(PAUSED_SHORT);
    expect(card.last).toEqual({ ok: true, at: NOW });
    expect(statusLines(card, NOW + 3 * 24 * HOUR).headline).toBe(
      'Synced 3 days ago',
    );
    expect(card.writes).toBeUndefined();
  });
});
