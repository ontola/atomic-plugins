// @wc-ignore-file
/**
 * First open of 0.5.0: make this app a view of the shared `time-entry-v1`
 * class (ontola/atomic-plugins#177 §5 and §6.2 items 3, 7 and 12, spike
 * S2). At the pinned host a catalog Install calls `createApp` without a row
 * class, so the App renders a class of its own (in its own ontology) and
 * gets a table of that class. Through the frame store, inside its own
 * subtree, the app fixes that itself, as the calendar app (0.2.0) does:
 *
 * 1. Its own table's rows (up to 0.4.0 the fields were Properties of the
 *    app's own ontology) get `isA` = [`time-entry-v1`], and each value
 *    moves to the shared property: start, end and billable are copied when
 *    the row has no shared value yet, then removed; the Clockify project id
 *    and name, and user id and name, become links to rows of the app's
 *    Projects and People tables (#177 Q11), made here. In place, not
 *    re-projected from the log, so an edit not sent to Clockify yet stays
 *    on the row and its baseline still finds it (#177 Q10: migrate where
 *    unsent edits could be lost). A project name typed into the table and
 *    not sent yet becomes a link to a project row of that name without a
 *    Clockify id, which is resolved by name as before. The provider extras
 *    (`clockify-entry-id`, the sync bookkeeping) keep their subjects. A row
 *    this pass did not reach keeps its old class and is done on the next
 *    open.
 * 2. Its own table's `classtype` becomes `time-entry-v1`, only once every
 *    row is done, so the table's columns are the shared ones.
 * 3. `time-entry-v1` is added to the App's `renders`, so the host's
 *    "+ Add view" (exact class match) offers the app on any table of that
 *    class.
 * 4. The App's `row-extras` lists the provider extras it keeps on time
 *    entry rows (atomic-server #1849): what an "Allow editing" grant on
 *    another table would also let it write.
 *
 * Every step is skipped when already done. `renders` and `row-extras` are
 * the drive's own App properties (minted per drive by the host's plugin
 * schema), so they are found by shortname among the App class's
 * `recommends`. The old class and its Properties stay in the app's
 * ontology, unused. Once the host lets a catalog entry declare its row
 * classes (#177 H2), steps 2 and 3 go.
 */
import { LEGACY_SHORTNAMES, SHARED, TIME_ENTRY } from './fields.js';
import { Links } from './links.js';
import { atomic } from './ontology.js';
import {
  ensureProperties,
  ensureTables,
  layout,
  type CompleteSchema,
} from './schema.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';

export interface Adopted {
  /** Whether the table is the app's own, rather than one it is a view of. */
  own: boolean;
  /** Rows moved onto `time-entry-v1` by this open. */
  migrated: number;
}

const asList = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : [];

const text = (value: JSONValue) =>
  typeof value === 'string' && value ? value : null;

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && a.every(x => b.includes(x));

/** The extras kept on time entry rows, by their key in the schema. */
export const ROW_EXTRAS = [
  'entryId',
  'baseline',
  'outbox',
  'deleteRequested',
  'create',
] as const;

/** Properties of the app's ontology named `shortnames`, by shortname. */
async function ownProperties(
  store: PluginStore,
  ontology: string,
  shortnames: readonly string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const listed = asList(
    (await store.getResource(ontology)).get(atomic.properties),
  );

  for (const subject of listed) {
    const shortname = await store
      .getResource(subject)
      .then(p => p.get(atomic.shortname))
      .catch(() => undefined);
    if (typeof shortname === 'string' && shortnames.includes(shortname))
      found.set(shortname, subject);
  }

  return found;
}

/** The App properties named `shortnames`, from the App class's `recommends`. */
async function appProperties(
  store: PluginStore,
  app: PluginResource,
  shortnames: string[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const klass of asList(app.get(atomic.isA))) {
    const listed = await store
      .getResource(klass)
      .then(k => asList(k.get(atomic.recommends)))
      .catch(() => []);

    for (const property of listed) {
      const shortname = await store
        .getResource(property)
        .then(p => p.get(atomic.shortname))
        .catch(() => undefined);
      if (typeof shortname === 'string' && shortnames.includes(shortname))
        found.set(shortname, property);
    }
  }

  return found;
}

type Legacy = Partial<Record<keyof typeof LEGACY_SHORTNAMES, string>>;

/** Moves one 0.4.0 row onto `time-entry-v1`; true when it wrote. */
async function migrateRow(
  row: PluginResource,
  legacy: Legacy,
  schema: Pick<CompleteSchema, 'links' | 'sync'>,
): Promise<boolean> {
  let changed = false;

  const take = (key: keyof Legacy) => {
    const property = legacy[key];
    if (!property) return undefined;
    const value = row.get(property);
    if (value === undefined) return undefined;
    row.remove(property);
    changed = true;

    return value;
  };

  for (const key of ['start', 'end', 'billable'] as const) {
    const value = take(key);
    const current = row.get(SHARED[key]);
    if (
      value !== undefined &&
      value !== '' &&
      (current === undefined || current === null || current === '')
    )
      row.set(SHARED[key], value);
  }

  const projectId = text(take('projectId') ?? null);
  const projectName = text(take('projectName') ?? null);
  const memberId = text(take('memberId') ?? null);
  const memberName = text(take('memberName') ?? null);

  if (row.get(SHARED.project) === undefined && (projectId || projectName)) {
    let baseline: { projectId?: unknown; project?: unknown } | undefined;

    try {
      baseline = JSON.parse(String(row.get(schema.sync.baseline) ?? ''));
    } catch {
      baseline = undefined;
    }

    // A name typed into the table, not resolved or sent yet: kept as a
    // link to a project of that name.
    const typed =
      !!projectName &&
      !!baseline &&
      (baseline.projectId ?? null) === projectId &&
      baseline.project !== projectName;
    row.set(
      SHARED.project,
      projectId && !typed
        ? await schema.links.ensure('project', projectId, projectName)
        : await schema.links.named(projectName ?? projectId!),
    );
  }

  if (row.get(SHARED.person) === undefined && memberId)
    row.set(
      SHARED.person,
      await schema.links.ensure('person', memberId, memberName),
    );

  const isA = asList(row.get(atomic.isA));

  if (isA.length !== 1 || isA[0] !== TIME_ENTRY) {
    row.set(atomic.isA, [TIME_ENTRY]);
    changed = true;
  }

  if (changed) await row.save();

  return changed;
}

export async function adopt(store: PluginStore): Promise<Adopted> {
  const where = await layout(store);
  let migrated = 0;
  const props = await ensureProperties(store, where);

  // Once the table is `time-entry-v1`, every row was done (step 2 is last).
  if (where.own && where.rowClass !== TIME_ENTRY) {
    const tables = await ensureTables(store, where.app);
    const links = new Links(store, tables, props.link);
    const found = await ownProperties(
      store,
      where.ontology,
      Object.values(LEGACY_SHORTNAMES),
    );
    const legacy: Legacy = {};

    for (const [key, shortname] of Object.entries(LEGACY_SHORTNAMES)) {
      const subject = found.get(shortname);
      if (subject) legacy[key as keyof Legacy] = subject;
    }

    for (const subject of await store.query({
      property: atomic.parent,
      value: where.table,
    }))
      if (
        await migrateRow(await store.getResource(subject), legacy, {
          links,
          sync: props.sync,
        })
      )
        migrated++;

    const table = await store.getResource(where.table);
    await table.set(atomic.classtype, TIME_ENTRY).save();
  }

  const app = await store.getResource(where.app);
  const terms = await appProperties(store, app, ['renders', 'row-extras']);
  const renders = terms.get('renders');
  const rowExtras = terms.get('row-extras');
  let dirty = false;

  if (renders) {
    const list = asList(app.get(renders));

    if (!list.includes(TIME_ENTRY)) {
      app.set(renders, [...list, TIME_ENTRY]);
      dirty = true;
    }
  }

  if (rowExtras) {
    const wanted = ROW_EXTRAS.map(key =>
      key === 'entryId' ? props.row.entryId : props.sync[key],
    );

    if (!sameSet(asList(app.get(rowExtras)), wanted)) {
      app.set(rowExtras, wanted);
      dirty = true;
    }
  }

  if (dirty) await app.save();

  return { own: where.own, migrated };
}
