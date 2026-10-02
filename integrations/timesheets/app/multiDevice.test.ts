// @wc-ignore-file
/**
 * #123 M5 against the mock proxy, through the controller and the in-memory
 * store: two open copies of the app (two devices, or two tabs).
 *
 * - S21 and S22: range edits made apart, and one made after seeing the
 *   other. "Apart" is modelled with two copies of the drive (`twoDrives`):
 *   each device writes to its own until `reconnect`, which merges them the
 *   way commits to one resource do: per property, the later save wins
 *   (device B's here), new resources are added, destroyed ones go.
 * - The send lease: one drive, two controllers.
 *
 * S28 (two devices compacting at once) is in `observationLog.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyEntry,
  PROJECT,
  PROJECT_2,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import {
  createController,
  describe as describeState,
  HELD_BY_CONFLICT,
  type Controller,
} from './controller.js';
import { APP, fakeStore, PARENT, TABLE, type FakeStore } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { LEASE_TTL_MS, SendLease } from './lease.js';
import { ensureSchema, type CompleteSchema } from './schema.js';
import type { JSONValue } from './store.js';
import { resolutions } from './timeline/render.js';
import type { TimelineConflict } from './timeline/types.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const HOUR = 3_600_000;
const DAY = Date.parse('2026-09-22T00:00:00Z');
const at = (h: number) => DAY + h * HOUR;
const P = PROJECT.id;
const Q = PROJECT_2.id;

type Entry = ReturnType<typeof clockifyEntry>;
type Drive = Map<string, Record<string, JSONValue>>;
const entry = (
  id: string,
  from: number,
  to: number,
  extra: Record<string, unknown> = {},
): Entry => clockifyEntry(id, `Entry ${id}`, from, to, extra);

const copy = (drive: Drive): Drive =>
  new Map([...drive].map(([k, v]) => [k, structuredClone(v)]));

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
  let clock = NOW;

  const open = async (on: FakeStore, device: string): Promise<Controller> => {
    const controller = createController(
      on,
      () => {},
      () => clock,
      device,
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
  const rows = (on: FakeStore = store) =>
    [...on.resources.values()].filter(r => r[PARENT] === TABLE);

  return {
    proxy,
    store,
    schema,
    open,
    writes,
    rows,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
  };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Device A on the setup's drive, device B on a copy of it, each synced. */
async function twoDrives(t: Setup) {
  const a = await t.open(t.store, 'frame-a');
  let base = copy(t.store.resources);
  const storeB = fakeStore({
    proxy: t.proxy.request,
    resources: copy(base),
    idPrefix: 'b',
  });
  const b = await t.open(storeB, 'frame-b');
  // B's first sync is part of the shared starting point.
  base = copy(storeB.resources);
  t.store.resources.clear();
  for (const [k, v] of copy(base)) t.store.resources.set(k, v);

  /** Both drives sync: per property, B's saves after A's. */
  const reconnect = () => {
    const merged = copy(base);
    const gone = new Set<string>();

    for (const side of [t.store.resources, storeB.resources]) {
      for (const subject of base.keys())
        if (!side.has(subject)) gone.add(subject);

      for (const [subject, props] of side) {
        const was = base.get(subject);
        const into = merged.get(subject) ?? {};
        for (const [p, v] of Object.entries(props))
          if (!was || JSON.stringify(was[p]) !== JSON.stringify(v))
            into[p] = structuredClone(v);
        merged.set(subject, into);
      }
    }

    for (const subject of gone) merged.delete(subject);
    base = merged;

    for (const side of [t.store.resources, storeB.resources]) {
      side.clear();
      for (const [k, v] of copy(merged)) side.set(k, v);
    }
  };

  return { a, b, storeB, reconnect };
}

const local = (c: Controller) =>
  (c.sheet()!.conflicts as TimelineConflict[]).filter(x => x.kind === 'local');

describe('range edits on two devices (#123 M5)', () => {
  it('S21: the same range edited apart to different projects is a conflict on both devices, and nothing is sent until one is chosen', async () => {
    const t = await setup([entry('a', at(8), at(9), { projectId: P })]);
    const { a, b, storeB, reconnect } = await twoDrives(t);

    expect(
      await a.editRange({
        from: at(13),
        to: at(14),
        target: { kind: 'worked', projectId: P },
      }),
    ).toBe(true);
    expect(
      await b.editRange({
        from: at(13),
        to: at(14),
        target: { kind: 'worked', projectId: Q },
      }),
    ).toBe(true);
    // Apart, each sees only its own.
    expect(local(a)).toEqual([]);
    expect(local(b)).toEqual([]);

    reconnect();
    await a.sync();
    await b.sync();

    for (const [device, here] of [
      [a, 'frame-a'],
      [b, 'frame-b'],
    ] as const) {
      const [conflict] = local(device);
      expect(conflict).toMatchObject({
        from: at(13),
        to: at(14),
        candidates: [
          { kind: 'worked', projectId: P },
          { kind: 'worked', projectId: Q },
        ],
      });
      // Each device marks its own edit as made here.
      expect(
        conflict
          .edits!.map(e => [e.label, e.here])
          .sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)),
      ).toEqual([
        [{ kind: 'worked', projectId: P }, here === 'frame-a'],
        [{ kind: 'worked', projectId: Q }, here === 'frame-b'],
      ]);
      expect(resolutions(conflict, device.sheet()!).map(r => r.label)).toEqual([
        'Keep Atomic plugins',
        'Keep Research',
        'Did not work',
      ]);
      const review = device.changes().review;
      expect(review.map(c => c.kind)).toEqual(['create', 'create']);
      for (const change of review)
        expect(change.blockers).toContain(HELD_BY_CONFLICT);
    }

    await a.send();
    await b.send();
    expect(t.writes()).toEqual([]);

    // A chooses B's edit: it replaces both, and only that is sent.
    const [conflict] = local(a);
    expect(
      await a.resolveConflict(conflict, { kind: 'worked', projectId: Q }),
    ).toBe(true);
    expect(local(a)).toEqual([]);
    expect(a.changes().review).toMatchObject([
      { kind: 'create', desired: { projectId: Q }, blockers: [] },
    ]);
    await a.send();
    expect(t.writes()).toMatchObject([
      { method: 'POST', body: { projectId: Q } },
    ]);

    reconnect();
    await b.sync();
    expect(local(b)).toEqual([]);
    expect(b.changes().review).toEqual([]);
    expect(t.rows(storeB)).toHaveLength(2);
  });

  it('S21: one entry edited apart ("did not work" here, another project there) is held, not silently sent as one of them', async () => {
    const t = await setup([entry('e', at(13), at(14), { projectId: P })]);
    const { a, b, reconnect } = await twoDrives(t);

    await a.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'didNotWork' },
    });
    await b.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: Q },
    });
    reconnect();
    await a.sync();

    // The row now holds both: the deletion mark and the other project.
    const [change] = a.changes().review;
    expect(change).toMatchObject({ kind: 'delete', entryId: 'e' });
    expect(change.blockers).toContain(HELD_BY_CONFLICT);
    await a.send();
    expect(t.writes()).toEqual([]);

    const [conflict] = local(a);
    expect(conflict.candidates).toEqual([
      { kind: 'worked', projectId: Q },
      { kind: 'didNotWork' },
    ]);
    await a.resolveConflict(conflict, { kind: 'worked', projectId: Q });
    expect(a.changes().review).toMatchObject([
      { kind: 'update', entryId: 'e', fields: ['projectId'], blockers: [] },
    ]);
    await a.send();
    expect(t.writes()).toMatchObject([
      { method: 'PUT', path: '/e', body: { projectId: Q } },
    ]);
  });

  it('agrees when both devices made the same edit apart: no conflict, and one entry is created', async () => {
    const t = await setup([]);
    const { a, b, reconnect } = await twoDrives(t);
    const edit = {
      from: at(13),
      to: at(14),
      target: { kind: 'worked' as const, projectId: P },
    };

    await a.editRange(edit);
    await b.editRange(edit);
    reconnect();
    await a.sync();
    expect(local(a)).toEqual([]);
    expect(a.changes().review.map(c => c.blockers)).toEqual([[], []]);
    await a.send();
    // The second create finds the first one's entry there and stops.
    expect(a.changes().outcomes!.results.map(o => o.status)).toEqual([
      'sent',
      'conflict',
    ]);
    expect(t.writes()).toHaveLength(1);
  });

  it('S22: a device that saw the other one’s edit replaces it: no conflict on either device', async () => {
    const t = await setup([]);
    const { a, b, reconnect } = await twoDrives(t);

    await a.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    reconnect();
    await b.sync();
    expect(b.changes().review).toMatchObject([
      { kind: 'create', desired: { projectId: P } },
    ]);

    expect(
      await b.editRange({
        from: at(13),
        to: at(14),
        target: { kind: 'worked', projectId: Q },
      }),
    ).toBe(true);
    expect(local(b)).toEqual([]);
    expect(b.changes().review).toMatchObject([
      { kind: 'create', desired: { projectId: Q }, blockers: [] },
    ]);

    reconnect();
    await a.sync();
    expect(local(a)).toEqual([]);
    expect(a.changes().review).toMatchObject([
      { kind: 'create', desired: { projectId: Q }, blockers: [] },
    ]);
    await a.send();
    expect(t.writes()).toMatchObject([
      { method: 'POST', body: { projectId: Q } },
    ]);
  });

  it('S22: refuses to replace an edit that reaches outside the new range', async () => {
    const t = await setup([]);
    const { a, b, reconnect } = await twoDrives(t);

    await a.editRange({
      from: at(13),
      to: at(15),
      target: { kind: 'worked', projectId: P },
    });
    reconnect();
    await b.sync();

    expect(
      await b.editRange({
        from: at(13),
        to: at(14),
        target: { kind: 'worked', projectId: Q },
      }),
    ).toBe(false);
    expect(b.changes().error).toMatch(/reaches outside this range/);
    expect(b.changes().review).toMatchObject([
      { kind: 'create', desired: { projectId: P } },
    ]);
  });
});

describe('a range edit after a sent one (#279)', () => {
  it('a range edit over a row a sent range edit made is a normal edit, not a conflict between your edits', async () => {
    const t = await setup([entry('e', at(8), at(12), { projectId: Q })]);
    const a = await t.open(t.store, 'frame-a');

    expect(
      await a.editRange({
        from: at(9),
        to: at(10),
        target: { kind: 'worked', projectId: P },
      }),
    ).toBe(true);
    await a.send();
    expect(t.writes().map(w => w.method)).toEqual(['PUT', 'POST', 'POST']);
    expect(a.changes().review).toEqual([]);

    // Right away, "did not work" over the new middle entry.
    expect(
      await a.editRange({
        from: at(9),
        to: at(10),
        target: { kind: 'didNotWork' },
      }),
    ).toBe(true);
    expect(local(a)).toEqual([]);
    expect(a.changes().review).toMatchObject([
      { kind: 'delete', blockers: [] },
    ]);

    // Also after reopening the app.
    const again = await t.open(t.store, 'frame-a2');
    expect(local(again)).toEqual([]);
    expect(again.changes().review).toMatchObject([
      { kind: 'delete', blockers: [] },
    ]);

    await again.send();
    expect(t.writes().map(w => w.method)).toEqual([
      'PUT',
      'POST',
      'POST',
      'DELETE',
    ]);
  });

  it('S21 still holds over a sent edit: two devices that both saw it and edit its rows apart, differently, conflict', async () => {
    const t = await setup([entry('e', at(8), at(12), { projectId: Q })]);
    const { a, b, reconnect } = await twoDrives(t);

    await a.editRange({
      from: at(9),
      to: at(10),
      target: { kind: 'worked', projectId: P },
    });
    await a.send();
    expect(t.writes()).toHaveLength(3);
    reconnect();
    await b.sync();
    expect(b.changes().review).toEqual([]);

    // Both name the sent edit as settled, but not each other.
    expect(
      await a.editRange({
        from: at(9),
        to: at(10),
        target: { kind: 'didNotWork' },
      }),
    ).toBe(true);
    expect(
      await b.editRange({
        from: at(9),
        to: at(10),
        target: { kind: 'worked', projectId: Q },
      }),
    ).toBe(true);
    expect(local(a)).toEqual([]);
    expect(local(b)).toEqual([]);

    reconnect();
    await a.sync();
    await b.sync();

    for (const device of [a, b]) {
      const [conflict] = local(device);
      expect(conflict).toMatchObject({ from: at(9), to: at(10) });
      expect(conflict.candidates).toEqual([
        { kind: 'worked', projectId: Q },
        { kind: 'didNotWork' },
      ]);
      for (const change of device.changes().review)
        expect(change.blockers).toContain(HELD_BY_CONFLICT);
    }

    await a.send();
    expect(t.writes()).toHaveLength(3);
  });

  it('a later edit over a sent edit’s range does not put back an edit of the sent one’s other row', async () => {
    const t = await setup([entry('e', at(8), at(12), { projectId: Q })]);
    const a = await t.open(t.store, 'frame-a');

    await a.editRange({
      from: at(9),
      to: at(10),
      target: { kind: 'worked', projectId: P },
    });
    await a.send();
    expect(t.writes()).toHaveLength(3);

    // The tail row (made by the sent edit, outside its range) is edited...
    expect(
      await a.editRange({
        from: at(11),
        to: at(12),
        target: { kind: 'didNotWork' },
      }),
    ).toBe(true);
    // ...then the sent edit's own range: the tail's change stays staged.
    expect(
      await a.editRange({
        from: at(9),
        to: at(10),
        target: { kind: 'didNotWork' },
      }),
    ).toBe(true);
    expect(local(a)).toEqual([]);
    expect(
      a
        .changes()
        .review.map(c => `${c.kind} ${c.blockers.length}`)
        .sort(),
    ).toEqual(['delete 0', 'update 0']);
  });
});

describe('one sender at a time: the lease (#123 M5)', () => {
  const take = (t: Setup, device: string) =>
    SendLease.take(t.store, t.schema as CompleteSchema, {
      device,
      clock: t.now,
    });

  const lease = (t: Setup) => {
    const head = t.store.resources.get(APP)![t.schema.log.log] as string;

    return JSON.parse(
      t.store.resources.get(head)![t.schema.log.lease] as string,
    ) as { device: string; until: string };
  };

  it('sends nothing while another copy holds the lease, and sends once it has expired', async () => {
    const t = await setup([]);
    const a = await t.open(t.store, 'frame-a');
    await a.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    expect(await take(t, 'frame-b')).toBeInstanceOf(SendLease);

    await a.send();
    expect(a.changes().outcomes!.results).toMatchObject([
      {
        status: 'not-sent',
        message: expect.stringMatching(/Another open copy/),
      },
    ]);
    expect(t.writes()).toEqual([]);
    expect(a.changes().review).toHaveLength(1);

    t.advance(LEASE_TTL_MS + 1000);
    await a.send();
    expect(a.changes().outcomes!.results.map(o => o.status)).toEqual(['sent']);
    expect(t.writes()).toHaveLength(1);
    // Given back at the end: another copy may take it at once.
    expect(lease(t)).toMatchObject({
      device: 'frame-a',
      until: new Date(t.now()).toISOString(),
    });
    expect(await take(t, 'frame-b')).toBeInstanceOf(SendLease);
  });

  it('keeps the lease through a batch longer than its 60 s, and another copy cannot take it meanwhile', async () => {
    const t = await setup([]);
    const a = await t.open(t.store, 'frame-a');
    for (const h of [13, 15, 17])
      await a.editRange({
        from: at(h),
        to: at(h + 1),
        target: { kind: 'worked', projectId: P },
      });
    const taken: unknown[] = [];
    const request = t.proxy.request;

    t.store.proxy!.request = async req => {
      t.advance(20_000);
      if (req.method === 'POST') taken.push(await take(t, 'frame-b'));

      return request(req);
    };

    await a.send();
    expect(a.changes().outcomes!.results.map(o => o.status)).toEqual([
      'sent',
      'sent',
      'sent',
    ]);
    // Each create reads the range, posts, and reads the entry: 60 s each.
    expect(taken).toHaveLength(3);
    for (const result of taken)
      expect(result).toMatchObject({ heldBy: { device: 'frame-a' } });
  });

  it('stops when another copy took the lease over (this one stalled past it): the rest is not sent', async () => {
    const t = await setup([]);
    const a = await t.open(t.store, 'frame-a');
    for (const h of [13, 15])
      await a.editRange({
        from: at(h),
        to: at(h + 1),
        target: { kind: 'worked', projectId: P },
      });
    const request = t.proxy.request;
    let stalled = false;

    t.store.proxy!.request = async req => {
      const response = await request(req);

      if (req.method === 'POST' && !stalled) {
        stalled = true;
        t.advance(LEASE_TTL_MS + 1000);
        expect(await take(t, 'frame-b')).toBeInstanceOf(SendLease);
      }

      return response;
    };

    await a.send();
    expect(a.changes().outcomes!.results).toMatchObject([
      { status: 'sent' },
      {
        status: 'not-sent',
        message: expect.stringMatching(/Another open copy/),
      },
    ]);
    expect(t.writes()).toHaveLength(1);
    // Not given back: it is the other copy's now.
    expect(lease(t).device).toBe('frame-b');
  });

  it('a sync leaves an unconfirmed create alone while another copy is sending it', async () => {
    const t = await setup([]);
    const a = await t.open(t.store, 'frame-a');
    await a.editRange({
      from: at(13),
      to: at(14),
      target: { kind: 'worked', projectId: P },
    });
    // Another copy holds the lease and has marked the row: its POST may be
    // on its way.
    expect(await take(t, 'frame-b')).toBeInstanceOf(SendLease);
    const [row] = t.rows();
    const subject = [...t.store.resources].find(([, r]) => r === row)![0];
    const marker = JSON.stringify({
      op: 'post',
      sentAt: '2026-09-23T11:59:59Z',
    });
    t.store.resources.get(subject)![t.schema.sync.outbox] = marker;

    await a.sync();
    const state = a.state();
    expect(
      state.kind === 'ready' && state.last?.ok && state.last.result,
    ).toMatchObject({
      recovered: [],
    });
    expect(describeState(state)).toMatch(
      /Another open copy of this app is sending changes to Clockify/,
    );
    expect(t.store.resources.get(subject)![t.schema.sync.outbox]).toBe(marker);

    // Once its turn is over, the next sync settles it: it did not arrive.
    t.advance(LEASE_TTL_MS + 1000);
    await a.sync();
    const after = a.state();
    expect(
      after.kind === 'ready' && after.last?.ok && after.last.result,
    ).toMatchObject({
      recovered: [{ applied: false }],
    });
    expect(t.store.resources.get(subject)![t.schema.sync.outbox]).toBe('');
  });
});
