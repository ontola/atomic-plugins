// @wc-ignore-file
/**
 * First open of 0.2.0: make this app a view of the shared `event-v1` class
 * (ontola/atomic-plugins#177 §5 and §6.2 items 3 and 12, spike S2). At the
 * pinned host a catalog Install calls `createApp` without a row class, so
 * the App renders a class of its own ("Event", in its own ontology) and
 * gets a table of that class. Through the frame store, inside its own
 * subtree, the app fixes that itself:
 *
 * 1. Its own table's rows (0.1.x wrote the fields as Properties of the
 *    app's own ontology) get `isA` = [`event-v1`], and each value moves to
 *    the shared property: copied when the row has no shared value yet, then
 *    removed. In place, so an edit not sent to Google yet stays on the row
 *    and its baseline still finds it (#177 Q10: migrate where unsent edits
 *    could be lost; the provider extras keep their subjects). A row this
 *    pass did not reach keeps its old class and is done on the next open.
 * 2. Its own table's `classtype` becomes `event-v1`, only once every row is
 *    done, so the table's columns are the shared ones.
 * 3. `event-v1` is added to the App's `renders`, so the host's "+ Add view"
 *    (exact class match) offers the app on any table of that class.
 * 4. The App's `row-extras` lists the provider extras it keeps on rows
 *    (atomic-server #1849): what an "Allow editing" grant on another table
 *    would also let it write.
 *
 * Every step is skipped when already done. `renders` and `row-extras` are
 * the drive's own App properties (minted per drive by the host's plugin
 * schema), so they are found by shortname among the App class's
 * `recommends`. The old class stays in the app's ontology, unused. Once the
 * host lets a catalog entry declare its row classes (#177 H2), steps 2 and 3
 * go.
 */
import { EVENT, LEGACY_SHORTNAMES, SHARED, type SharedKey } from './fields.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';
import {
  CLASSTYPE,
  existing,
  IS_A,
  layout,
  PARENT,
  properties,
  RECOMMENDS,
  ROW_EXTRAS,
  SHORTNAME,
} from './sync.js';

export interface Adopted {
  /** Whether the table is the app's own, rather than one it is a view of. */
  own: boolean;
  /** Rows moved onto `event-v1` by this open. */
  migrated: number;
}

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** The App properties named `shortnames`, from the App class's `recommends`. */
async function appProperties(
  store: PluginStore,
  app: PluginResource,
  shortnames: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const klass of asList(app.get(IS_A))) {
    const listed = await store
      .getResource(klass)
      .then(k => asList(k.get(RECOMMENDS)))
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

/** Moves one row onto `event-v1`; true when it wrote. */
async function migrateRow(
  row: PluginResource,
  legacy: Array<[SharedKey, string]>,
): Promise<boolean> {
  let changed = false;

  for (const [key, old] of legacy) {
    const value = row.get(old);
    if (value === undefined) continue;
    const current = row.get(SHARED[key]);
    if (current === undefined || current === null || current === '')
      row.set(SHARED[key], value);
    row.remove(old);
    changed = true;
  }

  const isA = asList(row.get(IS_A));

  if (isA.length !== 1 || isA[0] !== EVENT) {
    row.set(IS_A, [EVENT]);
    changed = true;
  }

  if (changed) await row.save();

  return changed;
}

export async function adopt(store: PluginStore): Promise<Adopted> {
  const where = await layout(store);
  let migrated = 0;

  // Once the table is `event-v1`, every row was done (step 2 comes last).
  if (where.own && where.rowClass !== EVENT) {
    const found = await existing(store, where);
    const legacy = (Object.keys(SHARED) as SharedKey[])
      .map(key => [key, found.get(LEGACY_SHORTNAMES[key])] as const)
      .filter((pair): pair is [SharedKey, string] => !!pair[1]);

    for (const subject of await store.query({
      property: PARENT,
      value: where.table,
    }))
      if (await migrateRow(await store.getResource(subject), legacy))
        migrated++;

    const table = await store.getResource(where.table);
    await table.set(CLASSTYPE, EVENT).save();
  }

  const app = await store.getResource(where.app);
  const terms = await appProperties(store, app, ['renders', 'row-extras']);
  const renders = terms.get('renders');
  const rowExtras = terms.get('row-extras');
  let dirty = false;

  if (renders) {
    const list = asList(app.get(renders));

    if (!list.includes(EVENT)) {
      app.set(renders, [...list, EVENT]);
      dirty = true;
    }
  }

  if (rowExtras) {
    const props = (await properties(store, where, true))!;
    const wanted = ROW_EXTRAS.map(shortname => props[shortname]);

    if (!sameSet(asList(app.get(rowExtras)), wanted)) {
      app.set(rowExtras, wanted);
      dirty = true;
    }
  }

  if (dirty) await app.save();

  return { own: where.own, migrated };
}
