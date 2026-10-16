// @wc-ignore-file
/**
 * Notion options as the host's own select columns (since 0.4.0).
 *
 * The host's table renders a `string` cell as text and never reads
 * `allowsOnly`, so a select, status or multi-select column holding Notion's
 * option ids (0.1.0–0.3.0) showed UUIDs. The pinned host does have a select
 * column of its own (`chunks/TablePage/PropertyForm/NewPropertyDialog.tsx`):
 * a Property that `isA` SelectProperty, datatype `resourceArray`, `classtype`
 * Tag, whose `allowsOnly` lists the Tag resources a cell may hold. Its
 * `SelectCell` shows one coloured chip per Tag (the Tag's name, in its
 * `color`) and its editor offers exactly `allowsOnly`. So the app makes each
 * option column that shape, with one Tag per Notion option as a child of the
 * column's Property:
 *
 * - `shortname`: a slug of the option name (the host filters on it);
 * - `name`: Notion's option name, which the chip shows;
 * - `color`: a hex colour for Notion's colour name (the host derives the
 *   chip's shade from it);
 * - `notion-option-id`: the Notion option id, a Property in the app's
 *   ontology that is never a column.
 *
 * A cell holds the Tag's subject, so a rename or recolour in Notion updates
 * the Tag and leaves every row as it was: the value stays keyed by the
 * option id, as before. The lens, the baseline, the review and the send keep
 * working in option ids; the functions here translate at the host boundary
 * (`sync.ts`, `rows.ts`, `send.ts`). A cell that still holds a raw option id
 * (a row written by 0.2.0 or 0.3.0) is read as that id, so an edit made
 * before the upgrade is not lost; the first 0.4.0 sync rewrites it.
 *
 * `max` is 1 on a select or status column. The pinned host's `SelectCell`
 * does not enforce it, so a person can add a second Tag to such a cell;
 * `changes.ts` then holds that row back ("takes one option") instead of
 * sending the first.
 */
import type { Column } from './record.js';
import {
  MAX_GET_MANY,
  type JSONValue,
  type PluginResource,
  type PluginStore,
} from './store.js';

const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';
const NAME = 'https://atomicdata.dev/properties/name';
const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const DATATYPE = 'https://atomicdata.dev/properties/datatype';

/** The host's data-browser vocabulary for select columns and tags. */
export const dataBrowser = {
  tag: 'https://atomicdata.dev/classes/Tag',
  selectProperty: 'https://atomicdata.dev/classes/SelectProperty',
  color: 'https://atomicdata.dev/properties/color',
  max: 'https://atomicdata.dev/properties/max',
  classtype: 'https://atomicdata.dev/properties/classtype',
  allowsOnly: 'https://atomicdata.dev/properties/allowsOnly',
} as const;

export const RESOURCE_ARRAY = 'https://atomicdata.dev/datatypes/resourceArray';

/** The Tag property that carries the Notion option id (app ontology, not a column). */
export const OPTION_ID_SHORTNAME = 'notion-option-id';

/**
 * A hex colour per Notion option colour name. The host's chip derives its
 * shade from the hue, so these follow its own preset tag palette where a
 * hue matches, with a neutral for `default`/`gray` and a red of its own.
 */
export const OPTION_COLOURS: Readonly<Record<string, string>> = {
  default: '#8A8A8A',
  gray: '#8A8A8A',
  brown: '#A9825E',
  orange: '#CC7B54',
  yellow: '#CC9A44',
  green: '#6E9B7B',
  blue: '#4C6FA5',
  purple: '#7C7BB8',
  pink: '#B5657A',
  red: '#C0504D',
};

export const optionColour = (name: string): string =>
  OPTION_COLOURS[name] ?? OPTION_COLOURS.default!;

/**
 * The Tag's shortname: the option name as a slug (lowercase ASCII letters and
 * digits, dashes between them, as the host requires), or `option-<id>` when
 * nothing of the name survives that.
 */
export function optionSlug(name: string, id: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  const fallback = id.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return `option-${fallback.replace(/^-+|-+$/g, '') || 'untitled'}`;
}

/** One Tag resource of an option column, as the app wrote it. */
export interface OptionTag {
  subject: string;
  id: string;
  name: string;
  color: string;
  shortname: string;
}

/** Notion option id <-> Tag subject, over every option column. */
export interface OptionIndex {
  readonly byId: ReadonlyMap<string, string>;
  readonly bySubject: ReadonlyMap<string, string>;
}

export const EMPTY_INDEX: OptionIndex = {
  byId: new Map(),
  bySubject: new Map(),
};

export function indexTags(tags: Iterable<OptionTag>): OptionIndex {
  const byId = new Map<string, string>();
  const bySubject = new Map<string, string>();

  for (const tag of tags) {
    byId.set(tag.id, tag.subject);
    bySubject.set(tag.subject, tag.id);
  }

  return { byId, bySubject };
}

const text = (value: JSONValue | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The option ids a host cell holds, in the cell's order. A string the index
 * does not know is taken as a raw option id (a cell written before 0.4.0).
 */
export function optionIds(
  value: JSONValue | undefined,
  index: OptionIndex,
): string[] {
  const items = Array.isArray(value)
    ? value
    : value === undefined || value === null || value === ''
      ? []
      : [value];

  return items
    .filter((v): v is string => typeof v === 'string' && v !== '')
    .map(v => index.bySubject.get(v) ?? v);
}

/**
 * Host cell -> the lens's value: one option id for a single-option column
 * (select, status), the ids for a multi-select. A single-option cell holding
 * more than one Tag keeps them all, as a list, so the review can say so.
 */
export function lensOptionValue(
  options: 'single' | 'multiple',
  value: JSONValue | undefined,
  index: OptionIndex,
): string | string[] | undefined {
  const ids = optionIds(value, index);
  if (options === 'multiple') return ids;
  if (!ids.length) return undefined;

  return ids.length === 1 ? ids[0] : ids;
}

/**
 * Lens value (an option id, or ids) -> the Tag subjects the host cell holds.
 * No option (`undefined`) is no value; a multi-select's empty list stays a
 * list, as the lens holds it. Every id must have a Tag: the sync makes one
 * per option it reads (`ensureOptions`), so a missing one is a bug, and
 * throws rather than writing a value the host's column would not accept.
 */
export function hostOptionValue(
  value: JSONValue | undefined,
  index: OptionIndex,
): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const ids = Array.isArray(value) ? value : [value];

  return ids.map(id => {
    const subject = typeof id === 'string' ? index.byId.get(id) : undefined;
    if (!subject) throw new Error(`No tag for Notion option ${String(id)}`);

    return subject;
  });
}

/** A column's host value for a lens value; other columns pass through. */
export function hostValueFor(
  column: Pick<Column, 'options'>,
  value: JSONValue | undefined,
  index: OptionIndex,
): JSONValue | undefined {
  return column.options ? hostOptionValue(value, index) : value;
}

/** A column's lens value for a host value; other columns pass through. */
export function lensValueFor(
  column: Pick<Column, 'options'>,
  value: JSONValue | undefined,
  index: OptionIndex,
): JSONValue | undefined {
  return column.options ? lensOptionValue(column.options, value, index) : value;
}

/** Whether a Property resource is a select column (the host's shape). */
export function isSelectProperty(property: PluginResource): boolean {
  const isA = property.get(IS_A);

  return (
    (Array.isArray(isA) && isA.includes(dataBrowser.selectProperty)) ||
    property.get(dataBrowser.classtype) === dataBrowser.tag
  );
}

async function readMany(
  store: PluginStore,
  subjects: readonly string[],
): Promise<PluginResource[]> {
  const out: PluginResource[] = [];
  const many = store.getMany?.bind(store);

  for (let i = 0; i < subjects.length; i += MAX_GET_MANY) {
    const slice = subjects.slice(i, i + MAX_GET_MANY);
    const batch = many
      ? (await many(slice)).flatMap(entry =>
          entry.error === undefined ? [entry as PluginResource] : [],
        )
      : (
          await Promise.all(
            slice.map(s => store.getResource(s).catch(() => undefined)),
          )
        ).flatMap(r => (r ? [r] : []));
    out.push(...batch);
  }

  return out;
}

/**
 * The Tags of one option column: its Property's children that carry a
 * Notion option id. One `query` and one `getMany` per column.
 */
export async function readTags(
  store: PluginStore,
  property: string,
  optionIdProperty: string,
): Promise<OptionTag[]> {
  const subjects = await store.query({ property: PARENT, value: property });
  const tags: OptionTag[] = [];

  for (const resource of await readMany(store, subjects)) {
    const id = text(resource.get(optionIdProperty));
    if (!id) continue;
    tags.push({
      subject: resource.subject,
      id,
      name: text(resource.get(NAME)) ?? '',
      color: text(resource.get(dataBrowser.color)) ?? '',
      shortname: text(resource.get(SHORTNAME)) ?? '',
    });
  }

  return tags;
}

/** Every option column's Tags, indexed. No `notion-option-id` Property yet: empty. */
export async function loadOptionIndex(
  store: PluginStore,
  columns: Iterable<Column>,
): Promise<OptionIndex> {
  const all = [...columns];
  const optionId = all.find(c => c.shortname === OPTION_ID_SHORTNAME)?.subject;
  if (!optionId) return EMPTY_INDEX;
  const tags = await Promise.all(
    all
      .filter(c => c.options)
      .map(column => readTags(store, column.subject, optionId)),
  );

  return indexTags(tags.flat());
}

/** A Notion option as the sync's schema reports it. */
export interface WantedOption {
  id: string;
  name: string;
  /** Notion's colour name. */
  color: string;
}

export interface EnsureOptionsArgs {
  store: PluginStore;
  /** The column's Property subject. */
  property: string;
  options: 'single' | 'multiple';
  /** The options in Notion's schema, in Notion's order. */
  schema: readonly WantedOption[];
  /**
   * Option ids the pages hold that the schema does not list (should not
   * happen; a Tag named after the id keeps the row writable).
   */
  seen?: Iterable<string>;
  optionIdProperty: string;
}

/**
 * Makes the column's Tags match Notion's options: one Tag per option (made
 * under the Property the first time, renamed or recoloured when Notion
 * changed them, never deleted), and the Property's `allowsOnly` listing the
 * schema's options in Notion's order. An option Notion no longer has keeps
 * its Tag, so a row that still holds it stays readable, but leaves
 * `allowsOnly`, so it is not offered. Returns every Tag of the column.
 */
export async function ensureOptions({
  store,
  property,
  options,
  schema,
  seen = [],
  optionIdProperty,
}: EnsureOptionsArgs): Promise<OptionTag[]> {
  const existing = new Map(
    (await readTags(store, property, optionIdProperty)).map(t => [t.id, t]),
  );
  const wanted: WantedOption[] = [...schema];
  const listed = new Set(schema.map(o => o.id));

  for (const id of seen)
    if (!listed.has(id)) {
      listed.add(id);
      wanted.push({ id, name: id, color: 'default' });
    }

  for (const option of wanted) {
    const name = option.name || 'Untitled option';
    const color = optionColour(option.color);
    const shortname = optionSlug(name, option.id);
    const found = existing.get(option.id);

    if (!found) {
      const created = await store.newResource({
        parent: property,
        isA: [dataBrowser.tag],
        propVals: {
          [SHORTNAME]: shortname,
          [NAME]: name,
          [dataBrowser.color]: color,
          [optionIdProperty]: option.id,
        },
      });
      existing.set(option.id, {
        subject: created.subject,
        id: option.id,
        name,
        color,
        shortname,
      });
      continue;
    }

    if (
      found.name !== name ||
      found.color !== color ||
      found.shortname !== shortname
    ) {
      const tag = await store.getResource(found.subject);
      tag.set(NAME, name);
      tag.set(dataBrowser.color, color);
      tag.set(SHORTNAME, shortname);
      await tag.save();
      existing.set(option.id, { ...found, name, color, shortname });
    }
  }

  const allowsOnly = schema.map(o => existing.get(o.id)!.subject);
  const resource = await store.getResource(property);
  const current = resource.get(dataBrowser.allowsOnly);
  const max = options === 'single' ? 1 : undefined;
  let dirty = false;

  if (JSON.stringify(current) !== JSON.stringify(allowsOnly)) {
    resource.set(dataBrowser.allowsOnly, allowsOnly);
    dirty = true;
  }

  if (resource.get(dataBrowser.max) !== max) {
    if (max === undefined) resource.remove(dataBrowser.max);
    else resource.set(dataBrowser.max, max);
    dirty = true;
  }

  if (dirty) await resource.save();

  return [...existing.values()];
}

/**
 * The select-column shape on a Property the sync creates or upgrades:
 * `isA` SelectProperty next to Property, datatype `resourceArray`,
 * `classtype` Tag, and an `allowsOnly` (SelectProperty requires one; the
 * server checks required properties on commit) that `ensureOptions` fills.
 * Returns whether anything changed (the caller saves).
 */
export function shapeSelectProperty(property: PluginResource): boolean {
  const isA = property.get(IS_A);
  const classes = Array.isArray(isA) ? isA.map(String) : [];
  let changed = false;

  if (!classes.includes(dataBrowser.selectProperty)) {
    property.set(IS_A, [...classes, dataBrowser.selectProperty]);
    changed = true;
  }

  if (!Array.isArray(property.get(dataBrowser.allowsOnly))) {
    property.set(dataBrowser.allowsOnly, []);
    changed = true;
  }

  if (property.get(DATATYPE) !== RESOURCE_ARRAY) {
    property.set(DATATYPE, RESOURCE_ARRAY);
    changed = true;
  }

  if (property.get(dataBrowser.classtype) !== dataBrowser.tag) {
    property.set(dataBrowser.classtype, dataBrowser.tag);
    changed = true;
  }

  return changed;
}
