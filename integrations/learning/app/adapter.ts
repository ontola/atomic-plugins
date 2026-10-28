// @wc-ignore-file
/**
 * The Atomic adapter: maps rows of the shared `skill-v1`, `lesson-v1` and
 * `mastery-v1` classes (ontology v2) to and from the core's interfaces
 * (`../core/`), through the frame `store`. Everything is read and written by
 * the published property subjects; nothing is guessed from shortnames.
 *
 * - Skills are read from the table this app is a view of, and are written
 *   there only for the starter tree, after the host's "Allow editing".
 * - Lessons and mastery live in two tables the app owns under itself, so
 *   writing them needs no grant. They inherit the App's rights: install the
 *   app in the learner's own drive and the mastery stays theirs.
 */
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes, properties } from '../../../ontology-kit/terms-v2.mjs';
import { buildGraph } from '../core/index.js';
import type {
  Mastery,
  SkillNode,
  SkillSource,
  MasterySource,
} from '../core/index.js';
import type { StarterTree } from './starter.js';
import {
  GET_MANY_MAX,
  type DataRef,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

export const SKILL = classes['skill-v1'].subject;
export const LESSON = classes['lesson-v1'].subject;
export const MASTERY = classes['mastery-v1'].subject;

export const skillResolver = createResolver({ classes: [classes['skill-v1']] });

export const atomic = {
  parent: 'https://atomicdata.dev/properties/parent',
  isA: 'https://atomicdata.dev/properties/isA',
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  shortname: 'https://atomicdata.dev/properties/shortname',
  classtype: 'https://atomicdata.dev/properties/classtype',
  requires: 'https://atomicdata.dev/properties/requires',
  recommends: 'https://atomicdata.dev/properties/recommends',
  tableClass: 'https://atomicdata.dev/classes/Table',
} as const;

const term = (name: keyof typeof properties) => properties[name].subject;

export const P = {
  requires: term('skill-requires'),
  recommends: term('skill-recommends'),
  equivalentTo: term('skill-equivalent-to'),
  threshold: term('skill-mastery-threshold'),
  level: term('skill-level'),
  teaches: term('lesson-teaches'),
  content: term('lesson-content'),
  format: term('lesson-format'),
  minutes: term('lesson-minutes'),
  language: term('lesson-language'),
  skill: term('mastery-skill'),
  masteryLevel: term('mastery-level'),
  source: term('mastery-source'),
  updatedAt: term('mastery-updated-at'),
} as const;

export const list = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];
const text = (value: JSONValue) =>
  typeof value === 'string' ? value : undefined;
const num = (value: JSONValue) =>
  typeof value === 'number' ? value : undefined;

export interface Lesson {
  subject: string;
  name: string;
  teaches: string[];
  content?: string;
  format?: string;
  minutes?: number;
  language?: string;
}

/** Every row whose parent is `table`, read in batches. */
async function rowsOf(
  store: PluginStore,
  table: string,
): Promise<PluginResource[]> {
  const subjects = await store.query({ property: atomic.parent, value: table });
  const rows: PluginResource[] = [];

  for (let at = 0; at < subjects.length; at += GET_MANY_MAX) {
    const batch = subjects.slice(at, at + GET_MANY_MAX);
    const got = store.getMany
      ? await store.getMany(batch)
      : await Promise.all(
          batch.map((s) =>
            store
              .getResource(s)
              .catch(() => ({ subject: s, error: 'unreadable' })),
          ),
        );
    for (const row of got) if (!('error' in row)) rows.push(row);
  }

  return rows;
}

export function toSkill(row: PluginResource): SkillNode {
  const description = text(row.get(atomic.description));
  const threshold = num(row.get(P.threshold));
  const level = num(row.get(P.level));

  return {
    id: row.subject,
    name: text(row.get(atomic.name)) ?? row.subject,
    ...(description ? { description } : {}),
    requires: list(row.get(P.requires)),
    recommends: list(row.get(P.recommends)),
    equivalentTo: list(row.get(P.equivalentTo)),
    ...(threshold === undefined ? {} : { threshold }),
    ...(level === undefined ? {} : { level }),
  };
}

/** The tree in a table of `skill-v1` rows, as the core's `SkillSource`. */
export const skillSource = (
  store: PluginStore,
  table: string,
): SkillSource => ({
  readSkills: async () => (await rowsOf(store, table)).map(toSkill),
});

export async function readLessons(
  store: PluginStore,
  table: string,
): Promise<Lesson[]> {
  return (await rowsOf(store, table)).map((row) => ({
    subject: row.subject,
    name: text(row.get(atomic.name)) ?? row.subject,
    teaches: list(row.get(P.teaches)),
    ...(text(row.get(P.content)) ? { content: text(row.get(P.content)) } : {}),
    ...(text(row.get(P.format)) ? { format: text(row.get(P.format)) } : {}),
    ...(num(row.get(P.minutes)) === undefined
      ? {}
      : { minutes: num(row.get(P.minutes)) }),
    ...(text(row.get(P.language))
      ? { language: text(row.get(P.language)) }
      : {}),
  }));
}

/** Points a lesson at a resource or URL, as `lesson-content`. */
export async function linkLesson(
  store: PluginStore,
  lesson: string,
  target: string,
): Promise<void> {
  const row = await store.getResource(lesson);
  row.set(P.content, target);
  await row.save();
}

/** The learner's mastery rows, as the core's `MasterySource`, and the write side. */
export function masteryStore(
  store: PluginStore,
  table: string,
): MasterySource & {
  set(skill: string, level: number): Promise<void>;
} {
  let rows = new Map<string, PluginResource>();

  const read = async () => {
    rows = new Map();

    for (const row of await rowsOf(store, table)) {
      const skill = text(row.get(P.skill));
      if (skill) rows.set(skill, row);
    }
  };

  return {
    async readMastery(): Promise<Mastery> {
      await read();

      return new Map(
        [...rows].map(([skill, row]) => [
          skill,
          num(row.get(P.masteryLevel)) ?? 0,
        ]),
      );
    },
    /** One row per skill: updated in place, created the first time. */
    async set(skill, level) {
      const values = {
        [P.masteryLevel]: level,
        [P.source]: 'self',
        [P.updatedAt]: Date.now(),
      };
      const row = rows.get(skill);

      if (row) {
        for (const [property, value] of Object.entries(values))
          row.set(property, value);
        await row.save();
      } else {
        rows.set(
          skill,
          await store.newResource({
            parent: table,
            isA: [MASTERY],
            propVals: { [P.skill]: skill, ...values },
          }),
        );
      }
    },
  };
}

/** The App's own table of `klass`: found by `classtype`, made once if missing. */
export async function ownTable(
  store: PluginStore,
  app: string,
  klass: string,
  name: string,
): Promise<string> {
  for (const subject of await store.query({
    property: atomic.classtype,
    value: klass,
  })) {
    const table = await store.getResource(subject).catch(() => undefined);
    if (table?.get(atomic.parent) === app) return subject;
  }

  return (
    await store.newResource({
      parent: app,
      isA: [atomic.tableClass],
      propVals: { [atomic.name]: name, [atomic.classtype]: klass },
    })
  ).subject;
}

export interface Tables {
  /** The table of skills shown: the one this app is a view of, or its own. */
  skills: string;
  /** True when the skills table is the App's own (rows need no grant). */
  ownSkills: boolean;
  lessons: string;
  mastery: string;
  /** False when the table is not a `skill-v1` table: nothing to show. */
  usable: boolean;
}

/**
 * Every open. A catalog install gives the app one empty table of a class of
 * its own; that table becomes a `skill-v1` table, and the App's `renders`
 * lists `skill-v1` so "+ Add view" offers this app on any skill table (the
 * same two steps the Money app takes, `integrations/money/app/adopt.ts`).
 * The lesson and mastery tables are made on first open.
 */
export async function adopt(
  store: PluginStore,
  data: DataRef | undefined,
): Promise<Tables> {
  const app = await store.getApp();
  let skills = data?.table;
  let ownSkills = false;
  let rowClass = data?.rowClass;

  if (skills) {
    const table = await store.getResource(skills);
    ownSkills = table.get(atomic.parent) === app;

    if (ownSkills && rowClass !== SKILL) {
      await table.set(atomic.classtype, SKILL).save();
      rowClass = SKILL;
    }
  } else {
    skills = await ownTable(store, app, SKILL, 'Skills');
    ownSkills = true;
    rowClass = SKILL;
  }

  const appResource = await store.getResource(app);
  const renders = await appRendersProperty(store, appResource);

  if (renders && !list(appResource.get(renders)).includes(SKILL))
    await appResource
      .set(renders, [...list(appResource.get(renders)), SKILL])
      .save();

  return {
    skills,
    ownSkills,
    lessons: await ownTable(store, app, LESSON, 'Lessons'),
    mastery: await ownTable(store, app, MASTERY, 'Mastery'),
    usable: rowClass !== undefined && skillResolver.accepts(rowClass),
  };
}

/** The drive's own `renders` property, found by shortname on the App class. */
async function appRendersProperty(
  store: PluginStore,
  app: PluginResource,
): Promise<string | undefined> {
  for (const klass of list(app.get(atomic.isA))) {
    const resource = await store.getResource(klass).catch(() => undefined);
    const properties_ = [
      ...list(resource?.get(atomic.recommends)),
      ...list(resource?.get(atomic.requires)),
    ];

    for (const property of properties_) {
      const shortname = await store.getResource(property).then(
        (p) => p.get(atomic.shortname),
        () => undefined,
      );
      if (shortname === 'renders') return property;
    }
  }

  return undefined;
}

export type StarterResult =
  | { status: 'loaded'; skills: number; lessons: number }
  | { status: 'denied' };

/**
 * Creates the starter tree's skills (parents before children, so every
 * `requires` is a subject) and lessons. Safe to press twice: a skill whose
 * name is already in the table, and a lesson already teaching it, are reused.
 * On a table the app did not make, the host's "Allow editing" comes first.
 */
export async function loadStarter(
  store: PluginStore,
  tables: Tables,
  tree: StarterTree,
): Promise<StarterResult> {
  if (!tables.ownSkills) {
    const access = await store.rowAccess?.();

    if (access?.status !== 'granted') {
      const asked = await store.requestRowAccess?.();
      if (asked?.status !== 'granted') return { status: 'denied' };
    }
  }

  const existing = new Map(
    (await rowsOf(store, tables.skills)).map((r) => [
      text(r.get(atomic.name)),
      r.subject,
    ]),
  );
  const subjectOf = new Map<string, string>();
  const byKey = new Map(tree.skills.map((s) => [s.key, s]));
  const order = buildGraph(
    tree.skills.map((s) => ({
      id: s.key,
      name: s.name,
      requires: s.requires,
      recommends: s.recommends,
      equivalentTo: [],
    })),
  ).order;
  let created = 0;

  for (const key of order) {
    const s = byKey.get(key)!;
    const known = existing.get(s.name);

    if (known) {
      subjectOf.set(key, known);
      continue;
    }

    const link = (keys: string[]) =>
      keys.map((k) => subjectOf.get(k)).filter((x): x is string => !!x);
    const row = await store.newResource({
      parent: tables.skills,
      isA: [SKILL],
      propVals: {
        [atomic.name]: s.name,
        [atomic.description]: s.description,
        ...(s.requires.length ? { [P.requires]: link(s.requires) } : {}),
        ...(s.recommends.length ? { [P.recommends]: link(s.recommends) } : {}),
      },
    });
    subjectOf.set(key, row.subject);
    created += 1;
  }

  const have = new Set(
    (await readLessons(store, tables.lessons)).map(
      (l) => `${l.teaches.join()}|${l.name}`,
    ),
  );
  let lessons = 0;

  for (const l of tree.lessons) {
    const skill = subjectOf.get(l.skill)!;
    if (have.has(`${skill}|${l.name}`)) continue;
    await store.newResource({
      parent: tables.lessons,
      isA: [LESSON],
      propVals: {
        [atomic.name]: l.name,
        [P.teaches]: [skill],
        [P.format]: l.format,
        [P.minutes]: l.minutes,
        [P.language]: l.language,
        ...(l.content ? { [P.content]: l.content } : {}),
      },
    });
    lessons += 1;
  }

  return { status: 'loaded', skills: created, lessons };
}
