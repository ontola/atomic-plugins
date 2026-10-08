// @wc-ignore-file
/**
 * `tasks.ts`, pure: the mapping of one Google task onto the shared fields
 * (the due day kept as Google's exact date, never shifted), which absent
 * tasks are looked up, and what each lookup outcome makes of a task that
 * stopped appearing in its list.
 */
import { describe, expect, it } from 'vitest';
import {
  absentTasks,
  type Fetched,
  reconcileTasks,
  type Row,
  taskFields,
  type TaskRecord,
} from './tasks.js';

const T0 = '2026-03-01T09:00:00.000Z';
const T1 = '2026-03-01T10:00:00.000Z';
const LIST = 'list-a';

const task = (id: string, over: Row = {}): Row => ({
  kind: 'tasks#task',
  id,
  title: `Task ${id}`,
  status: 'needsAction',
  ...over,
});

const record = (id: string, over: Partial<TaskRecord> = {}): TaskRecord => ({
  id,
  listId: LIST,
  listTitle: 'A',
  task: task(id),
  presence: 'present',
  ...over,
});

const fetched = (tasks: Row[], over: Partial<Fetched> = {}): Fetched => ({
  lists: [{ id: LIST, title: 'A' }],
  listsComplete: true,
  read: [{ id: LIST, title: 'A', tasks }],
  ...over,
});

describe('taskFields', () => {
  it('keeps the due day as the exact date Google wrote, with no time-zone shift', () => {
    expect(
      taskFields(task('1', { due: '2026-03-02T00:00:00.000Z' })).dueDay,
    ).toBe('2026-03-02');
    // Google writes midnight UTC; a local-time conversion west of UTC would
    // make this the 1st. The string's date part is what counts.
    expect(taskFields(task('1', { due: '2026-03-02T00:00:00Z' })).dueDay).toBe(
      '2026-03-02',
    );
    expect(taskFields(task('1', { due: 'soon' }))).not.toHaveProperty('dueDay');
    expect(taskFields(task('1'))).not.toHaveProperty('dueDay');
  });

  it('maps title, status, notes and parent, with an empty title for a task without one', () => {
    expect(
      taskFields(
        task('1', {
          title: 'Call',
          status: 'completed',
          notes: 'Ask about it.',
          parent: 'p1',
        }),
      ),
    ).toEqual({
      name: 'Call',
      done: true,
      body: 'Ask about it.',
      parent: 'p1',
    });
    expect(taskFields({ id: '2' })).toEqual({ name: '', done: false });
    expect(taskFields(task('3', { notes: '' }))).not.toHaveProperty('body');
  });
});

describe('absentTasks', () => {
  it('names present and unconfirmed tasks missing from a complete read, in id order, never settled ones', () => {
    const previous = [
      record('b'),
      record('a'),
      record('c', { presence: 'unconfirmed' }),
      record('d', { presence: 'deleted' }),
      record('e', { presence: 'unavailable' }),
      record('f', { listId: 'other' }),
    ];
    expect(absentTasks(previous, fetched([task('b')]))).toEqual([
      { id: 'a', listId: LIST },
      { id: 'c', listId: LIST },
    ]);
  });

  it('draws nothing from a partial read of a list', () => {
    expect(
      absentTasks(
        [record('a')],
        fetched([], {
          read: [{ id: LIST, title: 'A', tasks: [], partial: 'cap' }],
        }),
      ),
    ).toEqual([]);
  });
});

describe('reconcileTasks', () => {
  it('takes the read as present, counts a settled task that is back, and keeps a task of an unticked list', () => {
    const previous = [
      record('a', { presence: 'deleted', lastSeen: T0 }),
      record('z', { listId: 'other', listTitle: 'Other' }),
    ];
    const { records, summary } = reconcileTasks({
      previous,
      fetched: fetched([task('a', { title: 'Back' }), task('b')]),
      chosen: [LIST],
      seenAt: T1,
    });
    expect(summary).toEqual({
      present: 3,
      deleted: 0,
      unavailable: 0,
      unconfirmed: 0,
      reappeared: 1,
      complete: true,
    });
    const a = records.find(r => r.id === 'a')!;
    expect(a).toMatchObject({ presence: 'present', task: { title: 'Back' } });
    expect(a).not.toHaveProperty('lastSeen');
    // The unticked list's task is carried as it was, no lookup, no change.
    expect(records.find(r => r.id === 'z')).toEqual(previous[1]);
  });

  it('settles an absent task by its lookup: deleted, unavailable, unconfirmed, or back with its values', () => {
    const previous = ['a', 'b', 'c', 'd', 'e'].map(id => record(id));
    const { records, summary } = reconcileTasks({
      previous,
      fetched: fetched([]),
      chosen: [LIST],
      lookups: [
        { id: 'a', status: 200, body: task('a', { deleted: true }) },
        { id: 'b', status: 404 },
        { id: 'c', error: 'host offline' },
        {
          id: 'd',
          status: 200,
          body: task('d', { hidden: true, status: 'completed' }),
        },
        // 'e' got no lookup (past the cap).
      ],
      seenAt: T1,
      lastCompleteAt: T0,
    });
    const by = Object.fromEntries(records.map(r => [r.id, r]));
    expect(by.a).toMatchObject({
      presence: 'deleted',
      lastSeen: T0,
      task: { deleted: true },
    });
    expect(by.b).toMatchObject({ presence: 'unavailable', lastSeen: T0 });
    expect(by.c).toMatchObject({ presence: 'unconfirmed', lastSeen: T0 });
    expect(by.d).toMatchObject({
      presence: 'present',
      task: { status: 'completed' },
    });
    expect(by.d).not.toHaveProperty('lastSeen');
    expect(by.e).toMatchObject({ presence: 'unconfirmed', lastSeen: T0 });
    expect(summary).toMatchObject({
      present: 1,
      deleted: 1,
      unavailable: 1,
      unconfirmed: 2,
      complete: true,
    });
  });

  it('stamps last-seen with the read time when there was no complete read before, and keeps an older stamp', () => {
    const { records } = reconcileTasks({
      previous: [
        record('a'),
        record('b', { presence: 'unconfirmed', lastSeen: T0 }),
      ],
      fetched: fetched([]),
      chosen: [LIST],
      lookups: [
        { id: 'a', status: 404 },
        { id: 'b', status: 404 },
      ],
      seenAt: T1,
    });
    expect(records.find(r => r.id === 'a')?.lastSeen).toBe(T1);
    expect(records.find(r => r.id === 'b')?.lastSeen).toBe(T0);
  });

  it('marks the tasks of a list that is gone unavailable without a lookup, after a complete read only', () => {
    const previous = [
      record('a'),
      record('b', { listId: 'gone', listTitle: 'Gone' }),
    ];
    const { records, summary } = reconcileTasks({
      previous,
      fetched: fetched([task('a')]),
      chosen: [LIST, 'gone'],
      seenAt: T1,
      lastCompleteAt: T0,
    });
    expect(records.find(r => r.id === 'a')).toMatchObject({
      presence: 'present',
    });
    expect(records.find(r => r.id === 'b')).toMatchObject({
      presence: 'unavailable',
      lastSeen: T0,
    });
    expect(summary.complete).toBe(true);

    // A partial read of any chosen list settles nothing: not the tasks of
    // that list, and not the tasks of a vanished list either, so the card's
    // "no task was settled" holds. The same when the task-list read itself
    // was partial.
    for (const partialFetched of [
      {
        lists: [{ id: LIST, title: 'A' }],
        listsComplete: true,
        read: [{ id: LIST, title: 'A', tasks: [], partial: 'cap' }],
      },
      { lists: [], listsComplete: false, read: [] },
    ]) {
      expect(absentTasks(previous, partialFetched)).toEqual([]);
      const partial = reconcileTasks({
        previous,
        fetched: partialFetched,
        chosen: [LIST, 'gone'],
        seenAt: T1,
        lastCompleteAt: T0,
      });
      expect(partial.records).toEqual(previous);
      expect(partial.summary.complete).toBe(false);
    }
  });

  it('refuses a seenAt that is not an ISO 8601 date and time', () => {
    expect(() =>
      reconcileTasks({
        previous: [],
        fetched: fetched([]),
        chosen: [],
        seenAt: 'now',
      }),
    ).toThrow('seenAt');
  });
});
