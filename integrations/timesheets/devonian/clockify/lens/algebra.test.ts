// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { checkLensLaws } from 'devonian/lenses';
import { clockifyEntryLens } from './algebra.js';
import { entryValues, putBody, type ClockifyTimeEntry } from './writeBack.js';

const now = Date.parse('2026-10-02T12:00:00Z');
const source: ClockifyTimeEntry = {
  id: 'invented-entry',
  description: '  Original  ',
  billable: false,
  projectId: 'p1',
  taskId: 'task-1',
  tagIds: ['tag-1'],
  type: 'REGULAR',
  timeInterval: {
    start: '2026-10-02T09:00:00+02:00',
    end: '2026-10-02T10:00:00+02:00',
  },
};
const context = {
  now,
  projects: [
    { id: 'p1', name: 'One' },
    { id: 'p2', name: 'Two' },
  ],
};
const lens = clockifyEntryLens(context);

describe('Clockify lens algebra prototype', () => {
  it('preserves exact timestamps, description formatting, task and tags on an unrelated edit', () => {
    const updated = lens.put({ ...lens.get(source), billable: true }, source);
    expect(updated).toEqual({ ...source, billable: true });
    expect(source.billable).toBe(false);
    expect(lens.put(lens.get(source), source)).toEqual(source);
  });

  it('groups project and task updates, retaining task when the project is unchanged', () => {
    const unchanged = lens.put({ ...lens.get(source), name: 'New' }, source);
    expect(unchanged.taskId).toBe('task-1');
    const updated = lens.put({ ...lens.get(source), projectId: 'p2' }, source);
    expect(updated.projectId).toBe('p2');
    expect(updated).not.toHaveProperty('taskId');
    expect(updated.tagIds).toEqual(['tag-1']);
    expect(
      lens.put({ ...lens.get(source), projectId: null }, source),
    ).not.toHaveProperty('taskId');
  });

  it('round trips supported edits and agrees with the existing provider request-body mapping', () => {
    for (const name of ['Original', 'New', 'Time entry'])
      for (const projectId of ['p1', 'p2', null])
        for (const billable of [false, true]) {
          const desired = {
            ...lens.get(source),
            name,
            projectId,
            billable,
            interval: { start: now - 3 * 3600000, end: now - 2 * 3600000 },
          };
          expect(checkLensLaws(lens, source, desired)).toEqual({
            getPut: true,
            putGet: true,
            stablePut: true,
          });
          const updated = lens.put(desired, source);
          const row = {
            ...entryValues(source)!,
            name,
            projectId,
            billable,
            ...desired.interval,
          };
          const body = putBody(source, row);
          expect(updated.timeInterval).toEqual({
            start: body.start,
            end: body.end,
          });
          expect(updated.description).toBe(body.description);
          expect(updated.tagIds).toEqual(source.tagIds);
        }
  });

  it('refuses invalid intervals, unsupported precision and locked entries', () => {
    const desired = lens.get(source);
    expect(() =>
      lens.put(
        {
          ...desired,
          interval: { ...desired.interval, end: desired.interval.start },
        },
        source,
      ),
    ).toThrow('Start has to be before end');
    expect(() =>
      lens.put(
        {
          ...desired,
          interval: { ...desired.interval, start: desired.interval.start + 1 },
        },
        source,
      ),
    ).toThrow('whole seconds');
    expect(() =>
      lens.put({ ...desired, billable: true }, { ...source, isLocked: true }),
    ).toThrow('locked');
    expect(() =>
      lens.put({ ...desired, projectId: 'missing' }, source),
    ).toThrow('not one of');
  });

  it('captures host context and keeps rejected edits from changing the source', () => {
    const input = structuredClone(context);
    const scoped = clockifyEntryLens(input);
    input.projects[1]!.id = 'changed';
    expect(
      scoped.put({ ...scoped.get(source), projectId: 'p2' }, source).projectId,
    ).toBe('p2');
    expect(source.taskId).toBe('task-1');
  });
});
