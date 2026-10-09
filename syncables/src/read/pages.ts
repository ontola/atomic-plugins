import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { locateItemsField } from '../pagination/items.js';
import { resolveLink } from '../pagination/links.js';
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
} from '../pagination/response-parser.js';
import type {
  PaginationResponseState,
  PaginationSchemeObject,
} from '../pagination/types.js';
import {
  halves,
  parseBound,
  WindowReadError,
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
  /** 429 retries per request, honouring `Retry-After`. */
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
 * deadline, and bounded 429 retries that wait out `Retry-After` (seconds or
 * an HTTP date). A 429 without a usable `Retry-After` is returned as-is.
 */
export class Budget {
  readonly limits: ReadLimits;
  private readonly deadline: number;
  private requests = 0;

  constructor(
    private readonly transport: Transport,
    limits: Partial<ReadLimits> = {},
    private readonly sleep: (ms: number) => Promise<void> = defaultSleep,
  ) {
    this.limits = { ...DEFAULT_READ_LIMITS, ...limits };
    this.deadline = Date.now() + this.limits.timeoutMs;
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
      const response = { ...raw, headers: lowerCaseHeaders(raw.headers) };
      if (response.status !== 429 || retries >= this.limits.maxRetries) {
        return response;
      }
      const retryAfter = response.headers['retry-after'];
      const seconds = Number(retryAfter);
      const at =
        retryAfter !== undefined &&
        retryAfter !== '' &&
        Number.isFinite(seconds)
          ? Date.now() + Math.max(0, seconds) * 1000
          : retryAfter
            ? Date.parse(retryAfter)
            : NaN;
      if (!Number.isFinite(at)) {
        return response;
      }
      const delay = Math.max(0, at - Date.now());
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

/** The array at a dot-path of the body (`''`: the body), its objects only. */
function itemsAt(body: unknown, path: string): Record<string, unknown>[] {
  const array =
    path === ''
      ? body
      : isRecord(body)
        ? readNestedField(body, path)
        : undefined;
  if (!Array.isArray(array)) {
    throw new Error(
      `No items array at ${path || 'the body root'} (the declared envelope.itemsField)`,
    );
  }
  return array.filter(isRecord);
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
        (operation.parameters ?? [])
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
   * Without it, `pageItems` locates the array.
   */
  itemsField?: string;
  /**
   * The range a `rangeWindow` operation is read over (Pagination Schemes
   * 0.5.0 §4.6.3), both bounds in the window's format. Required for such an
   * operation, ignored for any other: which range to read is the caller's
   * choice.
   */
  range?: WindowRange;
  /**
   * An item's identity, for a windowed read: an item that a later window
   * returns again (its field changed during the read) is yielded once
   * (§4.6.4 rule 3).
   */
  identity?: (item: Record<string, unknown>) => string;
  /**
   * Set when the walk ends normally: `complete` is false for a read that
   * returned every page but is never complete in the Collection
   * Completeness sense (a windowed read, §4.6.4 rule 5), with `reason`.
   */
  outcome?: WalkOutcome;
}

export interface WindowRange {
  start: string;
  end: string;
}

export interface WalkOutcome {
  complete: boolean;
  reason?: string;
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
  }
  const result: WalkOutcome = { complete: true };
  yield* walkAllPages({ ...walk, outcome: result });
  if (outcome) {
    outcome.complete = result.complete;
    if (result.reason !== undefined) outcome.reason = result.reason;
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
  const sendsPageSize = Boolean(
    scheme &&
      (['queryParameters', 'bodyFields'] as const).some((location) =>
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

    const items =
      walk.itemsField === undefined
        ? pageItems(body, responseSchema, scheme)
        : itemsAt(body, walk.itemsField);
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
      const identity = walk.identity;
      if (identity) {
        const ids = items.map((item) => identity(item)).filter((id) => id);
        if (ids.some((id) => seenIds.has(id))) {
          throw new PageReadError(
            `Page ${number} holds an item an earlier page returned; the read is not complete`,
          );
        }
        for (const id of ids) seenIds.add(id);
      } else {
        const fingerprint = JSON.stringify(items);
        if (items.length > 0 && fingerprint === previousPage) {
          throw new PageReadError(
            `Page ${number} repeats the page before it; the read is not complete`,
          );
        }
        previousPage = fingerprint;
      }
    }
    itemsSoFar += items.length;
    yield { url, items, body };

    if (!scheme) {
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
    const items =
      walk.itemsField === undefined
        ? pageItems(body, responseSchema, scheme)
        : itemsAt(body, walk.itemsField);
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
