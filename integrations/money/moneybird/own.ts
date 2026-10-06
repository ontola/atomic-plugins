// @wc-ignore-file
/**
 * What this app keeps in its own subtree, the one place the host lets an app
 * write without a grant, and what it declares about itself. Every open
 * (`adopt`):
 *
 * 1. Its own Properties exist in the App's ontology (`sync.ts`
 *    `ensureProperties`): the import identity and the other row extras, the
 *    administration, the chosen collections and the table binding.
 * 2. Its own tables for the two shared-class collections exist under the
 *    App, found by `classtype` among the App's children and made only when
 *    missing: "Moneybird hours" (`time-entry-v1`), "Moneybird projects"
 *    (`work-project-v1`), "Moneybird people" (`work-person-v1`) and
 *    "Moneybird mutations" (`bank-transaction-v1`). The Contacts table stays
 *    the one the install made, with its drive-local class.
 * 3. The App's `renders` lists `time-entry-v1` and `bank-transaction-v1`, so
 *    the host's "+ Add view" (`appsForClass`, exact subject) offers this app
 *    on any table of those classes, where it can offer "Sync this table to
 *    Moneybird" (`binding.ts`).
 * 4. The App's `row-extras` lists the extras it keeps on shared-class rows
 *    (atomic-server#1849): what an "Allow editing" grant on another table
 *    also lets it write.
 *
 * `renders` and `row-extras` are the drive's own App properties (minted per
 * drive by the host's plugin schema), found by shortname among the App
 * class's `recommends`. Each step is skipped when already done, so a second
 * open writes nothing. Shared classes are read by the host from their
 * published subjects (ontology-kit/README.md), which the gate keeps off
 * production drives while the base is on github.io.
 */
import { TIME_ENTRY, WORK_PERSON, WORK_PROJECT } from './hours.js';
import { BANK_TRANSACTION } from './mutations.js';
import {
  ADMINISTRATION,
  asList,
  CLASSTYPE,
  DESCRIPTION,
  ensureProperties,
  IS_A,
  NAME,
  PARENT,
  RECOMMENDS,
  REQUIRES,
  ROW_EXTRAS,
  SHORTNAME,
  TABLE_CLASS,
  type HourTables,
} from './sync.js';
import type { ContactField } from './contacts.js';
import type { PluginResource, PluginStore } from './store.js';

const A = 'https://atomicdata.dev';

/** The table a binding syncs (`binding.ts`), on a resource under the App. */
export const SYNCED_TABLE: ContactField = {
  key: 'synced_table',
  shortname: 'moneybird-synced-table',
  name: 'Synced table',
  description:
    'The table this binding syncs with Moneybird: one the app is a view of, not its own.',
  datatype: `${A}/datatypes/atomicURL`,
};

/** Which collections to import, comma-separated, on the App or a binding. */
export const COLLECTIONS_TERM: ContactField = {
  key: 'collections',
  shortname: 'moneybird-collections',
  name: 'Moneybird collections',
  description:
    'Which Moneybird collections this app imports, comma-separated: contacts, hours, mutations.',
  datatype: `${A}/datatypes/string`,
};

/** What a binding holds, for the view and for the sync. */
export const BINDING_TERMS: ContactField[] = [
  SYNCED_TABLE,
  ADMINISTRATION,
  COLLECTIONS_TERM,
];

export const TABLE_NAMES = {
  hours: 'Moneybird hours',
  projects: 'Moneybird projects',
  people: 'Moneybird people',
  mutations: 'Moneybird mutations',
} as const;

export interface OwnTables extends HourTables {
  mutations: string;
}

/** A child table of `app` whose `classtype` is `klass`, if any. */
export async function ownTable(
  store: PluginStore,
  app: string,
  klass: string,
): Promise<string | undefined> {
  for (const subject of await store.query({
    property: CLASSTYPE,
    value: klass,
  })) {
    const table = await store.getResource(subject).catch(() => undefined);
    if (table?.get(PARENT) === app) return subject;
  }

  return undefined;
}

/** The app's own shared-class tables, made under the App where missing. */
export async function ensureTables(
  store: PluginStore,
  app: string,
): Promise<OwnTables> {
  const ensure = async (klass: string, name: string, description: string) =>
    (await ownTable(store, app, klass)) ??
    (
      await store.newResource({
        parent: app,
        isA: [TABLE_CLASS],
        propVals: {
          [NAME]: name,
          [CLASSTYPE]: klass,
          [DESCRIPTION]: description,
        },
      })
    ).subject;

  return {
    hours: await ensure(
      TIME_ENTRY,
      TABLE_NAMES.hours,
      'This year’s Moneybird time entries, imported read-only by the Moneybird app; rows link to its Projects and People tables.',
    ),
    projects: await ensure(
      WORK_PROJECT,
      TABLE_NAMES.projects,
      'The Moneybird projects this year’s time entries belong to, named as Moneybird names them.',
    ),
    people: await ensure(
      WORK_PERSON,
      TABLE_NAMES.people,
      'The Moneybird users who logged this year’s time entries, named as Moneybird names them.',
    ),
    mutations: await ensure(
      BANK_TRANSACTION,
      TABLE_NAMES.mutations,
      'This year’s Moneybird financial mutations, imported read-only by the Moneybird app.',
    ),
  };
}

/** The App properties named `shortnames`, from the App class's `recommends`/`requires`. */
async function appProperties(
  store: PluginStore,
  app: PluginResource,
  shortnames: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const klass of asList(app.get(IS_A))) {
    const listed = await store
      .getResource(klass)
      .then(k => [...asList(k.get(RECOMMENDS)), ...asList(k.get(REQUIRES))])
      .catch(() => []);

    for (const property of listed) {
      const shortname = await store
        .getResource(property)
        .then(p => p.get(SHORTNAME))
        .catch(() => undefined);
      if (typeof shortname === 'string' && shortnames.includes(shortname))
        found.set(shortname, property);
    }
  }

  return found;
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

export interface Adopted {
  app: string;
  /** Shortname -> subject of every own Property (`ROW_EXTRAS`, `BINDING_TERMS`). */
  properties: Map<string, string>;
  /** The row extras' subjects, in `ROW_EXTRAS` order. */
  extras: string[];
  /** Whether the App's `renders` lists the shared classes (now or before). */
  renders: boolean;
}

export async function adopt(store: PluginStore): Promise<Adopted> {
  const appSubject = await store.getApp();
  const properties = await ensureProperties(store, [
    ...ROW_EXTRAS,
    ...BINDING_TERMS,
  ]);
  const extras = ROW_EXTRAS.map(field => properties.get(field.shortname)!);
  const app = await store.getResource(appSubject);
  const terms = await appProperties(store, app, ['renders', 'row-extras']);
  const renders = terms.get('renders');
  const rowExtras = terms.get('row-extras');
  let dirty = false;

  if (renders) {
    const current = asList(app.get(renders));
    const wanted = [TIME_ENTRY, BANK_TRANSACTION].filter(
      klass => !current.includes(klass),
    );

    if (wanted.length) {
      app.set(renders, [...current, ...wanted]);
      dirty = true;
    }
  }

  if (rowExtras && !sameSet(asList(app.get(rowExtras)), extras)) {
    app.set(rowExtras, extras);
    dirty = true;
  }

  if (dirty) await app.save();

  return { app: appSubject, properties, extras, renders: !!renders };
}
