import { isRecord } from '../read/model.js';

/**
 * RFC 7396 JSON Merge Patch: `patch` applied to `target`. A patch that is
 * not a JSON object replaces the target. Inside an object patch, a member
 * whose value is `null` removes that member from the target, an object
 * member merges into the target's member (which is created when it is not
 * an object), and any other value (an array included) replaces it. A member
 * whose value is `undefined` has no JSON form and is skipped. The target is
 * not changed; the result shares no objects with the patch.
 */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isRecord(patch)) return structuredClone(patch);
  const result: Record<string, unknown> = isRecord(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete result[key];
    // Defined, not assigned: a `__proto__` member is data, not the prototype.
    else
      Object.defineProperty(result, key, {
        value: mergePatch(result[key], value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}

/**
 * The value a record field has after the merge-patch member `patch` is
 * applied to its value `current`: `undefined` (the field is absent) for a
 * `null` member.
 */
export function patchedField(current: unknown, patch: unknown): unknown {
  return patch === null ? undefined : mergePatch(current, patch);
}

/**
 * `patch` without what a later merge patch `later` sets: a member `later`
 * sets is dropped, except that where both are objects only the nested
 * members `later` sets are, recursively; an object left empty is dropped
 * too. Neither argument is changed.
 */
export function withoutPatched(
  patch: Record<string, unknown>,
  later: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...patch };
  for (const [key, value] of Object.entries(later)) {
    if (value === undefined || !Object.hasOwn(result, key)) continue;
    const own = result[key];
    if (isRecord(own) && isRecord(value)) {
      const left = withoutPatched(own, value);
      if (Object.keys(left).length)
        Object.defineProperty(result, key, {
          value: left,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      else delete result[key];
    } else delete result[key];
  }
  return result;
}

/** `mergePatch` for a record and an object patch, typed as a record. */
export function mergePatchRecord(
  target: Record<string, unknown> | undefined,
  patch: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return mergePatch(target ?? {}, patch ?? {}) as Record<string, unknown>;
}
