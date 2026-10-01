// @wc-ignore-file
/**
 * The range planner (#123 M4): the plans of §3.2–§3.3 per overlap case,
 * the refusals of §3.1, S11 and S12 as plans, and the §5.3 planner
 * property test over 200 seeded random mirrors of up to 20 entries, each
 * plan applied step by step to a model Clockify.
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_PROJECT,
  clockifyEntry,
  PROJECT,
  PROJECT_2,
} from '../../../fixtures/clockify/scenario.mjs';
import {
  planRange,
  type PlanStep,
  type RangeEdit,
  type RangeTarget,
} from './rangePlan.js';
import { putBody, type ClockifyTimeEntry } from './writeBack.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const T0 = NOW - 10 * HOUR;
const P = PROJECT.id;
const Q = PROJECT_2.id;
const projects = [PROJECT, PROJECT_2, ARCHIVED_PROJECT];
const context = { now: NOW, projects };

const entry = (
  id: string,
  from: number,
  to: number | null,
  extra: Record<string, unknown> = {},
) =>
  clockifyEntry(id, `Entry ${id}`, from, to, {
    projectId: P,
    ...extra,
  }) as ClockifyTimeEntry;

const worked = (projectId: string | null): RangeTarget => ({
  kind: 'worked',
  projectId,
});
const notWorked: RangeTarget = { kind: 'didNotWork' };
const at = (h: number) => T0 + h * HOUR;
const edit = (from: number, to: number, target: RangeTarget): RangeEdit => ({
  from: at(from),
  to: at(to),
  target,
});

/** Steps as short strings, for readable expectations. */
const brief = (steps: PlanStep[]) =>
  steps.map(s => {
    const h = (ms: number) => (ms - T0) / HOUR;
    if (s.op === 'delete') return `delete ${s.entryId}`;
    if (s.op === 'update')
      return `update ${s.entryId} ${h(s.desired.start)}-${h(s.desired.end)}${s.desired.projectId !== s.current.projectId ? ` ${s.desired.projectId === Q ? 'Q' : s.desired.projectId}` : ''}`;

    return `create ${h(s.values.start)}-${h(s.values.end)}${s.copyOf ? ` copy ${s.copyOf}` : ''}`;
  });

describe('did not work over [a, b) (§3.2)', () => {
  const plan = (from: number, to: number, e: ClockifyTimeEntry) =>
    brief(planRange([e], edit(from, to, notWorked), context).steps);

  it('deletes an entry inside, trims one sticking out, splits one spanning', () => {
    expect(plan(1, 4, entry('a', at(2), at(3)))).toEqual(['delete a']);
    expect(plan(2, 4, entry('a', at(1), at(3)))).toEqual(['update a 1-2']);
    expect(plan(1, 3, entry('a', at(2), at(4)))).toEqual(['update a 3-4']);
    expect(plan(2, 3, entry('a', at(1), at(4)))).toEqual([
      'update a 1-2',
      'create 3-4 copy a',
    ]);
  });

  it('leaves breaks alone (they already say "did not work")', () => {
    const steps = planRange(
      [entry('a', at(1), at(3)), entry('b', at(2), at(3), { type: 'BREAK' })],
      edit(2, 3, notWorked),
      context,
    );
    expect(steps.refused).toEqual([]);
    expect(brief(steps.steps)).toEqual(['update a 1-2']);
  });

  it('plans nothing over time that is already free', () => {
    expect(
      planRange([entry('a', at(1), at(2))], edit(3, 4, notWorked), context)
        .steps,
    ).toEqual([]);
  });
});

describe('worked on P over [a, b) (§3.3)', () => {
  it('S10: one create in an empty range, with the billable default', () => {
    const { steps } = planRange([], edit(1, 2, worked(P)), {
      ...context,
      billableDefault: id => id === P,
    });
    expect(brief(steps)).toEqual(['create 1-2']);
    expect(steps[0]).toMatchObject({
      values: {
        name: 'Time entry',
        billable: true,
        projectId: P,
        project: PROJECT.name,
      },
    });
  });

  it('S11: extends an adjacent P entry instead of creating one (#97 answer 8)', () => {
    expect(
      brief(
        planRange([entry('a', at(1), at(2))], edit(2, 3, worked(P)), context)
          .steps,
      ),
    ).toEqual(['update a 1-3']);
    expect(
      brief(
        planRange([entry('a', at(3), at(4))], edit(2, 3, worked(P)), context)
          .steps,
      ),
    ).toEqual(['update a 2-4']);
  });

  it('S12: changes the project of an entry covering exactly [a, b); its PUT drops the task and keeps description and tags', () => {
    const q = entry('q', at(1), at(2), {
      projectId: Q,
      taskId: 'task-1',
      tagIds: ['tag-1'],
    });
    const { steps } = planRange([q], edit(1, 2, worked(P)), context);
    expect(brief(steps)).toEqual(['update q 1-2 ' + P]);
    const step = steps[0] as Extract<PlanStep, { op: 'update' }>;
    const body = putBody(q, step.desired);
    expect(body).toMatchObject({
      projectId: P,
      description: 'Entry q',
      tagIds: ['tag-1'],
    });
    expect(body).not.toHaveProperty('taskId');
  });

  it('trims another project and fills the gap by extending P (Keep P on a conflict)', () => {
    const p = entry('p', at(1), at(3));
    const q = entry('q', at(2), at(4), { projectId: Q });
    // The conflict is [2, 3): keep P there.
    expect(
      brief(planRange([p, q], edit(2, 3, worked(P)), context).steps),
    ).toEqual(['update q 3-4']);
    // Keep Q there instead.
    expect(
      brief(planRange([p, q], edit(2, 3, worked(Q)), context).steps),
    ).toEqual(['update p 1-2']);
  });

  it('removes a duplicate: the earliest P entry keeps the time', () => {
    const a = entry('a', at(1), at(3));
    const b = entry('b', at(2), at(3));
    expect(
      brief(planRange([a, b], edit(2, 3, worked(P)), context).steps),
    ).toEqual(['delete b']);
    const c = entry('c', at(2), at(4));
    expect(
      brief(planRange([a, c], edit(2, 3, worked(P)), context).steps),
    ).toEqual(['update c 3-4']);
  });

  it('orders shrinks and deletes before extends and creates (§3.5)', () => {
    const { steps } = planRange(
      [
        entry('p', at(0), at(1)),
        entry('q', at(1), at(2), { projectId: Q }),
        entry('r', at(3), at(5), { projectId: Q }),
      ],
      edit(1, 4, worked(P)),
      context,
    );
    expect(brief(steps)).toEqual(['delete q', 'update r 4-5', 'update p 0-4']);
    expect(steps.map(s => s.phase)).toEqual(['shrink', 'shrink', 'grow']);
  });
});

describe('refusals (§3.1, S23)', () => {
  const refused = (entries: ClockifyTimeEntry[], e: RangeEdit) =>
    planRange(entries, e, context).refused;

  it('refuses an empty range, a future end and bad target projects', () => {
    expect(refused([], edit(2, 2, notWorked))).toEqual(['The range is empty.']);
    expect(
      refused([], { from: NOW - HOUR, to: NOW + MIN, target: notWorked }),
    ).toEqual(['The range ends in the future.']);
    expect(refused([], edit(1, 2, worked('nope')))).toEqual([
      'The project is not one of this workspace’s projects.',
    ]);
    expect(refused([], edit(1, 2, worked(ARCHIVED_PROJECT.id)))).toEqual([
      'The project Old project is archived.',
    ]);
    expect(
      planRange([], edit(1, 2, worked(null)), {
        ...context,
        forceProjects: true,
      }).refused,
    ).toEqual(['This workspace requires a project on every entry.']);
  });

  it('refuses running, locked, custom-field entries, and breaks for "worked"', () => {
    expect(refused([entry('r', at(9), null)], edit(9, 10, notWorked))).toEqual([
      'A running timer is in this range. Stop it in Clockify first.',
    ]);
    expect(
      refused(
        [entry('l', at(1), at(2), { isLocked: true })],
        edit(1, 3, notWorked),
      ),
    ).toEqual(['A locked entry is in this range.']);
    expect(
      refused(
        [entry('c', at(1), at(2), { customFieldValues: [{ value: 'x' }] })],
        edit(1, 3, notWorked),
      ),
    ).toHaveLength(1);
    expect(
      refused(
        [entry('b', at(1), at(2), { type: 'BREAK' })],
        edit(1, 3, worked(P)),
      ),
    ).toEqual([
      'A break entry is in this range; it can only be changed in Clockify.',
    ]);
  });

  it('does not extend a locked neighbour', () => {
    const { steps } = planRange(
      [entry('a', at(1), at(2), { isLocked: true })],
      edit(2, 3, worked(P)),
      context,
    );
    expect(brief(steps)).toEqual(['create 2-3']);
  });
});

// ---- the planner property (§5.3) ------------------------------------------

interface Model {
  id: string;
  from: number;
  to: number;
  projectId: string | null;
}

/** Applies a plan's steps one at a time to a model Clockify, checking each
 * intermediate state with `check`. */
function apply(
  model: Model[],
  steps: PlanStep[],
  check: (state: Model[]) => void,
): Model[] {
  let state = model.map(m => ({ ...m }));
  let created = 0;

  for (const step of steps) {
    if (step.op === 'delete') state = state.filter(m => m.id !== step.entryId);
    else if (step.op === 'update')
      state = state.map(m =>
        m.id === step.entryId
          ? {
              ...m,
              from: step.desired.start,
              to: step.desired.end,
              projectId: step.desired.projectId,
            }
          : m,
      );
    else
      state.push({
        id: `new-${created++}`,
        from: step.values.start,
        to: step.values.end,
        projectId: step.values.projectId,
      });
    check(state);
  }

  return state;
}

/** Labels covering instant `t`, sorted: what Clockify says about it. */
const labelsAt = (state: Model[], t: number) =>
  state
    .filter(m => m.from <= t && t < m.to)
    .map(m => m.projectId ?? 'none')
    .sort();

describe('planner property (§5.3), 200 seeded mirrors of up to 20 entries', () => {
  it('holds the target over [a, b), changes nothing outside, adds no overlap mid-plan, and every PUT carries end', () => {
    let seed = 11;

    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;

      return seed / 2 ** 31;
    };

    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)];
    // A 12-hour day in 15-minute steps; `now` is after all of it.
    const slot = () => T0 + Math.floor(random() * 48) * 15 * MIN;
    let planned = 0;

    for (let run = 0; run < 200; run++) {
      const n = Math.floor(random() * 21);
      const entries: ClockifyTimeEntry[] = [];

      for (let i = 0; i < n; i++) {
        const from = slot();
        const to = from + (1 + Math.floor(random() * 12)) * 15 * MIN;
        entries.push(
          entry(`e${i}`, from, to, { projectId: pick([P, Q, null]) }),
        );
      }

      const a = slot();
      const b = a + (1 + Math.floor(random() * 16)) * 15 * MIN;
      const target = pick<RangeTarget>([worked(P), worked(Q), notWorked]);
      const plan = planRange(
        entries,
        { from: a, to: b, target },
        { ...context, now: T0 + 24 * HOUR },
      );
      expect(plan.refused).toEqual([]);
      planned += plan.steps.length;

      const model: Model[] = entries.map(e => ({
        id: e.id,
        from: Date.parse(e.timeInterval.start!),
        to: Date.parse(e.timeInterval.end!),
        projectId: e.projectId ?? null,
      }));
      const points = [
        ...new Set(
          [...model.flatMap(m => [m.from, m.to]), a, b].flatMap(t => [
            t - 1,
            t,
          ]),
        ),
      ];
      const count = (state: Model[], t: number) => labelsAt(state, t).length;
      const final = apply(model, plan.steps, () => {});
      const states: Model[][] = [];
      apply(model, plan.steps, s => states.push(s));

      for (const t of points) {
        const inside = a <= t && t < b;
        if (inside)
          expect(labelsAt(final, t)).toEqual(
            target.kind === 'worked' ? [target.projectId ?? 'none'] : [],
          );
        else expect(labelsAt(final, t)).toEqual(labelsAt(model, t));

        // Mid-plan, no instant is claimed more often than before or after.
        const bound = Math.max(count(model, t), count(final, t));
        for (const s of states) expect(count(s, t)).toBeLessThanOrEqual(bound);
      }

      for (const step of plan.steps)
        if (step.op === 'update') {
          const source = entries.find(e => e.id === step.entryId)!;
          expect(putBody(source, step.desired).end).toEqual(expect.any(String));
        }
    }

    // The runs exercised the planner, not only empty plans.
    expect(planned).toBeGreaterThan(200);
  });
});
