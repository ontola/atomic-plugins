// @wc-ignore-file
/**
 * #123 M3 write-back against the mock proxy (`../fixtures/clockify/`),
 * through the in-memory store: bookkeeping on the row (#177 Q4), compare on
 * open, review before send, fresh read and verification, Clockify wins
 * conflicts, and the #123 §5.2 scenarios S9 (a field edit here, not a
 * range split), S13, S14, S16, S17, S18, S20, S23–S26.
 */
import { describe, expect, it } from 'vitest';
import {
  ARCHIVED_PROJECT,
  PROJECT,
  PROJECT_2,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import type { Settings } from './config.js';
import { fakeStore, PARENT, TABLE } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { SHARED, WORK_PROJECT } from './fields.js';
import { ObservationLog } from './observationLog.js';
import { NAME } from './ontology.js';
import { ensureSchema, type CompleteSchema } from './schema.js';
import type { PluginResource } from './store.js';
import { newObservationId, syncClockify } from './sync.js';
import { relayTransport } from './transport.js';
import {
  planAll,
  sendChanges,
  type PendingChange,
  type SendContext,
} from './writeBack.js';
import type { ClockifyProject } from '../devonian/clockify/lens/index.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const MINUTE = 60_000;
const CONNECTION = { platform: 'clockify', connectionId: 'conn-1' };
const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};
const PROJECTS = [PROJECT, PROJECT_2, ARCHIVED_PROJECT] as ClockifyProject[];
const ENTRY_PATH = (id: string) =>
  `/proxy/clockify/api/v1/workspaces/${WORKSPACE.id}/time-entries/${id}`;

async function setup(options: { forceProjects?: boolean } = {}) {
  const proxy = fixtureProxy(NOW);
  if (options.forceProjects) proxy.fixture.state.forceProjects = true;
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const transport = relayTransport(store.proxy!, CONNECTION);
  let tick = NOW;
  const clock = () => tick++;
  const sync = () =>
    syncClockify(store, transport, settings, schema, NOW, { clock });
  const first = await sync();
  expect(first.created).toBe(2);

  const row = async (entryId: string): Promise<PluginResource> => {
    const subject = [...store.resources.entries()].find(
      ([, r]) => r[PARENT] === TABLE && r[schema.row.entryId] === entryId,
    )?.[0];
    if (!subject) throw new Error(`no row for ${entryId}`);

    return store.getResource(subject);
  };

  /** The Projects table's row of Clockify project `id`. */
  const projectRow = (id: string) =>
    [...store.resources.entries()].find(
      ([, r]) =>
        r[PARENT] === schema.tables.projects && r[schema.link.projectId] === id,
    )![0];
  /** A project row someone added by hand: a name, no Clockify id. */
  const namedRow = async (name: string) =>
    (
      await store.newResource({
        parent: schema.tables.projects,
        isA: [WORK_PROJECT],
        propVals: { [NAME]: name },
      })
    ).subject;
  const entry = (id: string) =>
    proxy.fixture.state.entries.find((e: { id: string }) => e.id === id);
  const sleeps: number[] = [];

  const send = async (changes: PendingChange[]) => {
    const log = await ObservationLog.open(store, schema, { clock });
    const context: SendContext = {
      store,
      schema,
      log,
      read: {
        transport,
        workspaceId: WORKSPACE.id,
        userId: USER.id,
        timeZone: 'Europe/Amsterdam',
        clock,
        newId: () => newObservationId(clock),
        device: 'test',
      },
      write: {
        now: NOW,
        ...(options.forceProjects ? { forceProjects: true } : {}),
        projects: PROJECTS,
      },
      sleep: async ms => {
        sleeps.push(ms);
      },
    };

    return { outcomes: await sendChanges(context, changes), log };
  };

  const writes = () =>
    proxy.fixture.state.writes as Array<{
      method: string;
      path: string;
      body: Record<string, unknown> | null;
    }>;
  const plan = async () =>
    planAll(
      store,
      schema,
      (await ObservationLog.open(store, schema, { clock })).mirror,
      { now: NOW, projects: PROJECTS },
    );

  return {
    proxy,
    store,
    schema,
    sync,
    row,
    entry,
    send,
    writes,
    plan,
    sleeps,
    projectRow,
    namedRow,
  };
}

const edit = async (
  row: PluginResource,
  values: Record<string, string | number | boolean>,
) => {
  for (const [p, v] of Object.entries(values)) row.set(p, v);
  await row.save();
};

const baselineOf = (row: PluginResource, schema: CompleteSchema) =>
  JSON.parse(String(row.get(schema.sync.baseline))) as Record<string, unknown>;

describe('bookkeeping on the row (#177 Q4)', () => {
  it('stores a baseline on every synced row, and lists nothing while rows match', async () => {
    const t = await setup();
    const row = await t.row('entry-2');

    expect(baselineOf(row, t.schema)).toEqual({
      name: 'Weekly sync',
      start: row.get(t.schema.row.start),
      end: row.get(t.schema.row.end),
      billable: false,
      projectId: PROJECT.id,
      project: PROJECT.name,
    });
    expect((await t.sync()).review).toEqual([]);
  });

  it('gives a pre-0.2 row (no baseline) one, taking Clockify’s values as before', async () => {
    const t = await setup();
    const row = await t.row('entry-1');
    row.set(t.schema.sync.baseline, '');
    await edit(row, { [NAME]: 'Edited before 0.2' });

    const result = await t.sync();

    expect(result.review).toEqual([]);
    expect((await t.row('entry-1')).get(NAME)).toBe(
      'Fix plugin source loading',
    );
  });
});

describe('compare on open', () => {
  it('keeps a table edit and lists it, instead of overwriting it (#177 Q5)', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), {
      [NAME]: 'Weekly sync (notes)',
      [t.schema.row.billable]: true,
    });

    const result = await t.sync();

    expect((await t.row('entry-2')).get(NAME)).toBe('Weekly sync (notes)');
    expect(result.review).toHaveLength(1);
    expect(result.review[0]).toMatchObject({
      kind: 'update',
      entryId: 'entry-2',
      title: 'Weekly sync',
      fields: ['name', 'billable'],
      blockers: [],
    });
    expect(result.unchanged).toBe(2);
    expect(t.writes()).toEqual([]);
  });

  it('takes a Clockify-only change into the row and keeps the row’s own change on another field', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [t.schema.row.billable]: true });
    t.proxy.fixture.control({
      action: 'update',
      id: 'entry-2',
      patch: { description: 'Weekly sync (moved)' },
    });

    const result = await t.sync();
    const row = await t.row('entry-2');

    expect(row.get(NAME)).toBe('Weekly sync (moved)');
    expect(row.get(t.schema.row.billable)).toBe(true);
    expect(result.providerWon).toEqual([]);
    expect(result.review.map(c => c.fields)).toEqual([['billable']]);
  });

  it('lets Clockify win a field changed on both sides, and says what was dropped', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    t.proxy.fixture.control({
      action: 'update',
      id: 'entry-2',
      patch: { description: 'Theirs' },
    });

    const result = await t.sync();

    expect((await t.row('entry-2')).get(NAME)).toBe('Theirs');
    expect(result.review).toEqual([]);
    expect(result.providerWon).toEqual([
      {
        entryId: 'entry-2',
        title: 'Theirs',
        fields: [{ field: 'name', yours: 'Mine', clockify: 'Theirs' }],
      },
    ]);
  });
});

describe('sending (review first)', () => {
  it('S9/S13: sends a reviewed edit as one full PUT, verifies it, and only then advances the baseline', async () => {
    const t = await setup();
    const before = structuredClone(t.entry('entry-2'));
    const start = Number((await t.row('entry-2')).get(t.schema.row.start));
    await edit(await t.row('entry-2'), {
      [NAME]: 'Weekly sync (notes)',
      // Another project: a link to its row in the Projects table (#177 Q11).
      [SHARED.project]: t.projectRow(PROJECT_2.id),
      // Seconds are snapped off a changed start (#97 answer 7).
      [t.schema.row.start]: start - 10 * MINUTE + 25_000,
    });
    const { review } = await t.sync();
    expect(review[0].desired.start).toBe(start - 10 * MINUTE);
    expect(review[0].desired.project).toBe(PROJECT_2.name);

    const { outcomes, log } = await t.send(review);

    expect(outcomes).toEqual([
      {
        entryId: 'entry-2',
        title: 'Weekly sync',
        kind: 'update',
        status: 'sent',
      },
    ]);
    expect(t.writes()).toEqual([
      {
        method: 'PUT',
        path: ENTRY_PATH('entry-2'),
        body: {
          start: new Date(start - 10 * MINUTE)
            .toISOString()
            .replace('.000Z', 'Z'),
          end: before.timeInterval.end,
          billable: false,
          description: 'Weekly sync (notes)',
          projectId: PROJECT_2.id,
          tagIds: [],
          type: 'REGULAR',
        },
      },
    ]);
    // Fresh read, write, verification read: in that order.
    const requests = t.proxy.fixture.state.requests as string[];
    expect(requests.slice(-3)).toEqual([
      `GET ${ENTRY_PATH('entry-2')}`,
      `PUT ${ENTRY_PATH('entry-2')}`,
      `GET ${ENTRY_PATH('entry-2')}`,
    ]);
    const row = await t.row('entry-2');
    expect(baselineOf(row, t.schema)).toMatchObject({
      name: 'Weekly sync (notes)',
      projectId: PROJECT_2.id,
      project: PROJECT_2.name,
    });
    expect(row.get(t.schema.sync.outbox)).toBe('');
    expect(row.get(SHARED.project)).toBe(t.projectRow(PROJECT_2.id));
    // The log saw it: the views follow without another sync.
    expect(log.mirror.records[`timeEntry/entry-2`].fields.description).toBe(
      'Weekly sync (notes)',
    );
    expect(await t.plan()).toEqual([]);
    expect((await t.sync()).review).toEqual([]);
  });

  it('sends nothing for a row that changed after the review', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'First' });
    const { review } = await t.sync();
    await edit(await t.row('entry-2'), { [NAME]: 'Second' });

    const { outcomes } = await t.send(review);

    expect(outcomes[0].status).toBe('changed');
    expect(t.writes()).toEqual([]);
  });

  it('S17: a change in Clockify before the fresh read wins, and nothing is written', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({
      action: 'onNextRequest',
      match: `GET ${ENTRY_PATH('entry-2')}`,
      id: 'entry-2',
      patch: { description: 'Theirs' },
    });

    const { outcomes } = await t.send(review);

    expect(outcomes[0]).toMatchObject({ status: 'conflict', fields: ['name'] });
    expect(t.writes()).toEqual([]);
    expect((await t.row('entry-2')).get(NAME)).toBe('Theirs');
    expect(await t.plan()).toEqual([]);
  });

  it('S18: a change in Clockify between the fresh read and the write is overwritten (the known race)', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({
      action: 'onNextRequest',
      match: `PUT ${ENTRY_PATH('entry-2')}`,
      id: 'entry-2',
      patch: { billable: true },
    });

    const { outcomes } = await t.send(review);

    // Our full-replacement PUT carried the billable value we read: theirs
    // is gone, and the verification read shows ours. Clockify offers no
    // If-Match to prevent this (#97 §4.4).
    expect(outcomes[0].status).toBe('sent');
    expect(t.entry('entry-2').billable).toBe(false);
  });

  it('S14: an uncertain PUT stops the batch; the next sync finds it applied and settles', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    await edit(await t.row('entry-1'), { [NAME]: 'Also mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({ action: 'applyThenDrop', status: 502 });

    const { outcomes } = await t.send(review);

    expect(outcomes.map(o => o.status)).toEqual(['uncertain', 'not-sent']);
    expect(t.writes()).toHaveLength(1);
    const marker = JSON.parse(
      String((await t.row('entry-1')).get(t.schema.sync.outbox)),
    );
    expect(marker).toMatchObject({ op: 'put' });

    const next = await t.sync();

    expect(next.recovered).toEqual([
      { entryId: 'entry-1', title: 'Also mine', applied: true },
    ]);
    expect(next.review.map(c => c.entryId)).toEqual(['entry-2']);
    expect((await t.row('entry-1')).get(t.schema.sync.outbox)).toBe('');
  });

  it('S16/S20: a PUT that failed before applying is listed again after reopening, and sent once more', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({ action: 'failBefore', status: 503 });

    expect((await t.send(review)).outcomes[0].status).toBe('uncertain');
    // The frame reloads: the marker on the row is all that is left.
    const reopened = await t.sync();
    expect(reopened.recovered).toEqual([
      { entryId: 'entry-2', title: 'Weekly sync', applied: false },
    ]);
    expect(reopened.review.map(c => c.entryId)).toEqual(['entry-2']);

    expect((await t.send(reopened.review)).outcomes[0].status).toBe('sent');
    expect(t.entry('entry-2').description).toBe('Mine');
    expect(t.writes()).toHaveLength(2);
  });

  it('S23/S24: a locked entry or one with custom field values is listed but not sent', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    await edit(await t.row('entry-1'), { [NAME]: 'Also mine' });
    t.proxy.fixture.control({
      action: 'update',
      id: 'entry-2',
      patch: { isLocked: true },
    });
    t.proxy.fixture.control({
      action: 'update',
      id: 'entry-1',
      patch: { customFieldValues: [{ customFieldId: 'cf-1', value: 'x' }] },
    });

    const { review } = await t.sync();

    expect(review.map(c => c.blockers)).toEqual([
      ['It has custom field values, which this app cannot write back yet.'],
      ['It is locked in Clockify.'],
    ]);
    // Even if sent anyway, the fresh read refuses them before writing.
    const { outcomes } = await t.send(review);
    expect(outcomes.map(o => o.status)).toEqual(['refused', 'refused']);
    expect(t.writes()).toEqual([]);
  });

  it('S25: a 403 on the write is shown and not retried; the next change still goes', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    await edit(await t.row('entry-1'), { [NAME]: 'Also mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({ action: 'forbid', methods: ['PUT'] });

    const { outcomes } = await t.send(review);

    expect(outcomes.map(o => o.status)).toEqual(['failed', 'failed']);
    expect(outcomes[0].message).toBe(
      'Clockify answered 403: Simulated refusal.',
    );
    expect((await t.row('entry-1')).get(t.schema.sync.outbox)).toBe('');
    expect(await t.plan()).toHaveLength(2);
  });

  it('S26: a 429 waits for retry-after, then continues', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    const { review } = await t.sync();
    // One 429 on the first request after the fresh read: the PUT.
    const request = t.proxy.fixture.request;
    let reads = 0;

    t.proxy.fixture.request = async (
      method: string,
      url: URL,
      body: unknown,
    ) => {
      const response = await request(method, url, body);
      if (
        method === 'GET' &&
        url.pathname === ENTRY_PATH('entry-2') &&
        ++reads === 1
      )
        t.proxy.fixture.control({
          action: 'fail',
          status: 429,
          count: 1,
          retryAfter: 2,
        });

      return response;
    };

    const { outcomes } = await t.send(review);

    expect(t.sleeps).toEqual([2000]);
    expect(outcomes[0].status).toBe('sent');
  });

  it('stops with a clear message when the proxy’s catalog has no write overlay', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), { [NAME]: 'Mine' });
    await edit(await t.row('entry-1'), { [NAME]: 'Also mine' });
    const { review } = await t.sync();
    t.proxy.fixture.control({ action: 'catalog', readOnly: true });

    const { outcomes } = await t.send(review);

    expect(outcomes.map(o => o.status)).toEqual(['failed', 'not-sent']);
    expect(outcomes[0].message).toMatch(/does not allow writing to Clockify/);
  });
});

describe('what may be sent', () => {
  it('resolves a link to a project row without a Clockify id by its name, and refuses an unknown or archived one', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), {
      [SHARED.project]: await t.namedRow(PROJECT_2.name),
    });
    await edit(await t.row('entry-1'), {
      [SHARED.project]: await t.namedRow(ARCHIVED_PROJECT.name),
    });

    const { review } = await t.sync();

    expect(review.find(c => c.entryId === 'entry-2')!.desired).toMatchObject({
      projectId: PROJECT_2.id,
      project: PROJECT_2.name,
    });
    expect(review.find(c => c.entryId === 'entry-1')!.blockers).toEqual([
      'No active project is named “Old project”.',
    ]);
  });

  it('refuses no project where the workspace requires one', async () => {
    const t = await setup({ forceProjects: true });
    await (await t.row('entry-2')).remove(SHARED.project).save();

    const { review } = await t.sync();

    expect(review[0].blockers).toEqual([
      'This workspace requires a project on every entry.',
    ]);
  });
});

describe('deleting an entry ("did not work" for all of it)', () => {
  it('deletes after review, confirms with a read, and removes the row', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), {
      [t.schema.sync.deleteRequested]: true,
    });
    const { review } = await t.sync();
    expect(review).toMatchObject([{ kind: 'delete', entryId: 'entry-2' }]);

    const { outcomes, log } = await t.send(review);

    expect(outcomes[0].status).toBe('sent');
    expect(t.writes()).toEqual([
      { method: 'DELETE', path: ENTRY_PATH('entry-2'), body: null },
    ]);
    expect(t.entry('entry-2')).toBeUndefined();
    await expect(t.row('entry-2')).rejects.toThrow('no row');
    expect(log.mirror.records['timeEntry/entry-2'].deletedAt).toBeTruthy();
  });

  it('keeps the entry when Clockify changed it since, and drops the request', async () => {
    const t = await setup();
    await edit(await t.row('entry-2'), {
      [t.schema.sync.deleteRequested]: true,
    });
    const { review } = await t.sync();
    t.proxy.fixture.control({
      action: 'update',
      id: 'entry-2',
      patch: { description: 'Still happening' },
    });

    const { outcomes } = await t.send(review);

    expect(outcomes[0].status).toBe('conflict');
    expect(t.writes()).toEqual([]);
    const row = await t.row('entry-2');
    expect(row.get(t.schema.sync.deleteRequested)).toBe(false);
    expect(row.get(NAME)).toBe('Still happening');
  });
});
