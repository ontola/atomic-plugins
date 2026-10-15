import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import {
  invalidAutoDetected,
  resolveEffectiveScheme,
} from '../pagination/autodetect.js';
import { locateItemsField } from '../pagination/items.js';
import { resolveLink } from '../pagination/links.js';
import {
  classifyThrottling,
  type ThrottlingDeclaration,
} from '../throttling/throttling.js';
import {
  buildBody,
  buildQuery,
  nextCursor,
  pageStart,
  type PageCursor,
} from '../pagination/request-builder.js';
import {
  parsePaginationState,
  readNestedField,
  setNestedField,
  splitPath,
} from '../pagination/response-parser.js';
import type {
  IncompleteObject,
  PaginationResponseState,
  PaginationSchemeObject,
} from '../pagination/types.js';
import {
  halves,
  parseBound,
  WindowReadError,
  windowFields,
  windowRequest,
  windowWidth,
} from '../pagination/window.js';
import { isRecord } from './model.js';
import {
  lowerCaseHeaders,
  type ListMethod,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './transport.js';

export interface ReadLimits {
  /** Requests across the whole read, including retries. */
  maxRequests: number;
  /** Records across the whole read; more stops with an error. */
  maxRecords: number;
  /** Wall-clock budget for the whole read, in milliseconds. */
  timeoutMs: number;
  /** Retries per throttled request (a 429, or a declared throttling signal), each after the earliest retry time. */
  maxRetries: number;
}

export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxRequests: 10000,
  maxRecords: 5000,
  timeoutMs: 30 * 60 * 1000,
  maxRetries: 3,
};

/** A whole-read budget ran out: stop every collection, keep what was read. */
export class BudgetExhausted extends Error {}

/** A 429's `Retry-After` reaches past the read's deadline. */
export class RetryBeyondDeadline extends Error {}

/**
 * A page-number read that ended with an error (Pagination Schemes 0.6.0
 * §4.4.5 step 3): a page with more items than the declared full size, or a
 * page that repeats the one before it. The read is not complete.
 */
export class PageReadError extends Error {}

/** A page answered a non-2xx status; carries the status and the body text. */
export class PageStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wraps a transport with the whole-read budget: a request count, a
 * deadline, and bounded retries of throttled requests (a 429, or a response
 * that matches a signal of the document's `x-throttling`, draft Throttling
 * extension) that wait until the earliest retry time the response gives
 * (`Retry-After`, or the declared `retryAfter`/`reset` headers). A
 * throttled response without a usable time is returned as-is.
 */
export class Budget {
  readonly limits: ReadLimits;
  private readonly deadline: number;
  private requests = 0;

  constructor(
    private readonly transport: Transport,
    limits: Partial<ReadLimits> = {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
    private readonly throttling?: ThrottlingDeclaration,
  ) {
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.timeoutMs;
  }

  /** Milliseconds left before the read's deadline; 0 once past it. */
  remainingMs(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    for (let retries = 0; ; retries += 1) {
      if (Date.now() > this.deadline) {
        throw new BudgetExhausted('Read timed out');
      }
      this.requests += 1;
      if (this.requests > this.limits.maxRequests) {
        throw new BudgetExhausted(
          `Read exceeds ${this.limits.maxRequests} requests; narrow its scope`,
        );
      }
      const raw = await this.transport(request);
      const receivedAt = Date.now();
      const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
      if (retries >= this.limits.maxRetries) {
        return response;
      }
      const throttled = classifyThrottling(this.throttling, {
        status: response.status,
        headers: response.headers,
        body: response.body,
        receivedAt,
      });
      if (!throttled || throttled.retryAt === undefined) {
        return response;
      }
      // Never earlier than the response asks (the spec's MUST); a read
      // that cannot wait that long stops instead.
      const delay = Math.max(0, throttled.retryAt - Date.now());
      if (Date.now() + delay > this.deadline) {
        throw new RetryBeyondDeadline(
          'API retry delay exceeds the remaining read time',
        );
      }
      await this.sleep(delay);
    }
  }
}

const COMMON_ITEMS_FIELDS = ['items', 'data', 'results', 'records', 'content'];

/**
 * The items of one page: a top-level array body, else the array property
 * `locateItemsField` finds in the response schema, else a common envelope
 * name (`items`, `data`, `results`, ...) that holds an array in the body.
 */
export function pageItems(
  body: unknown,
  responseSchema: SchemaObject | undefined,
  scheme: PaginationSchemeObject | undefined,
): Record<string, unknown>[] {
  let array: unknown;
  if (Array.isArray(body)) {
    array = body;
  } else if (isRecord(body)) {
    const field =
      locateItemsField(responseSchema, scheme) ??
      COMMON_ITEMS_FIELDS.find((name) => Array.isArray(body[name]));
    array = field === undefined ? undefined : body[field];
  }
  if (!Array.isArray(array)) {
    throw new Error('Could not locate the items array in the response');
  }
  return array.filter(isRecord);
}

/**
 * The caller's envelope (a Collection Object's), else the scheme's own
 * (Pagination Schemes §4.4.2; `null` means the body root), with its
 * `emptyWhenAbsent` (0.7.0); undefined when neither declares one and the
 * array is located.
 */
function declaredEnvelope(
  walk: PageWalk,
  scheme: PaginationSchemeObject | undefined,
): { path: string; emptyWhenAbsent: boolean } | undefined {
  if (walk.itemsField !== undefined)
    return {
      path: walk.itemsField,
      emptyWhenAbsent: walk.emptyWhenAbsent === true,
    };
  const schemeEnvelope = scheme?.response?.envelope;
  if (schemeEnvelope === undefined) return undefined;
  return typeof schemeEnvelope.itemsField === 'string'
    ? {
        path: schemeEnvelope.itemsField,
        emptyWhenAbsent: schemeEnvelope.emptyWhenAbsent === true,
      }
    : { path: '', emptyWhenAbsent: false };
}

/**
 * The value of the scheme's response body field with `role`, when it is an
 * integer of at least `min` as the body carries it (spec 0.7.0 §4.3.2).
 */
function integerRole(
  scheme: PaginationSchemeObject,
  body: unknown,
  role: string,
  min: number,
): number | undefined {
  if (!isRecord(body)) return undefined;
  for (const [name, field] of Object.entries(
    scheme.response?.bodyFields ?? {},
  )) {
    if (field.role !== role) continue;
    const value = readNestedField(body, name);
    if (typeof value === 'number' && Number.isInteger(value) && value >= min)
      return value;
    return undefined;
  }
  return undefined;
}

/** Whether the scheme's response declares a field (body or header) with `role`. */
function declaresRole(scheme: PaginationSchemeObject, role: string): boolean {
  return [
    ...Object.values(scheme.response?.bodyFields ?? {}),
    ...Object.values(scheme.response?.headers ?? {}),
  ].some((field) => field.role === role);
}

/** The `advance` of the scheme's offset field (spec 0.7.0 §4.3.2), if any. */
function offsetAdvance(
  scheme: PaginationSchemeObject,
): 'itemCount' | 'pageSize' | undefined {
  for (const location of ['queryParameters', 'bodyFields'] as const)
    for (const field of Object.values(scheme.request?.[location] ?? {}))
      if (field.role === 'offset')
        return field.advance === 'pageSize' ? 'pageSize' : 'itemCount';
  return undefined;
}

/**
 * Whether the field at a dot-path is absent (Pagination Schemes 0.7.0
 * §4.4.2): the body is an object and some object along the path lacks the
 * next segment. A present `null`, or a value along the way that is not an
 * object, is not absent.
 */
function isAbsent(body: unknown, path: string): boolean {
  let node: unknown = body;
  for (const segment of splitPath(path)) {
    if (!isRecord(node)) return false;
    if (!Object.prototype.hasOwnProperty.call(node, segment)) return true;
    node = node[segment];
  }
  return false;
}

/**
 * The array at a dot-path of the body (`''`: the body). An item that is not
 * an object is an error, so an array of strings never reads as empty
 * (#384); a feed read (`skipNonObjects`) skips such items instead, as its
 * documentation says.
 */
function itemsAt(
  body: unknown,
  path: string,
  skipNonObjects = false,
  emptyWhenAbsent = false,
): Record<string, unknown>[] {
  // Pagination Schemes 0.7.0: only a declared envelope makes an absent
  // field an empty page; a mistyped itemsField must not read as empty.
  if (emptyWhenAbsent && path !== '' && isAbsent(body, path)) return [];
  const array =
    path === ''
      ? body
      : isRecord(body)
        ? readNestedField(body, path)
        : undefined;
  const where = path
    ? `${path} (the declared envelope.itemsField)`
    : 'the body root';
  if (!Array.isArray(array)) {
    throw new Error(`No items array at ${where}`);
  }
  if (skipNonObjects) return array.filter(isRecord);
  const odd = array.findIndex((item) => !isRecord(item));
  if (odd !== -1) {
    throw new Error(`Item ${odd} at ${where} is not an object`);
  }
  return array as Record<string, unknown>[];
}

/**
 * The documented `default` and `maximum` of the parameter (or JSON body
 * property) that a scheme's `pageSize` field names, when they are integers.
 */
function pageSizeLimits(
  document: OpenApiDocument,
  scheme: PaginationSchemeObject,
  operation: OperationObject,
): { default?: number; maximum?: number } {
  const deref = <T>(value: T): T => {
    let current: unknown = value;
    for (let hops = 0; hops < 8 && isRecord(current); hops += 1) {
      const ref = current['$ref'];
      if (typeof ref !== 'string' || !ref.startsWith('#/')) break;
      let node: unknown = document;
      for (const raw of ref.slice(2).split('/'))
        node = isRecord(node)
          ? node[raw.replace(/~1/g, '/').replace(/~0/g, '~')]
          : undefined;
      current = node;
    }
    return current as T;
  };
  const schemas: (SchemaObject | undefined)[] = [];
  for (const [name, field] of Object.entries(
    scheme.request?.queryParameters ?? {},
  )) {
    if (field.role !== 'pageSize') continue;
    schemas.push(
      deref(
        (Array.isArray(operation.parameters) ? operation.parameters : [])
          .map((p) => deref(p))
          .find((p) => p?.in === 'query' && p.name === name)?.schema,
      ),
    );
  }
  const body = deref(
    operation.requestBody?.content?.['application/json']?.schema,
  );
  for (const [name, field] of Object.entries(
    scheme.request?.bodyFields ?? {},
  )) {
    if (field.role === 'pageSize')
      schemas.push(deref(body?.properties?.[name]));
  }
  const integer = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1
      ? value
      : undefined;
  for (const schema of schemas) {
    if (!schema) continue;
    const limits: { default?: number; maximum?: number } = {};
    const fallback = integer(schema.default);
    const maximum = integer(schema.maximum);
    if (fallback !== undefined) limits.default = fallback;
    if (maximum !== undefined) limits.maximum = maximum;
    return limits;
  }
  return {};
}

/** Fills `{name}` path variables, percent-encoding each value. */
export function bindPath(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') {
      throw new Error(`Missing value for ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export interface PageWalk {
  document: OpenApiDocument;
  operation: OperationObject;
  budget: Budget;
  /** `servers[0].url`; every request stays on its origin. */
  upstream: URL;
  /** Path relative to `upstream`, variables already bound. */
  path: string;
  method: ListMethod;
  query: Record<string, string>;
  /** Fixed JSON body fields (POST only); the cursor is merged in per page. */
  body: Record<string, unknown>;
  pageSize?: number;
  /**
   * Dot-path to the items array in each body, `''` for the body itself.
   * Without it, the pagination scheme's own `response.envelope` applies,
   * and without that `pageItems` locates the array.
   */
  itemsField?: string;
  /**
   * With `itemsField`: a body in which that field is absent is a page with
   * no items (an Envelope Object's `emptyWhenAbsent`, Pagination Schemes
   * 0.7.0). Ignored without `itemsField`; the scheme's own envelope then
   * says.
   */
  emptyWhenAbsent?: boolean;
  /** Skip items that are not objects instead of failing the page (the deletion feed read). */
  skipNonObjects?: boolean;
  /**
   * The range a `rangeWindow` operation is read over (Pagination Schemes
   * 0.5.0 §4.6.3), both bounds in the window's format. Required for such an
   * operation, ignored for any other: which range to read is the caller's
   * choice.
   */
  range?: WindowRange;
  /**
   * An item's identity. A windowed read yields an item that a later window
   * returns again (its field changed during the read) once (§4.6.4 rule 3);
   * an offset read and a page-number read with `shortPage` end with
   * `PageReadError` at a page holding an identity an earlier page returned
   * (§4.3.2, §4.4.5).
   */
  identity?: (item: Record<string, unknown>) => string;
  /**
   * Set when the walk ends normally: `complete` is false for a read that
   * returned every page but is never complete in the Collection
   * Completeness sense (a windowed read, §4.6.4 rule 5), with `reason`.
   */
  outcome?: WalkOutcome;
  /**
   * Converts one window bound before it is sent in a query parameter that
   * carries the window (`parameter` is its name): the bounds are split as
   * instants, and a parameter the API reads as wall-clock time in a zone
   * (Filtering 0.2.0-draft `x-time-zone`) needs other digits. Applied to
   * each bound separately, before a `windowRange` template is filled; header
   * and body window fields are sent as they are. Returns the bound to send,
   * or `undefined` when it does not convert that parameter (the bound is
   * then sent as it is).
   */
  windowValue?: (parameter: string, bound: string) => string | undefined;
}

export interface WindowRange {
  start: string;
  end: string;
}

export interface WalkOutcome {
  complete: boolean;
  reason?: string;
  /**
   * Pagination Schemes 0.8.0 §4.4.6: set when a response of the walk was
   * marked incomplete by the scheme's `response.incomplete` (why, in words).
   */
  marked?: string;
}

const jsonEqual = (a: unknown, b: unknown): boolean =>
  typeof a === 'number' && typeof b === 'number'
    ? a === b
    : typeof a === typeof b && (a === b || (a === null && b === null));

/**
 * Pagination Schemes 0.8.0 §4.4.6, after the spec's `response_incomplete`:
 * whether a response body carries the Incomplete Object's value. The
 * dot-path's names are read literally (split on `.`, own properties of
 * objects only); the value equals `equals`, or one of `in`, by JSON
 * equality (`1` equals `1.0`; `"1"`, `true` and `1` differ). A body without
 * a value there, or with another value, is not marked.
 */
export function responseIncomplete(
  marker: IncompleteObject,
  body: unknown,
): boolean {
  let value: unknown = body;
  for (const name of marker.field.split('.')) {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !Object.hasOwn(value, name)
    )
      return false;
    value = (value as Record<string, unknown>)[name];
  }
  if ('equals' in marker) return jsonEqual(value, marker.equals);
  return marker.in.some((candidate) => jsonEqual(value, candidate));
}

export interface Page {
  url: URL;
  items: Record<string, unknown>[];
  /** The parsed response body. */
  body: unknown;
}

function withBody(
  body: Record<string, unknown>,
  cursorFields: Record<string, unknown>,
): Record<string, unknown> {
  const merged = structuredClone(body);
  const flat: [string, unknown][] = [];
  const collect = (node: Record<string, unknown>, prefix: string): void => {
    for (const [key, value] of Object.entries(node)) {
      if (isRecord(value)) {
        collect(value, `${prefix}${key}.`);
      } else {
        flat.push([`${prefix}${key}`, value]);
      }
    }
  };
  collect(cursorFields, '');
  for (const [path, value] of flat) {
    setNestedField(merged, path, value);
  }
  return merged;
}

/**
 * Walks every page of one list operation through its resolved pagination
 * scheme (explicit `x-pagination`, else auto-detected): page numbers or
 * offsets, page tokens/cursors (in the query or, for a POST, the JSON
 * body), and next links (in the body or an RFC 8288 `Link` header). With
 * no scheme it makes one request. Yields each page's items as it arrives,
 * so a caller that stops early (a cap) keeps what was already read.
 *
 * Stops with an error when a page repeats (a proxy that drops the cursor
 * would otherwise loop until the request budget runs out), when a next
 * link leaves the upstream origin or carries credentials or a fragment, on
 * a non-2xx status, or on a non-JSON body.
 */
export async function* walkPages(walk: PageWalk): AsyncGenerator<Page> {
  // Not complete until the walk ends normally: a throw, or a caller that
  // stops early, leaves `complete: false`.
  const outcome = walk.outcome;
  if (outcome) {
    outcome.complete = false;
    delete outcome.reason;
    // An outcome passed again: an earlier walk's mark is not this one's.
    delete outcome.marked;
  }
  const result: WalkOutcome = { complete: true };
  yield* walkAllPages({ ...walk, outcome: result });
  // §4.4.6: a marked response makes the read not complete; paging itself
  // went on as the scheme says.
  if (result.marked !== undefined && result.complete) {
    result.complete = false;
    result.reason = result.marked;
  }
  if (outcome) {
    outcome.complete = result.complete;
    if (result.reason !== undefined) outcome.reason = result.reason;
    if (result.marked !== undefined) outcome.marked = result.marked;
  }
}

async function* walkAllPages(walk: PageWalk): AsyncGenerator<Page> {
  const { document, operation, budget, upstream } = walk;
  const effective = resolveEffectiveScheme(document, operation);
  const scheme = effective?.scheme;
  const responseSchema =
    operation.responses?.['200']?.content?.['application/json']?.schema;
  const basePath = upstream.pathname.replace(/\/$/, '');
  if (scheme?.type === 'rangeWindow') {
    yield* walkWindows(walk, scheme, responseSchema);
    return;
  }
  const itemCursor = scheme ? itemCursorField(scheme) : undefined;
  if (scheme && itemCursor) {
    yield* walkItemCursor(walk, scheme, itemCursor, responseSchema);
    return;
  }
  const seen = new Set<string>();
  let cursor: PageCursor = {};
  let next: URL | undefined;
  let itemsSoFar = 0;
  // Pagination Schemes 0.6.0 §4.4.5: a page with fewer than `size` items
  // ends a pageNumber list.
  const short =
    scheme?.type === 'pageNumber' ? scheme.response?.shortPage : undefined;
  // The page size sent: the caller's, capped at the pageSize parameter's
  // documented maximum (a server caps a larger one, and a short page would
  // then end the list early); else, for a shortPage that takes the size
  // sent, the parameter's documented default, sent explicitly.
  const limits = scheme ? pageSizeLimits(document, scheme, operation) : {};
  let pageSize = walk.pageSize;
  if (pageSize !== undefined && limits.maximum !== undefined)
    pageSize = Math.min(pageSize, limits.maximum);
  if (pageSize === undefined && short?.size === 'request')
    pageSize =
      limits.default !== undefined && limits.maximum !== undefined
        ? Math.min(limits.default, limits.maximum)
        : limits.default;
  // The full size (spec 0.6.0 §4.4.5): `size`, or the page size sent when
  // it is smaller, so that a smaller page does not look short. A page size
  // is only sent through a pageSize field; without one it changes nothing.
  // A GET walk sends no body, so a body field only counts on a POST walk.
  const pageSizeLocations =
    walk.method === 'POST'
      ? (['queryParameters', 'bodyFields'] as const)
      : (['queryParameters'] as const);
  const sendsPageSize = Boolean(
    scheme &&
      pageSizeLocations.some((location) =>
        Object.values(scheme.request?.[location] ?? {}).some(
          (field) => field.role === 'pageSize',
        ),
      ),
  );
  const shortSize =
    short?.size === 'request'
      ? pageSize
      : short && pageSize !== undefined && sendsPageSize
        ? Math.min(short.size, pageSize)
        : short?.size;
  if (short && shortSize === undefined) {
    throw new PageReadError(
      'The shortPage size of the scheme is the page size the client sends, and its pageSize parameter documents no default; pass pageSize',
    );
  }
  let previousPage: string | undefined;
  const seenIds = new Set<string>();
  const first = scheme ? pageStart(scheme) : 1;

  for (;;) {
    let url = next;
    if (!url) {
      url = new URL(upstream.href);
      url.pathname = basePath + walk.path;
      const query = {
        ...walk.query,
        ...(scheme ? buildQuery(scheme, cursor, pageSize) : {}),
      };
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const request: TransportRequest = {
      url,
      method: walk.method,
      headers: { accept: 'application/json' },
    };
    if (walk.method === 'POST') {
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify(
        next || !scheme
          ? walk.body
          : withBody(walk.body, buildBody(scheme, cursor, pageSize)),
      );
    }

    const key = `${request.method} ${url.href} ${request.body ?? ''}`;
    if (seen.has(key)) {
      throw new Error('Pagination repeated a page; stopping');
    }
    seen.add(key);

    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new PageStatusError(
        `${request.method} ${url.pathname} responded ${response.status} (failed with status ${response.status})`,
        response.status,
        response.body,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const marker = scheme?.response?.incomplete;
    if (
      marker &&
      walk.outcome &&
      walk.outcome.marked === undefined &&
      responseIncomplete(marker, body)
    )
      walk.outcome.marked = `the server marked the result incomplete (${request.method} ${url.pathname}: ${marker.field} ${JSON.stringify('equals' in marker ? marker.equals : marker.in)}): not a complete read (Pagination Schemes 0.8.0 §4.4.6)`;

    const envelope = declaredEnvelope(walk, scheme);
    const items =
      envelope === undefined
        ? pageItems(body, responseSchema, scheme)
        : itemsAt(
            body,
            envelope.path,
            walk.skipNonObjects,
            envelope.emptyWhenAbsent,
          );
    // Pagination Schemes 0.6.0 §4.4.5: checked before the page is handed
    // on, so that its items are not taken.
    const number = cursor.page ?? first;
    let shortState: PaginationResponseState | undefined;
    let full = shortSize ?? 0;
    if (scheme && short && shortSize !== undefined) {
      shortState = parsePaginationState(
        scheme,
        isRecord(body) ? body : {},
        response.headers,
        itemsSoFar + items.length,
      );
      // A pageSize-role field reports the size the server applied.
      if (shortState.pageSize !== null && shortState.pageSize >= 1)
        full = shortState.pageSize;
      if (items.length > full) {
        throw new PageReadError(
          `Page ${number} holds ${items.length} items, more than the declared ${full}; the read is not complete`,
        );
      }
    }
    // §4.4.5, and §4.3.2 (0.7.0) for every offset read: a page holding an
    // item an earlier page returned ends the read, so a server that ignores
    // the page or offset field is not asked again without end.
    if (
      scheme &&
      ((short && shortSize !== undefined) ||
        (scheme.type === 'pageNumber' && offsetAdvance(scheme) !== undefined))
    ) {
      const where =
        cursor.offset !== undefined || offsetAdvance(scheme) !== undefined
          ? `The page at offset ${cursor.offset ?? 0}`
          : `Page ${number}`;
      const identity = walk.identity;
      const ids = identity
        ? items.map((item) => identity(item)).filter((id) => id)
        : [];
      // Items without an identity value fall back to the page fingerprint.
      if (ids.length > 0) {
        if (ids.some((id) => seenIds.has(id))) {
          throw new PageReadError(
            `${where} holds an item an earlier page returned; the read is not complete`,
          );
        }
        for (const id of ids) seenIds.add(id);
      } else {
        const fingerprint = JSON.stringify(items);
        if (items.length > 0 && fingerprint === previousPage) {
          throw new PageReadError(
            `${where} repeats the page before it; the read is not complete`,
          );
        }
        previousPage = fingerprint;
      }
    }
    itemsSoFar += items.length;
    yield { url, items, body };

    if (!scheme) {
      // A scheme that would have been auto-detected but is invalid: the
      // operation presumably pages, so this one page is not the whole
      // collection. Its items stand; nothing is concluded from absence.
      const invalid = invalidAutoDetected(document, operation);
      if (invalid && walk.outcome) {
        walk.outcome.complete = false;
        walk.outcome.reason = `the pagination scheme "${invalid.schemeName}" matches this operation by auto-detection but is invalid (${invalid.problems.join('; ')}), so only its first response was read: not a complete read`;
      }
      return;
    }
    const state =
      shortState ??
      parsePaginationState(
        scheme,
        isRecord(body) ? body : {},
        response.headers,
        itemsSoFar,
      );
    // A link the response carried, whatever its type: `resolveLink` decides
    // whether it is followed, so a value that is not a string is refused
    // rather than taken as the last page.
    const linkPresent =
      state.nextLinkValue !== undefined &&
      state.nextLinkValue !== null &&
      state.nextLinkValue !== '';
    if (short && shortSize !== undefined) {
      // totalPages is a count: with start s the last page is s + totalPages - 1.
      const last =
        state.totalPages !== null ? first + state.totalPages - 1 : null;
      const ended =
        (last !== null && number >= last) ||
        (state.totalCount !== null && itemsSoFar >= state.totalCount);
      const more =
        (last !== null && number < last) ||
        (state.totalCount !== null && itemsSoFar < state.totalCount);
      if (items.length < full) {
        if (more && short.assurance === 'documented') {
          throw new PageReadError(
            `Page ${number} is short, but the response says more pages follow; the read is not complete`,
          );
        }
        if (
          walk.outcome &&
          (more || (!ended && short.assurance !== 'documented'))
        ) {
          walk.outcome.complete = false;
          walk.outcome.reason = more
            ? `ended by a short page while the response says more pages follow: not a complete read (Pagination Schemes 0.6.0 §4.4.5)`
            : `ended by a short page whose end is ${short.assurance}, not documented: not a complete read (Pagination Schemes 0.6.0 §4.4.5)`;
        }
        return;
      }
      // A full page: a totalPages or totalCount end is complete, whatever
      // the assurance; else the next page number, unless a link leads on.
      if (ended) return;
      if (!linkPresent) {
        cursor = { page: number + 1 };
        next = undefined;
        continue;
      }
    }
    // Pagination Schemes 0.7.0 §4.3.2: an offset that advances by the page
    // size (a reported pageSize field, else the size sent) ends only at
    // totalCount; a short or empty page before that does not end the list.
    // A scheme that also declares a next link is led by it (0.7.1): an
    // absent or null link ends the read below, never a step from an offset
    // that was not advanced while links were followed.
    if (
      scheme.type === 'pageNumber' &&
      !linkPresent &&
      offsetAdvance(scheme) === 'pageSize' &&
      !declaresRole(scheme, 'nextLink')
    ) {
      // §4.3.2: a reported page size counts as an integer of at least 1,
      // a totalCount as an integer of at least 0; read per response, as
      // sent (a string or a fraction is not carried).
      const reported = integerRole(scheme, body, 'pageSize', 1);
      const totalCount = integerRole(scheme, body, 'totalCount', 0);
      const sent =
        sendsPageSize && Number.isInteger(pageSize) && (pageSize ?? 0) >= 1
          ? pageSize
          : undefined;
      const step = reported ?? sent;
      const offset = cursor.offset ?? 0;
      if (step === undefined) {
        throw new PageReadError(
          `The page at offset ${offset} gives no page size to advance by; the read is not complete`,
        );
      }
      const following = offset + step;
      if (
        totalCount !== undefined ? following >= totalCount : items.length === 0
      ) {
        return;
      }
      cursor = { offset: following };
      next = undefined;
      continue;
    }
    // §4.3.2 `itemCount` (the default advance): the next offset adds the
    // items the page held, and the list ends at the first empty page or,
    // when the response carries a totalCount, once the next offset reaches
    // it. Without a totalCount a full or short page does not end it (#495:
    // such a read used to stop after one page, short and unreported); the
    // repeat check above ends a read whose server ignores the offset. A
    // scheme that also declares a next link (Spotify's `next`) is led by
    // it: a link that is absent or `null` is the last page (0.7.1 §4.3.2).
    if (
      scheme.type === 'pageNumber' &&
      !linkPresent &&
      offsetAdvance(scheme) === 'itemCount' &&
      !declaresRole(scheme, 'nextLink')
    ) {
      const totalCount = integerRole(scheme, body, 'totalCount', 0);
      const following = (cursor.offset ?? 0) + items.length;
      if (
        items.length === 0 ||
        (totalCount !== undefined && following >= totalCount)
      ) {
        return;
      }
      cursor = { offset: following };
      next = undefined;
      continue;
    }
    // 0.7.1 §4.3.2: in an offset scheme that declares a next link, an
    // absent, null or empty link ends the read under either advance. When
    // the last response's totalCount exceeds the items read, the read ends
    // there but is not complete.
    if (
      !linkPresent &&
      scheme.type === 'pageNumber' &&
      offsetAdvance(scheme) !== undefined &&
      declaresRole(scheme, 'nextLink')
    ) {
      const totalCount = integerRole(scheme, body, 'totalCount', 0);
      if (walk.outcome && totalCount !== undefined && totalCount > itemsSoFar) {
        walk.outcome.complete = false;
        walk.outcome.reason = `ended by a response without a next link while its totalCount (${totalCount}) exceeds the ${itemsSoFar} items read: not a complete read (Pagination Schemes 0.7.1 §4.3.2)`;
      }
      return;
    }
    if (!state.hasNextPage && !linkPresent) {
      return;
    }

    if (
      scheme.type === 'nextLink' ||
      (linkPresent && state.nextPageToken === null)
    ) {
      // Pagination Schemes 0.4.0 §4.4.3–§4.4.4: resolved against the
      // request URL, the server URL or a declared base, then checked (the
      // server's origin only, no userinfo or fragment). A refused link
      // throws `LinkRefused`: the read ends with an error, never as the
      // last page. The URL requested is exactly the checked object.
      const link = resolveLink(state.nextLinkValue, {
        requestUrl: url,
        serverUrl: upstream,
        resolution: state.nextLinkResolution,
      });
      if (link === null) {
        return;
      }
      next = link;
    } else {
      if (scheme.type === 'pageNumber' && items.length === 0) {
        return;
      }
      const following = nextCursor(scheme, cursor, state, items.length);
      if (!following) {
        return;
      }
      cursor = following;
      next = undefined;
    }
  }
}

/** The request field a scheme reads from the last item (0.9.0 §4.3.3), if any. */
function itemCursorField(
  scheme: PaginationSchemeObject,
): { location: string; name: string; path: string } | undefined {
  for (const location of [
    'queryParameters',
    'bodyFields',
    'headerFields',
  ] as const)
    for (const [name, field] of Object.entries(
      scheme.request?.[location] ?? {},
    ))
      if (typeof field.fromLastItem === 'string')
        return { location, name, path: field.fromLastItem };
  return undefined;
}

/**
 * Pagination Schemes 0.9.0 §4.3.3, after the spec's `read_item_cursor`: a
 * cursor read from the previous page's last item (Stripe's
 * `starting_after`, Discord's `after`). The first request goes without the
 * field; the read ends at an empty page or at `hasMore: false`, complete
 * unless a response of the read was marked (§4.4.6; the mark is kept
 * across pages on `outcome.marked`). Otherwise the next request sends the
 * value at `fromLastItem` in the last item, in that field only (never in
 * another `pageToken`- or `cursor`-role field, which rule 28 allows): a
 * string as it is, a safe integer in decimal. `PageReadError` ends the
 * read, not complete, when that value is missing or neither a string nor
 * a safe integer (`Number.isSafeInteger`), when it equals the one
 * sent for this page, when a page holds an item an earlier page returned
 * (`identity`, else the whole item), when an empty page says `hasMore:
 * true`, and when `hasMore` is present and not a boolean (stricter than
 * the 0.9.0 reference, which lets a non-boolean decide nothing; 0.9.1
 * makes `null` an error too, so only an absent `hasMore` is no
 * information). A short page does not end it.
 */
async function* walkItemCursor(
  walk: PageWalk,
  scheme: PaginationSchemeObject,
  field: { location: string; name: string; path: string },
  responseSchema: SchemaObject | undefined,
): AsyncGenerator<Page> {
  const { document, operation, budget, upstream } = walk;
  if (
    field.location === 'headerFields' ||
    (field.location === 'bodyFields' && walk.method !== 'POST')
  )
    throw new PageReadError(
      `The cursor field ${field.name} is a ${field.location === 'headerFields' ? 'request header' : 'body field of a request without a body'}, which this client does not send; the read is not complete`,
    );
  const limits = pageSizeLimits(document, scheme, operation);
  let pageSize = walk.pageSize;
  if (pageSize !== undefined && limits.maximum !== undefined)
    pageSize = Math.min(pageSize, limits.maximum);
  const hasMoreField = Object.entries(scheme.response?.bodyFields ?? {}).find(
    ([, f]) => f.role === 'hasMore',
  )?.[0];
  const basePath = upstream.pathname.replace(/\/$/, '');
  const seenItems = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    // The page size, but no token: buildQuery and buildBody would write a
    // token into every pageToken- or cursor-role field, and rule 28 allows
    // another one (an `ending_before` beside `starting_after`), which would
    // then bound the read from the other side and end it early, as if
    // complete. Only the fromLastItem field carries the cursor, as in the
    // spec's read_item_cursor.
    const page: PageCursor = {};
    const url = new URL(upstream.href);
    url.pathname = basePath + walk.path;
    for (const [key, value] of Object.entries({
      ...walk.query,
      ...buildQuery(scheme, page, pageSize),
    }))
      url.searchParams.set(key, value);
    if (cursor !== undefined && field.location === 'queryParameters')
      url.searchParams.set(field.name, cursor);
    const request: TransportRequest = {
      url,
      method: walk.method,
      headers: { accept: 'application/json' },
    };
    if (walk.method === 'POST') {
      request.headers['content-type'] = 'application/json';
      const fields = buildBody(scheme, page, pageSize);
      if (cursor !== undefined && field.location === 'bodyFields')
        setNestedField(fields, field.name, cursor);
      request.body = JSON.stringify(withBody(walk.body, fields));
    }
    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300)
      throw new PageStatusError(
        `${request.method} ${url.pathname} responded ${response.status} (failed with status ${response.status})`,
        response.status,
        response.body,
      );
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const marker = scheme.response?.incomplete;
    if (
      marker &&
      walk.outcome &&
      walk.outcome.marked === undefined &&
      responseIncomplete(marker, body)
    )
      walk.outcome.marked = `the server marked the result incomplete (${request.method} ${url.pathname}: ${marker.field} ${JSON.stringify('equals' in marker ? marker.equals : marker.in)}): not a complete read (Pagination Schemes 0.8.0 §4.4.6)`;
    const envelope = declaredEnvelope(walk, scheme);
    const items =
      envelope === undefined
        ? pageItems(body, responseSchema, scheme)
        : itemsAt(
            body,
            envelope.path,
            walk.skipNonObjects,
            envelope.emptyWhenAbsent,
          );
    const after =
      cursor === undefined
        ? 'the first page'
        : `the page after ${JSON.stringify(cursor)}`;
    for (const item of items) {
      const id = walk.identity?.(item);
      const key = id ? `id:${id}` : `item:${JSON.stringify(item)}`;
      if (seenItems.has(key))
        throw new PageReadError(
          `${after} holds an item an earlier page returned; the read is not complete`,
        );
      seenItems.add(key);
    }
    yield { url, items, body };
    let hasMore: unknown;
    if (hasMoreField !== undefined) {
      hasMore = isRecord(body) ? itemValue(body, hasMoreField) : undefined;
      if (hasMore !== undefined && typeof hasMore !== 'boolean')
        throw new PageReadError(
          `${after} has a ${hasMoreField} of ${JSON.stringify(hasMore)}, not a boolean; the read is not complete`,
        );
    }
    if (items.length === 0 && hasMore === true)
      throw new PageReadError(
        `${after} is empty but says hasMore true; the read is not complete`,
      );
    if (items.length === 0 || hasMore === false) return;
    const value = itemValue(items[items.length - 1], field.path);
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value)
    )
      // Past 2^53 the parsed number was already rounded, so it may not be
      // the id the API sent, and from 1e21 String() writes `1e+21`.
      throw new PageReadError(
        `the last item of ${after} has a ${field.path} of ${String(value)}, not a safe integer to continue from; the read is not complete`,
      );
    if (
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isSafeInteger(value))
    )
      throw new PageReadError(
        `the last item of ${after} has no usable ${field.path} to continue from; the read is not complete`,
      );
    const following = typeof value === 'number' ? String(value) : value;
    if (following === cursor)
      throw new PageReadError(
        `the cursor ${JSON.stringify(following)} did not move; the read is not complete`,
      );
    cursor = following;
  }
}

/** A dot-path's value in an object: own properties, names split on `.`. */
function itemValue(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const name of path.split('.'))
    current =
      isRecord(current) && Object.hasOwn(current, name)
        ? current[name]
        : undefined;
  return current;
}

/**
 * Applies `PageWalk.windowValue` to the query fields that carry a window.
 * The hook says, per parameter, whether it converts it: `undefined` sends
 * the bound as it is. Bounds on one clock must still be in order
 * (fixed-width digits compare as strings): two instants an hour apart in a
 * repeated hour convert to the same wall-clock digits, and a window inside
 * that hour would be sent inverted or empty. It cannot be sent, so the read
 * ends with `WindowReadError` and is not complete. Only two converted
 * bounds are compared, and the comparison assumes offset-free digits: the
 * hook returns wall-clock digits followed by one fixed suffix on every
 * bound (`2026-10-25T02:30:00Z`, where `Z` is the declared suffix, not the
 * instant's offset), which order as strings as their times do. Bounds that
 * each carry their own offset (`+02:00`, then `+01:00`) do not, and are
 * compared wrongly.
 *
 * Known limit: a start that is converted and an end that is not (or the
 * reverse) are on different clocks and are not compared, so a window whose
 * converted bound falls in a repeated hour can still be sent inverted when
 * the other bound targets a parameter without a zone. No provider in the
 * catalogs mixes the two on one window.
 */
function convertWindowQuery(
  scheme: PaginationSchemeObject,
  window: NonNullable<PaginationSchemeObject['window']>,
  low: string,
  high: string,
  convert: (parameter: string, bound: string) => string | undefined,
  values: { queryParameters: Record<string, string> },
): void {
  const fields = windowFields(scheme).filter(
    (field) => field.location === 'queryParameters',
  );
  const startField =
    fields.find((f) => f.role === 'windowStart') ??
    fields.find((f) => f.role === 'windowRange');
  const endField =
    fields.find((f) => f.role === 'windowEnd') ??
    fields.find((f) => f.role === 'windowRange');
  if (!startField && !endField) return;
  // Each bound is converted when its own field is in the query, so a start
  // in the query is converted even when the end is sent elsewhere.
  const convertedStart = startField ? convert(startField.name, low) : undefined;
  const convertedEnd = endField ? convert(endField.name, high) : undefined;
  const start = convertedStart ?? low;
  const end = convertedEnd ?? high;
  // Compared only when both bounds were converted, and only for the
  // fixed-width date formats, whose digits order as strings; bounds sent as
  // they are need no check (halves keeps them in order), and integer or
  // unixSeconds bounds do not order as strings.
  const comparable =
    convertedStart !== undefined &&
    convertedEnd !== undefined &&
    (window.format === 'dateTime' ||
      window.format === 'date' ||
      window.format === 'basicDate');
  const inOrder = window.bounds === 'closed' ? start <= end : start < end;
  if (comparable && !inOrder) {
    throw new WindowReadError(
      `The window ${low}..${high} converts to ${start}..${end} (inside a repeated hour of the parameter's time zone, say) and cannot be sent; the read is not complete`,
    );
  }
  for (const field of fields) {
    values.queryParameters[field.name] =
      field.role === 'windowStart'
        ? start
        : field.role === 'windowEnd'
          ? end
          : (field.template ?? '{start}..{end}')
              .replace('{start}', start)
              .replace('{end}', end);
  }
}

/**
 * A `rangeWindow` read (Pagination Schemes 0.5.0 §4.6.3): the whole range
 * first, then, for an answer with `cap` items or more (full, §4.6.4 rule 2),
 * its two halves, depth first and the first half first, down to windows
 * narrower than `2 × minimumWidth`. A full window that cannot be split
 * throws `WindowReadError`; the read is then not complete. The items of a
 * full answer are not yielded: they do not make the window complete, and
 * its halves return them. Every window sends the same fixed query, body
 * and headers; only the window fields change. An item an earlier window
 * returned is yielded once (`walk.identity`). The read is never complete in
 * the Collection Completeness sense (§4.6.4 rule 5): `walk.outcome` says so.
 */
async function* walkWindows(
  walk: PageWalk,
  scheme: PaginationSchemeObject,
  responseSchema: SchemaObject | undefined,
): AsyncGenerator<Page> {
  const window = scheme.window;
  if (!window) {
    throw new WindowReadError('A rangeWindow scheme needs a window');
  }
  if (!walk.range) {
    throw new WindowReadError(
      `${walk.path} is read by range windows; pass the range to read`,
    );
  }
  const { start, end } = walk.range;
  if (
    windowWidth(parseBound(start, window), parseBound(end, window), window) < 1
  ) {
    throw new WindowReadError(`The range ${start}..${end} is empty`);
  }
  const { budget, upstream } = walk;
  const basePath = upstream.pathname.replace(/\/$/, '');
  const yielded = new Set<string>();
  const pending: [string, string][] = [[start, end]];
  while (pending.length) {
    const [low, high] = pending.shift() as [string, string];
    const values = windowRequest(scheme, low, high);
    if (walk.windowValue) {
      convertWindowQuery(scheme, window, low, high, walk.windowValue, values);
    }
    const url = new URL(upstream.href);
    url.pathname = basePath + walk.path;
    for (const [key, value] of Object.entries({
      ...walk.query,
      ...values.queryParameters,
    })) {
      url.searchParams.set(key, value);
    }
    const request: TransportRequest = {
      url,
      method: walk.method,
      headers: { ...values.headerFields, accept: 'application/json' },
    };
    if (walk.method === 'POST') {
      request.headers['content-type'] = 'application/json';
      request.body = JSON.stringify(withBody(walk.body, values.bodyFields));
    }
    const response = await budget.send(request);
    if (response.status < 200 || response.status >= 300) {
      throw new PageStatusError(
        `${request.method} ${url.pathname} responded ${response.status} for the window ${low}..${high} (failed with status ${response.status})`,
        response.status,
        response.body,
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new Error(`${request.method} ${url.pathname} did not return JSON`);
    }
    const envelope = declaredEnvelope(walk, scheme);
    const items =
      envelope === undefined
        ? pageItems(body, responseSchema, scheme)
        : itemsAt(
            body,
            envelope.path,
            walk.skipNonObjects,
            envelope.emptyWhenAbsent,
          );
    if (items.length >= window.cap) {
      const split = halves(low, high, window);
      if (!split) {
        throw new WindowReadError(
          `The window ${low}..${high} answered ${items.length} items, at least the cap of ${window.cap}, and is too narrow to split; the read is not complete`,
        );
      }
      pending.unshift(...split);
      continue;
    }
    const fresh = walk.identity
      ? items.filter((item) => {
          const id = (walk.identity as (i: Record<string, unknown>) => string)(
            item,
          );
          // An item without an identity cannot be told apart: kept as is.
          if (id === '') return true;
          if (yielded.has(id)) return false;
          yielded.add(id);
          return true;
        })
      : items;
    yield { url, items: fresh, body };
  }
  if (walk.outcome) {
    walk.outcome.complete = false;
    walk.outcome.reason =
      'read by range windows: never a complete read (Pagination Schemes 0.5.0 §4.6.4)';
  }
}
