// @wc-ignore-file
/**
 * #123 M4 against the mock proxy, through the controller and the in-memory
 * store: range edits ("worked on P", "did not work") and resolving
 * conflicts, staged on rows and sent only after review. #123 §5.2
 * scenarios S6 and S7 (resolution), S9 (as a range split), S10, S11, S12,
 * S15, a failed create sent again (S16 for creates), and the refusals.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyEntry,
  PROJECT,
  PROJECT_2,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import { createController, type Controller } from './controller.js';
import { APP, fakeStore, PARENT, TABLE } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { ensureSchema } from './schema.js';
import type { TimelineConflict } from './timeline/types.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
const MIN = 60_000;
/** 22 September 2026, 00:00 UTC: the day before NOW. */
const DAY = Date.parse('2026-09-22T00:00:00Z');
const at = (h: number) => DAY + h * HOUR;
const P = PROJECT.id;
const Q = PROJECT_2.id;

type Entry = ReturnType<typeof clockifyEntry>;
const entry = (
  id: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
): Entry => clockifyEntry(id, `Entry ${id}`, from, to, extra);

async function setup(entries: Entry[]) {
  const proxy = fixtureProxy(NOW);
  proxy.fixture.state.entries = entries;
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const app = await store.getResource(APP);
  app.set(schema.settings.workspaceId, WORKSPACE.id);
  app.set(schema.settings.userId, USER.id);
  app.set(schema.settings.lookbackDays, 7);
  await app.save();

  const open = async (): Promise<Controller> => {
    const controller = createController(
      store,
      () => {},
      () => NOW,
    );
    const { syncing } = await controller.load();
    await syncing;

    return controller;
  };

  const writes = () =>
    (
      proxy.fixture.state.writes as Array<{
        method: string;
        path: string;
        body: Record<string, unknown> | null;
      }>
    ).map(w => ({ ...w, path: w.path.split('/time-entries')[1] ?? '' }));
  const rows = () =>
    [...store.resources.values()].filter(r => r[PARENT] === TABLE);
  const clockify = () => proxy.fixture.state.entries as Entry[];

  return { proxy, store, schema, open, writes, rows, clockify };
}

const iso = (ms: number) => new Date(ms).toISOString().replace('.000', '');

describe('worked on P over a range', () => {
  it('S10: an empty range becomes one POST after review; reopening shows it once', async () => {
    const t = await setup([entry('a', at(8), at(9), { projectId: P })]);
    const c = await t.open();

    expect(
      await c.editRange({
        from: at(13) + 20_000,
        to: at(14),
        target: { kind: 'worked', projectId: Q },
      }),
    ).toBe(true);
    const [change] = c.changes().review;
    expect(change).toMatchObject({
      kind: 'create',
      // Typed ranges snap to whole minutes.
      desired: { start: at(13), end: at(14), projectId: Q, billable: false },
      blockers: [],
    });
    expect(c.sheet()!.entries.find(e => e.pending === 'create')).toMatchObject({
      start: at(13),
      end: at(14),
      project: { id: Q },
    });
    expect(t.writes()).toEqual([]);

    await c.send();
    expect(c.changes().outcomes!.results).toMatchObject([
      { kind: 'create', status: 'sent' },
    ]);
    expect(t.writes()).toMatchObject([
      {
        method: 'POST',
        path: '',
        body: {
          start: iso(at(13)),
          end: iso(at(14)),
          projectId: Q,
          description: '',
          billable: false,
          tagIds: [],
          type: 'REGULAR',
        },
      },
    ]);
    expect(c.changes().review).toEqual([]);

    const again = await t.open();
    const last = again.state();
    // The new row already has its Member columns: nothing to update.
    expect(
      last.kind === 'ready' && last.last?.ok && last.last.result,
    ).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: 2,
    });
    expect(again.changes().review).toEqual([]);
    expect(t.rows()).toHaveLength(2);
    expect(t.clockify()).toHaveLength(2);
    expect(again.sheet()!.conflicts).toEqual([]);
  });

  it('S11: next to a P entry, extends it with one PUT', async () => {
    const t = await setup([entry('a', at(8), at(9), { projectId: P })]);
    const c = await t.open();

    await c.editRange({
      from: at(9),
      to: at(10),
      target: { kind: 'worked', projectId: P },
    });
    expect(c.changes().review).toMatchObject([
      { kind: 'update', entryId: 'a', fields: ['end'] },
    ]);
    await c.send();
    expect(t.writes()).toMatchObject([
      {
        method: 'PUT',
        path: '/a',
        body: { start: iso(at(8)), end: iso(at(10)), projectId: P },
      },
    ]);
  });

  it('S12: over exactly one Q entry, one PUT moves it to P; the task goes, description and tags stay', async () => {
    const t = await setup([
      entry('q', at(8), at(9), {
        projectId: Q,
        taskId: 'task-1',
        tagIds: ['tag-1'],
      }),
    ]);
    const c = await t.open();

    await c.editRange({
      from: at(8),
      to: at(9),
      target: { kind: 'worked', projectId: P },
    });
    await c.send();
    const [put] = t.writes();
    expect(put).toMatchObject({
      method: 'PUT',
      path: '/q',
      body: {
        projectId: P,
        description: 'Entry q',
        tagIds: ['tag-1'],
        end: iso(at(9)),
      },
    });
    expect(put.body).not.toHaveProperty('taskId');
    expect(t.writes()).toHaveLength(1);
  });
});

describe('did not work over a range', () => {
  it('S9: inside an entry, a PUT trims it and a POST copies the rest, in that order', async () => {
    const t = await setup([
      entry('a', at(8), at(10), {
        projectId: P,
        taskId: 'task-1',
        tagIds: ['tag-1'],
      }),
    ]);
    const c = await t.open();

    await c.editRange({
      from: at(8) + 30 * MIN,
      to: at(9),
      target: { kind: 'didNotWork' },
    });
    expect(c.changes().review.map(x => x.kind)).toEqual(['update', 'create']);
    await c.send();
    expect(c.changes().outcomes!.results.map(o => o.status)).toEqual([
      'sent',
      'sent',
    ]);
    expect(t.writes()).toMatchObject([
      { method: 'PUT', path: '/a', body: { end: iso(at(8) + 30 * MIN) } },
      {
        method: 'POST',
        body: {
          start: iso(at(9)),
          end: iso(at(10)),
          projectId: P,
          description: 'Entry a',
          taskId: 'task-1',
          tagIds: ['tag-1'],
          billable: true,
        },
      },
    ]);

    // The verification reads show the gap; reopening lists nothing.
    const again = await t.open();
    expect(again.changes().review).toEqual([]);
    expect(
      again
        .sheet()!
        .entries.map(e => [e.start, e.end])
        .sort((x, y) => x[0] - y[0]),
    ).toEqual([
      [at(8), at(8) + 30 * MIN],
      [at(9), at(10)],
    ]);
  });
});

describe('resolving conflicts (#123 §4)', () => {
  it('S6: "Keep P" on an overlap of P and Q trims Q, and the conflict is gone', async () => {
    const t = await setup([
      entry('p', at(9), at(11) + 13_000, { projectId: P }),
      entry('q', at(10) + 7_000, at(12), { projectId: Q }),
    ]);
    const c = await t.open();
    const [conflict] = c.sheet()!.conflicts as TimelineConflict[];
    expect(conflict).toMatchObject({
      kind: 'whichProject',
      from: at(10) + 7_000,
      to: at(11) + 13_000,
    });

    await c.resolveConflict(conflict, { kind: 'worked', projectId: P });
    // A conflict's span is used exactly: Q now starts where P ends.
    expect(c.changes().review).toMatchObject([
      {
        kind: 'update',
        entryId: 'q',
        desired: { start: at(11) + 13_000, end: at(12) },
      },
    ]);
    await c.send();
    expect(t.writes()).toMatchObject([
      { method: 'PUT', path: '/q', body: { start: iso(at(11) + 13_000) } },
    ]);
    expect(c.sheet()!.conflicts).toEqual([]);

    const again = await t.open();
    expect(again.sheet()!.conflicts).toEqual([]);
    expect(again.changes().review).toEqual([]);
  });

  it('S6: "Did not work" on the overlap trims both', async () => {
    const t = await setup([
      entry('p', at(9), at(11), { projectId: P }),
      entry('q', at(10), at(12), { projectId: Q }),
    ]);
    const c = await t.open();
    const [conflict] = c.sheet()!.conflicts as TimelineConflict[];

    await c.resolveConflict(conflict, { kind: 'didNotWork' });
    await c.send();
    expect(t.writes().map(w => `${w.method} ${w.path}`)).toEqual([
      'PUT /p',
      'PUT /q',
    ]);
    expect(c.sheet()!.conflicts).toEqual([]);
  });

  it('S7: "Remove duplicate" deletes the later copy with one DELETE', async () => {
    const t = await setup([
      entry('a', at(9), at(11), { projectId: P }),
      entry('b', at(10), at(11), { projectId: P }),
    ]);
    const c = await t.open();
    const [conflict] = c.sheet()!.conflicts as TimelineConflict[];
    expect(conflict.kind).toBe('duplicate');

    await c.resolveConflict(conflict, { kind: 'worked', projectId: P });
    expect(c.changes().review).toMatchObject([
      { kind: 'delete', entryId: 'b' },
    ]);
    await c.send();
    expect(t.writes()).toMatchObject([{ method: 'DELETE', path: '/b' }]);
    expect(c.sheet()!.conflicts).toEqual([]);
    expect(t.rows()).toHaveLength(1);
  });
});

describe('creates that may not have arrived', () => {
  it('S15: an uncertain POST is bound on the next sync, with no duplicate row or entry', async () => {
    const t = await setup([]);
    const c = await t.open();
    await c.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    t.proxy.fixture.state.applyThenDrop = { status: 502 };

    await c.send();
    expect(c.changes().outcomes!.results).toMatchObject([
      { kind: 'create', status: 'uncertain' },
    ]);
    expect(t.clockify()).toHaveLength(1);

    const again = await t.open();
    expect(again.changes().recovered).toMatchObject([{ applied: true }]);
    expect(again.changes().review).toEqual([]);
    expect(t.rows()).toHaveLength(1);
    expect(t.rows()[0][t.schema.row.entryId]).toBe(t.clockify()[0].id);
    expect(t.writes().filter(w => w.method === 'POST')).toHaveLength(1);
  });

  it('the sync that settles an uncertain send drops its outcome in the same copy', async () => {
    const t = await setup([]);
    const c = await t.open();
    await c.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    t.proxy.fixture.state.failBefore = { status: 503 };
    await c.send();
    expect(c.changes().outcomes!.results[0].status).toBe('uncertain');

    // The card would otherwise still say "checked on the next sync" after
    // that sync; what happened is in `recovered`, the change is listed again.
    await c.sync();
    expect(c.changes().outcomes).toBeUndefined();
    expect(c.changes().recovered).toMatchObject([{ applied: false }]);
    expect(c.changes().review).toMatchObject([
      { kind: 'create', blockers: [] },
    ]);
  });

  it('S16: a POST that failed before applying is listed again, and sent once more', async () => {
    const t = await setup([]);
    const c = await t.open();
    await c.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    t.proxy.fixture.state.failBefore = { status: 503 };

    await c.send();
    expect(c.changes().outcomes!.results[0].status).toBe('uncertain');
    // Until a sync settles it, it is not sent again.
    expect(c.changes().review[0].blockers).toHaveLength(1);

    const again = await t.open();
    expect(again.changes().recovered).toMatchObject([{ applied: false }]);
    expect(again.changes().review).toMatchObject([
      { kind: 'create', blockers: [] },
    ]);
    await again.send();
    expect(again.changes().outcomes!.results[0].status).toBe('sent');
    expect(t.clockify()).toHaveLength(1);
    expect(t.writes().filter(w => w.method === 'POST')).toHaveLength(2);
  });

  it('creates nothing when Clockify has time in the range by the time it is sent', async () => {
    const t = await setup([]);
    const c = await t.open();
    await c.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    t.clockify().push(entry('other', at(13) + 30 * MIN, at(15)));

    await c.send();
    expect(c.changes().outcomes!.results[0]).toMatchObject({
      status: 'conflict',
    });
    expect(t.writes()).toEqual([]);
  });

  it('Discard removes a new row that was not sent', async () => {
    const t = await setup([]);
    const c = await t.open();
    await c.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    expect(t.rows()).toHaveLength(1);

    await c.discard(c.changes().review[0].entryId);
    expect(c.changes().review).toEqual([]);
    expect(t.rows()).toHaveLength(0);
  });
});

describe('refused range edits (§3.1, S23)', () => {
  it('refuses a break for "worked", time outside the window, and an entry with an unsent change', async () => {
    const t = await setup([
      entry('a', at(8), at(9), { projectId: P }),
      entry('brk', at(12), at(13), { type: 'BREAK' }),
    ]);
    const c = await t.open();
    const worked = { kind: 'worked' as const, projectId: P };

    expect(
      await c.editRange({ from: at(12), to: at(14), target: worked }),
    ).toBe(false);
    expect(c.changes().error).toBe(
      'A break entry is in this range; it can only be changed in Clockify.',
    );

    expect(
      await c.editRange({
        from: NOW - 9 * 24 * HOUR,
        to: NOW - 8 * 24 * HOUR,
        target: worked,
      }),
    ).toBe(false);
    expect(c.changes().error).toMatch(/inside the last 7 days/);

    await c.editEntry('a', { name: 'Renamed' });
    expect(
      await c.editRange({
        from: at(8),
        to: at(10),
        target: { kind: 'didNotWork' },
      }),
    ).toBe(false);
    expect(c.changes().error).toMatch(/not sent yet/);
    expect(t.writes()).toEqual([]);
  });
});
