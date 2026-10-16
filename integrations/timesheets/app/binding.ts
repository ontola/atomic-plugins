// @wc-ignore-file
/**
 * "Sync this table to Clockify" (ontola/atomic-plugins#177 §6.2 item 14) on
 * a `time-entry-v1` table the app didn't make, which it reaches through the
 * host's "+ Add view".
 *
 * #177 §3.3 for timesheets: the per-row bookkeeping goes on the rows and the
 * observation log stays under the app, keyed by that table. So:
 *
 * - The table's **binding** is a resource under the App (its own subtree,
 *   always writable) whose `clockify-synced-table` names the table. It holds
 *   what the App holds for the app's own table: the workspace, account and
 *   look-back, and the pointer to that table's own observation log, whose
 *   head, snapshots, incrementals, range edits and send lease are under the
 *   binding. `schema.home` is the App or the binding; everything that read
 *   the App for these reads `home`.
 * - The **rows** are that table's: created with `isA` [time-entry-v1] and
 *   the shared fields, plus the App's declared `row-extras`
 *   (`clockify-entry-id` and the sync bookkeeping), which the person's
 *   "Allow editing" grant covers once the app asked for them
 *   (atomic-server#1740, #1849). The table itself is never written.
 * - A grant **never deletes a row**: where the app would destroy a row of
 *   its own table, it takes its own extras off a row of this one, which
 *   leaves an ordinary row the person can delete (`writeBack.ts`
 *   `retireRow`).
 * - Projects and People stay the app's own two tables, under the App,
 *   shared by every table it syncs: their rows are keyed by Clockify's ids.
 */
import { ROW_EXTRAS } from './adopt.js';
import { atomic } from './ontology.js';
import {
  ensureProperties,
  findSchema,
  homeOf,
  layout,
  type Schema,
} from './schema.js';
import type { PluginStore, RowAccessAnswer } from './store.js';

/** The name the binding gets: shown if someone browses the App's children. */
export const bindingName = (table: string) => `Clockify sync of ${table}`;

/** The table's name, as the person gave it. */
export async function tableName(store: PluginStore): Promise<string> {
  const data = await store.getData();
  if (!data?.table) return 'Time entries';
  const name = (await store.getResource(data.table)).get(atomic.name);

  return typeof name === 'string' && name ? name : 'Time entries';
}

/** The subjects of the row extras, as the App declares them (`adopt.ts`). */
export function rowExtraSubjects(schema: Schema): string[] | undefined {
  const subjects = ROW_EXTRAS.map(key =>
    key === 'entryId' ? schema.row.entryId : schema.sync[key],
  );

  return subjects.every((s): s is string => !!s) ? subjects : undefined;
}

/**
 * Whether the person's grant on the table the app is a view of covers its
 * columns and every row extra (`rowAccess().extras`). Always true on the
 * app's own table, which needs no grant. Read fresh each time: the grant
 * lapses when the view is removed, the person who gave it loses write
 * access, the app's key changes or someone takes it back in the tab menu.
 */
export async function hasRowAccess(store: PluginStore): Promise<boolean> {
  const schema = await findSchema(store);
  if (schema.own) return true;
  if (typeof store.rowAccess !== 'function') return false;
  const access = await store.rowAccess();
  if (access.status !== 'granted') return false;
  const wanted = rowExtraSubjects(schema);

  return !!wanted && wanted.every(extra => access.extras.includes(extra));
}

/** Whether this host can ask for, and report, "Allow editing". */
export const canAskRowAccess = (store: PluginStore) =>
  typeof store.rowAccess === 'function' &&
  typeof store.requestRowAccess === 'function';

/**
 * Asks for "Allow editing" when the grant is missing or doesn't cover the
 * row extras: the host's own bar asks the person and records a grant for
 * the extras the App declares now, superseding an older one. Never writes
 * the table.
 */
export async function ensureRowAccess(
  store: PluginStore,
): Promise<RowAccessAnswer> {
  if (await hasRowAccess(store)) return { status: 'granted' };
  if (!canAskRowAccess(store))
    return {
      status: 'denied',
      reason: 'This host can’t let an app edit another table’s rows',
    };
  const answer = await store.requestRowAccess!();
  if (answer.status !== 'granted') return answer;
  if (await hasRowAccess(store)) return answer;

  return {
    status: 'denied',
    reason:
      'The grant doesn’t cover the Clockify ids and sync baselines the app keeps on rows',
  };
}

/**
 * The binding for the table the app is a view of, made under the App when
 * missing. No workspace yet: the setup form adds it. Returns its subject
 * (the App itself on the app's own table).
 */
export async function bindTable(store: PluginStore): Promise<string> {
  const where = await layout(store);
  if (where.own) return where.app;
  const properties = await ensureProperties(store, where);
  const found = await homeOf(store, where, properties.settings.syncedTable);
  if (found) return found;
  const binding = await store.newResource({
    parent: where.app,
    propVals: {
      [atomic.name]: bindingName(await tableName(store)),
      [properties.settings.syncedTable]: where.table,
    },
  });

  return binding.subject;
}

/**
 * "Not now" before a workspace was chosen: the table goes back to not
 * synced. A binding that has settings or a log is kept: that is "Stop
 * syncing", which is not built. True when it removed one.
 */
export async function unbindTable(store: PluginStore): Promise<boolean> {
  const schema = await findSchema(store);
  if (schema.own || !schema.home) return false;
  const binding = await store.getResource(schema.home);
  const kept = [
    schema.settings.workspaceId,
    schema.settings.userId,
    schema.settings.lookbackDays,
    schema.log.log,
  ].some(property => !!property && binding.get(property) !== undefined);
  if (kept) return false;
  await binding.destroy();

  return true;
}
