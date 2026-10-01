// @wc-ignore-file
/**
 * First open after an install: make this app a view of the shared class
 * (ontola/atomic-plugins#177 §6.2 item 3, spike S2). At the pinned host a
 * catalog Install calls `createApp` without a row class, so the App renders
 * only a class of its own and gets a table of that class. Nothing offers it
 * on the importer's Bank transactions table, whose class is
 * `bank-transaction-v1`. Through the frame store, inside its own subtree, the
 * app can fix both itself:
 *
 * - add `bank-transaction-v1` to its own App's `renders`, so the host's
 *   "+ Add view" (`appsForClass`, exact subject) offers it on any table of
 *   that class;
 * - set its own table's `classtype` to `bank-transaction-v1`, so that table
 *   is a bank transactions table too. Rows already in it keep their class.
 *
 * Both are idempotent, and both are skipped when already done. `renders` is
 * the drive's own property (minted per drive by the host's plugin schema),
 * so it is found by its shortname among the App's properties. Once the host
 * lets a catalog entry declare its row classes (#177 H2), this goes.
 */
import { atomic, BANK_TRANSACTION } from './rows.js';
import type { DataRef, PluginStore } from './store.js';

export interface Adopted {
  /** Whether the App's `renders` lists the shared class (now or before). */
  renders: boolean;
  /** The data ref, with the row class the app's own table now has. */
  data: DataRef | undefined;
  /** True when the table shown is the app's own, not an importer's. */
  own: boolean;
}

const ATOMIC = 'https://atomicdata.dev/';

async function rendersProperty(
  store: PluginStore,
  props: Record<string, unknown>,
): Promise<string | undefined> {
  for (const [property, value] of Object.entries(props)) {
    if (property.startsWith(ATOMIC) || !Array.isArray(value)) continue;
    const term = await store.getResource(property).catch(() => undefined);
    if (term?.get(atomic.shortname) === 'renders') return property;
  }

  return undefined;
}

export async function adoptSharedClass(
  store: PluginStore,
  data: DataRef | undefined,
): Promise<Adopted> {
  const app = await store.getApp();
  const resource = await store.getResource(app);
  let renders = false;
  const property = await rendersProperty(store, resource.props);

  if (property) {
    const current = resource.get(property);
    const list = Array.isArray(current)
      ? current.filter((v): v is string => typeof v === 'string')
      : [];
    renders = list.includes(BANK_TRANSACTION);

    if (!renders) {
      resource.set(property, [...list, BANK_TRANSACTION]);
      await resource.save();
      renders = true;
    }
  }

  if (!data) return { renders, data, own: false };
  const table = await store.getResource(data.table);
  const own = table.get(atomic.parent) === app;

  if (own && data.rowClass !== BANK_TRANSACTION) {
    table.set(atomic.classtype, BANK_TRANSACTION);
    await table.save();

    return { renders, own, data: { ...data, rowClass: BANK_TRANSACTION } };
  }

  return { renders, own, data };
}
