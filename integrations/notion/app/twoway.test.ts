// @wc-ignore-file
/**
 * Two-way edits (#8, #177 Q4–Q7): compare on open, review, send. Runs the
 * controller over the fake store and the mock proxy's notion fixture, which
 * accepts `PATCH /v1/pages/{id}` as Notion documents it.
 */
import { describe, expect, it } from 'vitest';
import { notionFieldShortname } from '../devonian/notion/index.js';
import { pages } from '../fixtures/notion/scenario.mjs';
import {
  BASELINE_SHORTNAME,
  localChanges,
  normalize,
  parseBaseline,
  problemWith,
  reconcile,
} from './changes.js';
import { createController, type ViewState } from './controller.js';
import { fakeStore, fixtureProxy, PARENT, TABLE } from './fakeStore.js';
import { OPTION_ID_SHORTNAME } from './options.js';
import { loadSchema } from './record.js';
import type { HostProxy, JSONValue } from './store.js';
import { atomic } from './sync.js';

const T0 = Date.parse('2026-09-24T12:00:00.000Z');
const POINTS = notionFieldShortname('n%3D1');
const DONE = notionFieldShortname('BJXS');
const STATUS = notionFieldShortname('%3AUPp');
const NOTES = notionFieldShortname('Nt0s');
const TITLE = notionFieldShortname('title');
const SHIPPED = 'b1f5a3c2-0001-4000-8000-000000000003';
const [LAUNCH, CHANGELOG, RETRO] = pages.map(p => p.id);

async function synced(overrides: Partial<HostProxy> = {}) {
  const proxy = { ...fixtureProxy(), ...overrides };
  const store = fakeStore({ proxy });
  const controller = createController(
    store,
    () => {},
    () => T0,
  );
  await controller.load();
  await controller.sync();
  const schema = (await loadSchema(store))!;
  const column = (shortname: string) => schema.columns.get(shortname)!.subject;
  const rowOf = (pageId: string) =>
    [...store.resources].find(
      ([, p]) => p[PARENT] === TABLE && p[column('notion-page-id')] === pageId,
    )!;

  /** An edit made in the host (its table, another view): straight to the store. */
  const edit = (pageId: string, shortname: string, value: JSONValue) => {
    const [, props] = rowOf(pageId);
    const property = shortname === 'name' ? atomic.name : column(shortname);
    if (value === undefined) delete props[property];
    else props[property] = value;
  };

  const value = (pageId: string, shortname: string) =>
    rowOf(pageId)[1][column(shortname)];
  /** The Tag subject of a Notion option. */
  const tagOf = (optionId: string) =>
    [...store.resources].find(
      ([, p]) => p[column(OPTION_ID_SHORTNAME)] === optionId,
    )![0];
  const notion = (pageId: string) =>
    proxy.api.request(
      'GET',
      new URL(`http://mock/proxy/notion/v1/pages/${pageId}`),
      undefined,
    ).body as { properties: Record<string, Record<string, unknown>> };
  const patches = () => proxy.calls.filter(c => c.method === 'PATCH');

  return {
    proxy,
    store,
    controller,
    column,
    rowOf,
    edit,
    value,
    tagOf,
    notion,
    patches,
  };
}

const changesOf = (state: ViewState) =>
  'changes' in state ? (state.changes ?? []) : [];

describe('reconcile (three-way, per field)', () => {
  it.each([
    [3, 3, 3, 'same'],
    [3, 4, 3, 'notion'],
    [5, 3, 3, 'local'],
    [5, 5, 3, 'agree'],
    [5, 4, 3, 'conflict'],
  ] as const)('local %s, Notion %s, baseline %s: %s', (l, r, b, out) => {
    expect(reconcile('number', l, r, b)).toBe(out);
  });

  it('folds the empties of each type together', () => {
    expect(reconcile('rich_text', undefined, '', '')).toBe('same');
    expect(reconcile('checkbox', undefined, false, false)).toBe('same');
    expect(reconcile('url', '', undefined, undefined)).toBe('same');
    expect(reconcile('multi_select', ['b', 'a'], ['a', 'b'], [])).toBe('agree');
    expect(normalize('multi_select', null)).toEqual([]);
  });

  it('names values Notion would refuse', () => {
    const field = {
      id: 'x',
      shortname: 'x',
      name: 'Status',
      type: 'status' as const,
      options: ['a'],
    };
    expect(problemWith(field, 'a')).toBeUndefined();
    expect(problemWith(field, undefined)).toBeUndefined();
    expect(problemWith(field, 'b')).toMatch(/does not have/);
    expect(
      problemWith({ ...field, type: 'number', options: undefined }, 'x'),
    ).toMatch(/not a number/);
  });
});

describe('compare on open', () => {
  it('keeps a baseline on every synced row, outside the columns, and lists nothing', async () => {
    const { controller, rowOf, column } = await synced();
    const baseline = parseBaseline(
      rowOf(LAUNCH)[1][column(BASELINE_SHORTNAME)],
    );
    expect(baseline).toMatchObject({
      version: 1,
      fields: { [POINTS]: 3, [DONE]: false, [TITLE]: 'Launch plan' },
    });
    // Formatted text was never read, so it has no baseline value.
    expect(
      parseBaseline(rowOf(RETRO)[1][column(BASELINE_SHORTNAME)])!.fields,
    ).not.toHaveProperty(NOTES);
    expect(changesOf(controller.state())).toEqual([]);
  });

  it('lists an edit made in the host as soon as the rows are read, with no request', async () => {
    const { controller, edit, proxy } = await synced();
    const calls = proxy.calls.length;
    edit(LAUNCH, POINTS, 5);
    const state = await controller.refreshRows();
    expect(changesOf(state)).toMatchObject([
      {
        pageId: LAUNCH,
        name: 'Launch plan',
        dataSourceTitle: 'Roadmap',
        fields: [{ name: 'Points', before: 3, after: 5 }],
      },
    ]);
    expect(proxy.calls.length).toBe(calls);
  });

  it('a sync takes Notion’s edits and keeps the row’s own, field by field', async () => {
    const { controller, edit, value, proxy } = await synced();
    edit(LAUNCH, POINTS, 5);
    proxy.api.editPage(LAUNCH, { Done: { checkbox: true } });
    const state = await controller.sync();
    expect(value(LAUNCH, DONE)).toBe(true);
    expect(value(LAUNCH, POINTS)).toBe(5);
    expect(changesOf(state)).toMatchObject([
      { fields: [{ name: 'Points', before: 3, after: 5 }] },
    ]);
    expect(proxy.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('a field changed on both sides is a conflict: neither side is overwritten', async () => {
    const { controller, edit, value, proxy, patches } = await synced();
    edit(LAUNCH, POINTS, 5);
    proxy.api.editPage(LAUNCH, { Points: { number: 7 } });
    const state = await controller.sync();
    expect(value(LAUNCH, POINTS)).toBe(5);
    expect(changesOf(state)).toMatchObject([
      { fields: [{ before: 3, after: 5, notion: 7, conflict: true }] },
    ]);
    // Send skips a row with an open conflict.
    await controller.send();
    expect(patches()).toEqual([]);
  });

  it('a row imported before 0.2.0 (no baseline) takes Notion’s values once', async () => {
    const { controller, edit, value, rowOf, column } = await synced();
    delete rowOf(LAUNCH)[1][column(BASELINE_SHORTNAME)];
    edit(LAUNCH, POINTS, 5);
    expect(changesOf(await controller.refreshRows())).toEqual([]);
    await controller.sync();
    expect(value(LAUNCH, POINTS)).toBe(3);
    expect(rowOf(LAUNCH)[1][column(BASELINE_SHORTNAME)]).toBeTruthy();
  });

  it('a renamed row is a title edit', async () => {
    const { controller, edit } = await synced();
    edit(CHANGELOG, 'name', 'Write the changelog');
    expect(changesOf(await controller.refreshRows())).toMatchObject([
      {
        fields: [
          {
            name: 'Name',
            before: 'Write changelog',
            after: 'Write the changelog',
          },
        ],
      },
    ]);
  });
});

describe('review and send', () => {
  it('sends only the changed properties, by property id, and advances the baseline', async () => {
    const { controller, edit, notion, patches, value, rowOf, column, tagOf } =
      await synced();
    edit(LAUNCH, POINTS, 5);
    edit(LAUNCH, STATUS, SHIPPED);
    await controller.refreshRows();
    const state = await controller.send();
    expect(patches()).toHaveLength(1);
    expect(patches()[0]!.path).toBe(`/v1/pages/${LAUNCH}`);
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      properties: {
        '%3AUPp': { status: { id: SHIPPED } },
        'n%3D1': { number: 5 },
      },
    });
    expect('outcomes' in state && state.outcomes).toEqual([
      {
        subject: rowOf(LAUNCH)[0],
        name: 'Launch plan',
        status: 'sent',
        fields: 2,
      },
    ]);
    expect(changesOf(state)).toEqual([]);
    expect(notion(LAUNCH).properties.Points!.number).toBe(5);
    // The host cell holds the option's Tag (options.ts); the raw option id
    // the edit wrote was read as that option and sent by id.
    expect(value(LAUNCH, STATUS)).toEqual([tagOf(SHIPPED)]);
    expect(
      parseBaseline(rowOf(LAUNCH)[1][column(BASELINE_SHORTNAME)])!.fields[
        POINTS
      ],
    ).toBe(5);
    // The next sync agrees: nothing to send, nothing rewritten.
    expect(changesOf(await controller.sync())).toEqual([]);
    expect(patches()).toHaveLength(1);
  });

  it('sends a renamed row as the Notion title', async () => {
    const { controller, edit, notion, patches, value } = await synced();
    edit(CHANGELOG, 'name', 'Write the changelog');
    await controller.refreshRows();
    await controller.send();
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      properties: {
        title: {
          title: [{ type: 'text', text: { content: 'Write the changelog' } }],
        },
      },
    });
    expect(notion(CHANGELOG).properties.Name!.title).toMatchObject([
      { plain_text: 'Write the changelog' },
    ]);
    expect(value(CHANGELOG, TITLE)).toBe('Write the changelog');
  });

  it('does not send over an edit made in Notion since the review: it becomes a conflict', async () => {
    const { controller, edit, proxy, patches, rowOf } = await synced();
    edit(LAUNCH, POINTS, 5);
    await controller.refreshRows();
    proxy.api.editPage(LAUNCH, { Points: { number: 8 } });
    const state = await controller.send();
    expect(patches()).toEqual([]);
    expect('outcomes' in state && state.outcomes).toMatchObject([
      { subject: rowOf(LAUNCH)[0], status: 'changed', notion: { [POINTS]: 8 } },
    ]);
    expect(changesOf(state)).toMatchObject([
      { fields: [{ after: 5, notion: 8, conflict: true }] },
    ]);
  });

  it('resolves a conflict either way', async () => {
    const { controller, edit, proxy, rowOf, value, patches, notion } =
      await synced();
    edit(LAUNCH, POINTS, 5);
    edit(CHANGELOG, POINTS, 1);
    proxy.api.editPage(LAUNCH, { Points: { number: 7 } });
    proxy.api.editPage(CHANGELOG, { Points: { number: 2 } });
    await controller.sync();

    // Use Notion's: the row takes 7, nothing left to send for it.
    await controller.resolve(rowOf(LAUNCH)[0], POINTS, 'notion');
    expect(value(LAUNCH, POINTS)).toBe(7);
    // Keep mine: still a change, now sendable over Notion's 2.
    const state = await controller.resolve(rowOf(CHANGELOG)[0], POINTS, 'mine');
    expect(changesOf(state)).toMatchObject([
      { pageId: CHANGELOG, fields: [{ before: 2, after: 1 }] },
    ]);
    expect(changesOf(state)[0]!.fields[0]).not.toHaveProperty('conflict');
    await controller.send();
    expect(patches()).toHaveLength(1);
    expect(notion(CHANGELOG).properties.Points!.number).toBe(1);
  });

  it('keeps the row of a page archived in Notion, and sends nothing for it', async () => {
    const { controller, edit, proxy, patches, value } = await synced();
    edit(LAUNCH, POINTS, 5);
    await controller.refreshRows();
    proxy.api.archivePage(LAUNCH);
    const state = await controller.send();
    expect(patches()).toEqual([]);
    expect('outcomes' in state && state.outcomes).toMatchObject([
      { status: 'gone' },
    ]);
    expect(value(LAUNCH, POINTS)).toBe(5);
  });

  it('never overwrites formatted text in Notion with plain text', async () => {
    const { controller, edit, patches } = await synced();
    edit(RETRO, NOTES, 'Plain now');
    await controller.refreshRows();
    const state = await controller.send();
    expect(patches()).toEqual([]);
    expect('outcomes' in state && state.outcomes).toMatchObject([
      { status: 'refused', message: expect.stringMatching(/formatting/) },
    ]);
  });

  it('holds back a value Notion would refuse, and sends the other rows', async () => {
    const { controller, edit, patches } = await synced();
    edit(LAUNCH, STATUS, 'not-an-option');
    edit(CHANGELOG, DONE, false);
    const state = await controller.refreshRows();
    expect(changesOf(state)).toMatchObject([
      {
        pageId: LAUNCH,
        fields: [{ problem: expect.stringMatching(/Status/) }],
      },
      { pageId: CHANGELOG },
    ]);
    await controller.send();
    expect(patches().map(p => p.path)).toEqual([`/v1/pages/${CHANGELOG}`]);
  });

  it('stops at a PATCH with no answer: unknown, and the rest is not sent', async () => {
    const base = fixtureProxy();
    const { controller, edit, patches } = await synced({
      request: async request => {
        if (request.method === 'PATCH') {
          await base.request(request);
          throw new Error('connection reset');
        }

        return base.request(request);
      },
    });
    edit(LAUNCH, POINTS, 5);
    edit(CHANGELOG, POINTS, 1);
    await controller.refreshRows();
    const state = await controller.send();
    expect('outcomes' in state && state.outcomes).toMatchObject([
      { status: 'unknown', message: expect.stringMatching(/unknown whether/) },
    ]);
    // The base proxy's own log: one PATCH reached the fixture.
    expect(base.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
    expect(patches()).toEqual([]);
  });

  it('discard puts the row back to the baseline', async () => {
    const { controller, edit, rowOf, value } = await synced();
    edit(LAUNCH, POINTS, 5);
    edit(LAUNCH, 'name', 'Renamed');
    await controller.refreshRows();
    const state = await controller.discard(rowOf(LAUNCH)[0]);
    expect(changesOf(state)).toEqual([]);
    expect(value(LAUNCH, POINTS)).toBe(3);
    expect(rowOf(LAUNCH)[1][atomic.name]).toBe('Launch plan');
  });
});

describe('select cells (options.ts)', () => {
  const DOING = 'b1f5a3c2-0001-4000-8000-000000000002';
  const DOCS = 'c2e6b4d3-0002-4000-8000-000000000001';
  const RELEASE = 'c2e6b4d3-0002-4000-8000-000000000002';
  const TAGS = notionFieldShortname('Tg%5Cq');

  it('an option picked in the host’s select cell is a change by option id, sent by id', async () => {
    const { controller, edit, tagOf, patches, notion, value } = await synced();
    edit(LAUNCH, STATUS, [tagOf(SHIPPED)]);
    edit(LAUNCH, TAGS, [tagOf(DOCS)]);
    const state = await controller.refreshRows();
    expect(changesOf(state)).toMatchObject([
      {
        fields: [
          { name: 'Status', before: DOING, after: SHIPPED },
          { name: 'Tags', before: [DOCS, RELEASE], after: [DOCS] },
        ],
      },
    ]);
    await controller.send();
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      properties: {
        '%3AUPp': { status: { id: SHIPPED } },
        'Tg%5Cq': { multi_select: [{ id: DOCS }] },
      },
    });
    expect(notion(LAUNCH).properties.Status!.status).toMatchObject({
      id: SHIPPED,
    });
    expect(value(LAUNCH, STATUS)).toEqual([tagOf(SHIPPED)]);
    expect(value(LAUNCH, TAGS)).toEqual([tagOf(DOCS)]);
  });

  it('a status cell given two Tags is held back: Notion’s status takes one', async () => {
    const { controller, edit, tagOf, patches } = await synced();
    edit(LAUNCH, STATUS, [tagOf(DOING), tagOf(SHIPPED)]);
    const state = await controller.refreshRows();
    expect(changesOf(state)).toMatchObject([
      {
        fields: [
          {
            name: 'Status',
            after: [DOING, SHIPPED],
            problem: 'holds 2 options; Notion’s Status takes one',
          },
        ],
      },
    ]);
    await controller.send();
    expect(patches()).toEqual([]);
  });

  it('a Tag cleared in the host is sent as Notion’s empty, and the row is kept empty', async () => {
    const { controller, edit, patches, notion, value } = await synced();
    edit(LAUNCH, STATUS, []);
    await controller.refreshRows();
    await controller.send();
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      properties: { '%3AUPp': { status: null } },
    });
    expect(notion(LAUNCH).properties.Status!.status).toBeNull();
    expect(value(LAUNCH, STATUS)).toBeUndefined();
  });

  it('upgrades 0.3.0 columns in place: raw option ids become Tags, and an unsent edit survives', async () => {
    const { store, controller, column, rowOf, edit, tagOf, value, patches } =
      await synced();
    // Put the store in its 0.3.0 shape: string/json columns, raw ids in the
    // cells, no Tags.
    const status = store.resources.get(column(STATUS))!;
    const tags = store.resources.get(column(TAGS))!;
    for (const [property, datatype] of [
      [status, 'https://atomicdata.dev/datatypes/string'],
      [tags, 'https://atomicdata.dev/datatypes/json'],
    ] as const) {
      property[atomic.datatype] = datatype;
      property['https://atomicdata.dev/properties/isA'] = [atomic.propertyClass];
      for (const key of [
        'https://atomicdata.dev/properties/classtype',
        'https://atomicdata.dev/properties/allowsOnly',
        'https://atomicdata.dev/properties/max',
      ])
        delete property[key];
    }
    for (const [subject, props] of [...store.resources])
      if (props[PARENT] === column(STATUS) || props[PARENT] === column(TAGS))
        store.resources.delete(subject);
    const raw: Record<string, [string, string[]]> = {
      [LAUNCH]: [DOING, [DOCS, RELEASE]],
      [CHANGELOG]: [SHIPPED, []],
      [RETRO]: ['b1f5a3c2-0001-4000-8000-000000000001', [DOCS]],
    };
    for (const [pageId, [s, t]] of Object.entries(raw)) {
      rowOf(pageId)[1][column(STATUS)] = s;
      rowOf(pageId)[1][column(TAGS)] = t;
    }
    // An edit made in the table before the upgrade, as 0.3.0 cells held it.
    edit(LAUNCH, STATUS, SHIPPED);
    expect(changesOf(await controller.load())).toMatchObject([
      { fields: [{ name: 'Status', before: DOING, after: SHIPPED }] },
    ]);

    const state = await controller.sync();
    expect(store.resources.get(column(STATUS))).toMatchObject({
      [atomic.datatype]: 'https://atomicdata.dev/datatypes/resourceArray',
      'https://atomicdata.dev/properties/isA': [
        atomic.propertyClass,
        'https://atomicdata.dev/classes/SelectProperty',
      ],
      'https://atomicdata.dev/properties/max': 1,
    });
    expect(
      (
        store.resources.get(column(STATUS))![
          'https://atomicdata.dev/properties/allowsOnly'
        ] as string[]
      ).length,
    ).toBe(3);
    expect(value(CHANGELOG, STATUS)).toEqual([tagOf(SHIPPED)]);
    expect(value(RETRO, TAGS)).toEqual([tagOf(DOCS)]);
    // The local edit is kept, now as a Tag, and still waits for review.
    expect(value(LAUNCH, STATUS)).toEqual([tagOf(SHIPPED)]);
    expect(changesOf(state)).toMatchObject([
      { fields: [{ name: 'Status', before: DOING, after: SHIPPED }] },
    ]);
    await controller.send();
    expect(JSON.parse(patches()[0]!.body!)).toEqual({
      properties: { '%3AUPp': { status: { id: SHIPPED } } },
    });
  });
});

describe('localChanges', () => {
  it('skips rows without a page id or a baseline', () => {
    expect(
      localChanges(
        [
          { subject: 'a', name: 'A', dataSource: 'x', values: { y: 1 } },
          {
            subject: 'b',
            name: 'B',
            pageId: 'p',
            dataSource: 'x',
            values: { y: 1 },
          },
        ],
        undefined,
      ),
    ).toEqual([]);
  });
});
