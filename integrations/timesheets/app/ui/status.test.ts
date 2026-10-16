// @wc-ignore-file
/**
 * `status.ts`: the controller's state, the timesheet and the changes list
 * mapped onto the shared sync-status card's model, without a DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesState, SyncOutcome, ViewState } from '../controller.js';
import type { Timesheet } from '../model/types.js';
import type { SyncResult } from '../sync.js';
import type { SendOutcome } from '../writeBack.js';
import {
  hidesTail,
  hours,
  NEXT_STEP,
  NO_PROXY_NOTE,
  syncStatusFor,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
// `syncStatusFor` falls back to `Date.now()` where a test passes no `now`, so
// the clock is pinned to NOW: without it a fixture like "a lease until NOW +
// 60 s" turns into the past once the real date passes NOW.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CONNECTION = { platform: 'clockify', connectionId: 'c1' };
const SETTINGS = { workspaceId: 'ws', userId: 'u', lookbackDays: 7 as const };
const NO_CHANGES: ChangesState = { review: [], providerWon: [], recovered: [] };

const entry = (id: string, start: number) => ({
  id,
  description: id,
  start,
  end: start + HOUR,
  billable: false,
});

function sheet(over: Partial<Timesheet> = {}): Timesheet {
  return {
    entries: [
      entry('a', NOW - DAY),
      entry('b', NOW - 2 * DAY),
      entry('old', NOW - 20 * DAY),
    ],
    running: 0,
    breaks: 0,
    window: { from: NOW - 7 * DAY, to: NOW },
    weekStart: 'MONDAY',
    timeZone: 'UTC',
    unknown: [],
    conflicts: [],
    ...over,
  };
}

const result = (over: Partial<SyncResult> = {}) =>
  ({
    created: 1,
    updated: 0,
    unchanged: 1,
    removed: 0,
    kept: 0,
    review: [],
    providerWon: [],
    recovered: [],
    warnings: [],
    log: {
      incrementals: 0,
      snapshotWritten: false,
      candidates: 0,
      unknownMs: 0,
    },
    account: {},
    ...over,
  }) as SyncResult;

const ready = (last?: SyncOutcome): ViewState => ({
  kind: 'ready',
  connection: CONNECTION,
  settings: SETTINGS,
  ...(last ? { last } : {}),
});

describe('syncStatusFor', () => {
  it('ready after a sync: write-back after review, counts, the entries in the window', () => {
    const status = syncStatusFor({
      state: ready({ ok: true, at: NOW - 60_000, result: result() }),
      sheet: sheet(),
      changes: NO_CHANGES,
    });
    expect(status).toEqual({
      provider: 'Clockify',
      writeBack: 'after-review',
      rowNoun: ['entry', 'entries'],
      rows: 2,
      rowsScope: 'in the last 7 days',
      last: {
        ok: true,
        at: NOW - 60_000,
        counts: { added: 1, updated: 0, unchanged: 1 },
      },
      writes: { pending: 0 },
    });
  });

  it('before this page load synced: the last complete read, without counts', () => {
    const checked = new Date(NOW - 3 * HOUR).toISOString();
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet({ lastChecked: checked }),
      changes: NO_CHANGES,
    });
    expect(status.last).toEqual({ ok: true, at: NOW - 3 * HOUR });
    expect(
      syncStatusFor({ state: ready(), sheet: sheet(), changes: NO_CHANGES })
        .last,
    ).toBe(undefined);
  });

  it('a failed sync: the error and the next step for its kind', () => {
    const status = syncStatusFor({
      state: ready({
        ok: false,
        at: NOW,
        error: 'HTTP 401',
        problem: { kind: 'reauth', detail: 'HTTP 401' },
      }),
      sheet: sheet(),
      changes: NO_CHANGES,
    });
    expect(status.last).toEqual({
      ok: false,
      at: NOW,
      error: 'HTTP 401',
      nextStep: 'Reconnect Clockify.',
    });
    expect(Object.keys(NEXT_STEP).sort()).toEqual(
      [
        'forbidden',
        'network',
        'other',
        'rate-limited',
        'reauth',
        'too-many',
      ].sort(),
    );
  });

  it('syncing and sending are busy', () => {
    expect(
      syncStatusFor({
        state: { kind: 'syncing', connection: CONNECTION, settings: SETTINGS },
        sheet: sheet(),
        changes: NO_CHANGES,
      }).busy,
    ).toBe('Syncing…');
    expect(
      syncStatusFor({
        state: ready(),
        sheet: sheet(),
        changes: { ...NO_CHANGES, sending: { done: 1, total: 3 } },
      }).busy,
    ).toBe('Sending 2 of 3 to Clockify…');
  });

  it('the write queue: pending, held, failed and uncertain from the changes list', () => {
    const change = (entryId: string, blockers: string[] = []) =>
      ({
        entryId,
        blockers,
        kind: 'update',
        title: entryId,
      }) as ChangesState['review'][number];
    const outcome = (
      title: string,
      status: SendOutcome['status'],
      message?: string,
    ) =>
      ({
        entryId: title,
        title,
        kind: 'update',
        status,
        ...(message ? { message } : {}),
      }) as SendOutcome;
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet(),
      changes: {
        ...NO_CHANGES,
        review: [change('a'), change('b', ['It is locked in Clockify.'])],
        outcomes: {
          at: NOW,
          results: [
            outcome('Weekly sync', 'failed', 'HTTP 500'),
            outcome('Standup', 'refused'),
            outcome('Review', 'uncertain'),
            outcome('Later', 'not-sent'),
            outcome('Fine', 'sent'),
            outcome('Same', 'already'),
          ],
        },
      },
    });
    // `not-sent` (the rest of the batch after the uncertain one) is not
    // uncertain: the change stays in the review, so it is in `pending`.
    expect(status.writes).toEqual({
      pending: 2,
      held: 1,
      failed: [
        { title: 'Weekly sync', reason: 'HTTP 500' },
        { title: 'Standup', reason: 'Clockify does not allow this change.' },
      ],
      uncertain: 1,
    });
    expect(status.problems).toBe(undefined);
  });

  it('the lease held by another copy: changes stay pending, one problem names it, nothing is "uncertain"', () => {
    // As `lease.ts` `heldMessage` words it.
    const held =
      'Another open copy of this app (another device or tab) is sending changes to Clockify. Nothing was sent; try again after 12:05:00, when its turn ends at the latest.';
    const outcome = (title: string) =>
      ({
        entryId: title,
        title,
        kind: 'update',
        status: 'not-sent',
        message: held,
      }) as SendOutcome;
    const change = (entryId: string) =>
      ({
        entryId,
        blockers: [],
        kind: 'update',
        title: entryId,
      }) as ChangesState['review'][number];
    const status = syncStatusFor({
      state: ready({
        ok: true,
        at: NOW,
        result: result({
          sendingElsewhereUntil: new Date(NOW + 60_000).toISOString(),
        }),
      }),
      sheet: sheet(),
      changes: {
        ...NO_CHANGES,
        review: [change('a'), change('b')],
        outcomes: { at: NOW, results: [outcome('a'), outcome('b')] },
      },
    });
    expect(status.writes).toEqual({ pending: 2 });
    expect(status.problems).toEqual([
      {
        lead: 'Another open copy of this app is sending changes to Clockify.',
        text: 'Nothing was sent; try again after 12:05:00, when its turn ends at the latest.',
      },
    ]);
  });

  it('a held lease is a problem only until its turn ends; a settled sync carries no lease problem', () => {
    const until = new Date(NOW + 60_000).toISOString();
    const held = `Another open copy of this app (another device or tab) is sending changes to Clockify. Nothing was sent; try again after 12:01:00, when its turn ends at the latest.`;
    const outcome = {
      entryId: 'a',
      title: 'a',
      kind: 'update',
      status: 'not-sent',
      message: held,
      until,
    } as SendOutcome;
    const changes = {
      ...NO_CHANGES,
      review: [
        {
          entryId: 'a',
          blockers: [],
          kind: 'update',
          title: 'a',
        } as ChangesState['review'][number],
      ],
      outcomes: { at: NOW, results: [outcome] },
    };
    const live = syncStatusFor({
      state: ready(),
      sheet: sheet(),
      changes,
      now: NOW,
    });
    expect(live.problems).toHaveLength(1);
    // Its turn has ended: the outcome is still listed, the problem is not.
    const over = syncStatusFor({
      state: ready(),
      sheet: sheet(),
      changes,
      now: NOW + 61_000,
    });
    expect(over.problems).toBe(undefined);
    expect(over.writes).toEqual({ pending: 1 });
    // The sync's own "sending elsewhere" is timed the same way.
    const elsewhere = (now: number) =>
      syncStatusFor({
        state: ready({
          ok: true,
          at: NOW,
          result: result({ sendingElsewhereUntil: until }),
        }),
        sheet: sheet(),
        changes: NO_CHANGES,
        now,
      }).problems;
    expect(elsewhere(NOW)).toHaveLength(1);
    expect(elsewhere(NOW + 61_000)).toBe(undefined);
  });

  it('a failure after the write stood is marked written', () => {
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet(),
      changes: {
        ...NO_CHANGES,
        outcomes: {
          at: NOW,
          results: [
            {
              entryId: 'a',
              title: 'Weekly sync',
              kind: 'update',
              status: 'failed',
              message: 'Clockify no longer lists it as a completed entry.',
              written: true,
            },
            {
              entryId: 'b',
              title: 'Standup',
              kind: 'update',
              status: 'failed',
              message: 'HTTP 400',
            },
          ] as SendOutcome[],
        },
      },
    });
    expect(status.writes!.failed).toEqual([
      {
        title: 'Weekly sync',
        reason: 'Clockify no longer lists it as a completed entry.',
        written: true,
      },
      { title: 'Standup', reason: 'HTTP 400' },
    ]);
  });

  it('the settings sheet over a failed sync still shows the failure', () => {
    const failed: SyncOutcome = {
      ok: false,
      at: NOW,
      error: 'HTTP 401',
      problem: { kind: 'reauth', detail: 'HTTP 401' },
    };
    const status = syncStatusFor({
      state: {
        kind: 'setup',
        connection: CONNECTION,
        draft: SETTINGS,
        last: failed,
      },
      sheet: sheet({ lastChecked: new Date(NOW - HOUR).toISOString() }),
      changes: NO_CHANGES,
    });
    expect(status.last).toEqual({
      ok: false,
      at: NOW,
      error: 'HTTP 401',
      nextStep: 'Reconnect Clockify.',
      lastGood: NOW - HOUR,
    });
  });

  it('sends that wrote nothing for another reason are counted, and a changes error is a problem', () => {
    const outcome = (title: string, status: SendOutcome['status']) =>
      ({ entryId: title, title, kind: 'update', status }) as SendOutcome;
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet(),
      changes: {
        ...NO_CHANGES,
        error: 'Not sent. The row is kept as it is.',
        outcomes: {
          at: NOW,
          results: [
            outcome('a', 'conflict'),
            outcome('b', 'changed'),
            outcome('c', 'gone'),
            outcome('d', 'adjusted'),
            outcome('e', 'bound'),
            outcome('f', 'sent'),
          ],
        },
      },
    });
    expect(status.writes).toEqual({ pending: 0, notWritten: 3 });
    expect(status.problems).toEqual([
      {
        lead: 'The last edit or send could not be saved or started.',
        text: 'Not sent. The row is kept as it is.',
        tone: 'neg',
      },
    ]);
  });

  it('without a proxy relay (frame K): read-only, with the reason', () => {
    const status = syncStatusFor({
      state: { kind: 'no-proxy' },
      sheet: sheet({ lastChecked: new Date(NOW - HOUR).toISOString() }),
      changes: NO_CHANGES,
    });
    expect(status.writeBack).toBe('read-only');
    expect(status.writeBackNote).toBe(NO_PROXY_NOTE);
    // What was read earlier is still shown, with when.
    expect(status.last).toEqual({ ok: true, at: NOW - HOUR });
    expect(status.writes).toEqual({ pending: 0 });
    // The settings sheet over the data (`setup`) keeps write-back.
    expect(
      syncStatusFor({
        state: { kind: 'setup', connection: CONNECTION, draft: {} },
        sheet: sheet(),
        changes: NO_CHANGES,
      }).writeBack,
    ).toBe('after-review');
  });

  it('a failed sync after a gap: the tail since the last good read is not loaded, and the last good sync is named', () => {
    const checked = NOW - 3 * DAY;
    const gap = [{ from: checked, to: NOW }];
    const failed = ready({
      ok: false,
      at: NOW,
      error: 'HTTP 503',
      problem: { kind: 'other', detail: 'HTTP 503' },
    });
    const after = syncStatusFor({
      state: failed,
      sheet: sheet({
        lastChecked: new Date(checked).toISOString(),
        unknown: gap,
      }),
      changes: NO_CHANGES,
    });
    expect(after.last).toEqual({
      ok: false,
      at: NOW,
      error: 'HTTP 503',
      nextStep: 'Try again.',
      lastGood: checked,
    });
    expect(after.problems![0].lead).toBe(
      '72 h of the last 7 days not loaded yet.',
    );
    // The same tail after a successful sync: covered by "Synced just now".
    const ok = syncStatusFor({
      state: ready({ ok: true, at: NOW, result: result() }),
      sheet: sheet({
        lastChecked: new Date(checked).toISOString(),
        unknown: gap,
      }),
      changes: NO_CHANGES,
    });
    expect(ok.problems).toBe(undefined);
    // Before any sync of this page load the tail is shown too.
    expect(hidesTail(ready())).toBe(false);
    expect(hidesTail(failed)).toBe(false);
    expect(hidesTail(ready({ ok: true, at: NOW, result: result() }))).toBe(
      true,
    );
    expect(
      hidesTail({
        kind: 'syncing',
        connection: CONNECTION,
        settings: SETTINGS,
      }),
    ).toBe(true);
    expect(hidesTail({ kind: 'no-proxy' })).toBe(false);
  });

  it('ignored: incomplete rows (with Open row for one), running timers, breaks, locked and custom-field entries', () => {
    const opened: string[] = [];
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet({
        incomplete: [
          { id: 'row-1', description: '', note: 'Incomplete: missing Start' },
        ],
        running: 1,
        breaks: 2,
        uneditable: { locked: 1, customFields: 3 },
      }),
      changes: NO_CHANGES,
      onOpenRow: id => opened.push(id),
    });
    const groups = status.ignored!;
    expect(groups.map(g => [g.count, g.reason])).toEqual([
      [
        1,
        'is incomplete (missing Start): not counted and not sent to Clockify. Fill the column in the table.',
      ],
      [1, 'is a running timer: counted, and shown once stopped in Clockify.'],
      [2, 'are breaks: shown on the timeline, not as time worked.'],
      [1, 'is locked in Clockify: shown, but cannot be edited here.'],
      [3, 'have custom fields: shown, but cannot be edited here yet.'],
    ]);
    expect(groups[0].items).toEqual(['(no description)']);
    groups[0].action!.onClick();
    expect(opened).toEqual(['row-1']);
    expect(groups[0].action!.key).toBe('ss-open-row:row-1');
    // Two incomplete rows: listed, no single Open row.
    const two = syncStatusFor({
      state: ready(),
      sheet: sheet({
        incomplete: [
          { id: 'r1', description: 'x', note: 'Incomplete: missing Start' },
          { id: 'r2', description: 'y', note: 'Incomplete: missing Start' },
        ],
      }),
      changes: NO_CHANGES,
      onOpenRow: id => opened.push(id),
    }).ignored![0];
    expect(two.count).toBe(2);
    expect(two.items).toEqual(['x', 'y']);
    expect(two.action).toBe(undefined);
    expect(
      syncStatusFor({ state: ready(), sheet: sheet(), changes: NO_CHANGES })
        .ignored,
    ).toBe(undefined);
  });

  it('not loaded time in the window is a problem with Sync now; slivers are not', () => {
    let synced = 0;
    const status = syncStatusFor({
      state: ready(),
      sheet: sheet({
        unknown: [
          { from: NOW - 3 * HOUR, to: NOW - HOUR - 30 * 60_000 },
          { from: NOW - 10_000, to: NOW },
        ],
      }),
      changes: NO_CHANGES,
      onSync: () => synced++,
    });
    expect(status.problems).toHaveLength(1);
    const [problem] = status.problems!;
    expect(problem.lead).toBe('90 min of the last 7 days not loaded yet.');
    expect(problem.text).toContain('Sync now to load it.');
    expect(problem.action!.label).toBe('Sync now');
    expect(problem.action!.disabled).toBe(false);
    problem.action!.onClick();
    expect(synced).toBe(1);
    expect(
      syncStatusFor({
        state: ready(),
        sheet: sheet({ unknown: [{ from: NOW - 10_000, to: NOW }] }),
        changes: NO_CHANGES,
      }).problems,
    ).toBe(undefined);
    expect(hours(90 * 60_000)).toBe('90 min');
    expect(hours(6 * HOUR)).toBe('6 h');
    expect(hours(2.5 * HOUR)).toBe('2.5 h');
  });

  it('another copy sending is a problem to wait out', () => {
    const status = syncStatusFor({
      state: ready({
        ok: true,
        at: NOW,
        result: result({
          sendingElsewhereUntil: new Date(NOW + 60_000).toISOString(),
        }),
      }),
      sheet: sheet(),
      changes: NO_CHANGES,
    });
    expect(status.problems![0].lead).toBe(
      'Another open copy of this app is sending changes to Clockify.',
    );
  });

  it('as the view of a table that is not synced: read-only, no last sync, no queue, no not-loaded problem', () => {
    const status = syncStatusFor({
      state: { kind: 'local', tableName: 'Hours', canSync: true },
      sheet: sheet({
        window: undefined,
        lastChecked: new Date(NOW).toISOString(),
        unknown: [{ from: NOW - 3 * HOUR, to: NOW }],
      }),
      changes: NO_CHANGES,
    });
    expect(status).toEqual({
      provider: 'Clockify',
      writeBack: 'read-only',
      rowNoun: ['entry', 'entries'],
      rows: 3,
      rowsScope: 'in this table',
    });
    expect(
      syncStatusFor({
        state: {
          kind: 'local',
          tableName: 'Hours',
          canSync: true,
          paused: true,
        },
        sheet: sheet(),
        changes: NO_CHANGES,
      }).writeBackNote,
    ).toBe('Syncing with Clockify is paused.');
  });
});
