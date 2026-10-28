// @wc-ignore-file
import {
  readPlatform,
  type OpenApiDocument,
  type ReadOptions,
  type ReadResult,
  type Transport,
} from 'syncables/browser';
import document from '../catalog/notion.json' with { type: 'json' };
import {
  isNotionFieldType,
  isNotionReadOnlyType,
  notionFieldShortname,
  notionFieldValue,
  notionFormattedText,
  NotionRowLenses,
  notionColumns,
  notionDataSourceTitles,
  notionProjection,
  notionPropertyNames,
  type FetchedPlatform,
  type FetchedRecord,
  type NotionColumn,
  type Term,
  type JSONValue as LensValue,
} from '../devonian/notion/index.js';
import { Datatype } from '@tomic/lib';
import {
  BASELINE_SHORTNAME,
  editableFields,
  localValue,
  parseBaseline,
  reconcile,
  same,
  type Baseline,
  type Conflicts,
  type EditableField,
} from './changes.js';
import {
  dataBrowser,
  ensureOptions,
  hostOptionValue,
  indexTags,
  lensOptionValue,
  OPTION_ID_SHORTNAME,
  RESOURCE_ARRAY,
  shapeSelectProperty,
  type OptionIndex,
  type OptionTag,
} from './options.js';
import type { JSONValue, PluginResource, PluginStore } from './store.js';
import { observedTransport, PLATFORM } from './transport.js';

/** The composed catalog document (catalog/notion.json), bundled. */
export const NOTION_DOCUMENT = document as unknown as OpenApiDocument;

export const atomic = {
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  shortname: 'https://atomicdata.dev/properties/shortname',
  datatype: 'https://atomicdata.dev/properties/datatype',
  parent: 'https://atomicdata.dev/properties/parent',
  properties: 'https://atomicdata.dev/properties/properties',
  recommends: 'https://atomicdata.dev/properties/recommends',
  classes: 'https://atomicdata.dev/properties/classes',
  propertyClass: 'https://atomicdata.dev/classes/Property',
  classClass: 'https://atomicdata.dev/classes/Class',
} as const;

export interface SyncResult {
  created: number;
  updated: number;
  unchanged: number;
  dataSources: number;
  /**
   * Non-fatal: formatted text imported as plain text, values with no plain
   * form, archived pages, a partial read.
   */
  warnings: string[];
  /**
   * The part of `warnings` that says the read itself was incomplete (a
   * collection failed), as opposed to lens notes about single pages.
   */
  readErrors: string[];
  /** The same counts and warnings per data source, plus its schema. */
  perDataSource: DataSourceReport[];
  /**
   * Fields changed both here and in Notion since the baseline, differently:
   * Notion's value by row subject and column shortname. Neither side was
   * overwritten.
   */
  conflicts: Conflicts;
}

/** One option of a select, status or multi-select property. */
export interface NotionOption {
  id: string;
  name: string;
  /** One of Notion's ten colour names; anything else renders as `default`. */
  color: string;
}

/**
 * One property of a data source's schema, in Notion's order. `shortname` is
 * the column it lands in, only for the types the lens projects; the others
 * are listed so the view can say what was not copied.
 */
export interface SchemaProperty {
  id: string;
  name: string;
  type: string;
  shortname?: string;
  options?: NotionOption[];
  /** A relation's target: the data source whose pages it links to. */
  target?: string;
}

export interface DataSourceReport {
  id: string;
  title: string;
  url?: string;
  /** Pages read (archived ones included). */
  pages: number;
  created: number;
  updated: number;
  unchanged: number;
  /** The table holding this data source's rows (set by a sync from 0.5.8). */
  table?: string;
  properties: SchemaProperty[];
  /**
   * Pages whose `property` holds formatted text: imported as plain text
   * (from 0.5.3; before, not imported), and never written back.
   */
  formatted: { page: string; title: string; property: string }[];
  /** Archived or trashed pages: not imported, and an existing row is kept. */
  archived: string[];
  /** Any other lens message for this data source, verbatim. */
  errors: string[];
}

export type SyncPhase = 'listing' | 'reading' | 'writing' | 'done';

/**
 * Progress for one data source. Reported at most once per relayed request
 * (Notion returns up to 100 pages per query) and once per phase change,
 * never per row. `pages` is the number of pages read so far.
 */
export interface SyncProgress {
  dataSource: string;
  title: string;
  phase: SyncPhase;
  pages: number;
}

export interface SyncOptions {
  onProgress?: (progress: SyncProgress) => void;
}

type Read = (
  document: OpenApiDocument,
  options: ReadOptions,
) => Promise<ReadResult>;

/** One data source's pages, projected by the Notion lens. */
export interface NotionSource {
  dataSource: string;
  title: string;
  pages: FetchedRecord[];
  /** The columns of this data source alone. */
  columns: NotionColumn[];
}

/**
 * One read of every data source shared with the connection. Pages are
 * projected by the Notion lens one data source at a time (a page whose parent
 * is another data source fails the lens rather than landing in the wrong
 * place), and the lens derives the columns from what was read.
 */
export async function readNotion(
  transport: Transport,
  read: Read = readPlatform,
): Promise<{
  sources: NotionSource[];
  columns: NotionColumn[];
  dataSources: number;
  warnings: string[];
  readErrors: string[];
  reports: DataSourceReport[];
}> {
  const fetched = (await read(NOTION_DOCUMENT, {
    platform: PLATFORM,
    constants: {},
    transport,
    sleep: pauseBriefly,
  })) as unknown as FetchedPlatform;
  const titles = notionDataSourceTitles(fetched.records);
  const byDataSource = new Map<string, FetchedRecord[]>();

  for (const row of fetched.records)
    if (row.resource === 'page')
      byDataSource.set(row.namespace, [
        ...(byDataSource.get(row.namespace) ?? []),
        row,
      ]);

  const sources: NotionSource[] = [];
  const terms = new Map<string, Term>();
  const warnings = [...(fetched.errors ?? [])];
  const reports: DataSourceReport[] = [];
  const schemas = new Map(
    fetched.records
      .filter(r => r.resource === 'data-source')
      .map(r => [r.id, r] as const),
  );

  for (const dataSource of new Set([
    ...titles.keys(),
    ...byDataSource.keys(),
  ])) {
    const rows = byDataSource.get(dataSource) ?? [];
    const title = titles.get(dataSource) ?? dataSource;
    const projected = notionProjection(
      { ...fetched, records: rows, errors: [] },
      { dataSource },
    );
    const url = schemas.get(dataSource)?.values.url;
    const report: DataSourceReport = {
      id: dataSource,
      title,
      ...(typeof url === 'string' ? { url } : {}),
      pages: rows.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      properties: schemaProperties(schemas.get(dataSource)),
      formatted: [],
      archived: [],
      errors: [],
    };
    const names = new Map(projected.records.map(r => [r.id, r.name]));

    for (const message of projected.errors ?? []) {
      const formatted =
        /^Notion page (\S+) property "(.*)" \([\w-]+\) has formatting; imported as plain text/.exec(
          message,
        );
      const archived = /^Notion page (\S+) is archived or in trash/.exec(
        message,
      );
      if (formatted)
        report.formatted.push({
          page: formatted[1]!,
          title: names.get(formatted[1]!) ?? formatted[1]!,
          property: formatted[2]!,
        });
      else if (archived) report.archived.push(archived[1]!);
      else report.errors.push(message);
    }

    const own = projected.ontology.terms.filter(t => t.kind === 'property');

    sources.push({
      dataSource,
      title,
      pages: projected.records,
      columns: notionColumns(own, notionPropertyNames(projected.records)),
    });
    reports.push(report);
    warnings.push(...(projected.errors ?? []));
    for (const term of own) terms.set(term.shortname, term);
  }

  return {
    sources,
    columns: notionColumns(
      [...terms.values()],
      notionPropertyNames(sources.flatMap(s => s.pages)),
    ),
    dataSources: titles.size,
    warnings,
    readErrors: [...(fetched.errors ?? [])],
    reports,
  };
}

/** Longest `retry-after` the sync waits out itself before giving up. */
export const MAX_INLINE_RETRY_MS = 10_000;

/**
 * syncables' wait before retrying a 429. A short one is waited out; a longer
 * one fails that collection instead, so the view can say "paused until" and
 * retry the whole (idempotent) sync then, rather than sit on "Syncing…".
 */
async function pauseBriefly(ms: number): Promise<void> {
  if (ms > MAX_INLINE_RETRY_MS)
    throw new Error(`Notion asked to wait ${Math.round(ms / 1000)} s`);
  await new Promise(resolve => setTimeout(resolve, ms));
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * A data source's properties in Notion's order (the `properties` object's
 * key order), with the options of select, status and multi-select
 * properties. Read from the data source record the search already returned,
 * so it costs no extra request.
 */
export function schemaProperties(
  source: FetchedRecord | undefined,
): SchemaProperty[] {
  const out: SchemaProperty[] = [];

  for (const [name, raw] of Object.entries(record(source?.values.properties))) {
    const property = record(raw);
    const { id, type } = property;
    if (typeof id !== 'string' || typeof type !== 'string') continue;
    const options = record(property[type]).options;
    const target = record(property.relation).data_source_id;

    out.push({
      id,
      name: typeof property.name === 'string' ? property.name : name,
      type,
      ...(isNotionFieldType(type) || isNotionReadOnlyType(type)
        ? { shortname: notionFieldShortname(id) }
        : {}),
      ...(typeof target === 'string' ? { target } : {}),
      ...(Array.isArray(options)
        ? {
            options: options.flatMap(o => {
              const option = record(o);

              return typeof option.id === 'string'
                ? [
                    {
                      id: option.id,
                      name: typeof option.name === 'string' ? option.name : '',
                      color:
                        typeof option.color === 'string'
                          ? option.color
                          : 'default',
                    },
                  ]
                : [];
            }),
          }
        : {}),
    });
  }

  return out;
}

/**
 * The row's sync bookkeeping (`changes.ts`): a Property in the app's
 * ontology that is never a column.
 */
const BASELINE_COLUMN: NotionColumn = {
  shortname: BASELINE_SHORTNAME,
  name: 'Notion sync baseline',
  datatype: Datatype.STRING,
  description:
    'Written by the Notion app on each synced row: JSON of the values Notion and this row last agreed on, so a sync can tell an edit made here from one made in Notion.',
};

/** The Tag property carrying a Notion option id (`options.ts`): bookkeeping, never a column. */
const OPTION_ID_COLUMN: NotionColumn = {
  shortname: OPTION_ID_SHORTNAME,
  name: 'Notion option id',
  datatype: Datatype.STRING,
  description:
    'Written by the Notion app on each Tag of a select, status or multi-select column: the Notion option it stands for, so a rename in Notion renames the Tag and leaves the rows as they are.',
};

/** The table's bookkeeping Property: the data source whose pages it holds. */
export const SOURCE_SHORTNAME = 'notion-source';
const SOURCE_COLUMN: NotionColumn = {
  shortname: SOURCE_SHORTNAME,
  name: 'Notion data source',
  datatype: Datatype.STRING,
  description:
    'Written by the Notion app on each table it makes: the Notion data source whose pages the table holds.',
};

/** The datatype the host's Property gets: a select column holds Tags. */
const hostDatatype = (column: NotionColumn): string =>
  column.options ? RESOURCE_ARRAY : column.datatype;

/** Notion's value for a field, or `UNREADABLE` (no such property, no plain form). */
const UNREADABLE = Symbol('unreadable');

/** Formatted text: its words, readable but never written back. */
interface Formatted {
  formatted: string | undefined;
}

function remoteValue(
  page: FetchedRecord,
  field: EditableField,
): JSONValue | undefined | Formatted | typeof UNREADABLE {
  for (const raw of Object.values(record(page.values.properties))) {
    const property = record(raw);
    if (property.id !== field.id) continue;
    if (property.type !== field.type) return UNREADABLE;
    const value = notionFieldValue(field.type, property[field.type]);
    if (value !== undefined) return value ?? undefined;
    const words = notionFormattedText(field.type, property[field.type]);

    return words === undefined ? UNREADABLE : { formatted: words || undefined };
  }

  return UNREADABLE;
}

const isFormatted = (value: unknown): value is Formatted =>
  typeof value === 'object' && value !== null && 'formatted' in value;

/**
 * Compare on sync, per editable field (three-way: the row, Notion, the
 * baseline; `changes.ts`'s `reconcile`). Returns the row's next baseline,
 * the host properties whose local value must be kept rather than replaced
 * by Notion's (a local edit, or a conflict), and Notion's value for each
 * conflict. A row without a baseline (new, or imported before 0.2.0) takes
 * Notion's values, as an import always did. A field Notion holds as
 * formatted text follows Notion's words (plain text) unless the row edited
 * it since the last import; one with no plain form at all is left alone on
 * both sides. Select cells are compared as
 * option ids (`options.ts`).
 */
function compareOnSync(
  fields: readonly EditableField[],
  page: FetchedRecord,
  dataSource: string,
  bound: ReadonlyMap<string, string>,
  existing: PluginResource | undefined,
  baselineProperty: string,
  options: OptionIndex,
) {
  const previous = existing
    ? parseBaseline(existing.get(baselineProperty))
    : undefined;
  const base = previous?.dataSource === dataSource ? previous : undefined;
  const next: Baseline = { version: 1, dataSource, fields: {} };
  const keep = new Set<string>();
  const conflicts = new Map<string, JSONValue | undefined>();
  const local: Record<string, JSONValue> = {};

  for (const field of fields) {
    const value = existing?.get(bound.get(field.shortname)!);
    local[field.shortname] = isOptionType(field.type)
      ? lensOptionValue(
          field.type === 'multi_select' ? 'multiple' : 'single',
          value,
          options,
        )
      : value;
  }

  for (const field of fields) {
    const property = bound.get(field.shortname)!;
    const remote = remoteValue(page, field);
    const before = base?.fields[field.shortname];
    let agreed: JSONValue | undefined;

    if (remote === UNREADABLE) {
      // Left alone on both sides: the row keeps what it holds.
      agreed = before;
      keep.add(property);
    } else if (isFormatted(remote)) {
      // Formatted text, read as plain text and never sent (usertest-findings
      // #19): the row follows Notion's words unless it was edited here since
      // the last import, and then keeps the edit (which the review refuses
      // to send: "has formatting in Notion; edit it there").
      const mine = existing
        ? localValue(
            field,
            local,
            existing.get(atomic.name),
            base?.fields ?? {},
          )
        : undefined;

      // A cleared cell is an edit too: it is kept, not refilled (#536
      // review). A row that never held the words (formatted text before
      // 0.5.3) has no baseline value either, so `same` takes Notion's.
      if (!existing || !base || same(field.type, mine, before))
        agreed = remote.formatted;
      else {
        agreed = before;
        keep.add(property);
        if (field.id === 'title') keep.add(atomic.name);
      }
    } else if (!base) {
      agreed = remote;
    } else {
      const mine = localValue(
        field,
        local,
        existing?.get(atomic.name),
        base.fields,
      );
      const outcome = reconcile(field.type, mine, remote, before);
      agreed = outcome === 'local' || outcome === 'conflict' ? before : remote;

      if (outcome === 'local' || outcome === 'conflict') {
        keep.add(property);
        if (field.id === 'title') keep.add(atomic.name);
      }

      if (outcome === 'conflict') conflicts.set(field.shortname, remote);
    }

    if (agreed !== undefined) next.fields[field.shortname] = agreed;
  }

  return { baseline: next, keep, conflicts };
}

const values = (resource: PluginResource, property: string): string[] => {
  const raw = resource.get(property);

  return Array.isArray(raw) ? raw.map(String) : [];
};

const isOptionType = (type: string) =>
  type === 'select' || type === 'status' || type === 'multi_select';

/**
 * Finds or creates one Property per column under the row class's ontology
 * (the app's own subtree, where the host lets an app write), and lists it in
 * the ontology's `properties` and the class's `recommends`. An existing
 * property with another datatype is left alone and its column skipped,
 * except an option column still in its 0.3.0 shape (`string` or `json` of
 * option ids), which is upgraded in place to the host's select column
 * (`options.ts`); its rows are rewritten by the sync that follows. A stray
 * Page-field column of 0.1.0–0.4.0 (`isStrayRawColumn`) is retired.
 */
async function ensureColumns(
  store: PluginStore,
  rowClass: string,
  columns: readonly NotionColumn[],
  warnings: string[],
  extras: readonly NotionColumn[] = [],
): Promise<Map<string, string>> {
  const klass = await store.getResource(rowClass);
  const ontologySubject = klass.get(atomic.parent);
  if (typeof ontologySubject !== 'string')
    throw new Error('The row class has no parent ontology to add columns to');
  const ontology = await store.getResource(ontologySubject);
  const existing = new Map<string, PluginResource>();
  const listed: PluginResource[] = [];

  for (const subject of values(ontology, atomic.properties)) {
    const property = await store.getResource(subject);
    const shortname = property.get(atomic.shortname);
    listed.push(property);
    if (typeof shortname === 'string') existing.set(shortname, property);
  }

  const bound = new Map<string, string>();
  const added: string[] = [];

  for (const column of [...columns, ...extras]) {
    const found = existing.get(column.shortname);

    if (found) {
      if (found.get(atomic.datatype) !== hostDatatype(column)) {
        if (column.options && shapeSelectProperty(found)) {
          await found.save();
          bound.set(column.shortname, found.subject);
          continue;
        }

        warnings.push(
          `Column "${column.name}" exists with another datatype; not imported`,
        );
        continue;
      }

      bound.set(column.shortname, found.subject);
      continue;
    }

    const created = await store.newResource({
      parent: ontologySubject,
      isA: column.options
        ? [atomic.propertyClass, dataBrowser.selectProperty]
        : [atomic.propertyClass],
      propVals: {
        [atomic.shortname]: column.shortname,
        [atomic.name]: column.name,
        [atomic.datatype]: hostDatatype(column),
        [atomic.description]: column.description,
        ...(column.options
          ? {
              [dataBrowser.classtype]: dataBrowser.tag,
              [dataBrowser.allowsOnly]: [],
              ...(column.options === 'single' ? { [dataBrowser.max]: 1 } : {}),
            }
          : {}),
      },
    });
    bound.set(column.shortname, created.subject);
    added.push(created.subject);
  }

  // Up to 0.4.0 the platform's own Page fields became columns too (#303):
  // one Property per field of the Page schema, named by its raw term path.
  // The lens never wrote them, so their cells are empty. Retire them: off
  // the class and the ontology, then destroyed. Only that auto-named shape,
  // and only when no column of this sync binds it; a person's own column
  // with such a shortname has another name and stays, as do the rows.
  const kept = new Set(bound.values());
  const retired = listed.filter(
    p => !kept.has(p.subject) && isStrayRawColumn(p),
  );
  const gone = new Set(retired.map(p => p.subject));

  if (added.length || retired.length) {
    ontology.set(atomic.properties, [
      ...values(ontology, atomic.properties).filter(s => !gone.has(s)),
      ...added,
    ]);
    await ontology.save();
  }

  // Extras are bookkeeping on the row, not columns: never recommended.
  const before = values(klass, atomic.recommends);
  const recommends = before.filter(s => !gone.has(s));
  const extra = new Set(extras.map(e => bound.get(e.shortname)));
  const missing = [...bound.values()].filter(
    s => !recommends.includes(s) && !extra.has(s),
  );

  if (missing.length || recommends.length !== before.length) {
    klass.set(atomic.recommends, [...recommends, ...missing]);
    await klass.save();
  }

  for (const property of retired) await property.destroy();

  return bound;
}

/**
 * `<document title>/property/<shortname>`: the name 0.1.0–0.4.0 gave a
 * column made from one of syncables' Page-schema terms (`object`, `id`,
 * `created-time`, `last-edited-time`, `title`, `properties`, `parent`,
 * `url`, `archived`, `in-trash`), being that term's path. A column of a
 * Notion property is `notion-<hex>`, and a column a person adds is named by
 * them, so neither matches.
 */
const RAW_TERM_NAME = /\/property\/([^/]+)$/;

/** Whether an ontology Property is a stray Page-field column of an earlier version. */
export function isStrayRawColumn(property: PluginResource): boolean {
  const name = property.get(atomic.name);
  const shortname = property.get(atomic.shortname);
  if (typeof name !== 'string' || typeof shortname !== 'string') return false;
  if (shortname.startsWith('notion-')) return false;

  return RAW_TERM_NAME.exec(name)?.[1] === shortname;
}

/**
 * One Tag per Notion option on every select column (`options.ts`), from the
 * data sources' schemas plus any option id the pages hold, and the index
 * that translates between option ids and Tags. Two data sources whose
 * select properties share a Notion property id share the column, so their
 * options are merged.
 */
async function ensureAllOptions(
  store: PluginStore,
  columns: readonly NotionColumn[],
  bound: ReadonlyMap<string, string>,
  sources: readonly NotionSource[],
  reports: readonly DataSourceReport[],
): Promise<OptionIndex> {
  const optionIdProperty = bound.get(OPTION_ID_SHORTNAME);
  if (!optionIdProperty)
    throw new Error('No property to key option tags by Notion option id');
  const tags: OptionTag[] = [];

  for (const column of columns) {
    const property = bound.get(column.shortname);
    if (!column.options || !property) continue;
    const schema = new Map<string, NotionOption>();

    for (const report of reports)
      for (const p of report.properties)
        if (p.shortname === column.shortname)
          for (const option of p.options ?? [])
            if (!schema.has(option.id)) schema.set(option.id, option);

    const seen = new Set<string>();

    for (const source of sources)
      for (const page of source.pages) {
        const value = page.values[column.shortname];
        for (const id of Array.isArray(value) ? value : [value])
          if (typeof id === 'string' && id) seen.add(id);
      }

    tags.push(
      ...(await ensureOptions({
        store,
        property,
        options: column.options,
        schema: [...schema.values()],
        seen,
        optionIdProperty,
      })),
    );
  }

  return indexTags(tags);
}

/** A table of the app and the class its rows are. */
export interface SourceTable {
  table: string;
  rowClass: string;
}

/** The tables of the data sources (a table holds one), by `pageKey` of the id. */
export async function stampedTables(
  store: PluginStore,
  sourceProperty: string,
): Promise<Map<string, SourceTable>> {
  const found = new Map<string, SourceTable>();
  const children = await store.query({
    property: atomic.parent,
    value: await store.getApp(),
  });

  for (const subject of children) {
    const table = await store.getResource(subject).catch(() => undefined);
    const id = table?.get(sourceProperty);
    const rowClass = table?.get(dataBrowser.classtype);
    if (typeof id === 'string' && typeof rowClass === 'string')
      found.set(pageKey(id), { table: subject, rowClass });
  }

  return found;
}

/**
 * One table and row class per data source, so each table has only its own
 * data source's columns. The app's table (`getData`) is the first data
 * source's; each further one gets a class under the same ontology and a table
 * under the app, both made through the frame like the Properties are. A table
 * says which data source it holds in `notion-source`.
 *
 * Returns undefined, meaning every data source goes into the app's table with
 * merged columns as up to 0.5.7, when that table already holds rows from such
 * a sync (rows are not moved between tables) or is not the app's own (the
 * app is a view of someone else's table).
 */
async function ensureTables(
  store: PluginStore,
  data: { table: string; rowClass: string },
  sources: readonly NotionSource[],
  sourceProperty: string,
): Promise<Map<string, SourceTable> | undefined> {
  const app = await store.getApp();
  const primary = await store.getResource(data.table);
  const found = await stampedTables(store, sourceProperty);
  let free = ![...found.values()].some(t => t.table === data.table);

  if (
    free &&
    (primary.get(atomic.parent) !== app ||
      (await store.query({ property: atomic.parent, value: data.table }))
        .length)
  )
    return undefined;

  const klass = await store.getResource(data.rowClass);
  const ontology = await store.getResource(String(klass.get(atomic.parent)));
  const made: string[] = [];

  for (const { dataSource, title } of sources) {
    if (found.has(pageKey(dataSource))) continue;
    let table = data.table;
    let rowClass = data.rowClass;

    if (free) {
      free = false;
      primary.set(sourceProperty, dataSource).set(atomic.name, title);
      await primary.save();
    } else {
      rowClass = (
        await store.newResource({
          parent: ontology.subject,
          isA: [atomic.classClass],
          propVals: {
            [atomic.shortname]: `notion-source-${pageKey(dataSource).slice(0, 8)}`,
            [atomic.name]: title,
            [atomic.description]: `A page in the Notion data source ${title}`,
            [atomic.recommends]: [atomic.name],
          },
        })
      ).subject;
      made.push(rowClass);
      table = (
        await store.newResource({
          parent: app,
          isA: [dataBrowser.table],
          propVals: {
            [atomic.name]: title,
            [dataBrowser.classtype]: rowClass,
            [sourceProperty]: dataSource,
          },
        })
      ).subject;
    }

    found.set(pageKey(dataSource), { table, rowClass });
  }

  if (made.length) {
    ontology.set(atomic.classes, [
      ...values(ontology, atomic.classes),
      ...made,
    ]);
    await ontology.save();
  }

  return found;
}

/** One table, its row class, and the data sources whose pages it holds. */
interface Group extends SourceTable {
  columns: NotionColumn[];
  entries: { source: NotionSource; report: DataSourceReport }[];
  bound: Map<string, string>;
}

/**
 * Read every shared data source's pages through the proxy, run them through
 * the Notion row lens (Devonian `AtomicLens.ingest`), and reconcile the lens's
 * rows into the data source's table by Notion page id (`ensureTables`: one
 * table per data source, or the one merged table of up to 0.5.7). Import
 * only: nothing is written to Notion, and a page that is gone from Notion (or
 * archived) is left in place, never deleted. A value cleared in Notion is
 * removed from its row; one the lens cannot read losslessly is left as it was.
 */
export async function syncNotion(
  store: PluginStore,
  transport: Transport,
  read: Read = readPlatform,
  { onProgress = () => {} }: SyncOptions = {},
): Promise<SyncResult> {
  const data = await store.getData();
  if (!data?.table || !data.rowClass)
    throw new Error('This app has no data table with a row class to fill');
  const { sources, columns, dataSources, warnings, readErrors, reports } =
    await readNotion(
      observedTransport(transport, progressTap(onProgress)),
      read,
    );
  const extras = [BASELINE_COLUMN, OPTION_ID_COLUMN, SOURCE_COLUMN];
  // The bookkeeping Properties first: a table is found by `notion-source`.
  const allBound = await ensureColumns(
    store,
    data.rowClass,
    [],
    warnings,
    extras,
  );
  const entries = sources.map((source, i) => ({
    source,
    report: reports[i]!,
  }));
  const tables = await ensureTables(
    store,
    { table: data.table, rowClass: data.rowClass },
    sources,
    allBound.get(SOURCE_SHORTNAME)!,
  );
  const groups: Group[] = tables
    ? entries.map(entry => ({
        ...tables.get(pageKey(entry.source.dataSource))!,
        columns: entry.source.columns,
        entries: [entry],
        bound: new Map(),
      }))
    : [
        {
          table: data.table,
          rowClass: data.rowClass,
          columns,
          entries,
          bound: new Map(),
        },
      ];

  for (const group of groups) {
    group.bound = await ensureColumns(
      store,
      group.rowClass,
      group.columns,
      warnings,
      extras,
    );
    for (const [shortname, subject] of group.bound)
      allBound.set(shortname, subject);
    for (const { report } of group.entries) report.table = group.table;
  }

  const baselineProperty = allBound.get(BASELINE_SHORTNAME);
  const options = await ensureAllOptions(
    store,
    columns,
    allBound,
    sources,
    reports,
  );
  const optionColumns = new Map(
    columns.flatMap(c =>
      c.options && allBound.has(c.shortname)
        ? [[allBound.get(c.shortname)!, c.options] as const]
        : [],
    ),
  );

  /** Host row values with select cells as the lens holds them: option ids. */
  const seedValues = (props: Readonly<Record<string, JSONValue>>) => {
    const out: Record<string, JSONValue> = { ...props };

    for (const [property, kind] of optionColumns) {
      const ids = lensOptionValue(kind, props[property], options);
      // A single-option cell holding several Tags seeds its first: the seed
      // only gives the read something to unset; `keep` carries the cell.
      const value = kind === 'single' && Array.isArray(ids) ? ids[0] : ids;
      if (value === undefined) delete out[property];
      else out[property] = value;
    }

    return out;
  };

  /** Lens row values with option ids as Tag subjects, for the host. */
  const hostValues = (lensValues: Record<string, LensValue>) => {
    const out: Record<string, JSONValue> = { ...lensValues };

    for (const property of optionColumns.keys())
      if (property in out) {
        const value = hostOptionValue(out[property], options);
        if (value === undefined) delete out[property];
        else out[property] = value;
      }

    return out;
  };

  /** A host cell as the host should hold it: raw option ids become Tags. */
  const keptValue = (property: string, value: JSONValue | undefined) => {
    const kind = optionColumns.get(property);

    return kind
      ? hostOptionValue(lensOptionValue(kind, value, options), options)
      : value;
  };

  const result: SyncResult = {
    created: 0,
    updated: 0,
    unchanged: 0,
    dataSources,
    warnings,
    readErrors,
    perDataSource: reports,
    conflicts: new Map(),
  };
  const own = new Set(
    (
      await Promise.all(
        [...new Set(groups.map(g => g.table))].map(table =>
          store.query({ property: atomic.parent, value: table }),
        ),
      )
    ).flat(),
  );
  /** Row subject by Notion page id (dashes and case folded), for relations. */
  const rowOf = new Map<string, string>();
  /** What the first pass counted for a row, so the link pass can correct it. */
  const counted = new Map<
    string,
    { report: DataSourceReport; unchanged: boolean }
  >();

  for (const group of groups) {
    const { bound } = group;
    const pageId = bound.get('notion-page-id');
    if (!pageId) throw new Error('No column to key rows by Notion page id');
    const lenses = new NotionRowLenses({ columns: group.columns, bound });
    const managed = [
      ...lenses.managed(),
      ...(baselineProperty ? [baselineProperty] : []),
    ];

    for (const { source, report } of group.entries) {
      const lens = lenses.lens(source.dataSource, source.title, source.pages);
      const fields = (
        editableFields([report]).get(source.dataSource) ?? []
      ).filter(f => bound.has(f.shortname));
      onProgress({
        dataSource: source.dataSource,
        title: source.title,
        phase: 'writing',
        pages: report.pages,
      });

      for (const page of source.pages) {
        const matches = await store.query({ property: pageId, value: page.id });
        const subject = matches.find(s => own.has(s));
        const existing = subject ? await store.getResource(subject) : undefined;

        // The row's current values go into the lens store first, so the read's
        // `unset` has something to remove.
        if (existing)
          lenses.seed(source.dataSource, page.id, seedValues(existing.props));

        const row = lenses.store.get(await lens.ingest(page));
        if (!row) throw new Error(`The lens produced no row for ${page.id}`);
        const propVals = hostValues(lenses.toHost(row));

        if (baselineProperty) {
          const { baseline, keep, conflicts } = compareOnSync(
            fields,
            page,
            source.dataSource,
            bound,
            existing,
            baselineProperty,
            options,
          );
          if (existing)
            for (const property of keep)
              propVals[property] = keptValue(property, existing.get(property));
          propVals[baselineProperty] = JSON.stringify(baseline);
          if (existing && conflicts.size)
            result.conflicts.set(existing.subject, conflicts);
        }

        if (!existing) {
          const created = await store.newResource({
            parent: group.table,
            isA: [group.rowClass],
            propVals,
          });
          own.add(created.subject);
          rowOf.set(pageKey(page.id), created.subject);
          counted.set(created.subject, { report, unchanged: false });
          result.created++;
          report.created++;
          continue;
        }

        rowOf.set(pageKey(page.id), existing.subject);
        const changed = managed.filter(
          property =>
            JSON.stringify(existing.get(property)) !==
            JSON.stringify(propVals[property]),
        );

        if (!changed.length) {
          counted.set(existing.subject, { report, unchanged: true });
          result.unchanged++;
          report.unchanged++;
          continue;
        }

        for (const property of changed)
          if (propVals[property] === undefined) existing.remove(property);
          else existing.set(property, propVals[property]);
        await existing.save();
        counted.set(existing.subject, { report, unchanged: false });
        result.updated++;
        report.updated++;
      }

      onProgress({
        dataSource: source.dataSource,
        title: source.title,
        phase: 'done',
        pages: report.pages,
      });
    }
  }

  // Once every table exists, a relation column's class is the target data
  // source's row class (one table per data source), or the merged table's
  // class. A target that is not synced leaves the column without one.
  const classOf = new Map(
    groups.flatMap(g =>
      g.entries.map(e => [pageKey(e.source.dataSource), g.rowClass] as const),
    ),
  );
  const relationColumns = (group: Group) =>
    group.columns.filter(c => c.relation && group.bound.has(c.shortname));

  for (const group of groups)
    for (const column of relationColumns(group)) {
      const target = group.entries
        .flatMap(e => e.report.properties)
        .find(p => p.shortname === column.shortname)?.target;
      const rowClass = target ? classOf.get(pageKey(target)) : undefined;
      const property = await store.getResource(
        group.bound.get(column.shortname)!,
      );
      if (!rowClass || property.get(dataBrowser.classtype) === rowClass)
        continue;
      property.set(dataBrowser.classtype, rowClass);
      await property.save();
    }

  // Second pass, once every row exists: a relation's page ids become links to
  // rows (found by the page id column, so a row from an earlier sync counts
  // too). A page that is not a row (not shared with the integration) cannot
  // be linked: it is left out of the cell and named in the warnings.
  for (const group of groups) {
    const relations = relationColumns(group);
    if (!relations.length) continue;
    const pageId = group.bound.get('notion-page-id')!;

    for (const { source, report } of group.entries)
      for (const page of source.pages) {
        const subject = rowOf.get(pageKey(page.id));
        if (!subject) continue;
        const row = await store.getResource(subject);
        let changed = false;

        for (const column of relations) {
          const ids = page.values[column.shortname];
          if (!Array.isArray(ids)) continue;
          const links: string[] = [];
          const missing: string[] = [];

          for (const id of ids.map(String)) {
            let target = rowOf.get(pageKey(id));

            if (!target) {
              target = (
                await store.query({ property: pageId, value: id })
              ).find(s => own.has(s));
              if (target) rowOf.set(pageKey(id), target);
            }

            if (!target) missing.push(id);
            else if (!links.includes(target)) links.push(target);
          }

          if (missing.length) {
            const note = `Notion page ${page.id} property "${column.name}" (relation) links to ${missing.length} page(s) not shared with the integration (${missing.join(', ')}); left out of the links`;
            warnings.push(note);
            report.errors.push(note);
          }

          const property = group.bound.get(column.shortname)!;
          if (JSON.stringify(row.get(property) ?? []) === JSON.stringify(links))
            continue;
          if (links.length) row.set(property, links);
          else row.remove(property);
          changed = true;
        }

        if (!changed) continue;
        await row.save();
        const first = counted.get(subject);

        if (first?.unchanged) {
          first.unchanged = false;
          result.unchanged--;
          result.updated++;
          first.report.unchanged--;
          first.report.updated++;
        }
      }
  }

  return result;
}

/** Notion page ids come with or without dashes, in any case. */
const pageKey = (id: string) => id.replaceAll('-', '').toLowerCase();

const sameId = (a: string, b: string) =>
  a.replaceAll('-', '').toLowerCase() === b.replaceAll('-', '').toLowerCase();

/**
 * Turns relayed search and query responses into `listing` and `reading`
 * progress. syncables' `readPlatform` has no progress hook of its own, so
 * this reads the same responses it does: the search lists the data sources
 * (with titles), and each query page adds its `results` to one of them.
 */
function progressTap(onProgress: (progress: SyncProgress) => void) {
  const seen = new Map<string, SyncProgress>();

  return ({
    path,
    status,
    body,
  }: {
    path: string;
    status: number;
    body: unknown;
  }) => {
    if (status < 200 || status >= 300) return;
    const results = record(body).results;
    if (!Array.isArray(results)) return;

    if (/\/search(\?|$)/.test(path)) {
      for (const item of results.map(record))
        if (item.object === 'data_source' && typeof item.id === 'string') {
          if ([...seen.keys()].some(id => sameId(id, item.id as string)))
            continue;
          const progress: SyncProgress = {
            dataSource: item.id,
            title: notionPlainTitle(item.title) || item.id,
            phase: 'listing',
            pages: 0,
          };
          seen.set(item.id, progress);
          onProgress({ ...progress });
        }

      return;
    }

    const query = /\/data_sources\/([^/]+)\/query(\?|$)/.exec(path);
    if (!query) return;
    const id = decodeURIComponent(query[1]!);
    const key = [...seen.keys()].find(k => sameId(k, id)) ?? id;
    const progress = seen.get(key) ?? {
      dataSource: key,
      title: key,
      phase: 'reading' as const,
      pages: 0,
    };
    progress.phase = 'reading';
    progress.pages += results.length;
    seen.set(key, progress);
    onProgress({ ...progress });
  };
}

const notionPlainTitle = (title: unknown): string =>
  Array.isArray(title)
    ? title
        .map(part => record(part).plain_text)
        .filter((t): t is string => typeof t === 'string')
        .join('')
    : '';
