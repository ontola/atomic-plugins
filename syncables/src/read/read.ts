import {
  applyOverlay,
  type OverlayDocument,
} from '../openapi/apply-overlay.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import type { OpenApiDocument } from '../openapi/types.js';
import {
  asText,
  describeModel,
  discoverReadModel,
  listOperation,
  upstreamOf,
  type PlatformDescription,
  type QuerySelection,
} from './model.js';
import {
  DATATYPES,
  deriveOntology,
  ontologyShortname,
  type Ontology,
} from './ontology.js';
import {
  bindPath,
  Budget,
  BudgetExhausted,
  walkPages,
  type ReadLimits,
  type WalkOutcome,
  type WindowRange,
} from './pages.js';
import type { ListMethod, Transport } from './transport.js';
import { readCollections, type CollectionReadOptions } from './collections.js';
import { captureReadResponses, type StoreReadResponse } from './responses.js';
import { declaredThrottling } from '../throttling/throttling.js';
import type { RuntimeDescriber, RuntimeMembers } from './runtime-schemas.js';
import type { CollectionCoverage } from '../client/client.js';

/**
 * Applies overlays in order, then resolves local `$ref`s. The other read
 * functions resolve refs themselves too, so this is only required when
 * there are overlays to apply (e.g. the pagination-schemes and
 * CRUD-causality overlays for a third-party document).
 */
export function prepareDocument(
  document: Record<string, unknown>,
  overlays: OverlayDocument[] = [],
): OpenApiDocument {
  const overlaid = overlays.reduce(
    (current, overlay) => applyOverlay(current, overlay),
    document,
  );
  return resolveRefs(overlaid) as unknown as OpenApiDocument;
}

const resolvedCache = new WeakMap<object, OpenApiDocument>();

function resolved(document: OpenApiDocument): OpenApiDocument {
  let result = resolvedCache.get(document);
  if (!result) {
    result = resolveRefs(document);
    resolvedCache.set(document, result);
  }
  return result;
}

/** Setup form data: the parameters to ask for, and what a read walks. */
export function describePlatform(
  document: OpenApiDocument,
): PlatformDescription {
  const doc = resolved(document);
  return describeModel(doc, discoverReadModel(doc));
}

export interface ReadOptions {
  /** Copied onto the result, for the caller's bookkeeping. */
  platform: string;
  /** Values for `describePlatform(document).parameters`. */
  constants: Record<string, string>;
  transport: Transport;
  /** Optional storage hook for original data-read responses. */
  storeResponse?: StoreReadResponse;
  selection?: QuerySelection;
  limits?: Partial<ReadLimits>;
  /** Waits out a 429's `Retry-After`; defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Make one request to the first root collection, read nothing, return an empty result. */
  probe?: boolean;
  /** The range for collections read by range windows; see `CollectionReadOptions.ranges`. */
  ranges?: NonNullable<CollectionReadOptions['ranges']>;
}

export interface ReadRecord {
  /** `ontologyShortname` of the `crudResources` key. */
  resource: string;
  /** The collection's path-variable values joined by `/`; `''` for a root collection. */
  namespace: string;
  /** `String(item[idField])`. */
  id: string;
  /** The first non-empty string of `title`, `summary`, `name`; else `id`. */
  name: string;
  /**
   * Values keyed by property shortname, for fields the ontology knows only.
   * `date-time` strings become epoch milliseconds; null and absent fields
   * are left out; everything else is the provider's JSON value as-is.
   */
  values: Record<string, unknown>;
  /**
   * For a resource that declares `x-runtime-schema`: its user-defined
   * members, interpreted against the class of its describer (one of the
   * result's `describers`). `values` keeps the raw field as before.
   */
  runtime?: RuntimeMembers;
}

export interface ReadResult {
  platform: string;
  ontology: Ontology;
  records: ReadRecord[];
  /** Non-fatal per-collection failures, as `<collection>: <message>`. */
  errors: string[];
  /**
   * The describers read and the classes derived from them, when a resource
   * declares `x-runtime-schema` (Runtime Schemas 0.1.0-draft); absent
   * otherwise. These classes are per describer (one per Notion data
   * source), so they are not part of `ontology`, which the document alone
   * defines.
   */
  describers?: RuntimeDescriber[];
  /**
   * The entries of `errors` about describers that could not be read (the
   * last ones); present with `describers`.
   */
  describerErrors?: string[];
  /**
   * The collections read without an error but not completely, with why:
   * read by range windows, ended by a short page whose end is not
   * documented, or marked incomplete by the server (Pagination Schemes
   * 0.8.0 §4.4.6). Their records are in `records`, but an absent record
   * says nothing. Absent when every collection read completely.
   */
  incomplete?: {
    collection: string;
    context: Record<string, string>;
    reason: string;
  }[];
  /**
   * What each collection's query asked for (Filtering 0.2.0-draft
   * `x-time-zone`, with `selection` or `ranges`), as `SyncResult.coverage`
   * gives it: one entry per collection read with coverage, absent when
   * none had any; `context` holds the collection's own path parameters,
   * left out for a root collection. It describes the query, not the
   * records (see the README's `x-time-zone` section). Unlike `sync()`,
   * which throws when a collection fails, `readPlatform` reports coverage
   * for a failed collection too (its `spans` then null).
   */
  coverage?: CollectionCoverage[];
}

const TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i;

function typedValue(value: unknown, datatype: string): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (datatype === DATATYPES.timestamp) {
    if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
      throw new Error('Invalid provider timestamp');
    }
    return Date.parse(value);
  }
  return value;
}

/**
 * Walks every `crudResources` collection of `document` through `transport`
 * and returns the records plus the derived ontology. The records include
 * those of collections read without error but not completely (by range
 * windows, or ended by a short page whose end is not documented), which a
 * caller must not use to conclude that an absent record is gone;
 * `readCollections` reports that per snapshot (`complete`, `notComplete`). A collection whose
 * path variables come from a parent runs once per parent record, after the
 * parent. A failed collection becomes an entry in `errors` and the read
 * continues; a budget running out (`limits`) stops every collection but
 * keeps what was read. Throws when a root parameter is missing, or when
 * nothing was read and something failed.
 */
export async function readPlatform(
  document: OpenApiDocument,
  options: ReadOptions,
): Promise<ReadResult> {
  const doc = resolved(document);
  const ontology: Ontology = options.probe
    ? { description: '', terms: [] }
    : deriveOntology(doc);
  const properties = new Map<string, string>(
    ontology.terms
      .filter((t) => t.kind === 'property')
      .map((t) => [t.shortname, t.datatype]),
  );
  const records: ReadRecord[] = [];
  const byItem = new Map<Record<string, unknown>, ReadRecord>();
  const result = await readCollections(doc, {
    ...options,
    onRecord(value, collection, path): void {
      const values: Record<string, unknown> = {};
      for (const [field, raw] of Object.entries(value)) {
        const shortname = ontologyShortname(field);
        const datatype = properties.get(shortname);
        if (!datatype) continue;
        const typed = typedValue(raw, datatype);
        if (typed !== undefined) values[shortname] = typed;
      }
      const name = [value['title'], value['summary'], value['name']].find(
        (v): v is string => typeof v === 'string' && v !== '',
      );
      const id = asText(value[collection.idField]);
      const record: ReadRecord = {
        resource: ontologyShortname(collection.resource),
        namespace: collection.contextParams.map((p) => path[p] ?? '').join('/'),
        id,
        name: name ?? id,
        values,
      };
      records.push(record);
      byItem.set(value, record);
    },
  });
  if (!records.length && result.errors.length) {
    throw new Error(`Read incomplete: ${result.errors.join('; ')}`);
  }
  for (const snapshot of result.collections)
    snapshot.items.forEach((item, i) => {
      const record = byItem.get(item);
      const runtime = snapshot.runtimeMembers?.[i];
      if (record && runtime) record.runtime = runtime;
    });
  const incomplete = result.collections
    .filter((s) => s.notComplete !== undefined && s.error === undefined)
    .map((s) => ({
      collection: s.collection.name,
      context: { ...s.pathParams },
      reason: s.notComplete as string,
    }));
  // The context as sync() gives it: the collection's own path parameters,
  // not every constant, and none for a root collection.
  const coverage = result.collections.flatMap((s): CollectionCoverage[] => {
    if (!s.coverage) return [];
    const context = Object.fromEntries(
      s.collection.contextParams.map((p) => [p, s.pathParams[p] as string]),
    );
    return [
      {
        collection: s.collection.name,
        ...(Object.keys(context).length ? { context } : {}),
        ...s.coverage,
      },
    ];
  });
  return {
    platform: options.platform,
    ontology,
    records,
    errors: result.errors,
    ...(incomplete.length ? { incomplete } : {}),
    ...(coverage.length ? { coverage } : {}),
    ...(result.describers ? { describers: result.describers } : {}),
    ...(result.describerErrors
      ? { describerErrors: result.describerErrors }
      : {}),
  };
}

export interface PaginateOptions {
  transport: Transport;
  /** Optional storage hook for original data-read responses. */
  storeResponse?: StoreReadResponse;
  /**
   * Dot-path to the items array in each page body, `''` for the body root
   * (an Envelope Object's `itemsField`). Without it, the scheme's own
   * `response.envelope` applies, else the array is located.
   */
  itemsField?: string;
  /**
   * With `itemsField`: a body without that field is a page with no items
   * (an Envelope Object's `emptyWhenAbsent`, Pagination Schemes 0.7.0).
   */
  emptyWhenAbsent?: boolean;
  /** A path template from `document.paths`, e.g. `/v1/search`. */
  path: string;
  /** Default `GET`. */
  method?: ListMethod;
  pathParams?: Record<string, string>;
  /** Fixed query parameters; the page cursor is added per request. */
  query?: Record<string, string>;
  /** Fixed JSON body fields for a POST; the page cursor is merged in per request. */
  body?: Record<string, unknown>;
  /** Sent through the scheme's `pageSize`-role field, when it declares one. */
  pageSize?: number;
  /**
   * The range to read when the operation applies a `rangeWindow` scheme
   * (Pagination Schemes 0.5.0 §4.6), both bounds in its window format.
   */
  range?: WindowRange;
  /**
   * The item field that identifies an item. Default `id`. A windowed read
   * keeps an item two windows return once. An offset read (Pagination
   * Schemes 0.7.0 §4.3.2) and a page-number read with `shortPage` (0.6.0
   * §4.4.5) end with `PageReadError` at a page holding an id an earlier
   * page returned, so the field must be unique across the list's pages;
   * two items sharing an id on one page are not checked. An item without
   * the field is kept as is (a page of items without it is compared with
   * the page before instead).
   */
  idField?: string;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Filled in when the walk ends: `complete` is false for a read that
   * returned every page but is not complete (range windows, an
   * undocumented short-page end, a response the scheme's
   * `response.incomplete` marks), with `reason`.
   */
  outcome?: WalkOutcome;
}

/**
 * Every item of one list operation, across all its pages. Needs no
 * `crudResources`; the operation's pagination scheme comes from
 * `x-pagination` or auto-detection. Raw provider items, untyped. Throws on
 * the first failed request or when a `limits` budget runs out.
 */
export async function paginate(
  document: OpenApiDocument,
  options: PaginateOptions,
): Promise<Record<string, unknown>[]> {
  const doc = resolved(document);
  const method = options.method ?? 'GET';
  const operation = listOperation(doc, options.path, method);
  if (!operation) {
    throw new Error(`${options.path} declares no ${method} operation`);
  }
  const budget = new Budget(
    captureReadResponses(options.transport, options.storeResponse),
    options.limits,
    options.sleep,
    declaredThrottling(doc),
  );
  const items: Record<string, unknown>[] = [];
  for await (const page of walkPages({
    document: doc,
    operation,
    budget,
    upstream: upstreamOf(doc),
    path: bindPath(options.path, options.pathParams ?? {}),
    method,
    query: options.query ?? {},
    body: options.body ?? {},
    ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    ...(options.itemsField === undefined
      ? {}
      : { itemsField: options.itemsField }),
    ...(options.itemsField !== undefined && options.emptyWhenAbsent
      ? { emptyWhenAbsent: true }
      : {}),
    ...(options.range ? { range: options.range } : {}),
    ...(options.outcome ? { outcome: options.outcome } : {}),
    identity: (item) => asText(item[options.idField ?? 'id']),
  })) {
    items.push(...page.items);
    if (items.length > budget.limits.maxRecords) {
      throw new BudgetExhausted(
        `Read exceeds ${budget.limits.maxRecords} records; narrow its scope`,
      );
    }
  }
  return items;
}
