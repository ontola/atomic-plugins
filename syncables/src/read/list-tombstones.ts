import { isRecord } from './model.js';

/**
 * Deletion Feeds 0.3.0-draft §4.5, after the reference `list_tombstone()`
 * in `openapi-extensions/spec/deletion-feeds/validate.py`: a collection
 * whose list can return deleted objects among the others, with a marker
 * (Google Calendar's `status: cancelled` with `showDeleted=true`), and
 * `except` conditions for marked states the provider documents as
 * something else (its cancelled exceptions of a recurring event).
 */
export interface ListTombstone {
  field: string;
  values: (string | number | boolean)[];
  except: ListTombstoneCondition[];
}

export type ListTombstoneCondition =
  | { field: string; values: (string | number | boolean)[] }
  | { field: string; present: true };

const MISSING = Symbol('missing');

const scalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

const dotPath = (v: unknown): v is string =>
  typeof v === 'string' && v !== '' && v.split('.').every((name) => name);

function values(v: unknown): (string | number | boolean)[] | undefined {
  return Array.isArray(v) && v.length && v.every(scalar) ? v : undefined;
}

/**
 * A List Tombstone Object, parsed; undefined when absent or when it does not
 * parse (a declaration that cannot be read marks nothing, so every item stays
 * a member: no deletion is reported on a guess).
 */
export function parseListTombstone(value: unknown): ListTombstone | undefined {
  if (!isRecord(value) || !dotPath(value['field'])) return undefined;
  const marked = values(value['values']);
  if (!marked) return undefined;
  const except: ListTombstoneCondition[] = [];
  if (value['except'] !== undefined) {
    if (!Array.isArray(value['except']) || !value['except'].length)
      return undefined;
    for (const condition of value['except']) {
      if (!isRecord(condition) || !dotPath(condition['field']))
        return undefined;
      const hasValues = condition['values'] !== undefined;
      const hasPresent = condition['present'] !== undefined;
      if (hasValues === hasPresent) return undefined;
      if (hasPresent) {
        if (condition['present'] !== true) return undefined;
        except.push({ field: condition['field'], present: true });
      } else {
        const listed = values(condition['values']);
        if (!listed) return undefined;
        except.push({ field: condition['field'], values: listed });
      }
    }
  }
  return { field: value['field'], values: marked, except };
}

function at(item: unknown, path: string): unknown {
  let node = item;
  for (const name of path.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, name)) return MISSING;
    node = node[name];
  }
  return node;
}

/** JSON equality of scalars: the same JSON type and value. */
function same(a: unknown, b: unknown): boolean {
  return typeof a === typeof b && a === b;
}

/** §4.5: whether one item of a collection's read is a list tombstone. */
export function isListTombstone(
  declaration: ListTombstone,
  item: unknown,
): boolean {
  if (!isRecord(item)) return false;
  const value = at(item, declaration.field);
  if (value === MISSING || !declaration.values.some((v) => same(value, v)))
    return false;
  return !declaration.except.some((condition) => {
    const found = at(item, condition.field);
    if (found === MISSING) return false;
    return (
      'present' in condition || condition.values.some((v) => same(found, v))
    );
  });
}
