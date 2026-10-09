import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import type {
  PaginationApplicationObject,
  PaginationSchemeObject,
} from './types.js';
import { validatePaginationScheme } from './validate.js';

export interface EffectiveScheme {
  schemeName: string;
  scheme: PaginationSchemeObject;
}

/**
 * An operation's explicit `x-pagination` cannot be applied: it is not an
 * array of Pagination Application Objects, names a scheme the document does
 * not declare, or names one that fails validation (spec §9), before or
 * after its overrides are merged. A read of such an operation fails rather
 * than making one request and returning that page as complete (#384).
 */
export class PaginationSchemeError extends Error {}

/**
 * Schemes that fail validation (spec §9) are excluded here rather than
 * thrown on eagerly — one malformed scheme in a document (see e.g. Giphy's
 * `type: offset`, which isn't a valid scheme type) shouldn't prevent using
 * the rest of the document or its other schemes.
 */
function validSchemes(
  document: OpenApiDocument,
): Map<string, PaginationSchemeObject> {
  const map = new Map<string, PaginationSchemeObject>();
  const schemes = document.components?.paginationSchemes ?? {};
  for (const [name, scheme] of Object.entries(schemes)) {
    if (validatePaginationScheme(name, scheme).length === 0) {
      map.set(name, scheme);
    }
  }
  return map;
}

function queryParamNames(operation: OperationObject): Set<string> {
  return new Set(
    (operation.parameters ?? [])
      .filter((parameter) => parameter.in === 'query')
      .map((parameter) => parameter.name),
  );
}

function bodyFieldNames(operation: OperationObject): Set<string> {
  const schema = operation.requestBody?.content?.['application/json']?.schema;
  return new Set(Object.keys(schema?.properties ?? {}));
}

/**
 * Default auto-detection rules (spec §6.2/§6.3): a dimension only
 * contributes to the match when the scheme actually declares fields for
 * it — an empty declaration isn't treated as vacuously satisfied, or
 * every scheme with no query parameters would match every operation.
 */
function autoDetectMatches(
  scheme: PaginationSchemeObject,
  operation: OperationObject,
): boolean {
  // A rangeWindow scheme is never auto-detected (spec 0.5.0 §4.6): its
  // window field is often a filter parameter other operations share.
  if (scheme.autoDetect === false || scheme.type === 'rangeWindow') {
    return false;
  }
  const options =
    typeof scheme.autoDetect === 'object' ? scheme.autoDetect : {};
  const requireAll = options.requireAll ?? true;
  const results: boolean[] = [];

  if (options.matchQueryParams ?? true) {
    const required = Object.keys(scheme.request?.queryParameters ?? {});
    if (required.length > 0) {
      const declared = queryParamNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }

  if (options.matchBodyFields ?? true) {
    const required = Object.keys(scheme.request?.bodyFields ?? {});
    if (required.length > 0) {
      const declared = bodyFieldNames(operation);
      results.push(required.every((name) => declared.has(name)));
    }
  }

  if (results.length === 0) {
    return false;
  }
  return requireAll ? results.every(Boolean) : results.some(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, overrides: Partial<T>): T {
  const result: Record<string, unknown> = {
    ...(base as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = result[key];
    result[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? deepMerge(existing, value)
        : value;
  }
  return result as T;
}

/**
 * Resolves the pagination scheme that applies to an operation: an
 * explicit `x-pagination` application (with overrides merged in) takes
 * priority, falling back to auto-detection against the document's valid
 * `paginationSchemes`.
 */
export function resolveEffectiveScheme(
  document: OpenApiDocument,
  operation: OperationObject,
): EffectiveScheme | undefined {
  const schemes = validSchemes(document);

  // An explicit application is never dropped silently: a reader that
  // ignored it would make one request and take that page for the whole
  // collection. (An empty array applies nothing and falls through to
  // auto-detection, as before.)
  const explicit = operation['x-pagination'];
  if (explicit !== undefined && !Array.isArray(explicit)) {
    throw new PaginationSchemeError(
      'x-pagination must be an array of Pagination Application Objects',
    );
  }
  if (Array.isArray(explicit) && explicit.length > 0) {
    const application = explicit[0] as PaginationApplicationObject | undefined;
    if (!isPlainObject(application) || typeof application.scheme !== 'string') {
      throw new PaginationSchemeError(
        'x-pagination[0] must be a Pagination Application Object with a "scheme" name',
      );
    }
    const name = application.scheme;
    const declared = document.components?.paginationSchemes?.[name];
    if (!declared) {
      throw new PaginationSchemeError(
        `x-pagination names the pagination scheme "${name}", which the document does not declare`,
      );
    }
    const invalid = validatePaginationScheme(name, declared);
    if (invalid.length) {
      throw new PaginationSchemeError(
        `x-pagination names the pagination scheme "${name}", which is invalid: ${invalid.join('; ')}`,
      );
    }
    const scheme = application.overrides
      ? deepMerge(declared, application.overrides)
      : declared;
    // The overrides are checked after the merge too (the spec's validator
    // does the same): a typo in an override is as silent a truncation.
    const afterMerge = application.overrides
      ? validatePaginationScheme(name, scheme)
      : [];
    if (afterMerge.length) {
      throw new PaginationSchemeError(
        `x-pagination's overrides make the pagination scheme "${name}" invalid: ${afterMerge.join('; ')}`,
      );
    }
    // Rule 17: an operation that applies a rangeWindow scheme, after
    // overrides, applies no other scheme.
    const windowed = explicit.some((entry) => {
      if (!isPlainObject(entry)) return false;
      const overrides = entry['overrides'];
      const type =
        isPlainObject(overrides) && 'type' in overrides
          ? overrides['type']
          : document.components?.paginationSchemes?.[String(entry['scheme'])]
              ?.type;
      return type === 'rangeWindow';
    });
    if (windowed && explicit.length > 1) {
      throw new PaginationSchemeError(
        'x-pagination applies a rangeWindow scheme together with another scheme',
      );
    }
    return { schemeName: name, scheme };
  }

  for (const [schemeName, scheme] of schemes) {
    if (autoDetectMatches(scheme, operation)) {
      return { schemeName, scheme };
    }
  }
  return undefined;
}
