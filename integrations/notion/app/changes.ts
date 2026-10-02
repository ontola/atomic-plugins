// @wc-ignore-file
/**
 * Edits to synced rows, found by comparing each row with its baseline: the
 * values both sides last agreed on (#177 Q4–Q7, "compare on open").
 *
 * The baseline is sync bookkeeping kept on the row itself, as a provider
 * extra: one JSON string property, `notion-sync-baseline`, that is not a
 * column (its Property is not in the row class's `recommends`). It holds the
 * data source id and, per editable column shortname, the value Notion had
 * when the row last agreed with it. A key that is absent means Notion held
 * no value. It is keyed by the shortname, which is derived from Notion's
 * stable property id, so renaming a property in Notion or a column here
 * leaves it as it was.
 *
 * Everything here is pure: no store, no network.
 */
import type { NotionFieldType } from '../devonian/notion/index.js';
import { isNotionFieldType } from '../devonian/notion/index.js';
import type { SyncRecord } from './record.js';
import type { DataSourceReport } from './sync.js';
import type { Row } from './rows.js';
import type { JSONValue } from './store.js';

export const BASELINE_SHORTNAME = 'notion-sync-baseline';
/** The column every data source's title lands in (property id `title`). */
export const TITLE_ID = 'title';

export interface Baseline {
  version: 1;
  dataSource: string;
  /** By column shortname; absent means Notion held no value. */
  fields: Record<string, JSONValue>;
}

export function parseBaseline(value: unknown): Baseline | undefined {
  if (typeof value !== 'string') return undefined;

  try {
    const parsed = JSON.parse(value) as Partial<Baseline>;

    return parsed?.version === 1 &&
      typeof parsed.dataSource === 'string' &&
      parsed.fields &&
      typeof parsed.fields === 'object' &&
      !Array.isArray(parsed.fields)
      ? (parsed as Baseline)
      : undefined;
  } catch {
    return undefined;
  }
}

/** One property the app can send back: a projected Notion property. */
export interface EditableField {
  /** Notion's property id. */
  id: string;
  shortname: string;
  /** Notion's current name for it, for display. */
  name: string;
  type: NotionFieldType;
  /** Option ids a select, status or multi-select value may take. */
  options?: string[];
}

/** The editable fields of each data source, from a sync's schema. */
export function editableFields(
  sources: readonly Pick<DataSourceReport, 'id' | 'properties'>[] = [],
): Map<string, EditableField[]> {
  const out = new Map<string, EditableField[]>();

  for (const source of sources)
    out.set(
      source.id,
      source.properties.flatMap(p =>
        p.shortname && isNotionFieldType(p.type)
          ? [
              {
                id: p.id,
                shortname: p.shortname,
                name: p.name,
                type: p.type,
                ...(p.options ? { options: p.options.map(o => o.id) } : {}),
              },
            ]
          : [],
      ),
    );

  return out;
}

/**
 * A value in the form both sides compare in. Notion has an empty for every
 * type (empty text, no number, unchecked, no option), and a host cell can be
 * absent, `null` or `''` for the same thing, so those are folded together.
 * Multi-select ids are sorted, as the lens stores them.
 */
export function normalize(
  type: NotionFieldType,
  value: JSONValue | undefined,
): JSONValue | undefined {
  const empty = value === undefined || value === null || value === '';

  switch (type) {
    case 'title':
    case 'rich_text':
      return empty ? '' : value;
    case 'checkbox':
      return empty ? false : value;
    case 'multi_select':
      if (empty) return [];

      return Array.isArray(value) ? [...value].map(String).sort() : value;
    default:
      return empty ? undefined : value;
  }
}

export const same = (
  type: NotionFieldType,
  a: JSONValue | undefined,
  b: JSONValue | undefined,
) => JSON.stringify(normalize(type, a)) === JSON.stringify(normalize(type, b));

/** The row name the lens gives a page with this title. */
export const nameForTitle = (title: JSONValue | undefined) =>
  (typeof title === 'string' ? title.trim() : '') || 'Untitled';

/**
 * The row's own value for a field. For the title, a rename of the row itself
 * (its Name, which is what the host shows) counts too, when the title column
 * still holds the baseline.
 */
export function localValue(
  field: EditableField,
  values: Readonly<Record<string, JSONValue>>,
  hostName: JSONValue | undefined,
  base: Baseline['fields'],
): JSONValue | undefined {
  const own = values[field.shortname];
  if (field.id !== TITLE_ID) return own;
  const before = base[field.shortname];
  if (
    same(field.type, own, before) &&
    typeof hostName === 'string' &&
    hostName.trim() &&
    hostName !== nameForTitle(before)
  )
    return hostName;

  return own;
}

/**
 * What a value cannot be in Notion, or `undefined` when it can be sent:
 * the wrong shape for the type, or an option Notion's schema does not have.
 */
export function problemWith(
  field: EditableField,
  value: JSONValue | undefined,
): string | undefined {
  const v = normalize(field.type, value);
  if (v === undefined) return undefined;

  switch (field.type) {
    case 'title':
    case 'rich_text':
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof v === 'string' ? undefined : 'is not text';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v)
        ? undefined
        : 'is not a number';
    case 'checkbox':
      return typeof v === 'boolean' ? undefined : 'is not true or false';

    case 'select':
    case 'status':

    case 'multi_select': {
      const ids = Array.isArray(v) ? v : [v];

      if (!ids.every(id => typeof id === 'string'))
        return 'is not a list of option ids';
      // The host's select cell takes any number of Tags; Notion's select
      // and status take one.
      if (field.type !== 'multi_select' && ids.length > 1)
        return `holds ${ids.length} options; Notion’s ${field.name} takes one`;
      const unknown = ids.filter(
        id => field.options && !field.options.includes(id as string),
      );

      return unknown.length
        ? `holds ${unknown.length === 1 ? 'an option' : 'options'} Notion’s ${field.name} does not have (${unknown.join(', ')})`
        : undefined;
    }
  }
}

/**
 * How one field reconciles, given the row's value, Notion's value and the
 * baseline (three-way):
 * - `same`: neither side changed;
 * - `notion`: only Notion changed: the row takes Notion's value;
 * - `local`: only the row changed: kept, and offered for review;
 * - `agree`: both changed to the same value: the baseline catches up;
 * - `conflict`: both changed, differently: neither side is overwritten.
 */
export type Reconciled = 'same' | 'notion' | 'local' | 'agree' | 'conflict';

export function reconcile(
  type: NotionFieldType,
  local: JSONValue | undefined,
  remote: JSONValue | undefined,
  base: JSONValue | undefined,
): Reconciled {
  const localChanged = !same(type, local, base);
  const remoteChanged = !same(type, remote, base);
  if (!localChanged) return remoteChanged ? 'notion' : 'same';
  if (!remoteChanged) return 'local';

  return same(type, local, remote) ? 'agree' : 'conflict';
}

export interface FieldChange {
  id: string;
  shortname: string;
  /** Notion's name for the property. */
  name: string;
  type: NotionFieldType;
  /** The baseline: what Notion had when both sides last agreed. */
  before: JSONValue | undefined;
  /** The row's value now. */
  after: JSONValue | undefined;
  /**
   * Set when Notion changed the same field to something else since the
   * baseline (a conflict): Notion's value. Nothing is sent for the row
   * until each conflict is resolved.
   */
  notion?: JSONValue | undefined;
  conflict?: true;
  /** Why the value cannot be sent as it is. */
  problem?: string;
}

export interface RowChange {
  subject: string;
  pageId: string;
  /** The row name, for display. */
  name: string;
  dataSource: string;
  /** The data source's title. */
  dataSourceTitle: string;
  fields: FieldChange[];
}

/** A row can be sent when it has no unresolved conflict and no problem. */
export const sendable = (change: RowChange) =>
  change.fields.every(f => !f.conflict && !f.problem);

/**
 * Notion's values for fields that conflict, by row subject and shortname,
 * as the last sync or send found them. Kept in memory: reopening the app
 * syncs again, which finds the same conflicts from the baselines.
 */
export type Conflicts = Map<string, Map<string, JSONValue | undefined>>;

/**
 * Every synced row whose editable values differ from its baseline, however
 * the edit was made (this app, the host's table, another view or device).
 * Rows without a baseline (imported before 0.2.0, or never synced) and rows
 * made by hand (no Notion page id) are not listed: there is nothing to
 * compare them with, and creating pages is not supported.
 */
export function localChanges(
  rows: readonly Row[],
  record: SyncRecord | undefined,
  conflicts: Conflicts = new Map(),
): RowChange[] {
  const fields = editableFields(record?.dataSources);
  const titles = new Map(record?.dataSources.map(d => [d.id, d.title]));
  const out: RowChange[] = [];

  for (const row of rows) {
    const baseline = parseBaseline(row.values[BASELINE_SHORTNAME]);
    if (!baseline || !row.pageId) continue;
    const editable = fields.get(baseline.dataSource);
    if (!editable) continue;
    const known = conflicts.get(row.subject);
    const changed: FieldChange[] = [];

    for (const field of editable) {
      const before = baseline.fields[field.shortname];
      const after = localValue(
        field,
        row.values,
        row.hostName,
        baseline.fields,
      );
      if (same(field.type, after, before)) continue;
      const problem = problemWith(field, after);
      const conflict = known?.has(field.shortname);
      changed.push({
        id: field.id,
        shortname: field.shortname,
        name: field.name,
        type: field.type,
        before,
        after,
        ...(conflict
          ? { conflict: true, notion: known!.get(field.shortname) }
          : {}),
        ...(problem ? { problem } : {}),
      });
    }

    if (changed.length)
      out.push({
        subject: row.subject,
        pageId: row.pageId,
        name: row.name,
        dataSource: baseline.dataSource,
        dataSourceTitle: titles.get(baseline.dataSource) ?? row.dataSource,
        fields: changed,
      });
  }

  return out;
}
