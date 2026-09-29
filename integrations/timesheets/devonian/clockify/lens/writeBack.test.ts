// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  clockifyEntry,
  clockifyFixture,
  PROJECT,
  PROJECT_2,
  ARCHIVED_PROJECT,
  WORKSPACE,
} from '../../../fixtures/clockify/scenario.mjs';
import {
  blockers,
  changedFields,
  clockifyInstant,
  descriptionOf,
  entryValues,
  NO_DESCRIPTION,
  putBody,
  snapToMinute,
  type ClockifyTimeEntry,
  type EntryValues,
} from './writeBack.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
const projects = [PROJECT, PROJECT_2, ARCHIVED_PROJECT];
const context = { now: NOW, projects };
const names = (id: string) => projects.find(p => p.id === id)?.name;

const entry = (extra: Record<string, unknown> = {}): ClockifyTimeEntry =>
  clockifyEntry(
    'entry-1',
    'Write the plan',
    NOW - 3 * HOUR + 17_000,
    NOW - 2 * HOUR,
    { taskId: 'task-1', tagIds: ['tag-1'], ...extra },
  ) as ClockifyTimeEntry;

describe('entryValues (get)', () => {
  it('maps a completed REGULAR entry to row values, with exact instants', () => {
    expect(entryValues(entry(), names)).toEqual({
      name: 'Write the plan',
      start: NOW - 3 * HOUR + 17_000,
      end: NOW - 2 * HOUR,
      billable: true,
      projectId: PROJECT.id,
      project: PROJECT.name,
    });
  });

  it('has no row for a running timer, a break or a broken interval', () => {
    expect(
      entryValues(
        clockifyEntry('r', 'x', NOW - HOUR, null) as ClockifyTimeEntry,
      ),
    ).toBeUndefined();
    expect(entryValues(entry({ type: 'BREAK' }))).toBeUndefined();
    expect(
      entryValues(
        clockifyEntry('b', 'x', NOW, NOW - HOUR) as ClockifyTimeEntry,
      ),
    ).toBeUndefined();
  });

  it('names an entry without a description as the import does, and maps it back', () => {
    const values = entryValues(entry({ description: '  ' }))!;
    expect(values.name).toBe(NO_DESCRIPTION);
    expect(descriptionOf(values.name)).toBe('');
    expect(descriptionOf(' Kept ')).toBe('Kept');
  });
});

describe('putBody (put)', () => {
  it('S13: sends every field a full replacement would clear, from the full record', () => {
    const current = entry();
    const desired = { ...entryValues(current, names)!, billable: false };
    const body = putBody(current, desired);

    expect(body).toEqual({
      // Unchanged instants go back exactly as Clockify sent them.
      start: current.timeInterval.start,
      end: current.timeInterval.end,
      billable: false,
      description: 'Write the plan',
      projectId: PROJECT.id,
      taskId: 'task-1',
      tagIds: ['tag-1'],
      type: 'REGULAR',
    });
    expect(body).not.toHaveProperty('customFields');
  });

  it('drops the task when the project changes (tasks belong to a project)', () => {
    const current = entry();
    const body = putBody(current, {
      ...entryValues(current)!,
      projectId: PROJECT_2.id,
    });

    expect(body.projectId).toBe(PROJECT_2.id);
    expect(body).not.toHaveProperty('taskId');
    expect(body.description).toBe('Write the plan');
  });

  it('sends changed instants in whole seconds and a Name back as a description', () => {
    const current = entry();
    const body = putBody(current, {
      ...entryValues(current)!,
      name: NO_DESCRIPTION,
      start: NOW - 3 * HOUR + 500,
    });

    expect(body.start).toBe(clockifyInstant(NOW - 3 * HOUR));
    expect(body.description).toBe('');
  });

  it('leaves out a project that is cleared', () => {
    const current = entry();
    const body = putBody(current, {
      ...entryValues(current)!,
      projectId: null,
    });

    expect(body).not.toHaveProperty('projectId');
    expect(body).not.toHaveProperty('taskId');
  });

  it('PutGet: what the mock stores for a put body reads back as the values put', async () => {
    // Seeded, so a failure is reproducible.
    let seed = 7;

    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;

      return seed / 2 ** 31;
    };

    for (let i = 0; i < 40; i++) {
      const fixture = clockifyFixture();
      const current = entry({
        billable: random() < 0.5,
        projectId: random() < 0.2 ? null : PROJECT.id,
      });
      fixture.state.entries = [structuredClone(current)];
      const base = entryValues(current, names)!;
      const start = base.start - Math.floor(random() * 90) * 60_000;
      const desired: EntryValues = {
        ...base,
        ...(random() < 0.5 ? { name: `Renamed ${i}` } : {}),
        ...(random() < 0.5 ? { billable: !base.billable } : {}),
        ...(random() < 0.5
          ? { projectId: PROJECT_2.id, project: PROJECT_2.name }
          : {}),
        ...(random() < 0.5 ? { start: snapToMinute(start) } : {}),
      };
      const response = await fixture.request(
        'PUT',
        new URL(
          `http://proxy.test/proxy/clockify/api/v1/workspaces/${WORKSPACE.id}/time-entries/entry-1`,
        ),
        putBody(current, desired),
      );

      expect(response.status).toBe(200);
      expect(entryValues(response.body as ClockifyTimeEntry, names)).toEqual(
        desired,
      );
      // Nothing the lens does not manage was lost.
      expect((response.body as ClockifyTimeEntry).tagIds).toEqual(['tag-1']);
    }
  });
});

describe('blockers', () => {
  const values = entryValues(entry(), names)!;

  it('S23: refuses running, locked and non-REGULAR entries before any intent', () => {
    expect(
      blockers(
        clockifyEntry('r', 'x', NOW - HOUR, null) as ClockifyTimeEntry,
        context,
      ),
    ).toEqual(['It is a running timer. Stop it in Clockify first.']);
    expect(blockers(entry({ isLocked: true }), context)).toEqual([
      'It is locked in Clockify.',
    ]);
    expect(blockers(entry({ type: 'TIME_OFF' }), context)).toEqual([
      'It is a time off entry.',
    ]);
  });

  it('S24: refuses an entry with custom field values (request shape unverified)', () => {
    expect(
      blockers(
        entry({ customFieldValues: [{ customFieldId: 'cf', value: 'x' }] }),
        context,
      ),
    ).toEqual([
      'It has custom field values, which this app cannot write back yet.',
    ]);
    expect(blockers(entry({ customFieldValues: [] }), context)).toEqual([]);
  });

  it('refuses an empty or reversed range, an end in the future, and archived or unknown projects', () => {
    expect(
      blockers(entry(), context, { ...values, end: values.start }),
    ).toEqual(['Start has to be before end.']);
    expect(
      blockers(entry(), context, { ...values, end: NOW + 60_000 }),
    ).toEqual(['End is in the future.']);
    expect(
      blockers(entry(), context, { ...values, projectId: ARCHIVED_PROJECT.id }),
    ).toEqual(['The project Old project is archived.']);
    expect(
      blockers(entry(), context, { ...values, projectId: 'nope' }),
    ).toEqual(['The project is not one of this workspace’s projects.']);
  });

  it('refuses no project where the workspace requires one', () => {
    expect(
      blockers(
        entry(),
        { ...context, forceProjects: true },
        { ...values, projectId: null },
      ),
    ).toEqual(['This workspace requires a project on every entry.']);
  });
});

describe('changedFields and snapping', () => {
  it('lists changed fields in display order, and snaps down to whole minutes', () => {
    const values = entryValues(entry(), names)!;
    expect(
      changedFields(values, { ...values, end: 1, name: 'x', billable: false }),
    ).toEqual(['name', 'billable', 'end']);
    expect(snapToMinute(Date.parse('2026-09-23T10:15:59.999Z'))).toBe(
      Date.parse('2026-09-23T10:15:00Z'),
    );
  });
});
