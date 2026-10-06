// @wc-ignore-file
/**
 * `status.ts`: every controller state mapped onto the shared sync-status
 * card's model, without a DOM, and the words the card then says
 * (`statusLines`). The card itself is tested in `sync-status/card.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import { clockTime, type ViewState } from './controller.js';
import {
  ignoredGroups,
  nextStep,
  NO_RELAY_NOTE,
  OTHER_TABLE_NOTE,
  syncStatusFor,
  WRITE_BACK_NOTE,
} from './status.js';
import type { SyncSummary, TaskRow } from './sync.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const LAST_GOOD = '2026-10-04T09:30:00.000Z';
const CONNECTION = { platform: 'todoist', connectionId: 'c1' };
const WORDS = { locale: 'en-GB', timeZone: 'UTC' };

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  subject: `did:ad:${id}`,
  taskId: id,
  name: `Task ${id}`,
  done: false,
  presence: 'active',
  ...over,
});

const TASKS: TaskRow[] = [
  task('1'),
  task('2'),
  task('3', { presence: 'completed', done: true }),
  task('4', { presence: 'unavailable' }),
  {
    subject: 'did:ad:local',
    name: 'Written here',
    done: false,
    presence: 'local',
  },
];

const summary = (over: Partial<SyncSummary> = {}): SyncSummary => ({
  total: 4,
  added: 1,
  updated: 2,
  unchanged: 1,
  presence: {
    active: 2,
    completed: 1,
    deleted: 0,
    unavailable: 1,
    unconfirmed: 0,
  },
  reappeared: 0,
  checked: 1,
  complete: true,
  ...over,
});

const synced = (over: Partial<SyncSummary> = {}): ViewState => ({
  kind: 'synced',
  connection: CONNECTION,
  at: new Date(NOW - 4 * MINUTE),
  summary: summary(over),
  tasks: TASKS,
  lastGood: '2026-10-06T11:56:00.000Z',
});

const lines = (state: ViewState) =>
  statusLines(syncStatusFor({ state, now: NOW, ...WORDS }), NOW);

describe('syncStatusFor', () => {
  it('is read-only in every state, and says local edits are overwritten wherever it syncs', () => {
    const syncing: ViewState[] = [
      { kind: 'loading' },
      { kind: 'disconnected', tasks: [] },
      { kind: 'connecting', tasks: [] },
      { kind: 'syncing', connection: CONNECTION, tasks: TASKS },
      synced(),
      { kind: 'error', message: 'x', at: NOW, tasks: TASKS },
    ];
    const never: [ViewState, string][] = [
      [{ kind: 'other-table' }, OTHER_TABLE_NOTE],
      [{ kind: 'no-relay' }, NO_RELAY_NOTE],
    ];

    for (const [state, note] of [
      ...syncing.map((s): [ViewState, string] => [s, WRITE_BACK_NOTE]),
      ...never,
    ]) {
      const status = syncStatusFor({ state });
      expect(status.provider).toBe('Todoist');
      expect(status.writeBack).toBe('read-only');
      expect(status.writeBackNote).toBe(note);
      expect(status.writes).toBeUndefined();
      const { mode } = statusLines(status, NOW);
      expect(mode).toMatch(/^Read-only: edits here stay in Atomic\./);
      expect(mode).toContain(note);
    }

    for (const state of syncing) {
      const { mode } = lines(state);
      expect(mode).toContain('Nothing is sent to Todoist.');
      expect(mode).toContain('overwritten at the next sync');
    }

    // Where this app never syncs, the card does not promise a next sync.
    for (const [state] of never) {
      const { mode } = lines(state);
      expect(mode).not.toContain('next sync');
      expect(mode).toContain('nothing');
    }
  });

  it('after a sync: the headline, counts, the task count and the #99 groups', () => {
    const status = syncStatusFor({ state: synced() });
    expect(status.rows).toBe(4);
    expect(status.rowsScope).toBe('from Todoist');
    expect(status.last).toEqual({
      ok: true,
      at: NOW - 4 * MINUTE,
      counts: { added: 1, updated: 2, unchanged: 1 },
    });
    expect(status.problems).toBeUndefined();
    expect(status.ignored).toEqual([
      {
        count: 1,
        reason: 'is completed in Todoist: closed here and kept in the table.',
        items: ['Task 3'],
      },
      {
        count: 1,
        reason:
          'can no longer be reached in Todoist (gone, or no access): kept here, open, with the last values Todoist sent; not closed.',
        items: ['Task 4'],
      },
      {
        count: 1,
        reason:
          'was added here, not in Todoist: kept as it is; nothing is sent to Todoist.',
        items: ['Written here'],
      },
    ]);
    const words = lines(synced());
    expect(words.headline).toBe('Synced 4 min ago');
    expect(words.counts).toBe('Last sync: 1 added, 2 updated, 1 unchanged');
    expect(words.rows).toBe('4 tasks from Todoist');
    // Settled tasks and a hand-made row are notes, not trouble.
    expect(words.tone).toBe('warn');
  });

  it('is plainly ok when every task is active and nothing was left out', () => {
    const state: ViewState = {
      ...synced({
        presence: {
          active: 2,
          completed: 0,
          deleted: 0,
          unavailable: 0,
          unconfirmed: 0,
        },
      }),
      tasks: [task('1'), task('2')],
    };
    const status = syncStatusFor({ state });
    expect(status.ignored).toBeUndefined();
    expect(lines(state).tone).toBe('ok');
  });

  it('groups deleted, unconfirmed and incomplete rows, with Open row on one incomplete row', () => {
    const opened: string[] = [];
    const tasks: TaskRow[] = [
      task('5', { presence: 'deleted' }),
      task('6', { presence: 'unconfirmed' }),
      task('7', { presence: 'unconfirmed' }),
      {
        subject: 'did:ad:nameless',
        name: '',
        done: false,
        presence: 'local',
        incomplete: 'Incomplete: missing Name',
      },
    ];
    const groups = ignoredGroups(tasks, s => opened.push(s));
    expect(groups.map(g => [g.count, g.reason.split(':')[0], g.items])).toEqual(
      [
        [1, 'was deleted in Todoist', ['Task 5']],
        [2, 'could not be checked in Todoist', ['Task 6', 'Task 7']],
        [1, 'is incomplete (missing Name)', ['(no name)']],
      ],
    );
    expect(groups[1].reason).toContain('checked again at the next sync');
    const incomplete = groups[2];
    expect(incomplete.action?.label).toBe('Open row');
    expect(incomplete.action?.key).toBe('ss-open-row:did:ad:nameless');
    incomplete.action?.onClick();
    expect(opened).toEqual(['did:ad:nameless']);
    // No host way to a row, or several rows: no button.
    expect(ignoredGroups(tasks)[2].action).toBeUndefined();
    expect(
      ignoredGroups(
        [...tasks, { ...tasks[3], subject: 'did:ad:other' }],
        () => {},
      )[2].action,
    ).toBeUndefined();
    // An incomplete row is not counted again as "added here".
    expect(groups.some(g => /added here/.test(g.reason))).toBe(false);
  });

  it('names a partial read as a problem over an otherwise good sync, with the last complete read', () => {
    const state = synced({ complete: false });
    const status = syncStatusFor({ state, now: NOW });
    expect(status.last?.ok).toBe(true);
    expect(status.problems).toEqual([
      expect.objectContaining({
        lead: 'The read was partial, so no missing task was checked.',
        text: expect.stringContaining('cap of 50'),
      }),
    ]);
    expect(status.problems?.[0].text).toContain(
      'The last complete read was 4 min ago.',
    );
    expect(lines(state).tone).toBe('warn');

    const { lastGood: _, ...fresh } = state as ViewState & {
      lastGood?: string;
    };
    const first = syncStatusFor({ state: fresh as ViewState, now: NOW });
    expect(first.problems?.[0].text).toContain(
      'There has been no complete read yet.',
    );
  });

  it('shows a failed sync with the next step and the last good read', () => {
    const base = {
      kind: 'error' as const,
      connection: CONNECTION,
      at: NOW - MINUTE,
      tasks: TASKS,
      lastGood: LAST_GOOD,
    };
    const cases: [number | undefined, string, string][] = [
      [
        401,
        'Todoist refused tasks page 1 (401); reconnect Todoist.',
        'Reconnect Todoist.',
      ],
      [403, 'Todoist refused (403).', 'Reconnect Todoist.'],
      [
        503,
        'Todoist answered 503 for tasks page 1.',
        'Todoist had a problem; try again in a moment.',
      ],
      [undefined, 'host offline', 'Check your connection, then try again.'],
      [400, 'Todoist answered 400 for projects page 1.', 'Try again.'],
    ];

    for (const [status, message, step] of cases) {
      const state: ViewState = {
        ...base,
        message,
        ...(status === undefined ? {} : { status }),
      };
      const mapped = syncStatusFor({ state });
      expect(mapped.last).toEqual({
        ok: false,
        at: NOW - MINUTE,
        error: message,
        nextStep: step,
        lastGood: Date.parse(LAST_GOOD),
      });
      expect(nextStep(status)).toBe(step);
      const words = lines(state);
      expect(words.headline).toBe('Sync failed 1 min ago');
      expect(words.tone).toBe('neg');
      // The table's rows are still named.
      expect(words.rows).toBe('4 tasks from Todoist');
    }

    // Never synced: no last good read to name.
    const fresh = syncStatusFor({
      state: { kind: 'error', message: 'x', at: NOW, tasks: [] },
    });
    expect(fresh.last).not.toHaveProperty('lastGood');
  });

  it('says a rate limit is retried by itself, or that the sync stopped and when to try again', () => {
    const retryAt = NOW + 90_000;
    const time = clockTime(retryAt, WORDS);
    expect(time).toBe('12:01');
    const retrying = syncStatusFor({
      state: {
        kind: 'error',
        connection: CONNECTION,
        message: 'Todoist is rate-limiting this app (429 for /api/v1/tasks).',
        at: NOW,
        status: 429,
        rateLimited: { retryAt, retrying: true },
        tasks: TASKS,
        lastGood: LAST_GOOD,
      },
      ...WORDS,
    });
    expect(retrying.last).toEqual({
      ok: false,
      at: NOW,
      error: 'Todoist is rate-limiting; retrying at 12:01.',
      lastGood: Date.parse(LAST_GOOD),
    });

    const stopped = syncStatusFor({
      state: {
        kind: 'error',
        connection: CONNECTION,
        message: 'Todoist is rate-limiting this app (429 for /api/v1/tasks).',
        at: NOW,
        status: 429,
        rateLimited: { retryAt, retrying: false },
        tasks: TASKS,
      },
      ...WORDS,
    });
    expect(stopped.last).toEqual({
      ok: false,
      at: NOW,
      error: 'Todoist is rate-limiting; the sync stopped.',
      nextStep: 'Try again after 12:01.',
    });
  });

  it('before this page load has synced: the last good read, without counts', () => {
    const disconnected: ViewState = {
      kind: 'disconnected',
      tasks: TASKS,
      lastGood: LAST_GOOD,
    };
    const status = syncStatusFor({ state: disconnected });
    expect(status.last).toEqual({ ok: true, at: Date.parse(LAST_GOOD) });
    expect(status.problems).toEqual([
      {
        lead: 'Not connected.',
        text: 'Connect Todoist to import your active tasks.',
      },
    ]);
    expect(lines(disconnected).headline).toBe('Synced 2 days ago');

    const never: ViewState = { kind: 'disconnected', tasks: [] };
    expect(syncStatusFor({ state: never }).last).toBeUndefined();
    expect(lines(never).headline).toBe('Not synced yet');
  });

  it('is busy while loading, connecting and syncing', () => {
    expect(lines({ kind: 'loading' })).toMatchObject({
      tone: 'busy',
      headline: 'Loading…',
    });
    expect(lines({ kind: 'connecting', tasks: [] }).headline).toBe(
      'Waiting for you to confirm the connection…',
    );
    const syncing: ViewState = {
      kind: 'syncing',
      connection: CONNECTION,
      tasks: TASKS,
      lastGood: LAST_GOOD,
    };
    expect(lines(syncing)).toMatchObject({
      tone: 'busy',
      headline: 'Syncing with Todoist…',
      rows: '4 tasks from Todoist',
    });
    expect(syncStatusFor({ state: { kind: 'loading' } }).rows).toBeUndefined();
  });

  it('names a host without the proxy client, and another table', () => {
    const noRelay = syncStatusFor({ state: { kind: 'no-relay' } });
    expect(noRelay.problems).toEqual([
      expect.objectContaining({
        lead: 'This Atomic Server cannot connect apps to Todoist, so nothing is read.',
        tone: 'neg',
      }),
    ]);
    expect(lines({ kind: 'no-relay' })).toMatchObject({
      tone: 'idle',
      headline: 'Not synced yet',
    });

    const other = syncStatusFor({ state: { kind: 'other-table' } });
    expect(other.problems).toEqual([
      expect.objectContaining({ lead: 'This is another Issue table.' }),
    ]);
    expect(other.rows).toBeUndefined();
  });
});
