// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import * as code from '../devonian/clockify/lens/index.js';
import type { ClockifyTimeEntry } from '../devonian/clockify/lens/index.js';
import { CLOCKIFY_LENS, entryValues, putBody } from './catalogLens.js';
import { desiredValues, reconcileRow } from './writeBack.js';

const entry = (over: Partial<ClockifyTimeEntry> = {}): ClockifyTimeEntry => ({
  id: 'e1',
  description: 'Write docs',
  billable: false,
  projectId: 'p1',
  taskId: 't1',
  tagIds: ['g1'],
  type: 'REGULAR',
  timeInterval: {
    start: '2026-10-05T09:00:00Z',
    end: '2026-10-05T10:30:00Z',
  },
  ...over,
});

const ENTRIES: [string, ClockifyTimeEntry][] = [
  ['a plain entry', entry()],
  [
    'an offset start',
    entry({
      timeInterval: {
        start: '2026-10-05T11:00:00+02:00',
        end: '2026-10-05T10:30:00Z',
      },
    }),
  ],
  ['no project', entry({ projectId: null, taskId: null })],
  ['billable null', entry({ billable: null })],
  [
    'a running timer',
    entry({ timeInterval: { start: '2026-10-05T09:00:00Z', end: null } }),
  ],
  ['a break', entry({ type: 'BREAK' })],
  [
    'an end before its start',
    entry({
      timeInterval: {
        start: '2026-10-05T11:00:00Z',
        end: '2026-10-05T10:00:00Z',
      },
    }),
  ],
];

describe('timesheets 0.8.0 maps entries through clockify-time-entry-v2', () => {
  it('bundles the published lens', () => {
    expect(CLOCKIFY_LENS['@id']).toMatch(/\/lenses\/clockify-time-entry-v2$/);
  });

  it.each(ENTRIES)(
    'agrees with the code lens on %s (apart from the name)',
    (_, e) => {
      const ours = entryValues(e, () => 'One');
      const theirs = code.entryValues(e, () => 'One');
      if (!theirs) return expect(ours).toBeUndefined();
      expect({ ...ours, name: undefined }).toEqual({
        ...theirs,
        name: undefined,
      });
    },
  );

  it('reads the name as the description exactly', () => {
    expect(entryValues(entry({ description: '  Write docs  ' }))?.name).toBe(
      '  Write docs  ',
    );
    expect(entryValues(entry({ description: '' }))?.name).toBe('');
    expect(entryValues(entry({ description: null }))?.name).toBe('');
  });

  it.each([
    ['surrounding whitespace', '  Write docs  '],
    ['an empty description', ''],
    ['no description at all', undefined],
  ])(
    'sends no description change for an untouched name with %s',
    (_, description) => {
      const fresh = entry(
        description === undefined
          ? { description: undefined }
          : { description },
      );
      const local = { ...entryValues(fresh)!, billable: true };
      const { desired } = desiredValues(local, entryValues(fresh)!, [
        { id: 'p1', name: 'One' },
      ]);
      const body = putBody(fresh, desired);
      expect(body.description).toBe(
        typeof description === 'string' ? description : '',
      );
      expect(body.billable).toBe(true);
      // Only billable changed: start and end keep Clockify's exact strings.
      expect(body.start).toBe(fresh.timeInterval.start);
      expect(body.end).toBe(fresh.timeInterval.end);
    },
  );

  it('writes changed fields like the code lens, and a typed name as typed', () => {
    const fresh = entry();
    const desired = {
      ...entryValues(fresh)!,
      name: ' New name',
      start: Date.parse('2026-10-05T08:00:00Z'),
      projectId: 'p2',
    };
    const ours = putBody(fresh, desired);
    expect(ours).toEqual({
      ...code.putBody(fresh, desired),
      description: ' New name',
    });
    // A changed project drops the task (gap 4, still code here).
    expect(ours).not.toHaveProperty('taskId');
    expect(ours.start).toBe('2026-10-05T08:00:00Z');
  });

  it('refuses a running timer as the code lens does', () => {
    const running = entry({
      timeInterval: { start: '2026-10-05T09:00:00Z', end: null },
    });
    expect(() => putBody(running, entryValues(entry())!)).toThrow(
      /not a completed entry/,
    );
  });

  it.each([
    ['an empty description', '', 'Time entry'],
    ['surrounding whitespace', '  Write docs  ', 'Write docs'],
  ])(
    'a 0.7.1 row (%s) takes the description over at its next sync, sending nothing',
    (_, description, stored) => {
      const fresh = entry({ description });
      const remote = entryValues(fresh)!;
      const old = { ...remote, name: stored };
      const result = reconcileRow(
        {
          subject: 'row',
          entryId: 'e1',
          local: old,
          baseline: old,
          deleteRequested: false,
        },
        remote,
      );
      expect(result.values.name).toBe(description);
      expect(result.baseline.name).toBe(description);
      expect(result.providerWon).toEqual([]);
    },
  );
});
