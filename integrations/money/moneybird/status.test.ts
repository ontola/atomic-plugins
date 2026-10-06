// @wc-ignore-file
/**
 * `status.ts`: every `ViewState`, with and without a sync this page load and
 * with and without stored last good refreshes, mapped onto the shared
 * sync-status card's model (Q-084), without a DOM. The words are checked
 * through the card's own `statusLines`, so a card change that moves them
 * shows here.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import type { SyncHistory, SyncRecord, ViewState } from './controller.js';
import type { SyncSummary } from './sync.js';
import {
  NEXT_STEP,
  NO_RELAY_NOTE,
  NOTHING_SENT_NOTE,
  OVERWRITES_NOTE,
  PAUSED_NOTE,
  syncStatusFor,
  UNSYNCED_NOTE,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const connection = { platform: 'moneybird', connectionId: 'c1' };
const A = '100000000000000001';

const summary = (
  total: number,
  over: Partial<SyncSummary> = {},
): SyncSummary => ({
  total,
  added: total,
  updated: 0,
  unchanged: 0,
  skipped: 0,
  ...over,
});

const record = (over: Partial<SyncRecord> = {}): SyncRecord => ({
  at: new Date(NOW - 2 * MIN),
  collections: ['contacts', 'hours', 'mutations'],
  results: {
    contacts: summary(5),
    hours: summary(4),
    mutations: summary(6),
  },
  ...over,
});

/** A history whose latest sync is `last`, every collection good at `last.at`. */
const history = (
  last: SyncRecord,
  lastGood: SyncHistory['lastGood'] = Object.fromEntries(
    last.collections.map(c => [c, last.at]),
  ),
): SyncHistory => ({ last, lastGood });

const synced = (last: SyncRecord): ViewState => ({
  kind: 'synced',
  connection,
  administration: A,
  collections: last.collections,
  at: last.at,
  results: last.results,
});

const lines = (state: ViewState, h?: SyncHistory) =>
  statusLines(syncStatusFor({ state, history: h, now: NOW })!, NOW);

describe('the sync-status card for the Moneybird app', () => {
  it('shows no card while loading or on a table it cannot sync', () => {
    expect(
      syncStatusFor({ state: { kind: 'loading' }, now: NOW }),
    ).toBeUndefined();
    expect(
      syncStatusFor({
        state: {
          kind: 'unsupported',
          message: 'not a table this app can sync',
        },
        now: NOW,
      }),
    ).toBeUndefined();
  });

  it('is read-only in every state, saying that the next sync overwrites imported columns', () => {
    const states: ViewState[] = [
      { kind: 'disconnected' },
      { kind: 'disconnected', table: 'Bank' },
      { kind: 'connecting' },
      {
        kind: 'choosing',
        connection,
        administrations: [],
        collections: ['contacts'],
        selectable: true,
      },
      {
        kind: 'syncing',
        connection,
        administration: A,
        collections: ['hours'],
      },
      synced(record()),
      { kind: 'error', message: 'boom', bound: true },
    ];

    for (const state of states) {
      const status = syncStatusFor({ state, now: NOW })!;
      expect(status.provider).toBe('Moneybird');
      expect(status.writeBack).toBe('read-only');
      expect(status.writeBackNote).toBe(OVERWRITES_NOTE);
      expect(lines(state).mode).toBe(
        `Read-only: edits here stay in Atomic. ${OVERWRITES_NOTE}`,
      );
    }
  });

  it('says nothing is overwritten on an unsynced or paused table, why nothing is read without a relay, and claims only "nothing is sent" after an error on an unbound table', () => {
    const unsynced: ViewState = {
      kind: 'unsynced',
      table: 'Bank',
      collection: 'mutations',
    };
    expect(syncStatusFor({ state: unsynced, now: NOW })!.writeBackNote).toBe(
      UNSYNCED_NOTE,
    );
    expect(lines(unsynced).headline).toBe('Not synced yet');
    const paused: ViewState = {
      kind: 'paused',
      table: 'Bank',
      collection: 'mutations',
    };
    expect(syncStatusFor({ state: paused, now: NOW })!.writeBackNote).toBe(
      PAUSED_NOTE,
    );
    expect(
      syncStatusFor({ state: { kind: 'no-relay' }, now: NOW })!.writeBackNote,
    ).toBe(NO_RELAY_NOTE);
    // The layout or the binding failed: the table may not be this app's.
    expect(
      syncStatusFor({ state: { kind: 'error', message: 'boom' }, now: NOW })!
        .writeBackNote,
    ).toBe(NOTHING_SENT_NOTE);
    for (const note of [
      UNSYNCED_NOTE,
      PAUSED_NOTE,
      NO_RELAY_NOTE,
      NOTHING_SENT_NOTE,
    ])
      expect(note).toMatch(/^Nothing is sent to Moneybird/);
  });

  it('before any sync anywhere: not synced yet, no rows, no counts', () => {
    const l = lines({ kind: 'disconnected' }, { lastGood: {} });
    expect(l.headline).toBe('Not synced yet');
    expect(l.tone).toBe('idle');
    expect(l.rows).toBeUndefined();
    expect(l.counts).toBeUndefined();
  });

  it('before this page load’s first sync, a table that holds imported rows names the stored last good refresh, not "Not synced yet"', () => {
    const stored: SyncHistory = {
      lastGood: {
        contacts: new Date(NOW - 3 * DAY),
        hours: new Date(NOW - 2 * DAY),
      },
    };
    const states: ViewState[] = [
      { kind: 'disconnected' },
      {
        kind: 'choosing',
        connection,
        administrations: [{ id: A, name: 'Synthetic Studio B.V.' }],
        collections: ['contacts', 'hours'],
        selectable: true,
      },
      { kind: 'error', message: 'boom', bound: true },
    ];

    for (const state of states) {
      const status = syncStatusFor({ state, history: stored, now: NOW })!;
      // The most recent refresh, without counts: nothing was read this time.
      expect(status.last).toEqual({ ok: true, at: NOW - 2 * DAY });
      expect(lines(state, stored).headline).toBe('Synced 2 days ago');
      expect(lines(state, stored).counts).toBeUndefined();
    }

    // Only the collections this view syncs count: a view on the hours table
    // does not borrow the contacts' or mutations' time.
    const hoursOnly: SyncHistory = { ...stored, chosen: ['hours'] };
    expect(lines({ kind: 'disconnected' }, hoursOnly).headline).toBe(
      'Synced 2 days ago',
    );
    const contactsOnly: SyncHistory = { ...stored, chosen: ['contacts'] };
    expect(lines({ kind: 'disconnected' }, contactsOnly).headline).toBe(
      'Synced 3 days ago',
    );
    const mutationsOnly: SyncHistory = { ...stored, chosen: ['mutations'] };
    expect(lines({ kind: 'disconnected' }, mutationsOnly).headline).toBe(
      'Not synced yet',
    );
    // A paused table reads the same way (the controller reads the stored
    // times before showing "paused").
    const paused: ViewState = {
      kind: 'paused',
      table: 'Bank',
      collection: 'mutations',
    };
    expect(
      lines(paused, {
        lastGood: { mutations: new Date(NOW - DAY) },
        chosen: ['mutations'],
      }).headline,
    ).toBe('Synced yesterday');
  });

  it('after a sync of three collections: each one counted, the totals, and when', () => {
    const last = record();
    const status = syncStatusFor({
      state: synced(last),
      history: history(last),
      now: NOW,
    })!;
    expect(status.rows).toBe(15);
    expect(status.rowNoun).toEqual(['row', 'rows']);
    expect(status.rowsScope).toBe(
      'imported: 5 contacts, 4 time entries, 6 mutations',
    );
    expect(status.last).toEqual({
      ok: true,
      at: NOW - 2 * MIN,
      counts: { added: 15, updated: 0, unchanged: 0 },
    });
    expect(status.problems).toBeUndefined();
    expect(status.ignored).toBeUndefined();
    const l = lines(synced(last), history(last));
    expect(l.headline).toBe('Synced 2 min ago');
    expect(l.tone).toBe('ok');
    expect(l.rows).toBe(
      '15 rows imported: 5 contacts, 4 time entries, 6 mutations',
    );
    expect(l.counts).toBe('Last sync: 15 added, 0 updated, 0 unchanged');
  });

  it('after a sync of one collection: that collection’s noun', () => {
    const last = record({
      collections: ['hours'],
      results: { hours: summary(4, { added: 1, unchanged: 3 }) },
    });
    const l = lines(synced(last), history(last));
    expect(l.rows).toBe('4 time entries imported');
    expect(l.counts).toBe('Last sync: 1 added, 0 updated, 3 unchanged');
    const one = record({
      collections: ['mutations'],
      results: { mutations: summary(1) },
    });
    expect(lines(synced(one), history(one)).rows).toBe('1 mutation imported');
  });

  it('skipped records are ignored rows, named with the reason, per collection; no "nothing to read" next to them', () => {
    const hours = summary(4, {
      added: 3,
      skipped: 1,
      skippedRows: [
        {
          name: 'Design review',
          reason:
            'without a readable start (started_at) in Moneybird: not imported.',
        },
      ],
    });
    const mutations = summary(6, {
      added: 4,
      skipped: 2,
      skippedRows: [
        {
          name: 'Nep Hosting',
          reason:
            'with an amount Moneybird did not send as a decimal string: not imported, never approximated.',
        },
        {
          name: 'Mutation 7',
          reason:
            'with an amount Moneybird did not send as a decimal string: not imported, never approximated.',
        },
      ],
    });
    const both = record({
      collections: ['hours', 'mutations'],
      results: { hours, mutations },
    });
    const status = syncStatusFor({
      state: synced(both),
      history: history(both),
      now: NOW,
    })!;
    // Rows in the tables, not the skipped ones.
    expect(status.rows).toBe(7);
    expect(status.ignored).toEqual([
      {
        count: 1,
        reason:
          '(time entry) without a readable start (started_at) in Moneybird: not imported.',
        items: ['Design review'],
      },
      {
        count: 2,
        reason:
          '(mutations) with an amount Moneybird did not send as a decimal string: not imported, never approximated.',
        items: ['Nep Hosting', 'Mutation 7'],
      },
    ]);
    expect(lines(synced(both), history(both))).toMatchObject({
      tone: 'warn',
      counts: 'Last sync: 7 added, 0 updated, 0 unchanged',
    });

    // One collection: the card's noun is that collection's.
    const only = record({ collections: ['hours'], results: { hours } });
    const single = syncStatusFor({
      state: synced(only),
      history: history(only),
      now: NOW,
    })!;
    expect(single.rowNoun).toEqual(['time entry', 'time entries']);
    expect(single.ignored![0].reason).toBe(
      'without a readable start (started_at) in Moneybird: not imported.',
    );

    // Every record skipped: no counts line ("nothing to read" would be
    // wrong next to "3 time entries … not imported").
    const none = record({
      collections: ['hours'],
      results: {
        hours: summary(3, {
          added: 0,
          skipped: 3,
          skippedRows: ['a', 'b', 'c'].map(name => ({
            name,
            reason:
              'without a readable start (started_at) in Moneybird: not imported.',
          })),
        }),
      },
    });
    const l = lines(synced(none), history(none));
    expect(l.counts).toBeUndefined();
    expect(l.rows).toBe('0 time entries imported');
    expect(l.headline).toBe('Synced 2 min ago');
    expect(
      syncStatusFor({ state: synced(none), history: history(none), now: NOW })!
        .ignored![0].count,
    ).toBe(3);
  });

  it('one collection failing: the others count, the failure names its error, the kept rows, the last good refresh and the next step', () => {
    const last = record({
      results: {
        contacts: { error: 'Moneybird answered 503 for contacts page 2.' },
        hours: summary(4, { added: 0, unchanged: 4 }),
        mutations: summary(6, { added: 0, unchanged: 6 }),
      },
    });
    const h = history(last, {
      contacts: new Date(NOW - 3 * HOUR),
      hours: last.at,
      mutations: last.at,
    });
    const status = syncStatusFor({
      state: synced(last),
      history: h,
      now: NOW,
    })!;
    expect(status.rows).toBe(10);
    expect(status.rowsScope).toBe('imported: 4 time entries, 6 mutations');
    expect(status.last).toEqual({
      ok: true,
      at: NOW - 2 * MIN,
      counts: { added: 0, updated: 0, unchanged: 10 },
    });
    expect(status.problems).toEqual([
      {
        lead: 'Contacts: refresh failed.',
        text: 'Moneybird answered 503 for contacts page 2. The contacts imported earlier are kept; they last refreshed 3 h ago. Press Sync now to try again.',
        tone: 'neg',
      },
    ]);
    const l = lines(synced(last), h);
    expect(l.headline).toBe('Synced 2 min ago');
    expect(l.tone).toBe('neg');

    // Never refreshed as far as this app knows: no "last refreshed" claim.
    const fresh = history(last, { hours: last.at, mutations: last.at });
    expect(
      syncStatusFor({ state: synced(last), history: fresh, now: NOW })!
        .problems![0].text,
    ).toBe(
      'Moneybird answered 503 for contacts page 2. The contacts imported earlier are kept. Press Sync now to try again.',
    );
  });

  it('every collection failing: the sync failed, the rows are kept, each known last good refresh is named, and the next step', () => {
    const last = record({
      collections: ['hours', 'mutations'],
      results: {
        hours: {
          error: 'Moneybird kept limiting requests (429) after 5 retries.',
          problem: 'rate-limited',
        },
        mutations: { error: 'Moneybird answered 500 for financial accounts.' },
      },
    });
    // Stored on the home by an earlier page load: hours only.
    const h = history(last, { hours: new Date(NOW - 3 * DAY) });
    const status = syncStatusFor({
      state: synced(last),
      history: h,
      now: NOW,
    })!;
    expect(status.rows).toBeUndefined();
    expect(status.last).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error:
        'Hours (time entries): Moneybird kept limiting requests (429) after 5 retries. Its time entries last refreshed 3 days ago. Financial mutations: Moneybird answered 500 for financial accounts. The rows imported earlier are kept.',
      nextStep: NEXT_STEP['rate-limited'],
      // The oldest of the refreshes this app knows, not none.
      lastGood: NOW - 3 * DAY,
    });
    expect(status.problems).toBeUndefined();
    const l = lines(synced(last), h);
    expect(l.headline).toBe('Sync failed 2 min ago');
    expect(l.tone).toBe('neg');
    expect(l.counts).toBeUndefined();

    // Both known: the older one is the gap.
    const both = history(last, {
      hours: new Date(NOW - 3 * DAY),
      mutations: new Date(NOW - 1 * DAY),
    });
    expect(
      syncStatusFor({ state: synced(last), history: both, now: NOW })!.last,
    ).toMatchObject({ ok: false, lastGood: NOW - 3 * DAY });

    // The first sync ever, failing: its error alone, no gap named, and no
    // claim that rows are kept, since none were imported.
    const one = record({
      collections: ['contacts'],
      results: {
        contacts: {
          error: 'Moneybird refused contacts (401); reconnect Moneybird.',
          problem: 'reauth',
        },
      },
    });
    expect(
      syncStatusFor({
        state: synced(one),
        history: history(one, {}),
        now: NOW,
      })!.last,
    ).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error: 'Moneybird refused contacts (401); reconnect Moneybird.',
      nextStep: 'Reconnect Moneybird.',
    });
  });

  it('while syncing: busy, with the wait for Moneybird’s limit while it lasts; the last good sync stays, the previous sync’s failures do not', () => {
    const last = record();
    const syncing: ViewState = {
      kind: 'syncing',
      connection,
      administration: A,
      collections: ['contacts', 'hours', 'mutations'],
    };
    expect(lines(syncing, history(last))).toMatchObject({
      tone: 'busy',
      headline: 'Syncing…',
      counts: 'Last sync: 15 added, 0 updated, 0 unchanged',
    });
    expect(
      lines({
        ...syncing,
        waiting: {
          ms: 4_000,
          reason: 'rate-limited',
          attempt: 1,
          path: '/x',
        },
      }).headline,
    ).toBe('Moneybird is limiting requests (429): retrying in 4 s…');
    expect(
      lines({
        ...syncing,
        waiting: { ms: 12_500, reason: 'pacing', path: '/x' },
      }).headline,
    ).toBe('Pacing requests under Moneybird’s limit: next in 13 s…');

    // A failed collection of the previous sync is not listed while the
    // running one settles it; a wholly failed previous sync falls back to
    // the last good refresh.
    const partial = record({
      results: {
        contacts: { error: 'Moneybird answered 503 for contacts page 2.' },
        hours: summary(4),
        mutations: summary(6),
      },
    });
    const h = history(partial, { hours: partial.at, mutations: partial.at });
    expect(
      syncStatusFor({ state: syncing, history: h, now: NOW })!.problems,
    ).toBeUndefined();
    expect(
      syncStatusFor({ state: synced(partial), history: h, now: NOW })!.problems,
    ).toHaveLength(1);
    const failed = record({
      collections: ['hours'],
      results: { hours: { error: 'Moneybird answered 500 for time entries.' } },
    });
    const old = history(failed, { hours: new Date(NOW - DAY) });
    expect(
      syncStatusFor({ state: syncing, history: old, now: NOW })!.last,
    ).toEqual({ ok: true, at: NOW - DAY });
    expect(
      syncStatusFor({ state: synced(failed), history: old, now: NOW })!.last,
    ).toMatchObject({ ok: false, lastGood: NOW - DAY });
  });

  it('settings open or an error after a sync: the last sync stays on the card', () => {
    const last = record();
    const choosing: ViewState = {
      kind: 'choosing',
      connection,
      administrations: [{ id: A, name: 'Synthetic Studio B.V.' }],
      collections: ['contacts'],
      selectable: true,
    };
    expect(lines(choosing, history(last)).headline).toBe('Synced 2 min ago');
    const error: ViewState = {
      kind: 'error',
      connection,
      message: 'Choose at least one collection to import.',
      bound: true,
    };
    const status = syncStatusFor({
      state: error,
      history: history(last),
      now: NOW,
    })!;
    expect(status.problems).toEqual([
      {
        lead: 'This app hit a problem.',
        text: 'Choose at least one collection to import.',
        tone: 'neg',
      },
    ]);
    expect(lines(error, history(last))).toMatchObject({
      headline: 'Synced 2 min ago',
      tone: 'neg',
    });
  });
});
