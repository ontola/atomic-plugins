// @wc-ignore-file
/**
 * `syncStatusFor`: the controller's states on the shared sync-status card
 * (Q-084), one case per `ViewState.kind`, then the write queue and the
 * problems. Pure: no DOM. The card's own rendering is tested in
 * `integrations/sync-status/card.test.ts`; its words in `statusLines`.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../../sync-status/card.js';
import type { FieldChange, RowChange } from '../changes.js';
import type { ConnectedState, ViewState } from '../controller.js';
import type { SyncRecord } from '../record.js';
import type { Row } from '../rows.js';
import type { SendOutcome } from '../send.js';
import type { DataSourceReport } from '../sync.js';
import type { Source } from './model.js';
import { NOTE, syncStatusFor } from './status.js';

const NOW = Date.parse('2026-10-06T10:16:00Z');
const MIN = 60_000;

const report = (
  id: string,
  title: string,
  extra: Partial<DataSourceReport> = {},
): DataSourceReport => ({
  id,
  title,
  pages: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  properties: [],
  formatted: [],
  archived: [],
  errors: [],
  ...extra,
});

const record: SyncRecord = {
  version: 1,
  at: NOW - 4 * MIN,
  durationMs: 3000,
  created: 1,
  updated: 2,
  unchanged: 3,
  dataSources: [report('d1', 'Roadmap')],
  general: [],
};

const row = (subject: string, name: string): Row => ({
  subject,
  name,
  pageId: subject,
  dataSource: 'Roadmap',
  values: {},
});
const rows = [row('p1', 'Launch plan'), row('p2', 'Write changelog')];
const sources: Source[] = [{ title: 'Roadmap', count: 2 }];

const field = (extra: Partial<FieldChange> = {}): FieldChange => ({
  id: 'pt',
  shortname: 'notion-pt',
  name: 'Points',
  type: 'number',
  before: 3,
  after: 5,
  ...extra,
});
const change = (
  subject: string,
  name: string,
  fields: FieldChange[],
): RowChange => ({
  subject,
  pageId: subject,
  name,
  dataSource: 'd1',
  dataSourceTitle: 'Roadmap',
  fields,
});

const ready: ConnectedState & { kind: 'ready' } = {
  kind: 'ready',
  connectionId: 'c',
  rows,
  last: record,
};

const status = (state: ViewState, extra: Partial<Source>[] = sources) =>
  syncStatusFor({ state, sources: extra as Source[], now: NOW });
const lines = (state: ViewState) => statusLines(status(state), NOW);

describe('syncStatusFor: every state', () => {
  it('loading, no-proxy, not-connected, connecting: read-only, no data', () => {
    for (const kind of ['loading', 'not-connected', 'connecting'] as const) {
      const s = status({ kind });
      expect(s).toMatchObject({ provider: 'Notion', writeBack: 'read-only' });
      expect(s.rows).toBeUndefined();
      expect(s.last).toBeUndefined();
      expect(s.writes).toBeUndefined();
    }

    expect(status({ kind: 'loading' }).writeBackNote).toBeUndefined();
    expect(status({ kind: 'not-connected' }).writeBackNote).toBe(
      NOTE['not-connected'],
    );
    expect(status({ kind: 'connecting' }).writeBackNote).toBe(
      NOTE['not-connected'],
    );
    expect(lines({ kind: 'no-proxy' }).mode).toBe(
      `Read-only: edits here stay in Atomic. ${NOTE['no-proxy']}`,
    );
  });

  it('ready without a record: not synced yet, write-back after review', () => {
    const s = status({ kind: 'ready', connectionId: 'c', rows: [] }, []);
    expect(s).toMatchObject({
      writeBack: 'after-review',
      rows: 0,
      rowsScope: 'in this table',
      writes: { pending: 0 },
    });
    expect(s.last).toBeUndefined();
    expect(s.writeBackNote).toBeUndefined();
    expect(s.problems).toBeUndefined();
    expect(lines({ kind: 'ready', connectionId: 'c', rows: [] })).toMatchObject(
      {
        tone: 'idle',
        headline: 'Not synced yet',
        mode: 'Edits here are sent to Notion after you review them.',
      },
    );
  });

  it('ready with a record: synced, the record counts, the row total', () => {
    const s = status(ready);
    expect(s.last).toEqual({
      ok: true,
      at: record.at,
      counts: { added: 1, updated: 2, unchanged: 3 },
    });
    expect(s.busy).toBeUndefined();
    expect(s.problems).toBeUndefined();
    expect(lines(ready)).toEqual({
      tone: 'ok',
      headline: 'Synced 4 min ago',
      counts: 'Last sync: 1 added, 2 updated, 3 unchanged',
      rows: '2 rows in this table',
      mode: 'Edits here are sent to Notion after you review them.',
    });
  });

  it('ready with shared databases but no pages: a problem with the next step', () => {
    const s = status({ ...ready, rows: [] });
    expect(s.rows).toBe(0);
    expect(s.problems).toEqual([
      {
        lead: 'The shared databases have no pages.',
        text: 'Add one in Notion, then sync again.',
      },
    ]);
    // No databases known yet (before the first sync): nothing to say.
    expect(status({ ...ready, rows: [] }, []).problems).toBeUndefined();
  });

  it('syncing: busy with the database being read; the record stays', () => {
    const s = status({
      ...ready,
      kind: 'syncing',
      progress: [
        { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 2 },
        { dataSource: 'd2', title: 'Reading list', phase: 'reading', pages: 1 },
      ],
    });
    expect(s.busy).toBe('Syncing… Reading list');
    expect(s.last).toMatchObject({ ok: true, at: record.at });
    expect(s.writeBackNote).toBeUndefined();
    expect(status({ ...ready, kind: 'syncing', progress: [] }).busy).toBe(
      'Syncing…',
    );
  });

  it('importing: busy, write-back after review', () => {
    const s = status({
      kind: 'importing',
      connectionId: 'c',
      rows: [],
      progress: [],
    });
    expect(s).toMatchObject({
      writeBack: 'after-review',
      busy: 'Importing…',
      rows: 0,
    });
    expect(s.last).toBeUndefined();
  });

  it('no-databases: the last good record, a problem, sending waits', () => {
    const empty = { ...record, dataSources: [] };
    const s = status({
      kind: 'no-databases',
      connectionId: 'c',
      rows,
      last: empty,
    });
    expect(s.writeBack).toBe('after-review');
    expect(s.writeBackNote).toBe(NOTE.waits);
    expect(s.last).toMatchObject({ ok: true, at: record.at });
    expect(s.problems).toEqual([
      {
        lead: 'Notion shares no database with Atomic any more.',
        text: 'Share a database with the integration in Notion, then sync again.',
      },
    ]);
  });

  it('disconnected: read-only with a note; rows and last good sync kept', () => {
    const state: ViewState = { kind: 'disconnected', rows, last: record };
    expect(status(state)).toMatchObject({
      writeBack: 'read-only',
      writeBackNote: NOTE.disconnected,
      rows: 2,
      last: { ok: true, at: record.at },
    });
    expect(lines(state).headline).toBe('Synced 4 min ago');
  });

  it('reauth: read-only, a failed sync naming the last good one', () => {
    const state: ViewState = {
      kind: 'reauth',
      at: NOW - MIN,
      connectionId: 'c',
      rows,
      last: record,
    };
    expect(status(state)).toMatchObject({
      writeBack: 'read-only',
      writeBackNote: NOTE.reauth,
      last: {
        ok: false,
        at: NOW - MIN,
        error: 'Notion no longer gives Atomic access.',
        nextStep: 'Reconnect Notion.',
        lastGood: record.at,
      },
    });
    expect(lines(state)).toMatchObject({
      tone: 'neg',
      headline: 'Sync failed 1 min ago',
    });
  });

  it('rate-limited: a failed sync with the retry time; sending waits', () => {
    const s = syncStatusFor({
      state: {
        kind: 'rate-limited',
        at: NOW,
        connectionId: 'c',
        rows,
        last: record,
        retryAt: Date.parse('2026-10-06T10:17:00Z'),
        pagesRead: 3,
        technical: '',
      },
      sources,
      now: NOW,
      locale: 'en-GB',
    });
    expect(s.writeBack).toBe('after-review');
    expect(s.writeBackNote).toBe(NOTE.waits);
    expect(s.last).toMatchObject({
      ok: false,
      at: NOW,
      error: 'Notion asked Atomic to slow down.',
      lastGood: record.at,
    });
    expect((s.last as { nextStep: string }).nextStep).toMatch(
      /^It tries again at \d\d:\d\d\.$/,
    );
  });

  it('failed: the title, Try again, the last good sync (or none)', () => {
    const failed: ViewState = {
      kind: 'failed',
      at: NOW - 2 * MIN,
      connectionId: 'c',
      rows,
      last: record,
      title: 'Notion didn’t answer properly',
      message: 'Error (502).',
      technical: 'POST /v1/search → 502',
    };
    expect(status(failed).last).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error: 'Notion didn’t answer properly',
      nextStep: 'Try again.',
      lastGood: record.at,
    });
    expect(status(failed).writeBackNote).toBe(NOTE.waits);
    expect(lines(failed).headline).toBe('Sync failed 2 min ago');
    // The first sync ever failed: no good sync to name.
    const first = { ...failed, rows: [], last: undefined };
    expect(status(first, []).last).not.toHaveProperty('lastGood');
  });

  it('a connected state without a connection id is read-only', () => {
    expect(status({ kind: 'ready', rows, last: record })).toMatchObject({
      writeBack: 'read-only',
      writeBackNote: NOTE.disconnected,
    });
  });
});

describe('syncStatusFor: the write queue', () => {
  const changes = [
    change('p1', 'Launch plan', [field(), field({ id: 'st', name: 'Status' })]),
    change('p2', 'Write changelog', [field({ conflict: true, notion: 7 })]),
    change('p3', 'Retrospective', [
      field({ problem: 'holds 2 options; Notion’s Status takes one' }),
    ]),
  ];

  it('counts fields as the strip does, with held conflicts and problems', () => {
    expect(status({ ...ready, changes }).writes).toEqual({
      pending: 4,
      held: 2,
    });
    expect(lines({ ...ready, changes }).tone).toBe('warn');
  });

  it('while sending: busy with the position in the sendable changes', () => {
    const sent: SendOutcome = {
      subject: 'p1',
      name: 'Launch plan',
      status: 'sent',
      fields: 2,
    };
    expect(
      status({ ...ready, changes, sending: true, outcomes: [] }).busy,
    ).toBe('Sending 1 of 1 to Notion…');
    expect(
      status({ ...ready, changes, sending: true, outcomes: [sent] }).busy,
    ).toBe('Sending 1 of 1 to Notion…');
    expect(status({ ...ready, sending: true }).busy).toBe('Sending to Notion…');
  });

  it('outcomes: failed and refused as failures, written apart; unknown uncertain; changed and gone not written', () => {
    const outcomes: SendOutcome[] = [
      { subject: 'p1', name: 'Launch plan', status: 'sent', fields: 1 },
      {
        subject: 'p2',
        name: 'Write changelog',
        status: 'refused',
        message: 'Status: holds an option Notion’s Status does not have.',
      },
      {
        subject: 'p3',
        name: 'Retrospective',
        status: 'refused',
        written: true,
        message:
          'Sent to Notion, but this row could not be updated here: offline. The next sync reads it back.',
      },
      {
        subject: 'p4',
        name: 'Hiring',
        status: 'unknown',
        message: 'No answer from Notion.',
      },
      { subject: 'p5', name: 'Budget', status: 'changed', notion: {} },
      { subject: 'p6', name: 'Offsite', status: 'gone' },
      { subject: '', name: '', status: 'failed', message: 'Relay refused.' },
    ];
    const s = status({ ...ready, outcomes });
    expect(s.writes).toEqual({
      pending: 0,
      failed: [
        {
          title: 'Write changelog',
          reason: 'Status: holds an option Notion’s Status does not have.',
        },
        {
          title: 'Retrospective',
          reason:
            'Sent to Notion, but this row could not be updated here: offline. The next sync reads it back.',
          written: true,
        },
        { title: 'The send', reason: 'Relay refused.' },
      ],
      uncertain: 1,
      notWritten: 2,
    });
    expect(lines({ ...ready, outcomes }).tone).toBe('neg');
  });

  it('a send with only sent outcomes leaves a clean card', () => {
    const outcomes: SendOutcome[] = [
      { subject: 'p1', name: 'Launch plan', status: 'sent', fields: 1 },
    ];
    expect(status({ ...ready, outcomes }).writes).toEqual({ pending: 0 });
    expect(lines({ ...ready, outcomes }).tone).toBe('ok');
  });
});

describe('syncStatusFor: the record’s notes', () => {
  it('per-database notes become one problem that opens Sync details', () => {
    const noted: SyncRecord = {
      ...record,
      dataSources: [
        report('d1', 'Roadmap', {
          formatted: [
            { page: 'p1', title: 'Launch plan', property: 'Notes' },
            { page: 'p2', title: 'Write changelog', property: 'Notes' },
          ],
          archived: ['p9'],
          errors: ['Could not read page p7'],
        }),
      ],
    };
    let opened = 0;
    const s = syncStatusFor({
      state: { ...ready, last: noted },
      sources,
      now: NOW,
      onDetails: () => opened++,
    });
    expect(s.problems).toHaveLength(1);
    expect(s.problems![0]).toMatchObject({
      lead: '3 notes from the last sync.',
      action: { label: 'Sync details', key: 'ss-details' },
    });
    s.problems![0].action!.onClick();
    expect(opened).toBe(1);
    // Without a way to open the panel, the line stands alone.
    expect(
      status({ ...ready, last: noted }).problems![0].action,
    ).toBeUndefined();
  });

  it('general warnings are listed one by one, before the notes', () => {
    const warned: SyncRecord = {
      ...record,
      general: ['The read was incomplete: 1 of 2 databases was skipped.'],
      dataSources: [
        report('d1', 'Roadmap', {
          formatted: [{ page: 'p1', title: 'Launch plan', property: 'Notes' }],
        }),
      ],
    };
    expect(status({ ...ready, last: warned }).problems).toEqual([
      {
        lead: 'From the last sync:',
        text: 'The read was incomplete: 1 of 2 databases was skipped.',
      },
      expect.objectContaining({ lead: '1 note from the last sync.' }),
    ]);
    expect(lines({ ...ready, last: warned }).tone).toBe('warn');
  });
});
