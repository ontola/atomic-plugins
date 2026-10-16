/**
 * The pure half of the Overlay support, with no file system access, so the
 * browser entry (`syncables/browser`) can import it. `loadOverlay`, which
 * reads a file path, lives in `overlay.ts`; that module re-exports
 * everything here, so existing Node imports keep working.
 */

export interface OverlayAction {
  target: string;
  /**
   * Merged onto the target when both are objects; otherwise it replaces the
   * target (an array included, as integration-proxy does).
   */
  update?: Record<string, unknown> | unknown[];
  remove?: boolean;
  [key: string]: unknown;
}

export interface OverlayDocument {
  overlay: string;
  info: { title: string; version: string };
  actions: OverlayAction[];
  [key: string]: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An own property's value, never an inherited one (`__proto__` included). */
const own = (object: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * Sets an own, enumerable property, as `JSON.parse` does. Plain assignment
 * of a key named `__proto__` would set the object's prototype instead.
 */
function define(
  object: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function deepMergeValue(existing: unknown, incoming: unknown): unknown {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      define(merged, key, deepMergeValue(own(merged, key), value));
    }
    return merged;
  }
  return incoming;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Splits an action target into member names, with the grammar
 * integration-proxy's `catalog.rs` `parse_target` accepts (and the
 * overlays' own Python check mirrors): `$`, then any number of `.name`
 * segments (up to the next `.` or `[`) or `['name']` segments (up to the
 * next `']`, so a name may hold `/`, `.`, `{` or `[`). Anything else,
 * wildcards, filters, array indexes, `["name"]` and `..` included, is
 * refused rather than read as something else. Nothing is unescaped, as in
 * the proxy: `['a\'b']` names `a\'b`, and `['a']b']` is refused. Unlike
 * the proxy, a `__proto__` segment is refused too, so that no target can
 * reach an object's prototype.
 */
export function parseOverlayTarget(target: string): string[] {
  const refuse = (): Error =>
    new Error(
      `Unsupported overlay target ${JSON.stringify(target)}: only "$" followed by .name or ['name'] segments is supported`,
    );
  if (typeof target !== 'string' || !target.startsWith('$')) throw refuse();
  let rest = target.slice(1);
  const keys: string[] = [];
  while (rest !== '') {
    if (rest.startsWith('.')) {
      const after = rest.slice(1);
      const found = after.search(/[.[]/);
      const end = found === -1 ? after.length : found;
      if (end === 0) throw refuse();
      keys.push(after.slice(0, end));
      rest = after.slice(end);
    } else if (rest.startsWith("['")) {
      const after = rest.slice(2);
      const end = after.indexOf("']");
      if (end === -1) throw refuse();
      keys.push(after.slice(0, end));
      rest = after.slice(end + 2);
    } else throw refuse();
  }
  if (keys.includes('__proto__'))
    throw new Error(
      `Unsupported overlay target ${JSON.stringify(target)}: a __proto__ segment is refused`,
    );
  return keys;
}

function navigate(
  root: Record<string, unknown>,
  segments: string[],
  createMissing: boolean,
): Record<string, unknown> | undefined {
  let node = root;
  for (const segment of segments) {
    let child = own(node, segment);
    if (child === undefined) {
      if (!createMissing) {
        return undefined;
      }
      child = {};
      define(node, segment, child);
    }
    if (!isPlainObject(child)) {
      throw new Error(
        `Overlay target segment "${segment}" does not resolve to an object`,
      );
    }
    node = child;
  }
  return node;
}

/**
 * Applies an OpenAPI Overlay (https://spec.openapis.org/overlay/v1.0.0.html)
 * to a document, returning a new document. Supports `update` and `remove`
 * actions, with the targets `parseOverlayTarget` accepts. An `update`
 * object is deep-merged onto an object target; any other `update`, or any
 * `update` onto a target that is not an object (an array, a scalar),
 * replaces the target, as integration-proxy does. Overlay 1.0 would
 * instead append to an array target. Missing objects along the target path
 * are created.
 */
export function applyOverlay<T extends Record<string, unknown>>(
  document: T,
  overlay: OverlayDocument,
): T {
  const result = deepClone(document) as Record<string, unknown>;

  for (const action of overlay.actions) {
    const segments = parseOverlayTarget(action.target);
    if (action.remove) {
      if (segments.length === 0) {
        throw new Error('Overlay cannot remove the document root');
      }
      const key = segments[segments.length - 1] as string;
      const parent = navigate(result, segments.slice(0, -1), false);
      if (parent) {
        delete parent[key];
      }
    } else if (action.update !== undefined) {
      const update: unknown = action.update;
      if (segments.length === 0) {
        if (!isPlainObject(update))
          throw new Error('Overlay cannot replace the document root');
        for (const [key, value] of Object.entries(deepClone(update)))
          define(result, key, deepMergeValue(own(result, key), value));
        continue;
      }
      const key = segments[segments.length - 1] as string;
      const parent = navigate(result, segments.slice(0, -1), true) as Record<
        string,
        unknown
      >;
      const current = own(parent, key);
      define(
        parent,
        key,
        deepMergeValue(current === undefined ? {} : current, deepClone(update)),
      );
    }
  }

  return result as T;
}
