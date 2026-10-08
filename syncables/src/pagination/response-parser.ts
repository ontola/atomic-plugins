import type {
  LinkResolutionObject,
  PaginationResponseState,
  PaginationSchemeObject,
  ResponseRole,
  SchemeType,
} from './types.js';

/** Reads a dot-separated path out of a plain object, e.g. "pagination.total_count". */
export function readNestedField(
  body: Record<string, unknown>,
  path: string,
): unknown {
  let node: unknown = body;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Writes a value at a dot-separated path, creating intermediate objects as needed. */
export function setNestedField(
  body: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split('.');
  let node = body;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i] as string;
    const child = node[segment];
    if (typeof child !== 'object' || child === null) {
      node[segment] = {};
    }
    node = node[segment] as Record<string, unknown>;
  }
  node[segments[segments.length - 1] as string] = value;
}

/**
 * Parses an RFC 8288 Link header value and extracts the URL with rel="next".
 * Example: `<https://api.example.com/items?page=2>; rel="next", <...>; rel="prev"`
 */
export function parseLinkHeader(header: string): string | null {
  if (!header) {
    return null;
  }
  const parts = header.split(/,\s*(?=<)/);
  for (const part of parts) {
    const match = part.match(/^\s*<([^>]+)>(.*)/);
    if (!match) {
      continue;
    }
    const [, url, attrs] = match;
    const relMatch = attrs?.match(/\brel\s*=\s*"?([^";,\s]+)"?/i);
    if (relMatch?.[1]?.trim().toLowerCase() === 'next') {
      return url ?? null;
    }
  }
  return null;
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  return String(value);
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function extractByRole(
  scheme: PaginationSchemeObject,
  body: Record<string, unknown>,
  headers: Record<string, string>,
): {
  roles: Map<ResponseRole, unknown>;
  /** The `linkResolution` of the field that supplied `nextLink`. */
  nextLinkResolution: LinkResolutionObject | null;
} {
  const roles = new Map<ResponseRole, unknown>();
  let nextLinkResolution: LinkResolutionObject | null = null;

  for (const [path, field] of Object.entries(
    scheme.response?.bodyFields ?? {},
  )) {
    if (!field.role) continue;
    const value = readNestedField(body, path);
    if (value !== undefined) {
      roles.set(field.role, value);
      if (field.role === 'nextLink')
        nextLinkResolution = field.linkResolution ?? null;
    }
  }

  for (const [name, field] of Object.entries(scheme.response?.headers ?? {})) {
    if (!field.role) continue;
    const raw =
      headers[name] ??
      headers[name.toLowerCase()] ??
      headers[name.toUpperCase()];
    if (raw === undefined) continue;
    if (field.role === 'nextLink') {
      const parsed = parseLinkHeader(raw);
      if (parsed) {
        roles.set('nextLink', parsed);
        nextLinkResolution = field.linkResolution ?? null;
      }
    } else {
      roles.set(field.role, raw);
    }
  }

  return { roles, nextLinkResolution };
}

/**
 * A `nextLink`/`nextPageToken` value is a strong, type-agnostic signal
 * that another page exists — real APIs sometimes include one even on a
 * scheme whose `type` is `pageNumber` (e.g. Spotify's offset-based
 * endpoints all carry a `next` URL). Checking it first, ahead of the
 * type-specific counting rules, means traversal still terminates
 * correctly for those schemes even without a `currentPage`/`totalPages`
 * role declared.
 *
 * `totalCount` (role: `all` per spec §4.5) is checked next against
 * `itemsFetchedSoFar`, which the *caller* tracks — some real schemes
 * (e.g. Giphy's) report `totalCount` and `pageSize` but no `currentPage`
 * at all, so there's nothing here to compute "current page * pageSize"
 * from; the client already knows exactly how many items it has pulled
 * across all pages so far, which is the more direct signal anyway.
 */
function deriveHasNextPage(
  type: SchemeType,
  state: PaginationResponseState,
  itemsFetchedSoFar?: number,
): boolean {
  if (state.nextLink !== null || state.nextPageToken !== null) {
    return true;
  }
  if (state.totalCount !== null && itemsFetchedSoFar !== undefined) {
    return itemsFetchedSoFar < state.totalCount;
  }
  if (type === 'pageNumber') {
    if (state.currentPage !== null && state.totalPages !== null) {
      return state.currentPage < state.totalPages;
    }
    if (
      state.currentPage !== null &&
      state.totalCount !== null &&
      state.pageSize !== null
    ) {
      return state.currentPage * state.pageSize < state.totalCount;
    }
  }
  return false;
}

/**
 * Parses a server response into pagination state, per the resolved scheme.
 * `itemsFetchedSoFar` — the cumulative item count across all pages
 * fetched so far, including this one — lets `hasNextPage` be derived from
 * a plain `totalCount` field even when no `currentPage` role is declared.
 */
export function parsePaginationState(
  scheme: PaginationSchemeObject,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  itemsFetchedSoFar?: number,
): PaginationResponseState {
  const { roles, nextLinkResolution } = extractByRole(scheme, body, headers);

  // The link is kept as the response carried it: `resolveLink` decides
  // whether it is followed (spec 0.4.0 §4.4.3), and a value that is not a
  // string is refused there rather than coerced.
  const nextLinkValue = roles.get('nextLink');
  const state: PaginationResponseState = {
    nextPageToken: toStringOrNull(
      roles.get('nextPageToken') ?? roles.get('nextCursor') ?? null,
    ),
    nextLink:
      typeof nextLinkValue === 'string' && nextLinkValue !== ''
        ? nextLinkValue
        : null,
    nextLinkValue,
    nextLinkResolution,
    currentPage: toNumberOrNull(roles.get('currentPage') ?? null),
    totalCount: toNumberOrNull(roles.get('totalCount') ?? null),
    totalPages: toNumberOrNull(roles.get('totalPages') ?? null),
    pageSize: toNumberOrNull(roles.get('pageSize') ?? null),
    hasNextPage: false,
  };
  state.hasNextPage = deriveHasNextPage(scheme.type, state, itemsFetchedSoFar);
  return state;
}
