import type {
  PaginationSchemeObject,
  RequestRole,
  ResponseFieldObject,
  ResponseRole,
} from './types.js';

const SCHEME_TYPES = new Set([
  'pageNumber',
  'pageToken',
  'nextLink',
  'rangeWindow',
]);
const WINDOW_UNITS = new Set(['day', 'second', 'integer']);
/** Spec §4.6.2: which formats fit which unit (rule 13). */
const WINDOW_FORMATS: Record<string, string> = {
  date: 'day',
  basicDate: 'day',
  dateTime: 'second',
  unixSeconds: 'second',
  integer: 'integer',
};
const WINDOW_BOUNDS = new Set(['closed', 'halfOpen']);
const WINDOW_ROLES = new Set(['windowStart', 'windowEnd', 'windowRange']);
const REQUEST_ROLES: Set<RequestRole> = new Set([
  'page',
  'pageSize',
  'offset',
  'pageToken',
  'cursor',
  'previousPageToken',
  'syncToken',
  'windowStart',
  'windowEnd',
  'windowRange',
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

const WINDOW_KEYS = new Set([
  'unit',
  'format',
  'bounds',
  'cap',
  'minimumWidth',
  'field',
  'timeZone',
  'description',
]);
/** `{start}` and `{end}` once each, in either order, and no other brace. */
const TEMPLATE =
  /^(?:[^{}]*\{start\}[^{}]*\{end\}[^{}]*|[^{}]*\{end\}[^{}]*\{start\}[^{}]*)$/;
const JSON_POINTER = /^(\/([^~]|~[01])*)*$/;
const REQUEST_LOCATIONS = [
  'queryParameters',
  'bodyFields',
  'headerFields',
] as const;

const isPositiveInteger = (value: unknown): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1;

const SHORT_PAGE_KEYS = new Set(['size', 'assurance', 'description']);
const ASSURANCES = new Set(['documented', 'observed', 'assumed']);

/**
 * Spec 0.6.0 §9 rules 19–21: `start` only on a `page` field, an integer of
 * at least 0; `shortPage` only on a `pageNumber` scheme, with a `size`
 * (a positive integer, or `request`, which needs a `pageSize` field) and
 * an `assurance`. Rule 22 (a `page` field where the scheme is applied) is
 * checked by `resolveEffectiveScheme`.
 */
function checkShortPage(
  path: string,
  scheme: PaginationSchemeObject,
  errors: string[],
): void {
  const fields = REQUEST_LOCATIONS.flatMap((location) =>
    Object.entries(scheme.request?.[location] ?? {}).map(([name, field]) => ({
      at: `${path}.request.${location}.${name}`,
      field,
    })),
  );
  for (const { at, field } of fields) {
    if (field.start === undefined) continue;
    if (field.role !== 'page') {
      errors.push(`${at}.start is allowed only on a page field`);
    } else if (
      typeof field.start !== 'number' ||
      !Number.isInteger(field.start) ||
      field.start < 0
    ) {
      errors.push(`${at}.start must be an integer of at least 0`);
    }
  }
  const short = scheme.response?.shortPage as unknown;
  if (short === undefined) return;
  const at = `${path}.response.shortPage`;
  if (scheme.type !== 'pageNumber') {
    errors.push(`${at} is allowed only on a pageNumber scheme`);
  }
  if (typeof short !== 'object' || short === null || Array.isArray(short)) {
    errors.push(`${at} must be an object`);
    return;
  }
  const s = short as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!SHORT_PAGE_KEYS.has(key) && !isExtensionKey(key)) {
      errors.push(`${at}.${key} is not a Short Page Object field`);
    }
  }
  if (s['size'] !== 'request' && !isPositiveInteger(s['size'])) {
    errors.push(`${at}.size must be an integer of at least 1, or request`);
  }
  if (
    s['size'] === 'request' &&
    !fields.some(({ field }) => field.role === 'pageSize')
  ) {
    errors.push(`${at}.size request needs a request field with role pageSize`);
  }
  if (typeof s['assurance'] !== 'string' || !ASSURANCES.has(s['assurance'])) {
    errors.push(
      `${at}.assurance must be one of documented, observed, or assumed`,
    );
  }
}

/**
 * Spec 0.5.0 §9 rules 12–16, which `schema.json` covers in the spec folder:
 * a `rangeWindow` scheme has a valid `window` (unit, a format that fits it,
 * bounds, a positive integer cap and minimum width, a JSON Pointer field, a
 * time zone only for days) and a `request`; other schemes have no window
 * and no window role; the window travels in one `windowRange` field with a
 * template, or one `windowStart` and one `windowEnd` field; a template sits
 * on a `windowRange` field only; and `autoDetect`, when given, is `false`.
 */
function checkWindow(
  path: string,
  scheme: PaginationSchemeObject,
  errors: string[],
): void {
  const fields = REQUEST_LOCATIONS.flatMap((location) =>
    Object.entries(scheme.request?.[location] ?? {}).map(([name, field]) => ({
      at: `${path}.request.${location}.${name}`,
      field,
    })),
  );
  for (const { at, field } of fields) {
    const role = String(field.role);
    if (field.template !== undefined) {
      if (role !== 'windowRange') {
        errors.push(`${at}.template is allowed only on a windowRange field`);
      } else if (
        typeof field.template !== 'string' ||
        !TEMPLATE.test(field.template)
      ) {
        errors.push(
          `${at}.template must hold {start} and {end} once each and no other brace`,
        );
      }
    } else if (role === 'windowRange') {
      errors.push(`${at} has role windowRange and needs a template`);
    }
  }
  if (scheme.type !== 'rangeWindow') {
    if (scheme.window !== undefined) {
      errors.push(`${path}.window is allowed only on a rangeWindow scheme`);
    }
    for (const { at, field } of fields) {
      if (WINDOW_ROLES.has(String(field.role))) {
        errors.push(
          `${at}.role ${String(field.role)} is allowed only in a rangeWindow scheme`,
        );
      }
    }
    return;
  }
  if (scheme.autoDetect !== undefined && scheme.autoDetect !== false) {
    errors.push(
      `${path}.autoDetect must be false: a rangeWindow scheme is never auto-detected`,
    );
  }
  if (!scheme.request) {
    errors.push(`${path} is a rangeWindow scheme and needs a request`);
  }
  const roles = fields
    .map(({ field }) => String(field.role))
    .filter((role) => WINDOW_ROLES.has(role))
    .sort();
  const carried =
    (roles.length === 1 && roles[0] === 'windowRange') ||
    (roles.length === 2 &&
      roles[0] === 'windowEnd' &&
      roles[1] === 'windowStart');
  if (!carried) {
    errors.push(
      `${path}.request needs one windowRange field, or one windowStart and one windowEnd field (found ${roles.join(', ') || 'none'})`,
    );
  }
  const window = scheme.window as unknown;
  if (typeof window !== 'object' || window === null || Array.isArray(window)) {
    errors.push(`${path}.window is required for a rangeWindow scheme`);
    return;
  }
  const w = window as Record<string, unknown>;
  for (const key of Object.keys(w)) {
    if (!WINDOW_KEYS.has(key) && !isExtensionKey(key)) {
      errors.push(`${path}.window.${key} is not a Range Window Object field`);
    }
  }
  if (typeof w['unit'] !== 'string' || !WINDOW_UNITS.has(w['unit'])) {
    errors.push(`${path}.window.unit must be one of day, second, or integer`);
  }
  const fits = WINDOW_FORMATS[String(w['format'])];
  if (fits === undefined) {
    errors.push(
      `${path}.window.format must be one of date, basicDate, dateTime, unixSeconds, or integer`,
    );
  } else if (fits !== w['unit']) {
    errors.push(
      `${path}.window.format ${String(w['format'])} does not fit unit ${String(w['unit'])}`,
    );
  }
  if (typeof w['bounds'] !== 'string' || !WINDOW_BOUNDS.has(w['bounds'])) {
    errors.push(`${path}.window.bounds must be closed or halfOpen`);
  }
  if (!isPositiveInteger(w['cap'])) {
    errors.push(`${path}.window.cap must be an integer of at least 1`);
  }
  if (
    w['minimumWidth'] !== undefined &&
    !isPositiveInteger(w['minimumWidth'])
  ) {
    errors.push(`${path}.window.minimumWidth must be an integer of at least 1`);
  }
  if (
    w['field'] !== undefined &&
    (typeof w['field'] !== 'string' || !JSON_POINTER.test(w['field']))
  ) {
    errors.push(`${path}.window.field must be a JSON Pointer`);
  }
  if (w['timeZone'] !== undefined) {
    if (w['unit'] !== 'day') {
      errors.push(`${path}.window.timeZone is allowed only with unit day`);
    } else if (typeof w['timeZone'] !== 'string' || w['timeZone'] === '') {
      errors.push(`${path}.window.timeZone must be a nonempty string`);
    }
  }
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
      `${path}.type must be one of pageNumber, pageToken, nextLink, or rangeWindow (got "${String(scheme.type)}")`,
    );
  }
  checkWindow(path, scheme, errors);
  checkShortPage(path, scheme, errors);

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
