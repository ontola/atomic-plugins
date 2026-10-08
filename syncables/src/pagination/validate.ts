import type {
  PaginationSchemeObject,
  RequestRole,
  ResponseFieldObject,
  ResponseRole,
} from './types.js';

const SCHEME_TYPES = new Set(['pageNumber', 'pageToken', 'nextLink']);
const REQUEST_ROLES: Set<RequestRole> = new Set([
  'page',
  'pageSize',
  'offset',
  'pageToken',
  'cursor',
  'previousPageToken',
  'syncToken',
]);
const RESPONSE_ROLES: Set<ResponseRole> = new Set([
  'nextPageToken',
  'nextCursor',
  'nextLink',
  'previousPageToken',
  'previousLink',
  'nextSyncToken',
  'totalCount',
  'totalPages',
  'pageSize',
  'currentPage',
  'offset',
]);
const LINK_BASES = new Set(['request', 'server', 'declared']);

function isExtensionKey(key: string): boolean {
  return key.startsWith('x-');
}

/**
 * Spec 0.4.0 §9 rules 8–10: `linkResolution` only on a `nextLink` or
 * `previousLink` field; `base` one of `request`, `server`, `declared`;
 * `url` present exactly when `base` is `declared`, then an absolute http(s)
 * URL without userinfo or fragment. (Rule 11, its origin against the
 * operation's server, needs the document and is checked at run time by
 * `resolveLink`, which refuses a link that leaves the server's origin.)
 */
function checkLinkResolution(
  path: string,
  field: ResponseFieldObject,
  errors: string[],
): void {
  const resolution: unknown = field.linkResolution;
  if (resolution === undefined) return;
  if (field.role !== 'nextLink' && field.role !== 'previousLink') {
    errors.push(
      `${path}.linkResolution is allowed only on a nextLink or previousLink field`,
    );
  }
  if (typeof resolution !== 'object' || resolution === null) {
    errors.push(`${path}.linkResolution must be an object`);
    return;
  }
  const { base, url } = resolution as Record<string, unknown>;
  if (typeof base !== 'string' || !LINK_BASES.has(base)) {
    errors.push(
      `${path}.linkResolution.base must be one of request, server, or declared (got "${String(base)}")`,
    );
  }
  if (base === 'declared') {
    if (typeof url !== 'string' || !isAbsoluteHttpUrl(url)) {
      errors.push(
        `${path}.linkResolution.url must be an absolute http or https URL without userinfo or a fragment when base is declared`,
      );
    }
  } else if (url !== undefined) {
    errors.push(
      `${path}.linkResolution.url is allowed only when base is declared`,
    );
  }
}

function isAbsoluteHttpUrl(value: string): boolean {
  if (value.includes('#')) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/**
 * Validates a single scheme against spec section 9. Returns a list of
 * human-readable errors (each naming the offending location), empty if
 * the scheme is valid. Schemes with errors are excluded from
 * auto-detection rather than throwing — one malformed scheme in a
 * document shouldn't prevent using the others.
 */
export function validatePaginationScheme(
  name: string,
  scheme: PaginationSchemeObject,
): string[] {
  const errors: string[] = [];
  const path = `paginationSchemes.${name}`;

  if (!SCHEME_TYPES.has(scheme.type)) {
    errors.push(
      `${path}.type must be one of pageNumber, pageToken, or nextLink (got "${String(scheme.type)}")`,
    );
  }

  if (!scheme.request && !scheme.response) {
    errors.push(`${path} must define at least one of "request" or "response"`);
  }

  for (const [fieldName, field] of Object.entries(
    scheme.request?.queryParameters ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !REQUEST_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.request.queryParameters.${fieldName}.role is not a valid request role (got "${field.role}")`,
      );
    }
  }
  for (const [fieldName, field] of Object.entries(
    scheme.request?.bodyFields ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !REQUEST_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.request.bodyFields.${fieldName}.role is not a valid request role (got "${field.role}")`,
      );
    }
  }

  for (const [fieldName, field] of Object.entries(
    scheme.response?.bodyFields ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !RESPONSE_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.response.bodyFields.${fieldName}.role is not a valid response role (got "${field.role}")`,
      );
    }
    checkLinkResolution(
      `${path}.response.bodyFields.${fieldName}`,
      field,
      errors,
    );
  }
  for (const [fieldName, field] of Object.entries(
    scheme.response?.headers ?? {},
  )) {
    if (
      field.role &&
      !isExtensionKey(field.role) &&
      !RESPONSE_ROLES.has(field.role)
    ) {
      errors.push(
        `${path}.response.headers.${fieldName}.role is not a valid response role (got "${field.role}")`,
      );
    }
    checkLinkResolution(`${path}.response.headers.${fieldName}`, field, errors);
  }

  return errors;
}
