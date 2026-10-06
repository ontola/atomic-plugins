// @wc-ignore-file
/**
 * `status.ts`: the controller's snapshot mapped onto the shared sync-status
 * card's model (Q-084), for every `ViewState`, without a DOM.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../../sync-status/card.js';
import { PAUSED_NOTE, type Snapshot, type ViewState } from '../controller.js';
import type { CalEvent } from '../events.js';
import type { ImportSummary, Outcome, PendingEdit } from '../sync.js';
import {
  NEXT_STEP,
  PAUSED_SHORT,
  READ_ONLY_CALENDAR_NOTE,
  syncStatusFor,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const AT = new Date(NOW - 4 * MINUTE);
const META = {
  summary: 'Synthetic calendar',
  color: '#4986e7',
  accessRole: 'owner',
};
const CAN = { openExternal: true, openResource: true, disconnect: true };

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
  statusLines(syncStatusFor({ snapshot: s, now: NOW, ...extra }), NOW);

describe('syncStatusFor: the states before a sync', () => {
  it('loading: busy, nothing known yet', () => {
    const status = syncStatusFor({
      snapshot: snap({
        state: { kind: 'loading' },
        summary: undefined,
        at: undefined,
        meta: undefined,
      }),
      now: NOW,
    });
    expect(status.busy).toBe('Loading…');
    expect(status.last).toBeUndefined();
    expect(status.writes).toBeUndefined();
    expect(status.rows).toBeUndefined();
  });

  it('a table that isn’t synced: read-only, its rows, not synced yet, no write queue', () => {
    const s = snap({
      state: { kind: 'local', canSync: true },
      meta: { summary: 'Team events', color: '#4986e7', accessRole: 'reader' },
      summary: undefined,
      at: undefined,
      events: [event({ subject: 'a' }), event({ subject: 'b' })],
      own: false,
      table: 'Team events',
    });
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
      summary: undefined,
      at: undefined,
      own: false,
    });
    expect(lines(paused).mode).toBe(
      `Read-only: edits here stay in Atomic. ${PAUSED_SHORT}`,
    );
    const refused = snap({
      state: {
        kind: 'local',
        canSync: true,
        reason: 'Not synced: The person said no.',
      },
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
    expect(syncStatusFor({ snapshot: s, now: NOW }).last).toBeUndefined();
    expect(
      syncStatusFor({
        snapshot: snap({
          state: { kind: 'refreshing', pages: 2 },
          summary: undefined,
          at: undefined,
        }),
        now: NOW,
      }).busy,
    ).toBe('Syncing… (page 2)');
    // The setup screens are not data views; the mapping still answers.
    for (const state of [
      { kind: 'no-relay' },
      { kind: 'disconnected' },
      { kind: 'connecting' },
      { kind: 'choosing', calendars: [] },
    ] as ViewState[]) {
      const status = syncStatusFor({
        snapshot: snap({
          state,
          meta: undefined,
          summary: undefined,
          at: undefined,
        }),
        now: NOW,
      });
      expect(status.last).toBeUndefined();
      expect(status.writes).toEqual({ pending: 0 });
    }
  });
});

describe('syncStatusFor: synced', () => {
  it('ready: synced ago, the counts, the rows from the calendar, write-back after review', () => {
    const s = snap();
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
    const status = syncStatusFor({ snapshot: s, now: NOW });
    expect(status.writeBack).toBe('after-review');
    expect(status.writeBackNote).toBe(READ_ONLY_CALENDAR_NOTE);
  });

  it('a refresh over a previous result keeps the last good sync under "Syncing…"', () => {
    const s = snap({ state: { kind: 'refreshing', summary: summary() } });
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
    expect(syncStatusFor({ snapshot: planned, now: NOW }).writes).toEqual({
      pending: 2,
    });
    // A local edit since the preview: the edited rows count, not the plan.
    expect(
      syncStatusFor({
        snapshot: { ...planned, stale: true, pending: 3 },
        now: NOW,
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
    const status = syncStatusFor({ snapshot: held, now: NOW });
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
        now: NOW,
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
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
    // Rows d, e and f are still edited: `pending` counts them.
    const s = snap({
      state: error('uncertain', { phase: 'send', outcomes }),
      pending: 3,
      stale: true,
    });
    const status = syncStatusFor({ snapshot: s, now: NOW });
    expect(status.writes).toEqual({
      pending: 3,
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
    const keptStatus = syncStatusFor({ snapshot: kept, now: NOW });
    expect(keptStatus.writes).toEqual({ pending: 0 });
    expect(keptStatus.problems).toHaveLength(1);
    expect(lines(kept).tone).toBe('warn');
    const fresh = syncStatusFor({ snapshot: snap(), now: NOW });
    expect(fresh.writes).toEqual({ pending: 0 });
    expect(fresh.problems).toBeUndefined();
  });

  it('a send that failed before any outcome: a problem over the last good sync', () => {
    const s = snap({ state: error('reauth', { phase: 'send' }), pending: 2 });
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
    // Rate limited: the plain title; the banner keeps the countdown.
    expect(
      syncStatusFor({
        snapshot: snap({ state: error('rate-limited') }),
        now: NOW,
      }).last,
    ).toMatchObject({
      error: 'Google is limiting requests.',
      nextStep: NEXT_STEP['rate-limited'],
    });
    // Reauth names the calendar's reconnect.
    expect(
      syncStatusFor({ snapshot: snap({ state: error('reauth') }), now: NOW })
        .last,
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
    expect(
      syncStatusFor({ snapshot: first, now: NOW }).last,
    ).not.toHaveProperty('lastGood');
  });

  it('left out: recurring, cancelled, unreadable (named), made here', () => {
    const s = snap({
      summary: summary({
        skipped: { recurring: 2, cancelled: 1, unreadable: 1 },
        unreadable: [{ id: 'u', title: ' ', reason: 'no start' }],
        localOnly: 1,
      }),
    });
    const status = syncStatusFor({ snapshot: s, now: NOW });
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
        reason: 'has dates this app can’t read: not imported.',
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
      now: NOW,
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
    expect(
      syncStatusFor({ snapshot: s, now: NOW }).ignored![0],
    ).not.toHaveProperty('action');
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
      now: NOW,
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
