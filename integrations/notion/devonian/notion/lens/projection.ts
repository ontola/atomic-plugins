// @wc-ignore-file
import { Datatype } from '@tomic/lib';
import type {
  FetchedPlatform,
  FetchedRecord,
  JSONValue,
  Term,
} from './types.js';

export const NOTION_PLATFORM = 'notion';
export const PAGE_RESOURCE = 'page';

/** Notion property types this lens projects; the same subset as the sandbox pilot. */
export const notionFieldTypes = [
  'title',
  'rich_text',
  'number',
  'checkbox',
  'url',
  'email',
  'phone_number',
  'date',
  'select',
  'multi_select',
  'status',
] as const;
export type NotionFieldType = (typeof notionFieldTypes)[number];

/**
 * Spelled out because `Datatype.JSON` is missing from the published
 * `@tomic/lib` 0.40 that devonian declares as its peer (and that devonian's
 * own tests installed while this lens lived there). It is only present in
 * the atomic-server source that integrations/ resolves `@tomic/lib` to.
 */
export const JSON_DATATYPE =
  'https://atomicdata.dev/datatypes/json' as Datatype;

const datatypes: Record<NotionFieldType, Datatype> = {
  title: Datatype.STRING,
  rich_text: Datatype.STRING,
  number: Datatype.FLOAT,
  checkbox: Datatype.BOOLEAN,
  url: Datatype.STRING,
  email: Datatype.STRING,
  phone_number: Datatype.STRING,
  date: Datatype.STRING,
  select: Datatype.STRING,
  status: Datatype.STRING,
  multi_select: JSON_DATATYPE,
};

/**
 * Property types the lens reads but never writes: not editable, never in
 * the baseline or the review. A relation's value is Notion page ids; the
 * sync turns them into links to rows once every row exists
 * (`app/sync.ts`), so the lens store does not hold the column. A formula or
 * rollup holds its result when that is a single string, number, boolean or
 * date (`notionComputedValue`); the lens reads it into the row like any other
 * column and has no way to write it.
 */
export const notionReadOnlyTypes = ['relation', 'formula', 'rollup'] as const;
export type NotionReadOnlyType = (typeof notionReadOnlyTypes)[number];

export const isNotionReadOnlyType = (
  type: unknown,
): type is NotionReadOnlyType =>
  typeof type === 'string' &&
  (notionReadOnlyTypes as readonly string[]).includes(type);

/** Whether this lens projects a Notion property type. */
export const isNotionFieldType = (type: unknown): type is NotionFieldType =>
  typeof type === 'string' &&
  (notionFieldTypes as readonly string[]).includes(type);

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * Term shortname for a Notion property id. Property ids are short,
 * case-sensitive, percent-encoded strings (`title`, `%3AUPp`, `BJXS`), so they
 * are hex-encoded instead of lowercased or slugged. Two different ids can
 * never share a shortname, and a rename in Notion does not change it.
 */
export function notionFieldShortname(propertyId: string): string {
  if (!propertyId) throw new Error('Notion property id is empty');
  const hex = Array.from(new TextEncoder().encode(propertyId), b =>
    b.toString(16).padStart(2, '0'),
  ).join('');

  return `notion-${hex}`;
}

/**
 * Plain text from a Notion rich-text array, or `undefined` when the text has
 * formatting, links, mentions or equations. Those have no lossless plain-text
 * form, so the lens leaves them unprojected rather than flattening them.
 */
export function notionPlainText(parts: unknown): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  let text = '';

  for (const part of parts) {
    const p = object(part);
    const content = object(p.text).content;
    if (
      p.type !== 'text' ||
      typeof content !== 'string' ||
      object(p.text).link ||
      Object.entries(object(p.annotations)).some(([k, v]) =>
        k === 'color' ? v !== 'default' : v !== false,
      )
    )
      return undefined;
    text += content;
  }

  return text;
}

/**
 * The words of a Notion rich-text array without its formatting: each part's
 * `plain_text` (Notion's own flattening of text, mentions and equations),
 * joined. `undefined` for a value that is not a rich-text array. Lossy, so
 * it is only ever read, never written back (usertest-findings#19).
 */
export function notionTextWithoutFormatting(
  parts: unknown,
): string | undefined {
  if (!Array.isArray(parts)) return undefined;
  let text = '';

  for (const part of parts) {
    const p = object(part);
    const plain =
      typeof p.plain_text === 'string' ? p.plain_text : object(p.text).content;
    if (typeof plain !== 'string') return undefined;
    text += plain;
  }

  return text;
}

/**
 * For a title or rich_text value that `notionFieldValue` cannot read
 * losslessly (it has formatting, links, mentions or equations): its text
 * without the formatting. `undefined` for every other value.
 */
export function notionFormattedText(
  type: NotionFieldType,
  raw: unknown,
): string | undefined {
  if (type !== 'title' && type !== 'rich_text') return undefined;
  if (notionFieldValue(type, raw) !== undefined) return undefined;

  return notionTextWithoutFormatting(raw);
}

/**
 * A Notion date property as one string: `start`, `start/end` for a range,
 * and ` time_zone` appended when Notion holds one, e.g.
 * `2026-03-01T09:00:00+01:00/2026-03-01T10:00:00+01:00 Europe/Amsterdam`.
 * Start and end are Notion's own ISO 8601 strings, kept verbatim. The host's
 * timestamp is not used: it would turn a date into midnight UTC and drop the
 * offset and the time zone, so a date-only value could not be sent back as
 * it was. Date-only strings still sort and compare as dates.
 */
const ISO_DATE =
  '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d+)?)?(?:Z|[+-]\\d{2}:\\d{2})?)?';
const TIME_ZONE = '[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*';
const DATE_VALUE = new RegExp(
  `^(${ISO_DATE})(?:/(${ISO_DATE}))?(?: (${TIME_ZONE}))?$`,
);

const formatDate = (raw: unknown): string | undefined => {
  const { start, end = null, time_zone: zone = null } = object(raw);
  const optional = (v: unknown) => v === null || typeof v === 'string';
  if (typeof start !== 'string' || !optional(end) || !optional(zone))
    return undefined;
  const text = `${start}${end === null ? '' : `/${end}`}${zone === null ? '' : ` ${zone}`}`;
  const parsed = DATE_VALUE.exec(text);

  // Only a string that splits back into the same parts is read, so the
  // reverse mapping sends exactly what Notion held.
  return parsed &&
    parsed[1] === start &&
    (parsed[2] ?? null) === end &&
    (parsed[3] ?? null) === zone
    ? text
    : undefined;
};

const optionId = (value: unknown): string | undefined => {
  const id = object(value).id;

  return typeof id === 'string' && id ? id : undefined;
};

/**
 * Decodes one Notion page property value. Returns `undefined` when the value
 * cannot be represented losslessly (formatted text, malformed options), and
 * `null` when Notion holds no value (no number, no selected option). Atomic
 * has no null, so the projection leaves an empty value's key absent.
 * `false`, `0` and `[]` are values, not empties.
 */
export function notionFieldValue(
  type: NotionFieldType,
  raw: unknown,
): JSONValue | null | undefined {
  switch (type) {
    case 'title':
    case 'rich_text':
      return notionPlainText(raw);
    case 'number':
      return raw === null || (typeof raw === 'number' && Number.isFinite(raw))
        ? raw
        : undefined;
    case 'checkbox':
      return typeof raw === 'boolean' ? raw : undefined;
    case 'url':
    case 'email':
    case 'phone_number':
      return raw === null || typeof raw === 'string' ? raw : undefined;
    case 'date':
      return raw === null ? null : formatDate(raw);
    case 'select':
    case 'status':
      if (raw === null) return null;

      return optionId(raw);

    case 'multi_select': {
      if (!Array.isArray(raw)) return undefined;
      const ids = raw.map(optionId);

      return ids.every((id): id is string => id !== undefined)
        ? [...ids].sort()
        : undefined;
    }
  }
}

/** Notion's limits on one text object and on a rich-text array. */
export const NOTION_TEXT_CHUNK = 2000;
export const NOTION_RICH_TEXT_PARTS = 100;

/**
 * The reverse of `notionFieldValue`: the Notion page property value for an
 * Atomic value, as a page `PATCH` body carries it (`{ [type]: value }`'s
 * inner value). `undefined` means "no value": Notion's empty for that type.
 * Text is split into 2000-character text objects without truncation (never
 * inside a surrogate pair); more than 100 of them throws. Options are sent
 * by id. A value of the wrong shape throws rather than being coerced.
 */
export function notionPropertyValue(
  type: NotionFieldType,
  value: JSONValue | undefined,
): unknown {
  const fail = () => {
    throw new Error(`Cannot write ${JSON.stringify(value)} as Notion ${type}`);
  };

  switch (type) {
    case 'title':

    case 'rich_text': {
      if (value === undefined) return [];
      if (typeof value !== 'string') return fail();
      const parts = [];

      for (let i = 0; i < value.length; ) {
        let end = Math.min(i + NOTION_TEXT_CHUNK, value.length);
        if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]!))
          end--;
        parts.push({ type: 'text', text: { content: value.slice(i, end) } });
        i = end;
      }

      if (parts.length > NOTION_RICH_TEXT_PARTS)
        throw new Error("Text exceeds Notion's rich-text array limit");

      return parts;
    }

    case 'number':
      if (value === undefined) return null;

      return typeof value === 'number' && Number.isFinite(value)
        ? value
        : fail();
    case 'checkbox':
      // Notion has no empty checkbox: absent is unchecked.
      if (value === undefined) return false;

      return typeof value === 'boolean' ? value : fail();
    case 'url':
    case 'email':
    case 'phone_number':
      if (value === undefined) return null;

      return typeof value === 'string' ? value : fail();

    case 'date': {
      if (value === undefined) return null;
      const parsed = typeof value === 'string' ? DATE_VALUE.exec(value) : null;
      if (!parsed) return fail();

      return {
        start: parsed[1],
        end: parsed[2] ?? null,
        time_zone: parsed[3] ?? null,
      };
    }

    case 'select':
    case 'status':
      if (value === undefined) return null;

      return typeof value === 'string' && value ? { id: value } : fail();
    case 'multi_select':
      if (value === undefined) return [];

      return Array.isArray(value) &&
        value.every(id => typeof id === 'string' && id)
        ? (value as string[]).map(id => ({ id }))
        : fail();
  }
}

interface FieldDefinition {
  id: string;
  name: string;
  type: NotionFieldType | NotionReadOnlyType;
  /** For a formula or rollup: the datatype its first result fixed. */
  datatype?: Datatype;
}

/**
 * The result of a formula or rollup property: `value` is `null` when Notion
 * holds none, and `datatype` is what the result's type maps to (a date is the
 * string form of `date`). `undefined` for a result that is not one string,
 * number, boolean or date: a rollup over a list (`array`), an `incomplete`
 * or `unsupported` rollup.
 */
export function notionComputedValue(
  type: 'formula' | 'rollup',
  raw: unknown,
): { value: JSONValue | null; datatype: Datatype } | undefined {
  const result = object(raw).type;
  const inner = typeof result === 'string' ? object(raw)[result] : undefined;
  const one = (datatype: Datatype, value: JSONValue | null | undefined) =>
    value === undefined ? undefined : { value, datatype };

  switch (result) {
    case 'string':
      // A rollup has no string result.
      return type === 'formula' && (inner === null || typeof inner === 'string')
        ? one(Datatype.STRING, inner)
        : undefined;
    case 'number':
      return inner === null ||
        (typeof inner === 'number' && Number.isFinite(inner))
        ? one(Datatype.FLOAT, inner)
        : undefined;
    case 'boolean':
      return type === 'formula' && typeof inner === 'boolean'
        ? one(Datatype.BOOLEAN, inner)
        : undefined;
    case 'date':
      return one(Datatype.STRING, inner === null ? null : formatDate(inner));
    default:
      return undefined;
  }
}

/**
 * The Notion page ids a relation property links to, in Notion's order.
 * `undefined` when the list is not whole: a page property carries at most 25
 * relations and sets `has_more` beyond that, so it is not read.
 */
export function notionRelationIds(
  raw: unknown,
  hasMore: unknown,
): string[] | undefined {
  if (!Array.isArray(raw) || hasMore === true) return undefined;
  const ids = raw.map(item => object(item).id);

  return ids.every((id): id is string => typeof id === 'string' && !!id)
    ? ids
    : undefined;
}

export interface NotionProjectionOptions {
  /**
   * The data source the pages were queried from. When set, a page whose
   * `parent.data_source_id` differs (moved to another data source) fails the
   * projection instead of being imported into the wrong table.
   */
  dataSource?: string;
}

const normalizeUuid = (value: unknown): string =>
  typeof value === 'string' ? value.replaceAll('-', '').toLowerCase() : '';

/**
 * Read-only projection of pages from one Notion data source, as fetched by
 * the generic Syncables engine (`resource: 'page'`, `values` holding the raw
 * page object including `properties`).
 *
 * - Every supported property becomes a typed value keyed by
 *   `notionFieldShortname(property.id)`. The Notion property id is stable
 *   across renames, and the display name only goes into the term description.
 * - The record name is the plain-text title (`Untitled` when empty).
 * - Archived or trashed pages are left out and listed in `errors`. A page
 *   missing from a fetch never means it should be deleted.
 * - Formatted rich text is projected as its words without the formatting
 *   (`notionFormattedText`, from 0.5.3) and listed in `errors`; malformed
 *   option values are left unprojected and listed too. The raw `properties` object passes through
 *   untouched, as do unsupported types (formula, people, files,
 *   ...), so nothing provider-side is lost.
 * - A relation is projected as its linked page ids (read-only, see
 *   `notionReadOnlyTypes`).
 * - A property id whose type differs between pages in one fetch (the schema
 *   changed mid-read) throws.
 *
 * It does not write anything back or reconcile views. Two-way sync belongs
 * to a Devonian bridge that does not exist yet.
 */
export function notionProjection(
  fetched: FetchedPlatform,
  options: NotionProjectionOptions = {},
): FetchedPlatform {
  if (fetched.platform !== NOTION_PLATFORM) return fetched;
  const page = fetched.ontology.terms.find(
    t => t.kind === 'class' && t.shortname === PAGE_RESOURCE,
  );
  if (!page) return fetched;

  const fields = new Map<string, FieldDefinition>();
  const errors = [...(fetched.errors ?? [])];
  const records: FetchedRecord[] = [];

  for (const row of fetched.records) {
    if (row.resource !== PAGE_RESOURCE) {
      records.push(row);
      continue;
    }

    // `in-trash` is the same field after a reader's ontology shortnaming
    // (`in_trash` -> `in-trash`), which readers derived from reflector apply.
    if (
      row.values.archived === true ||
      row.values.in_trash === true ||
      row.values['in-trash'] === true
    ) {
      errors.push(
        `Notion page ${row.id} is archived or in trash; left out, not deleted`,
      );
      continue;
    }

    if (options.dataSource !== undefined) {
      const parent = object(row.values.parent).data_source_id;
      if (normalizeUuid(parent) !== normalizeUuid(options.dataSource))
        throw new Error(
          `Notion page ${row.id} is outside data source ${options.dataSource}`,
        );
    }

    const values: Record<string, JSONValue> = { ...row.values };
    let title = '';

    for (const [name, property] of Object.entries(
      object(row.values.properties),
    )) {
      const p = object(property);
      const id = p.id;
      if (
        typeof id !== 'string' ||
        !(isNotionFieldType(p.type) || isNotionReadOnlyType(p.type))
      )
        continue;
      const known = fields.get(id);
      if (known && known.type !== p.type)
        throw new Error(
          `Notion property ${id} changed type from ${known.type} to ${p.type} during one fetch`,
        );

      if (p.type === 'formula' || p.type === 'rollup') {
        const computed = notionComputedValue(p.type, p[p.type]);
        // The first result fixes the column's datatype (an empty result still
        // carries its type); one of another type is left out.
        const datatype = known?.datatype ?? computed?.datatype;

        if (computed === undefined || computed.datatype !== datatype)
          errors.push(
            `Notion page ${row.id} property "${name}" (${p.type}) has no single plain result; left unprojected`,
          );
        else {
          if (!known) fields.set(id, { id, name, type: p.type, datatype });
          if (computed.value !== null)
            values[notionFieldShortname(id)] = computed.value;
        }

        continue;
      }

      if (!known) fields.set(id, { id, name, type: p.type });

      if (p.type === 'relation') {
        const ids = notionRelationIds(p.relation, p.has_more);

        if (ids === undefined)
          errors.push(
            `Notion page ${row.id} property "${name}" (relation) has no complete list of linked pages; left unprojected`,
          );
        else values[notionFieldShortname(id)] = ids;
        continue;
      }

      const value = notionFieldValue(p.type, p[p.type]);
      const formatted =
        value === undefined
          ? notionFormattedText(p.type, p[p.type])
          : undefined;

      // Formatted text is imported without its formatting, and reported, so
      // the words are there; the app never writes such a value back.
      if (formatted !== undefined) {
        errors.push(
          `Notion page ${row.id} property "${name}" (${p.type}) has formatting; imported as plain text`,
        );
        if (formatted !== '') values[notionFieldShortname(id)] = formatted;
        if (p.type === 'title') title = formatted.trim();
        continue;
      }

      if (value === undefined) {
        errors.push(
          `Notion page ${row.id} property "${name}" (${p.type}) has no lossless plain value; left unprojected`,
        );
        continue;
      }

      if (value === null) continue;
      values[notionFieldShortname(id)] = value;
      if (p.type === 'title') title = (value as string).trim();
    }

    records.push({ ...row, name: title || 'Untitled', values });
  }

  const terms: Term[] = [...fields.values()].map(field => ({
    path: `urn:atomic:notion:property:${encodeURIComponent(field.id)}`,
    kind: 'property',
    shortname: notionFieldShortname(field.id),
    datatype:
      field.datatype ??
      (field.type === 'relation'
        ? Datatype.RESOURCEARRAY
        : datatypes[field.type as NotionFieldType]),
    description: `Notion property "${field.name}" (${field.type}, id ${field.id}).`,
    requires: [],
    recommends: [],
    notionType: field.type,
  }));
  if (
    fetched.ontology.terms.some(t =>
      terms.some(extra => extra.shortname === t.shortname),
    )
  )
    throw new Error(
      'Notion projection property collides with provider ontology',
    );

  return {
    ...fetched,
    ontology: {
      ...fetched.ontology,
      terms: [
        ...fetched.ontology.terms.map(t =>
          t === page
            ? {
                ...t,
                recommends: [
                  ...t.recommends,
                  ...terms.map(extra => extra.path),
                ],
              }
            : t,
        ),
        ...terms,
      ],
    },
    records,
    ...(errors.length ? { errors } : {}),
  };
}
