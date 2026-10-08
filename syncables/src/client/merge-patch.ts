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
    else result[key] = mergePatch(result[key], value);
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
