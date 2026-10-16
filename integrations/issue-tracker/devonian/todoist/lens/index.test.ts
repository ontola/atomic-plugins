// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { checkLensLaws } from 'devonian/lenses';
import { AtomicStore, Datatype } from 'devonian/atomic';
import {
  issueTerms as t,
  todoistIssueLens as lens,
  todoistIssueSchema,
  todoistToAtomic,
  todoistFromAtomic,
  todoistUpdatePlan,
  type TodoistTask,
} from './index.js';

const source: TodoistTask = {
  id: 'task-a',
  content: 'Original',
  description: '**Body**',
  checked: false,
  parent_id: 'parent-a',
  labels: ['invented'],
  responsible_uid: 'user-a',
  due: {
    date: '2026-10-08T18:00:00',
    timezone: 'Europe/Amsterdam',
    is_recurring: true,
    string: 'every Thursday',
  },
  future: { exact: '001.2300' },
};
const subject = 'https://atomic.example/tasks/one';

function native(task = source) {
  return new AtomicStore(todoistIssueSchema()).patch(
    subject,
    todoistToAtomic(task),
  );
}

describe('Todoist → shared issue-v1', () => {
  it.each([false, true])(
    'satisfies editable-field laws for checked %s',
    checked => {
      const task = { ...source, checked };
      expect(
        checkLensLaws(lens, task, {
          ...lens.get(task),
          name: 'Edited',
          body: '',
        }),
      ).toEqual({ getPut: true, putGet: true, stablePut: true });
      expect(todoistFromAtomic(native(task), task)).toEqual(task);
      expect(lens.put({ ...lens.get(task), name: 'Edited' }, task)).toEqual({
        ...task,
        content: 'Edited',
      });
    },
  );
  it('plans text updates only while preserving recurrence, nesting, assignments and labels', () => {
    const resource = native();
    resource[t.name] = 'Changed';
    delete resource[t.body];
    expect(todoistUpdatePlan(resource, source)).toEqual({
      id: 'task-a',
      body: { content: 'Changed', description: '' },
    });
    expect(todoistUpdatePlan(native(), source)).toEqual({
      id: 'task-a',
      body: {},
    });
    const result = todoistFromAtomic(resource, source);
    expect(result.due).toEqual(source.due);
    expect(result.checked).toBe(false);
    expect(source.content).toBe('Original');
  });
  it('refuses completion, due-day and unsupported workflow edits', () => {
    for (const patch of [
      { status: 'done' as const },
      { dueDay: null },
      { dueDay: '2026-10-09' },
    ])
      expect(() => lens.put({ ...lens.get(source), ...patch }, source)).toThrow(
        'read-only',
      );
    const resource = native();
    resource[t.status] = ['https://atomicdata.dev/task/v1/doing'];
    expect(() => todoistUpdatePlan(resource, source)).toThrow('Todo or Done');
    resource[t.status] = [t.done];
    expect(() => todoistUpdatePlan(resource, source)).toThrow('read-only');
    resource[t.status] = [t.todo];
    delete resource[t.due];
    expect(() => todoistUpdatePlan(resource, source)).toThrow('read-only');
  });
  it.each([undefined, null])(
    'preserves absent scheduling representation %s',
    due => {
      const task = { ...source, due };
      if (due === undefined) delete task.due;
      expect(todoistFromAtomic(native(task), task)).toEqual(task);
      expect(lens.put({ ...lens.get(task), body: 'Changed' }, task)).toEqual({
        ...task,
        description: 'Changed',
      });
    },
  );
  it('clears stale due days in Atomic without clearing human native fields', () => {
    const note = 'https://atomic.example/property/human-note';
    const store = new AtomicStore(
      todoistIssueSchema().property(note, Datatype.STRING),
    );
    store.patch(subject, todoistToAtomic(source));
    store.patch(subject, { set: { [note]: 'Keep' } });
    const result = store.patch(
      subject,
      todoistToAtomic({ ...source, due: null }),
    );
    expect(result[t.due]).toBeUndefined();
    expect(result[note]).toBe('Keep');
  });
  it.each([
    '2026-02-30',
    '2026-13-01',
    '0000-01-01',
    'tomorrow',
    '2026-10-08junk',
  ])('rejects invalid civil day %s', date => {
    expect(() => lens.get({ ...source, due: { date } })).toThrow();
  });
  it.each([
    { id: 1 },
    { checked: undefined },
    { content: '' },
    { description: null },
    { is_deleted: true },
  ])('refuses incomplete or deleted task %s', patch => {
    expect(() => lens.get({ ...source, ...patch } as TodoistTask)).toThrow();
  });
  it('requires a class and rejects missing status rather than inferring open', () => {
    expect(() => todoistFromAtomic({ '@id': subject }, source)).toThrow(
      'issue-v1',
    );
    const resource = native();
    delete resource[t.status];
    expect(() => todoistFromAtomic(resource, source)).toThrow('Todo or Done');
  });
});
