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
} from './pages.js';
import type { ListMethod, Transport } from './transport.js';
import { readCollections } from './collections.js';
import { captureReadResponses, type StoreReadResponse } from './responses.js';
import { declaredThrottling } from '../throttling/throttling.js';

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
}

export interface ReadResult {
  platform: string;
  ontology: Ontology;
  records: ReadRecord[];
  /** Non-fatal per-collection failures, as `<collection>: <message>`. */
  errors: string[];
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
 * and returns the records plus the derived ontology. A collection whose
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
      records.push({
        resource: ontologyShortname(collection.resource),
        namespace: collection.contextParams.map((p) => path[p] ?? '').join('/'),
        id,
        name: name ?? id,
        values,
      });
    },
  });
  if (!records.length && result.errors.length) {
    throw new Error(`Read incomplete: ${result.errors.join('; ')}`);
  }
  return {
    platform: options.platform,
    ontology,
    records,
    errors: result.errors,
  };
}

export interface PaginateOptions {
  transport: Transport;
  /** Optional storage hook for original data-read responses. */
  storeResponse?: StoreReadResponse;
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
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
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
