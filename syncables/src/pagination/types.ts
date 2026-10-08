/**
 * Type definitions for the OpenAPI Pagination Schemes Extension.
 * Spec version 0.1.0: https://github.com/pondersource/openapi-pagination-schemes-extension
 *
 * Field names, optionality, and enum values are taken verbatim from the
 * spec (mirroring the reference implementation's src/types.ts) so a
 * PaginationSchemeObject can be lifted from an OAS document without
 * transformation.
 */

export type SchemeType = 'pageNumber' | 'pageToken' | 'nextLink';

export type RequestRole =
  | 'page'
  | 'pageSize'
  | 'offset'
  | 'pageToken'
  | 'cursor'
  | 'previousPageToken'
  | 'syncToken';

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

export interface ResponsePaginationFieldsObject {
  bodyFields?: Record<string, ResponseFieldObject>;
  headers?: Record<string, ResponseFieldObject>;
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
