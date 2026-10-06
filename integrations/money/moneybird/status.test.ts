// @wc-ignore-file
/**
 * `status.ts`: every `ViewState`, with and without a latest sync, mapped onto
 * the shared sync-status card's model (Q-084), without a DOM. The words are
 * checked through the card's own `statusLines`, so a card change that moves
 * them shows here.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import type { SyncRecord, ViewState } from './controller.js';
import type { SyncSummary } from './sync.js';
import {
  NEXT_STEP,
  NO_RELAY_NOTE,
  OVERWRITES_NOTE,
  PAUSED_NOTE,
  syncStatusFor,
  UNSYNCED_NOTE,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;
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
  lastGood: {
    contacts: new Date(NOW - 2 * MIN),
    hours: new Date(NOW - 2 * MIN),
    mutations: new Date(NOW - 2 * MIN),
  },
  ...over,
});

const synced = (last: SyncRecord): ViewState => ({
  kind: 'synced',
  connection,
  administration: A,
  collections: last.collections,
  at: last.at,
  results: last.results,
});

const lines = (state: ViewState, last?: SyncRecord) =>
  statusLines(syncStatusFor({ state, last, now: NOW })!, NOW);

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
      { kind: 'error', message: 'boom' },
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

  it('says nothing is overwritten on an unsynced or paused table, and why nothing is read without a relay', () => {
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
    for (const note of [UNSYNCED_NOTE, PAUSED_NOTE, NO_RELAY_NOTE])
      expect(note).toMatch(/^Nothing is sent to Moneybird/);
  });

  it('before any sync: not synced yet, no rows, no counts', () => {
    const l = lines({ kind: 'disconnected' });
    expect(l.headline).toBe('Not synced yet');
    expect(l.tone).toBe('idle');
    expect(l.rows).toBeUndefined();
    expect(l.counts).toBeUndefined();
  });

  it('after a sync of three collections: each one counted, the totals, and when', () => {
    const last = record();
    const status = syncStatusFor({ state: synced(last), last, now: NOW })!;
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
    const l = lines(synced(last), last);
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
      lastGood: { hours: new Date(NOW - 2 * MIN) },
    });
    const l = lines(synced(last), last);
    expect(l.rows).toBe('4 time entries imported');
    expect(l.counts).toBe('Last sync: 1 added, 0 updated, 3 unchanged');
    const one = record({
      collections: ['mutations'],
      results: { mutations: summary(1) },
    });
    expect(lines(synced(one), one).rows).toBe('1 mutation imported');
  });

  it('skipped records are ignored rows, named with the reason, per collection', () => {
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
      last: both,
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
    expect(lines(synced(both), both).tone).toBe('warn');

    // One collection: the card's noun is that collection's.
    const only = record({ collections: ['hours'], results: { hours } });
    const single = syncStatusFor({
      state: synced(only),
      last: only,
      now: NOW,
    })!;
    expect(single.rowNoun).toEqual(['time entry', 'time entries']);
    expect(single.ignored![0].reason).toBe(
      'without a readable start (started_at) in Moneybird: not imported.',
    );
  });

  it('one collection failing: the others count, the failure names its error, the kept rows, the last good refresh and the next step', () => {
    const last = record({
      results: {
        contacts: { error: 'Moneybird answered 503 for contacts page 2.' },
        hours: summary(4, { added: 0, unchanged: 4 }),
        mutations: summary(6, { added: 0, unchanged: 6 }),
      },
      lastGood: {
        contacts: new Date(NOW - 3 * 60 * MIN),
        hours: new Date(NOW - 2 * MIN),
        mutations: new Date(NOW - 2 * MIN),
      },
    });
    const status = syncStatusFor({ state: synced(last), last, now: NOW })!;
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
    const l = lines(synced(last), last);
    expect(l.headline).toBe('Synced 2 min ago');
    expect(l.tone).toBe('neg');

    // Never refreshed this page load: no "last refreshed" claim.
    const fresh = record({
      results: last.results,
      lastGood: { hours: new Date(NOW), mutations: new Date(NOW) },
    });
    expect(
      syncStatusFor({ state: synced(fresh), last: fresh, now: NOW })!
        .problems![0].text,
    ).toBe(
      'Moneybird answered 503 for contacts page 2. The contacts imported earlier are kept. Press Sync now to try again.',
    );
  });

  it('every collection failing: the sync failed, with the last good sync and the next step', () => {
    const last = record({
      collections: ['hours', 'mutations'],
      results: {
        hours: {
          error: 'Moneybird kept limiting requests (429) after 5 retries.',
          problem: 'rate-limited',
        },
        mutations: { error: 'Moneybird answered 500 for financial accounts.' },
      },
      lastGood: {
        hours: new Date(NOW - 3 * 24 * 60 * MIN),
        mutations: new Date(NOW - 2 * 24 * 60 * MIN),
      },
    });
    const status = syncStatusFor({ state: synced(last), last, now: NOW })!;
    expect(status.rows).toBeUndefined();
    expect(status.last).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error:
        'Hours (time entries): Moneybird kept limiting requests (429) after 5 retries. Financial mutations: Moneybird answered 500 for financial accounts.',
      nextStep: NEXT_STEP['rate-limited'],
      // The oldest: when every chosen collection was last good.
      lastGood: NOW - 3 * 24 * 60 * MIN,
    });
    expect(status.problems).toBeUndefined();
    const l = lines(synced(last), last);
    expect(l.headline).toBe('Sync failed 2 min ago');
    expect(l.tone).toBe('neg');
    expect(l.counts).toBeUndefined();

    // One collection, never good this page load: its error alone, no gap named.
    const one = record({
      collections: ['contacts'],
      results: {
        contacts: {
          error: 'Moneybird refused contacts (401); reconnect Moneybird.',
          problem: 'reauth',
        },
      },
      lastGood: {},
    });
    expect(
      syncStatusFor({ state: synced(one), last: one, now: NOW })!.last,
    ).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error: 'Moneybird refused contacts (401); reconnect Moneybird.',
      nextStep: 'Reconnect Moneybird.',
    });
  });

  it('while syncing: busy, with the wait for Moneybird’s limit while it lasts; the last sync stays', () => {
    const last = record();
    const syncing: ViewState = {
      kind: 'syncing',
      connection,
      administration: A,
      collections: ['contacts', 'hours', 'mutations'],
    };
    expect(lines(syncing, last)).toMatchObject({
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
    expect(lines(choosing, last).headline).toBe('Synced 2 min ago');
    const error: ViewState = {
      kind: 'error',
      connection,
      message: 'Choose at least one collection to import.',
    };
    const status = syncStatusFor({ state: error, last, now: NOW })!;
    expect(status.problems).toEqual([
      {
        lead: 'This app hit a problem.',
        text: 'Choose at least one collection to import.',
        tone: 'neg',
      },
    ]);
    expect(lines(error, last)).toMatchObject({
      headline: 'Synced 2 min ago',
      tone: 'neg',
    });
  });
});
