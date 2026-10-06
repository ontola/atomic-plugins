// @wc-ignore-file
/**
 * `status.ts`: every controller state mapped onto the shared sync-status
 * card's model, without a DOM, and the words the card then says
 * (`statusLines`). The card itself is tested in `sync-status/card.test.ts`.
 * The clock is pinned: nothing here depends on the real date.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import { clockTime, type ViewState } from './controller.js';
import { MAX_LOOKUPS } from './read.js';
import {
  ignoredGroups,
  nextStep,
  NO_RELAY_NOTE,
  syncStatusFor,
  WRITE_BACK_NOTE,
} from './status.js';
import type { SyncSummary, TaskRow } from './sync.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MINUTE = 60_000;
const LAST_GOOD = '2026-10-04T09:30:00.000Z';
const CONNECTION = { platform: 'google-tasks', connectionId: 'c1' };
const WORDS = { locale: 'en-GB', timeZone: 'UTC' };
const LISTS = [
  { id: 'l1', title: 'My Tasks' },
  { id: 'l2', title: 'Groceries' },
];
const CHOSEN = ['l1'];

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterAll(() => vi.useRealTimers());

const task = (id: string, over: Partial<TaskRow> = {}): TaskRow => ({
  subject: `did:ad:${id}`,
  taskId: id,
  name: `Task ${id}`,
  done: false,
  presence: 'present',
  listId: 'l1',
  list: 'My Tasks',
  ...over,
});

const TASKS: TaskRow[] = [
  task('1'),
  task('2', { done: true }),
  task('3', { presence: 'deleted' }),
  task('4', { presence: 'unavailable' }),
  {
    subject: 'did:ad:local',
    name: 'Written here',
    done: false,
    presence: 'local',
  },
];

const listed = { tasks: TASKS, lists: LISTS, chosen: CHOSEN };
const empty = { tasks: [], lists: [], chosen: [] };

const summary = (over: Partial<SyncSummary> = {}): SyncSummary => ({
  total: 4,
  added: 1,
  updated: 2,
  unchanged: 1,
  presence: { present: 2, deleted: 1, unavailable: 1, unconfirmed: 0 },
  reappeared: 0,
  checked: 1,
  complete: true,
  lists: LISTS,
  chosen: CHOSEN,
  ...over,
});

const synced = (over: Partial<SyncSummary> = {}): ViewState => ({
  kind: 'synced',
  connection: CONNECTION,
  at: new Date(NOW - 4 * MINUTE),
  summary: summary(over),
  ...listed,
  lastGood: '2026-10-06T11:56:00.000Z',
});

const lines = (state: ViewState) =>
  statusLines(syncStatusFor({ state, now: NOW, ...WORDS })!, NOW);

describe('syncStatusFor', () => {
  it('is read-only in every state, and says local edits are overwritten only where it syncs', () => {
    const syncing: ViewState[] = [
      { kind: 'loading' },
      { kind: 'disconnected', ...empty },
      { kind: 'connecting', ...empty },
      { kind: 'syncing', connection: CONNECTION, ...listed },
      synced(),
      { kind: 'error', message: 'x', at: NOW, ...listed },
    ];
    const never: [ViewState, string][] = [
      [{ kind: 'no-relay' }, NO_RELAY_NOTE],
    ];

    for (const [state, note] of [
      ...syncing.map((s): [ViewState, string] => [s, WRITE_BACK_NOTE]),
      ...never,
    ]) {
      // No `now`: the pinned Date.now() is what the card reads.
      const status = syncStatusFor({ state })!;
      expect(status).toBeDefined();
      expect(status.provider).toBe('Google Tasks');
      expect(status.writeBack).toBe('read-only');
      expect(status.writeBackNote).toBe(note);
      // A read-only app has no write queue, so nothing can be counted twice.
      expect(status.writes).toBeUndefined();
      const { mode } = statusLines(status, NOW);
      expect(mode).toMatch(/^Read-only: edits here stay in Atomic\./);
      expect(mode).toContain(note);
    }

    for (const state of syncing) {
      const { mode } = lines(state);
      expect(mode).toContain('Nothing is sent to Google Tasks.');
      expect(mode).toContain('overwritten at the next sync');
    }

    // Where this app never syncs, the card does not promise a next sync.
    for (const [state] of never) {
      const { mode } = lines(state);
      expect(mode).not.toContain('next sync');
      expect(mode).not.toContain('overwritten at');
      expect(mode).toContain('nothing');
    }
  });

  it('after a sync: the headline, counts, the task count and the groups', () => {
    const status = syncStatusFor({ state: synced() })!;
    expect(status.rows).toBe(4);
    expect(status.rowsScope).toBe('from Google Tasks');
    expect(status.last).toEqual({
      ok: true,
      at: NOW - 4 * MINUTE,
      counts: { added: 1, updated: 2, unchanged: 1 },
    });
    expect(status.problems).toBeUndefined();
    expect(status.ignored).toEqual([
      {
        count: 1,
        reason:
          'was deleted in Google Tasks: kept here as last read; not closed.',
        items: ['Task 3'],
      },
      {
        count: 1,
        reason:
          'can no longer be reached in Google Tasks (gone, moved, or no access): kept here with the last values Google sent; not closed.',
        items: ['Task 4'],
      },
      {
        count: 1,
        reason:
          'was added here, not in Google Tasks: kept as it is; nothing is sent to Google.',
        items: ['Written here'],
      },
    ]);
    const words = lines(synced());
    expect(words.headline).toBe('Synced 4 min ago');
    expect(words.counts).toBe('Last sync: 1 added, 2 updated, 1 unchanged');
    expect(words.rows).toBe('4 tasks from Google Tasks');
    // Settled tasks and a hand-made row are notes, not trouble.
    expect(words.tone).toBe('warn');
  });

  it('is plainly ok when every task is present, done or not, and nothing was left out', () => {
    const state: ViewState = {
      ...synced({
        presence: { present: 2, deleted: 0, unavailable: 0, unconfirmed: 0 },
      }),
      tasks: [task('1'), task('2', { done: true })],
    };
    const status = syncStatusFor({ state })!;
    expect(status.ignored).toBeUndefined();
    expect(lines(state).tone).toBe('ok');
  });

  it('groups unconfirmed, unticked-list and incomplete rows, each row once, with Open row on one incomplete row', () => {
    const opened: string[] = [];
    const tasks: TaskRow[] = [
      task('5', { presence: 'unconfirmed' }),
      task('6', { listId: 'l2', list: 'Groceries' }),
      // Deleted AND incomplete: only in the incomplete group.
      task('7', {
        presence: 'deleted',
        name: '',
        incomplete: 'Incomplete: missing Name',
      }),
    ];
    const groups = ignoredGroups(tasks, CHOSEN, s => opened.push(s));
    expect(groups.map(g => [g.count, g.reason.split(':')[0], g.items])).toEqual(
      [
        [1, 'could not be checked in Google Tasks', ['Task 5']],
        [1, 'is in a task list that is no longer ticked', ['Task 6']],
        [1, 'is incomplete (missing Name)', ['(no name)']],
      ],
    );
    expect(groups[0].reason).toContain('checked again at the next sync');
    expect(groups.reduce((n, g) => n + g.count, 0)).toBe(tasks.length);
    const incomplete = groups[2];
    expect(incomplete.reason).toContain('give the task a title in Google');
    expect(incomplete.action?.label).toBe('Open row');
    expect(incomplete.action?.key).toBe('ss-open-row:did:ad:7');
    incomplete.action?.onClick();
    expect(opened).toEqual(['did:ad:7']);
    // No host way to a row, or several rows: no button.
    expect(ignoredGroups(tasks, CHOSEN)[2].action).toBeUndefined();
    expect(
      ignoredGroups(
        [...tasks, { ...tasks[2], subject: 'did:ad:other' }],
        CHOSEN,
        () => {},
      )[2].action,
    ).toBeUndefined();
    // A hand-made incomplete row names the table only.
    expect(
      ignoredGroups(
        [
          {
            subject: 'did:ad:n',
            name: '',
            done: false,
            presence: 'local',
            incomplete: 'x',
          },
        ],
        CHOSEN,
      )[0].reason,
    ).not.toContain('Google');
  });

  it('asks for a task list when none is chosen', () => {
    const state: ViewState = {
      ...synced({ total: 0, added: 0, updated: 0, unchanged: 0, chosen: [] }),
      tasks: [],
      chosen: [],
    };
    const status = syncStatusFor({ state, now: NOW })!;
    expect(status.problems).toEqual([
      {
        lead: 'No task list chosen.',
        text: 'Google lists 2 task lists for this account; tick the ones to import below.',
      },
    ]);
    expect(lines(state)).toMatchObject({
      tone: 'warn',
      counts: 'Last sync: nothing to read',
    });
  });

  it('names a partial read, and too many departures, as problems over an otherwise good sync', () => {
    const state = synced({ complete: false });
    const status = syncStatusFor({ state, now: NOW })!;
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
    const first = syncStatusFor({ state: fresh as ViewState, now: NOW })!;
    expect(first.problems?.[0].text).toContain(
      'There has been no complete read yet.',
    );

    const many = syncStatusFor({
      state: synced({
        presence: {
          present: 0,
          deleted: 0,
          unavailable: 0,
          unconfirmed: MAX_LOOKUPS + 1,
        },
      }),
      now: NOW,
    })!;
    expect(many.problems?.[0].lead).toBe(
      `More than ${MAX_LOOKUPS} tasks left their lists at once.`,
    );
  });

  it('shows a failed sync with the next step and the last good read', () => {
    const base = {
      kind: 'error' as const,
      connection: CONNECTION,
      at: NOW - MINUTE,
      ...listed,
      lastGood: LAST_GOOD,
    };
    const cases: [number | undefined, string, string][] = [
      [
        401,
        'Google refused lists page 1 (401); reconnect Google Tasks.',
        'Reconnect Google Tasks.',
      ],
      [403, 'Google refused (403).', 'Reconnect Google Tasks.'],
      [
        503,
        'Google Tasks answered 503 for tasks page 1.',
        'Google had a problem; try again in a moment.',
      ],
      [undefined, 'host offline', 'Check your connection, then try again.'],
      [400, 'Google Tasks answered 400 for lists page 1.', 'Try again.'],
    ];

    for (const [status, message, step] of cases) {
      const state: ViewState = {
        ...base,
        message,
        ...(status === undefined ? {} : { status }),
      };
      const mapped = syncStatusFor({ state })!;
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
      expect(words.rows).toBe('4 tasks from Google Tasks');
    }

    // Never synced: no last good read to name. Without a connection (the
    // load's connection lookup failed) the next step is the one button shown.
    const fresh = syncStatusFor({
      state: { kind: 'error', message: 'x', at: NOW, ...empty },
    })!;
    expect(fresh.last).not.toHaveProperty('lastGood');
    expect(fresh.last).toMatchObject({
      nextStep: 'Reload the app, or press Connect Google Tasks.',
    });
  });

  it('says a rate limit is retried by itself, or that the sync stopped and when to try again', () => {
    const retryAt = NOW + 90_000;
    expect(clockTime(retryAt, WORDS)).toBe('12:01');
    const retrying = syncStatusFor({
      state: {
        kind: 'error',
        connection: CONNECTION,
        message:
          'Google Tasks is rate-limiting this app (429 for /tasks/v1/users/@me/lists).',
        at: NOW,
        status: 429,
        rateLimited: { retryAt, retrying: true },
        ...listed,
        lastGood: LAST_GOOD,
      },
      ...WORDS,
    })!;
    expect(retrying.last).toEqual({
      ok: false,
      at: NOW,
      error: 'Google Tasks is rate-limiting; retrying at 12:01.',
      lastGood: Date.parse(LAST_GOOD),
    });

    const stopped = syncStatusFor({
      state: {
        kind: 'error',
        connection: CONNECTION,
        message:
          'Google Tasks is rate-limiting this app (403 for /tasks/v1/users/@me/lists).',
        at: NOW,
        status: 403,
        rateLimited: { retryAt, retrying: false },
        ...listed,
      },
      ...WORDS,
    })!;
    expect(stopped.last).toEqual({
      ok: false,
      at: NOW,
      error: 'Google Tasks is rate-limiting; the sync stopped.',
      nextStep: 'Try again after 12:01.',
    });
  });

  it('before this page load has synced: the last good read, without counts, in every state that lists rows', () => {
    const disconnected: ViewState = {
      kind: 'disconnected',
      ...listed,
      lastGood: LAST_GOOD,
    };
    const status = syncStatusFor({ state: disconnected })!;
    expect(status.last).toEqual({ ok: true, at: Date.parse(LAST_GOOD) });
    expect(status.problems).toEqual([
      {
        lead: 'Not connected.',
        text: 'Connect Google Tasks to import the task lists you choose.',
      },
    ]);
    expect(lines(disconnected).headline).toBe('Synced 2 days ago');
    // While busy the headline is the busy text, but the last good read is
    // still carried, so the card never falls back to "Not synced yet".
    expect(
      syncStatusFor({
        state: { kind: 'connecting', ...listed, lastGood: LAST_GOOD },
      })!.last,
    ).toEqual({ ok: true, at: Date.parse(LAST_GOOD) });

    const never: ViewState = { kind: 'disconnected', ...empty };
    expect(syncStatusFor({ state: never })!.last).toBeUndefined();
    expect(lines(never).headline).toBe('Not synced yet');
  });

  it('is busy while loading, connecting and syncing', () => {
    expect(lines({ kind: 'loading' })).toMatchObject({
      tone: 'busy',
      headline: 'Loading…',
    });
    expect(lines({ kind: 'connecting', ...empty }).headline).toBe(
      'Waiting for you to confirm the connection…',
    );
    const syncing: ViewState = {
      kind: 'syncing',
      connection: CONNECTION,
      ...listed,
      lastGood: LAST_GOOD,
    };
    expect(lines(syncing)).toMatchObject({
      tone: 'busy',
      headline: 'Syncing with Google Tasks…',
      rows: '4 tasks from Google Tasks',
    });
    expect(syncStatusFor({ state: { kind: 'loading' } })!.rows).toBeUndefined();
  });

  it('names a host without the proxy client, and renders no card on another table', () => {
    const noRelay = syncStatusFor({ state: { kind: 'no-relay' } })!;
    expect(noRelay.problems).toEqual([
      expect.objectContaining({
        lead: 'This Atomic Server cannot connect apps to Google Tasks, so nothing is read.',
        tone: 'neg',
      }),
    ]);
    expect(lines({ kind: 'no-relay' })).toMatchObject({
      tone: 'idle',
      headline: 'Not synced yet',
    });

    // Another app's Issue table may be written back by that app, so no
    // "read-only" card goes there: the view shows the plain notice only.
    expect(syncStatusFor({ state: { kind: 'other-table' } })).toBeUndefined();
  });
});
