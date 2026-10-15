/**
 * CRUD Causality 0.7.0 §4.8: a resource the API cannot update, whose
 * objects are changed by creating a new object and deleting the old one
 * (`replace` on the CRUD Resource Object). Pure: `replaceOf` reads the
 * declaration, `replaceBlock` says whether an object may be replaced. The
 * requests themselves are the consumer's (`createApiClient` does not yet
 * replace on `update()`). Ports of the spec's `validate.py` rule 28 and
 * `replace_block`; keep them in step.
 */
import type { OpenApiDocument } from '../openapi/types.js';
import { splitPath } from '../pagination/response-parser.js';

export interface BlockObject {
  /** Dot-path to a field of the object. */
  field: string;
  /** `present` (default) or `nonEmpty`. Not with `moreThan`. */
  when?: 'present' | 'nonEmpty';
  /** Matches an array with more than this many items. */
  moreThan?: number;
  /** With `moreThan`: items equal on all these fields are not counted. */
  except?: Record<string, unknown>;
  /** Why such an object cannot be replaced, for the user. */
  description?: string;
}

export interface ReplaceDeclaration {
  blockedBy: BlockObject[];
  description?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ABSENT = Symbol('absent');

/** The value at a dot-path, or `ABSENT` when a segment is missing. */
export function valueAt(value: unknown, path: string): unknown {
  let at = value;

  for (const segment of splitPath(path)) {
    if (!isRecord(at) || !(segment in at)) return ABSENT;
    at = at[segment];
  }

  return at;
}

const isAbsent = (value: unknown): boolean => value === ABSENT;

/**
 * A resource's `replace` declaration, `undefined` when it has none, or
 * `{ refused }` naming the first rule-28 problem (a consumer must not
 * replace on a declaration it cannot read: a block it ignored could lose
 * data).
 */
export function replaceOf(
  document: OpenApiDocument,
  resource: string,
): ReplaceDeclaration | { refused: string } | undefined {
  const resources = document.components?.['crudResources'];
  const declared = isRecord(resources) ? resources[resource] : undefined;
  if (!isRecord(declared) || !('replace' in declared)) return undefined;
  const replace = declared['replace'];
  if (!isRecord(replace))
    return { refused: 'replace: expected an object (§4.8.1)' };
  const blocks = replace['blockedBy'] ?? [];
  if (!Array.isArray(blocks))
    return { refused: 'replace.blockedBy: expected an array (rule 28)' };
  const blockedBy: BlockObject[] = [];

  for (const [index, block] of blocks.entries()) {
    const at = `replace.blockedBy[${index}]`;
    if (!isRecord(block)) return { refused: `${at}: expected an object` };
    const field = block['field'];
    if (typeof field !== 'string' || !wellFormed(field))
      return { refused: `${at}.field: expected a dot-path (rule 28)` };
    const when = block['when'];
    if (when !== undefined && when !== 'present' && when !== 'nonEmpty')
      return {
        refused: `${at}.when: expected present or nonEmpty (rule 28)`,
      };
    const moreThan = block['moreThan'];
    if (
      moreThan !== undefined &&
      (typeof moreThan !== 'number' ||
        !Number.isInteger(moreThan) ||
        moreThan < 0)
    )
      return {
        refused: `${at}.moreThan: expected an integer >= 0 (rule 28)`,
      };
    if (moreThan !== undefined && when !== undefined)
      return { refused: `${at}: moreThan is not given with when (rule 28)` };
    const except = block['except'];
    if (except !== undefined && (!isRecord(except) || moreThan === undefined))
      return {
        refused: `${at}.except: an object, only with moreThan (rule 28)`,
      };
    blockedBy.push({
      field,
      ...(when === undefined ? {} : { when }),
      ...(moreThan === undefined ? {} : { moreThan }),
      ...(except === undefined ? {} : { except }),
      ...(typeof block['description'] === 'string'
        ? { description: block['description'] }
        : {}),
    });
  }

  return {
    blockedBy,
    ...(typeof replace['description'] === 'string'
      ? { description: replace['description'] }
      : {}),
  };
}

/**
 * The first Block Object that matches `object`, or undefined when it may
 * be replaced (§4.8.2). Read the object as it is now, not a cached copy.
 */
export function replaceBlock(
  replace: ReplaceDeclaration | undefined,
  object: unknown,
): BlockObject | undefined {
  for (const block of replace?.blockedBy ?? []) {
    const value = valueAt(object, block.field);

    if (block.moreThan !== undefined) {
      if (!Array.isArray(value)) continue;
      const skip = Object.entries(block.except ?? {});
      const counted = value.filter(
        (item) =>
          !(
            skip.length &&
            isRecord(item) &&
            skip.every(([key, want]) => sameJson(item[key], want))
          ),
      );
      if (counted.length > block.moreThan) return block;
      continue;
    }

    if (isAbsent(value) || value === null) continue;
    if ((block.when ?? 'present') === 'present') return block;
    if (Array.isArray(value) || typeof value === 'string') {
      if (value.length) return block;
    } else if (isRecord(value) && Object.keys(value).length) return block;
  }

  return undefined;
}

/** JSON equality, object keys in any order. */
export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** JSON with object keys sorted; `undefined` as the empty string. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return '';

  return JSON.stringify(value, (_key, v: unknown) =>
    isRecord(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

/** A nonempty dot-path whose segments are names or `["bracketed"]` names. */
export function wellFormed(path: string): boolean {
  return /^(?:\["(?:[^"\\]|\\.)*"\]|[^.[\]]+)(?:\.(?:\["(?:[^"\\]|\\.)*"\]|[^.[\]]+))*$/.test(
    path,
  );
}
