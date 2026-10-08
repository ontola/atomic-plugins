// @wc-ignore-file
/**
 * `status.ts`: every state of the Money app mapped onto the shared
 * sync-status card's model (Q-084), without a DOM. The words are checked
 * through the card's own `statusLines`, so a card change that moves them
 * shows here.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import type { State } from './controller.js';
import type { Filters } from './ledger.js';
import type { Fields, StoredStatement, Txn } from './rows.js';
import {
  ALLOW_EDITING_NOTE,
  EDITING_REFUSED_NOTE,
  IMPORT_STOPPED_LEAD,
  LOAD_FAILED_LEAD,
  NO_DATES_SCOPE,
  NO_PROVIDER_NOTE,
  RETRY_STEP,
  syncStatusFor,
} from './status.js';

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const txn = (over: Partial<Txn> = {}): Txn => ({
  subject: 'did:ad:row-1',
  account: 'NL00BANK0123456789',
  currency: 'EUR',
  amount: '-12.50',
  valueDate: '2026-09-20',
  bookingDate: '2026-09-20',
  description: 'Fixture lunch',
  reference: 'REF-1',
  code: '',
  statement: 'NL00BANK0123456789/EUR/MT940/0001',
  sourceId: 'mt940:0001:1',
  fingerprint: 'fp-1',
  category: '',
  note: '',
  ...over,
});

const statement = (over: Partial<StoredStatement> = {}): StoredStatement => ({
  subject: 'did:ad:stmt-1',
  account: 'NL00BANK0123456789',
  currency: 'EUR',
  number: '0001',
  start: '2026-09-01',
  end: '2026-09-20',
  opening: '100.00',
  closing: '87.50',
  entries: '1',
  imported: new Date(NOW - 2 * DAY).toISOString(),
  sourceId: 'statement:1',
  ...over,
});

const state = (over: Partial<State> = {}): State => ({
  view: { kind: 'populated', count: 1 },
  tab: 'transactions',
  rows: [txn()],
  incomplete: [],
  canOpenRows: true,
  fields: {} as Fields,
  filters: {} as Filters,
  limit: 200,
  edits: {},
  drafts: {},
  canApply: true,
  rowAccess: 'granted',
  source: 'own',
  ...over,
});

const lines = (s: State) =>
  statusLines(syncStatusFor({ state: s, now: NOW }), NOW);

describe('Money status card: read-only, with the reason', () => {
  it('is read-only in every state and says there is no provider', () => {
    for (const s of [
      state(),
      state({ view: { kind: 'empty' }, rows: [] }),
      state({ view: { kind: 'loading', loaded: 0 } }),
      state({ view: { kind: 'error', message: 'x' } }),
    ]) {
      const status = syncStatusFor({ state: s, now: NOW });
      expect(status.writeBack).toBe('read-only');
      expect(status.writes).toBeUndefined();
      expect(lines(s).mode).toBe(
        `Read-only: edits here stay in Atomic. ${NO_PROVIDER_NOTE}`,
      );
    }
  });

  it('adds that editing must be allowed first, or was refused', () => {
    expect(lines(state({ rowAccess: 'none', source: 'shared' })).mode).toBe(
      `Read-only: edits here stay in Atomic. ${NO_PROVIDER_NOTE} ${ALLOW_EDITING_NOTE}`,
    );
    expect(lines(state({ rowAccess: 'denied' })).mode).toBe(
      `Read-only: edits here stay in Atomic. ${NO_PROVIDER_NOTE} ${EDITING_REFUSED_NOTE}`,
    );
    for (const rowAccess of ['granted', 'unknown', 'unavailable'] as const)
      expect(lines(state({ rowAccess })).mode).toBe(
        `Read-only: edits here stay in Atomic. ${NO_PROVIDER_NOTE}`,
      );
  });
});

describe('Money status card: the last import', () => {
  it('before anything was imported: not synced yet, 0 transactions', () => {
    const s = state({ view: { kind: 'empty' }, rows: [] });
    const status = syncStatusFor({ state: s, now: NOW });
    expect(status.last).toBeUndefined();
    expect(lines(s)).toMatchObject({
      tone: 'idle',
      headline: 'Not synced yet',
      rows: '0 transactions in this table',
    });
    expect(status.ignored).toBeUndefined();
    expect(status.problems).toBeUndefined();
  });

  it('dates the last import from the stored statements, newest first', () => {
    const s = state({
      rows: [txn(), txn({ subject: 'did:ad:row-2', statement: 's2' })],
      statements: [
        statement(),
        statement({
          subject: 'did:ad:stmt-2',
          number: '0002',
          imported: new Date(NOW - 3 * MIN).toISOString(),
        }),
      ],
    });
    const status = syncStatusFor({ state: s, now: NOW });
    expect(status.last).toEqual({ ok: true, at: NOW - 3 * MIN });
    expect(lines(s)).toMatchObject({
      tone: 'ok',
      headline: 'Synced 3 min ago',
      rows: '2 transactions from 2 statements',
    });
    expect(lines(s).counts).toBeUndefined();
  });

  it('skips an unreadable import stamp', () => {
    const s = state({
      statements: [statement({ imported: '' }), statement({ imported: 'x' })],
    });
    expect(syncStatusFor({ state: s, now: NOW }).last).toBeUndefined();
  });

  it('rows that just arrived: synced just now, with how many arrived, and no made-up counts', () => {
    const s = state({
      rows: [txn(), txn({ subject: 'did:ad:row-2' }), txn({ subject: 'r3' })],
      arrived: { count: 2, at: NOW - 10_000 },
      statements: [statement()],
    });
    const status = syncStatusFor({ state: s, now: NOW });
    // `arrived` counts every row the subscription brought in, not only this
    // view's import, and nothing counts updated or unchanged rows: no counts.
    expect(status.last).toEqual({ ok: true, at: NOW - 10_000 });
    expect(lines(s)).toMatchObject({
      headline: 'Synced just now',
      rows: '3 transactions from 1 statement; 2 arrived at the last sync',
    });
    expect(lines(s).counts).toBeUndefined();
  });

  it('rows that arrived into a table with no stored statements still say so', () => {
    const s = state({
      rows: [txn()],
      arrived: { count: 1, at: NOW - 2 * MIN },
      statements: [],
    });
    expect(lines(s)).toMatchObject({
      headline: 'Synced 2 min ago',
      rows: '1 transaction in this table; 1 arrived at the last sync',
    });
  });

  it('rows whose import date is not recorded: says so instead of inventing one', () => {
    const s = state({ rows: [txn(), txn({ subject: 'did:ad:row-2' })] });
    const status = syncStatusFor({ state: s, now: NOW });
    expect(status.last).toBeUndefined();
    expect(lines(s)).toMatchObject({
      headline: 'Not synced yet',
      rows: `2 transactions ${NO_DATES_SCOPE}`,
    });
    // The statements derived from the rows are not claimed as a date.
    expect(lines(s).rows).not.toContain('statement');
  });
});

describe('Money status card: busy, failed and stopped', () => {
  it('loading, with or without a total', () => {
    expect(
      lines(state({ view: { kind: 'loading', loaded: 0 } })),
    ).toMatchObject({
      tone: 'busy',
      headline: 'Loading transactions…',
    });
    expect(
      lines(state({ view: { kind: 'loading', loaded: 40, total: 120 } })),
    ).toMatchObject({ headline: 'Loading 40 of 120…' });
    expect(
      syncStatusFor({
        state: state({ view: { kind: 'loading', loaded: 0 } }),
        now: NOW,
      }).rows,
    ).toBeUndefined();
  });

  it("a load error: the failed sync, when it failed, and 'Try again.'", () => {
    const s = state({
      view: { kind: 'error', message: 'Table not found' },
      failedAt: NOW - 2 * MIN,
      rows: [],
    });
    const status = syncStatusFor({ state: s, now: NOW });
    expect(status.last).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error: `${LOAD_FAILED_LEAD} Table not found.`,
      nextStep: RETRY_STEP,
    });
    expect(lines(s)).toMatchObject({
      tone: 'neg',
      headline: 'Sync failed 2 min ago',
    });
    expect(lines(s).rows).toBeUndefined();
    // Without a recorded time (a state from before this version): now.
    expect(
      syncStatusFor({
        state: state({ view: { kind: 'error', message: 'x' } }),
        now: NOW,
      }).last,
    ).toMatchObject({ ok: false, at: NOW });
  });

  const file = { name: 'sept.sta', size: 1024, format: 'mt940' as const };

  it("an import's steps show as busy", () => {
    type Step = 'done' | 'now' | 'todo';
    const checking = (steps: [Step, Step, Step]) =>
      state({
        importing: { step: 'checking', file, lines: steps },
      });
    expect(lines(checking(['now', 'todo', 'todo'])).headline).toBe(
      'Reading the file…',
    );
    expect(lines(checking(['done', 'now', 'todo'])).headline).toBe(
      'Checking balances…',
    );
    expect(lines(checking(['done', 'done', 'now'])).headline).toBe(
      'Comparing with the table…',
    );
    const applying = state({
      importing: {
        step: 'preview',
        file,
        preview: {} as never,
        tab: 'new',
        applying: true,
        progress: { done: 3, total: 10 },
      },
    });
    expect(lines(applying).headline).toBe('Importing 3 of 10…');
    const previewOnly = state({
      importing: { step: 'preview', file, preview: {} as never, tab: 'new' },
    });
    expect(lines(previewOnly).headline).toBe('Not synced yet');
  });

  it('an import that stopped midway: a problem that says the written rows are kept', () => {
    const s = state({
      statements: [statement()],
      importing: {
        step: 'preview',
        file,
        preview: {} as never,
        tab: 'new',
        failure: 'The host refused the 4th row',
      },
    });
    const status = syncStatusFor({ state: s, now: NOW });
    expect(status.problems).toEqual([
      {
        tone: 'neg',
        lead: IMPORT_STOPPED_LEAD,
        text: 'The host refused the 4th row. The rows written so far are kept; check the same file again to import the rest.',
      },
    ]);
    expect(lines(s).tone).toBe('neg');
  });
});

describe('Money status card: incomplete rows', () => {
  it('groups them by what is missing, names them, and offers Open row for one', () => {
    const opened: string[] = [];
    const s = state({
      statements: [statement()],
      incomplete: [
        txn({
          subject: 'did:ad:inc-1',
          incomplete: 'Incomplete: missing Amount',
          amount: '',
          description: 'Half a row',
        }),
        txn({
          subject: 'did:ad:inc-2',
          incomplete: 'Incomplete: missing Amount',
          amount: '',
          description: '',
          reference: 'REF-9',
        }),
        txn({
          subject: 'did:ad:inc-3',
          incomplete: 'Incomplete: missing Account and Currency',
          account: '',
          currency: '',
          description: ' ',
          reference: '',
        }),
      ],
    });
    const status = syncStatusFor({
      state: s,
      now: NOW,
      onOpenRow: subject => opened.push(subject),
    });
    expect(status.ignored).toHaveLength(2);
    expect(status.ignored![0]).toMatchObject({
      count: 2,
      reason:
        'are incomplete (missing Amount): shown above the ledger, in no balance, total or import check.',
      items: ['Half a row', 'REF-9'],
    });
    expect(status.ignored![0].action).toBeUndefined();
    expect(status.ignored![1]).toMatchObject({
      count: 1,
      reason:
        'is incomplete (missing Account and Currency): shown above the ledger, in no balance, total or import check.',
      items: ['(no description)'],
    });
    expect(status.ignored![1].action?.label).toBe('Open row');
    status.ignored![1].action!.onClick();
    expect(opened).toEqual(['did:ad:inc-3']);
    // Incomplete rows are not in the rows line, and make the tone a note.
    expect(lines(s)).toMatchObject({
      tone: 'warn',
      rows: '1 transaction from 1 statement',
    });
  });

  it('offers no Open row when the host cannot show a row', () => {
    const s = state({
      canOpenRows: false,
      incomplete: [txn({ incomplete: 'Incomplete: missing Amount' })],
    });
    const status = syncStatusFor({ state: s, now: NOW, onOpenRow: () => {} });
    expect(status.ignored![0].action).toBeUndefined();
  });
});
