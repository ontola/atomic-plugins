// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { buildGraph, masteredSet, nextSteps, pathTo } from '../core/index.js';
import {
  adopt,
  appKit,
  atomic,
  LESSON,
  linkLesson,
  loadStarter,
  masteryStore,
  MASTERY,
  P,
  readLessons,
  skillSource,
  SKILL,
} from './adapter.js';
import {
  APP,
  APP_CLASS,
  ENTRYPOINT,
  foreignTable,
  fakeStore,
  OWN_TABLE,
  PLUGIN_SOURCE,
  RENDERS,
  SCRIPT_CLASS,
} from './fakeStore.js';
import { MINI_APPS } from './miniapps.js';
import { starter } from './starter.js';

describe('adopt', () => {
  it("turns the app's own table into a skill table, lists the class in renders, and makes its two tables once", async () => {
    const store = fakeStore();
    const first = await adopt(store, await store.getData());
    expect(first).toMatchObject({
      skills: OWN_TABLE,
      ownSkills: true,
      usable: true,
    });
    expect(store.resources.get(OWN_TABLE)![atomic.classtype]).toBe(SKILL);
    expect(store.resources.get(APP)![RENDERS]).toEqual([SKILL]);
    expect(store.resources.get(first.lessons)![atomic.classtype]).toBe(LESSON);
    expect(store.resources.get(first.mastery)![atomic.classtype]).toBe(MASTERY);

    const again = await adopt(store, await store.getData());
    expect(again).toEqual(first);
    expect(store.resources.get(APP)![RENDERS]).toEqual([SKILL]);
  });

  it('shows a skill table it did not make, and leaves it alone', async () => {
    const store = fakeStore();
    const foreign = foreignTable(store, SKILL);
    const tables = await adopt(store, { table: foreign, rowClass: SKILL });
    expect(tables).toMatchObject({
      skills: foreign,
      ownSkills: false,
      usable: true,
    });
    expect(store.resources.get(foreign)![atomic.classtype]).toBe(SKILL);
  });

  it('is not usable on a table of another class', async () => {
    const store = fakeStore();
    const foreign = foreignTable(store, 'fake:other');
    expect(
      (await adopt(store, { table: foreign, rowClass: 'fake:other' })).usable,
    ).toBe(false);
  });

  it('makes its own skill table when it has no table at all', async () => {
    const store = fakeStore({ data: null });
    const tables = await adopt(store, undefined);
    expect(tables.ownSkills).toBe(true);
    expect(store.resources.get(tables.skills)![atomic.classtype]).toBe(SKILL);
  });
});

describe('the starter tree', () => {
  it('asks for "Allow editing" on a table it did not make, and writes nothing when refused', async () => {
    const store = fakeStore();
    store.grant.answer = 'denied';
    const foreign = foreignTable(store, SKILL);
    const tables = await adopt(store, { table: foreign, rowClass: SKILL });
    expect(await loadStarter(store, tables, starter)).toEqual({
      status: 'denied',
    });
    expect(store.grant.asked).toBe(1);
    expect(store.rowsOf(foreign)).toHaveLength(0);
  });

  it('creates every skill with its requires as subjects, and the lessons in its own table', async () => {
    const store = fakeStore();
    const foreign = foreignTable(store, SKILL);
    const tables = await adopt(store, { table: foreign, rowClass: SKILL });
    const result = await loadStarter(store, tables, starter);
    expect(result).toEqual({
      status: 'loaded',
      skills: starter.skills.length,
      lessons: starter.lessons.length,
      apps: 0,
    });
    expect(store.grant.asked).toBe(1);

    const graph = buildGraph(await skillSource(store, foreign).readSkills());
    expect(graph.order).toHaveLength(starter.skills.length);
    expect(graph.ignored).toEqual([]);
    expect(graph.missing).toEqual([]);

    const byName = new Map([...graph.nodes.values()].map(n => [n.name, n.id]));
    const newton = graph.nodes.get(
      byName.get('Krachten en de wetten van Newton')!,
    )!;
    expect(newton.requires).toContain(byName.get('Vectoren'));
    expect(newton.description).toMatch(/Newton/);

    const lessons = await readLessons(store, tables.lessons);
    expect(lessons).toHaveLength(starter.lessons.length);
    expect(
      lessons.every(
        l => l.teaches.length === 1 && graph.resolve(l.teaches[0]!),
      ),
    ).toBe(true);
    expect(lessons.every(l => l.content === undefined)).toBe(true);
  });

  it('is safe to press twice, and needs no grant on the own table', async () => {
    const store = fakeStore();
    const tables = await adopt(store, await store.getData());
    await loadStarter(store, tables, starter);
    expect(await loadStarter(store, tables, starter)).toEqual({
      status: 'loaded',
      skills: 0,
      lessons: 0,
      apps: 0,
    });
    expect(store.grant.asked).toBe(0);
    expect(store.rowsOf(tables.skills, SKILL)).toHaveLength(
      starter.skills.length,
    );
  });
});

describe('mini apps in the drive', () => {
  const fresh = async () => {
    const store = fakeStore();
    const tables = await adopt(store, await store.getData());

    return { store, tables };
  };

  const appsOf = (store: ReturnType<typeof fakeStore>) =>
    store.rowsOf(APP, APP_CLASS);
  const lessonNamed = async (
    store: ReturnType<typeof fakeStore>,
    tables: { lessons: string },
    name: string,
  ) => (await readLessons(store, tables.lessons)).find(l => l.name === name)!;

  it('finds the drive App and plugin-script classes from its own App', async () => {
    const { store } = await fresh();
    expect(await appKit(store)).toEqual({
      appClass: APP_CLASS,
      scriptClass: SCRIPT_CLASS,
      entrypoint: ENTRYPOINT,
      source: PLUGIN_SOURCE,
    });
  });

  it('creates each mini app as an App with its source in a plugin-script, and links the lessons', async () => {
    const { store, tables } = await fresh();
    const result = await loadStarter(store, tables, starter, MINI_APPS);
    expect(result).toMatchObject({ status: 'loaded', apps: 3 });

    const apps = appsOf(store);
    expect(apps.map(a => a[atomic.name]).sort()).toEqual([
      'Lenzen',
      'Magneten',
      'Trillingen',
    ]);

    for (const mini of Object.values(MINI_APPS)) {
      const app = [...store.resources].find(
        ([, p]) =>
          p[atomic.name] === mini.name &&
          (p[atomic.isA] as string[]).includes(APP_CLASS),
      )!;
      // Under the learning app, so a drive App opened from the sidebar finds it.
      expect(app[1][atomic.parent]).toBe(APP);
      const script = store.resources.get(app[1][ENTRYPOINT] as string)!;
      expect(script[atomic.parent]).toBe(app[0]);
      expect(script[atomic.isA]).toEqual([SCRIPT_CLASS]);
      expect(script[PLUGIN_SOURCE]).toBe(mini.source);
    }

    const lens = await lessonNamed(store, tables, 'Lenzen (interactief)');
    const apps_ = Object.fromEntries(apps.map(a => [a[atomic.name], a]));
    expect(lens.content).toBe(
      [...store.resources].find(([, p]) => p === apps_['Lenzen'])![0],
    );
    expect(
      (await lessonNamed(store, tables, 'Magneten (interactief)')).content,
    ).toBeDefined();
    expect(
      (await lessonNamed(store, tables, 'Trillingen (interactief)')).content,
    ).toBeDefined();
    // Only the lessons that name an app are linked.
    expect(
      (await readLessons(store, tables.lessons)).filter(l => l.content),
    ).toHaveLength(3);
  });

  it('reuses the apps when pressed twice, refreshes a changed source and keeps a teacher link', async () => {
    const { store, tables } = await fresh();
    await loadStarter(store, tables, starter, MINI_APPS);
    const lens = await lessonNamed(store, tables, 'Lenzen (interactief)');
    const magnet = await lessonNamed(store, tables, 'Magneten (interactief)');
    await linkLesson(store, magnet.subject, 'https://example.org/own');
    await linkLesson(store, lens.subject, 'https://example.org/own');
    store.resources.get(lens.subject)![P.content] = undefined;

    const newer = {
      ...MINI_APPS,
      lens: { ...MINI_APPS['lens']!, source: 'export function view() {}' },
    };
    await loadStarter(store, tables, starter, newer);

    expect(appsOf(store)).toHaveLength(3);
    const relinked = await lessonNamed(store, tables, 'Lenzen (interactief)');
    expect(relinked.content).toMatch(/^fake:/);
    expect(
      (await lessonNamed(store, tables, 'Magneten (interactief)')).content,
    ).toBe('https://example.org/own');
    const sources = [...store.resources.values()]
      .map(p => p[PLUGIN_SOURCE])
      .filter(Boolean);
    expect(sources).toContain('export function view() {}');
    expect(sources).not.toContain(MINI_APPS['lens']!.source);
  });

  it('makes no apps, and still loads the tree, in an app that is not a plain drive App', async () => {
    const { store, tables } = await fresh();
    store.resources.get(APP)![ENTRYPOINT] = undefined;
    const result = await loadStarter(store, tables, starter, MINI_APPS);
    expect(result).toMatchObject({ status: 'loaded', apps: 0 });
    expect(appsOf(store)).toHaveLength(0);
    expect(
      (await readLessons(store, tables.lessons)).filter(l => l.content),
    ).toHaveLength(0);
  });
});

describe('mastery', () => {
  it('writes one private row per skill and reads it back through the core', async () => {
    const store = fakeStore();
    const tables = await adopt(store, await store.getData());
    await loadStarter(store, tables, starter);
    const graph = buildGraph(
      await skillSource(store, tables.skills).readSkills(),
    );
    const id = (name: string) =>
      [...graph.nodes.values()].find(n => n.name === name)!.id;

    const mastery = masteryStore(store, tables.mastery);
    expect((await mastery.readMastery()).size).toBe(0);
    await mastery.set(id('Rekenen met getallen'), 1);
    await mastery.set(id('Rekenen met getallen'), 0);
    await mastery.set(id('Rekenen met getallen'), 1);
    const rows = store.rowsOf(tables.mastery, MASTERY);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ [P.masteryLevel]: 1, [P.source]: 'self' });
    expect(typeof rows[0]![P.updatedAt]).toBe('number');

    const done = masteredSet(
      graph,
      await masteryStore(store, tables.mastery).readMastery(),
    );
    expect([...done]).toEqual([id('Rekenen met getallen')]);
    expect(nextSteps(graph, done)).toEqual(
      expect.arrayContaining([id('Breuken'), id('Meetkunde')]),
    );
    expect(pathTo(graph, done, id('Procenten en verhoudingen'))).toEqual([
      id('Breuken'),
      id('Procenten en verhoudingen'),
    ]);
  });
});
