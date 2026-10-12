/**
 * Type definitions for the OpenAPI Pagination Schemes Extension.
 * Spec version 0.1.0: https://github.com/pondersource/openapi-pagination-schemes-extension
 *
 * Field names, optionality, and enum values are taken verbatim from the
 * spec (mirroring the reference implementation's src/types.ts) so a
 * PaginationSchemeObject can be lifted from an OAS document without
 * transformation.
 */

export type SchemeType =
  | 'pageNumber'
  | 'pageToken'
  | 'nextLink'
  | 'rangeWindow';

export type RequestRole =
  | 'page'
  | 'pageSize'
  | 'offset'
  | 'pageToken'
  | 'cursor'
  | 'previousPageToken'
  | 'syncToken'
  | 'windowStart'
  | 'windowEnd'
  | 'windowRange';

export type WindowUnit = 'day' | 'second' | 'integer';
export type WindowFormat =
  | 'date'
  | 'basicDate'
  | 'dateTime'
  | 'unixSeconds'
  | 'integer';
export type WindowBounds = 'closed' | 'halfOpen';

/**
 * Range Window Object (spec 0.5.0 §4.6.1): a `rangeWindow` scheme's
 * operation has no page parameter and answers at most `cap` items; a client
 * reads a range of one item field as windows, splitting a full window.
 */
export interface RangeWindowObject {
  unit: WindowUnit;
  /** How a bound is written (§4.6.2); fits `unit`. */
  format: WindowFormat;
  /** `closed`: `[start, end]`; `halfOpen`: `[start, end)`. */
  bounds: WindowBounds;
  /** The most items one answer holds; an answer with that many is full. */
  cap: number;
  /** The narrowest window the operation selects correctly, in units. Default 1. */
  minimumWidth?: number;
  /** JSON Pointer to the item field the range selects on. */
  field?: string;
  /** `unit: day` only: an IANA time zone, or `unspecified`. */
  timeZone?: string;
  description?: string;
  [key: `x-${string}`]: unknown;
}

export type ResponseRole =
  | 'nextPageToken'
  | 'nextCursor'
  | 'nextLink'
  | 'previousPageToken'
  | 'previousLink'
  | 'nextSyncToken'
  | 'totalCount'
  | 'totalPages'
  | 'pageSize'
  | 'currentPage'
  | 'offset';

/**
 * Link Resolution Object (spec 0.4.0 §4.4.3): the base a relative
 * `nextLink`/`previousLink` value is resolved against. `request` (the
 * default when absent) is the URL of the request that returned the link,
 * `server` the server URL as a directory (a `/` appended when its path has
 * none), `declared` the `url` field as written.
 */
export interface LinkResolutionObject {
  base: 'request' | 'server' | 'declared';
  /** Required with `base: declared`, forbidden otherwise: an absolute http(s) URL without userinfo or fragment. */
  url?: string;
  description?: string;
  [key: `x-${string}`]: unknown;
}

export interface RequestFieldObject {
  description?: string;
  schema?: unknown;
  role?: RequestRole;
  required?: boolean;
  /** `windowRange` only: the field's value, with `{start}` and `{end}` once each (§4.6.1). */
  template?: string;
  /** `page` only: the number of the first page (spec 0.6.0 §4.3.1). Default 1. */
  start?: number;
  [key: `x-${string}`]: unknown;
}

export interface RequestPaginationFieldsObject {
  queryParameters?: Record<string, RequestFieldObject>;
  bodyFields?: Record<string, RequestFieldObject>;
  headerFields?: Record<string, RequestFieldObject>;
  [key: `x-${string}`]: unknown;
}

export interface ResponseFieldObject {
  description?: string;
  schema?: unknown;
  role?: ResponseRole;
  /** Only on a `nextLink` or `previousLink` field (§4.4.3). */
  linkResolution?: LinkResolutionObject;
  [key: `x-${string}`]: unknown;
}

/**
 * Short Page Object (spec 0.6.0 §4.4.5), on a `pageNumber` scheme: a page
 * with fewer than `size` items ends the list. Only `documented` makes a
 * read ended that way complete.
 */
export interface ShortPageObject {
  /** Items in a full page, or `request` for the `pageSize` the client sends. */
  size: number | 'request';
  assurance: 'documented' | 'observed' | 'assumed';
  description?: string;
  [key: `x-${string}`]: unknown;
}

/**
 * Envelope Object (spec §4.4.2): where the items array sits in the body.
 * `itemsField` omitted or `null` means the body root is the array.
 */
export interface EnvelopeObject {
  itemsField?: string | null;
  [key: `x-${string}`]: unknown;
}

export interface ResponsePaginationFieldsObject {
  envelope?: EnvelopeObject;
  bodyFields?: Record<string, ResponseFieldObject>;
  headers?: Record<string, ResponseFieldObject>;
  shortPage?: ShortPageObject;
  [key: `x-${string}`]: unknown;
}

export interface AutoDetectObject {
  matchQueryParams?: boolean;
  matchBodyFields?: boolean;
  matchResponseFields?: boolean;
  matchHeaders?: boolean;
  requireAll?: boolean;
  [key: `x-${string}`]: unknown;
}

export interface PaginationSchemeObject {
  type: SchemeType;
  description?: string;
  autoDetect?: boolean | AutoDetectObject;
  /** Required for `rangeWindow`, absent otherwise (§4.6). */
  window?: RangeWindowObject;
  request?: RequestPaginationFieldsObject;
  response?: ResponsePaginationFieldsObject;
  [key: `x-${string}`]: unknown;
}

export interface PaginationApplicationObject {
  scheme: string;
  overrides?: Partial<PaginationSchemeObject>;
  description?: string;
  [key: `x-${string}`]: unknown;
}

export type PaginationSchemesMap = Record<string, PaginationSchemeObject>;

/** Everything derivable from a server response about the state of pagination. */
export interface PaginationResponseState {
  nextPageToken: string | null;
  /** The `nextLink` value when it is a non-empty string; see `nextLinkValue` for the rest. */
  nextLink: string | null;
  /**
   * The raw `nextLink`-role value as the response carried it (a body field
   * read as is, a header's `rel="next"` target): `undefined` when absent.
   * `resolveLink` (`links.ts`) decides whether it is followed; a value that
   * is not a string is refused there, never coerced. Optional only so that
   * a state built by hand (older callers) still type-checks;
   * `parsePaginationState` always sets it.
   */
  nextLinkValue?: unknown;
  /** The Link Resolution Object of the field that carried `nextLink`, if any. */
  nextLinkResolution?: LinkResolutionObject | null;
  currentPage: number | null;
  totalCount: number | null;
  totalPages: number | null;
  pageSize: number | null;
  hasNextPage: boolean;
}

/** Query parameters to send for a single page request. */
export type PaginationQuery = Record<string, string>;
