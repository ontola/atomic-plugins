import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import type {
  PaginationApplicationObject,
  PaginationSchemeObject,
} from './types.js';
import { splitPath } from './response-parser.js';
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

/**
 * The first scheme that fails validation but whose auto-detection would
 * match the operation, when no valid scheme matches it: the operation
 * presumably pages, but the scheme cannot be applied. A read that makes
 * one request must then not take that page as the whole collection.
 * `undefined` when an explicit `x-pagination` applies, a valid scheme
 * matches, or no invalid one would.
 */
export function invalidAutoDetected(
  document: OpenApiDocument,
  operation: OperationObject,
): { schemeName: string; problems: string[] } | undefined {
  const explicit = operation['x-pagination'];
  if (explicit !== undefined && !(Array.isArray(explicit) && !explicit.length))
    return undefined;
  const valid = validSchemes(document);
  for (const scheme of valid.values())
    if (autoDetectMatches(scheme, operation)) return undefined;
  const schemes = document.components?.paginationSchemes ?? {};
  for (const [schemeName, scheme] of Object.entries(schemes)) {
    if (valid.has(schemeName) || !isPlainObject(scheme)) continue;
    if (autoDetectMatches(scheme, operation))
      return {
        schemeName,
        problems: validatePaginationScheme(schemeName, scheme),
      };
  }
  return undefined;
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

/** The operation's success responses: `200`-`299` and `2XX`. */
function successResponses(operation: OperationObject): unknown[] {
  const responses: unknown = operation.responses;
  if (!isPlainObject(responses)) return [];
  return Object.entries(responses)
    .filter(([code]) => /^2(\d\d|XX)$/i.test(code))
    .map(([, response]) => response);
}

/**
 * §6.3 `matchHeaders`: one success response declares every name, compared
 * without case (HTTP header names are case-insensitive).
 */
function declaresHeaders(operation: OperationObject, names: string[]): boolean {
  return successResponses(operation).some((response) => {
    if (!isPlainObject(response) || !isPlainObject(response['headers']))
      return false;
    const declared = new Set(
      Object.keys(response['headers']).map((name) => name.toLowerCase()),
    );
    return names.every((name) => declared.has(name.toLowerCase()));
  });
}

/** A schema's `properties`, with those of its `allOf` members merged in. */
function schemaProperties(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) return {};
  const merged: Record<string, unknown> = isPlainObject(schema['properties'])
    ? { ...schema['properties'] }
    : {};
  if (Array.isArray(schema['allOf']))
    for (const member of schema['allOf'])
      Object.assign(merged, schemaProperties(member));
  return merged;
}

/**
 * §6.3 `matchResponseFields`: one success response's JSON schema has every
 * field, each a dot-path read as the response parser reads it, through
 * `properties` (and `allOf` members). A response without a JSON schema
 * matches nothing.
 */
function declaresResponseFields(
  operation: OperationObject,
  paths: string[],
): boolean {
  return successResponses(operation).some((response) => {
    if (!isPlainObject(response) || !isPlainObject(response['content']))
      return false;
    const media = response['content']['application/json'];
    if (!isPlainObject(media) || !isPlainObject(media['schema'])) return false;
    const root = media['schema'];
    return paths.every((path) => {
      let segments: string[];
      try {
        segments = splitPath(path);
      } catch {
        // A path the response parser cannot read either: counted as
        // present, so the read applies the scheme and fails on the path
        // rather than taking one page as the whole list.
        return true;
      }
      let schema: unknown = root;
      for (const segment of segments) {
        const properties = schemaProperties(schema);
        if (!Object.hasOwn(properties, segment)) return false;
        schema = properties[segment];
      }
      return true;
    });
  });
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
  // Anything but an Auto-Detect Object (`true`, or an invalid `null`,
  // string, number or array) means the default options: an invalid scheme
  // that then matches makes its read not complete, never one page complete.
  const options = isPlainObject(scheme.autoDetect) ? scheme.autoDetect : {};
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

  // Response dimensions, off by default (§6.3). They can only see what the
  // operation's description declares: a header the description leaves out
  // does not match, though the provider may send it.
  if (options.matchResponseFields === true) {
    const required = Object.keys(scheme.response?.bodyFields ?? {});
    if (required.length > 0)
      results.push(declaresResponseFields(operation, required));
  }

  if (options.matchHeaders === true) {
    const required = Object.keys(scheme.response?.headers ?? {});
    if (required.length > 0) results.push(declaresHeaders(operation, required));
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
    // Rule 22: a scheme with a Short Page Object pages by exactly one page field.
    const pageFields = (['queryParameters', 'bodyFields'] as const).flatMap(
      (location) =>
        Object.values(scheme.request?.[location] ?? {}).filter(
          (field) => field.role === 'page',
        ),
    );
    if (scheme.response?.shortPage !== undefined && pageFields.length !== 1) {
      throw new PaginationSchemeError(
        `x-pagination applies the pagination scheme "${name}", whose shortPage needs exactly one request field with role page`,
      );
    }
    // Rule 25 (0.7.0): an offset that advances by the page size needs one.
    const advancesByPageSize = (
      ['queryParameters', 'bodyFields'] as const
    ).some((location) =>
      Object.values(scheme.request?.[location] ?? {}).some(
        (field) => field.role === 'offset' && field.advance === 'pageSize',
      ),
    );
    const hasPageSize =
      (['queryParameters', 'bodyFields'] as const).some((location) =>
        Object.values(scheme.request?.[location] ?? {}).some(
          (field) => field.role === 'pageSize',
        ),
      ) ||
      Object.values(scheme.response?.bodyFields ?? {}).some(
        (field) => field.role === 'pageSize',
      );
    if (advancesByPageSize && !hasPageSize) {
      throw new PaginationSchemeError(
        `x-pagination applies the pagination scheme "${name}", whose offset advances by the page size but which has no request or response field with role pageSize`,
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
