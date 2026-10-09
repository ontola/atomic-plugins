// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  NAME,
  TAG_DONE,
  TAG_TODO,
  TASK_BODY,
  TASK_DUE_DATE,
  TASK_STATUS,
} from './drive.js';
import { issueFromTask, TODOIST_LENS } from './lens.js';

const task = {
  id: 'task-a',
  content: 'Water the plants',
  description: 'Twice',
  checked: false,
  due: { date: '2026-10-08T18:00:00', string: 'today 18:00' },
  priority: 4,
};

describe('the Todoist app reads tasks through the catalog lens', () => {
  it('bundles the published todoist-task-issue-v2 lens', () => {
    expect(TODOIST_LENS['@id']).toMatch(/\/lenses\/todoist-task-issue-v2$/);
    expect(TODOIST_LENS.mapping.version).toBe(3);
  });

  it('writes a new row from a task', () => {
    expect(issueFromTask(task, {})).toEqual({
      set: {
        [NAME]: 'Water the plants',
        [TASK_BODY]: 'Twice',
        [TASK_STATUS]: [TAG_TODO],
        [TASK_DUE_DATE]: '2026-10-08',
      },
      unset: [],
    });
  });

  it('keeps unchanged values, updates changed ones and removes a stale due date', () => {
    const row = {
      [NAME]: 'Water the plants',
      [TASK_BODY]: 'Twice',
      [TASK_STATUS]: [TAG_TODO],
      [TASK_DUE_DATE]: '2026-10-08',
    };
    expect(issueFromTask({ ...task, checked: true, due: null }, row)).toEqual({
      set: {
        [NAME]: 'Water the plants',
        [TASK_BODY]: 'Twice',
        [TASK_STATUS]: [TAG_DONE],
      },
      unset: [TASK_DUE_DATE],
    });
  });

  it.each([
    [
      'a deleted task',
      { ...task, is_deleted: true },
      /outside this lens's domain/,
    ],
    [
      'a task without content',
      { ...task, content: undefined },
      /outside this lens's domain/,
    ],
    [
      'a due date with a fixed time zone',
      { ...task, due: { date: '2026-10-08T16:00:00Z' } },
      /without a time zone/,
    ],
  ])('refuses %s, changing nothing', (_, input, reason) => {
    const result = issueFromTask(input, { [NAME]: 'Before' });
    expect(result).toEqual({ refused: expect.stringMatching(reason) });
  });
});
