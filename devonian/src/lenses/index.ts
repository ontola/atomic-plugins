/** Synchronous, effect-free value lenses. Providers and hosts own I/O. */
export type SourceKey<Source> = Extract<keyof Source, string>;
export type LensEquality<Value> = (left: Value, right: Value) => boolean;

export interface ValueLens<Source, View> {
  readonly reads: readonly SourceKey<Source>[];
  readonly writes: readonly SourceKey<Source>[];
  readonly equal: LensEquality<View>;
  get(source: Source): View;
  put(view: View, previous: Source): Source;
}

export interface LensPatch<Source> {
  set?: Partial<Source>;
  unset?: readonly SourceKey<Source>[];
}

/** Structural equality for JSON-like data, including missing vs undefined keys.
 * Other value types require a caller-supplied equality function. */
export function lensEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      Object.keys(left).length === Object.keys(right).length &&
      left.every(
        (value, index) =>
          Object.hasOwn(right, index) && lensEqual(value, right[index]),
      )
    );
  if (
    Object.prototype.toString.call(left) !== '[object Object]' ||
    Object.prototype.toString.call(right) !== '[object Object]'
  )
    return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && lensEqual(a[key], b[key]))
  );
}

export interface CustomLensOptions<Source extends object, View> {
  reads: readonly SourceKey<Source>[];
  writes: readonly SourceKey<Source>[];
  get(source: Source): View;
  /** Return a patch over owned top-level fields; deletion is explicit. */
  put(view: View, previous: Source): LensPatch<Source>;
  equal?: LensEquality<View>;
}

/** Callbacks receive detached copies. Unchanged views retain the complete
 * previous representation, including nulls, formatting and absent fields. */
export function customLens<Source extends object, View>(
  options: CustomLensOptions<Source, View>,
): ValueLens<Source, View> {
  const reads = Object.freeze([...new Set(options.reads)]);
  const writes = Object.freeze([...new Set(options.writes)]);
  const owned = new Set<string>(writes);
  const equal = options.equal ?? lensEqual;
  const read = options.get;
  const write = options.put;
  const get = (source: Source): View =>
    structuredClone(read(structuredClone(source)));
  return Object.freeze({
    reads,
    writes,
    equal,
    get,
    put(view: View, previous: Source): Source {
      if (equal(structuredClone(view), get(previous)))
        return structuredClone(previous);
      if (!writes.length) throw new Error('This lens is read-only');
      const patch = write(structuredClone(view), structuredClone(previous));
      const set: Partial<Source> = patch.set ?? {};
      const unset = patch.unset ?? [];
      for (const key of [...Object.keys(set), ...unset]) {
        if (!owned.has(key)) throw new Error(`Lens does not own field ${key}`);
        if (unset.includes(key as SourceKey<Source>) && Object.hasOwn(set, key))
          throw new Error(`Lens both sets and removes field ${key}`);
      }
      const result = structuredClone(previous);
      for (const key of Object.keys(set) as SourceKey<Source>[])
        Object.defineProperty(result, key, {
          value: structuredClone(set[key]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      for (const key of unset) delete result[key];
      return result;
    },
  });
}

/** A direct field mapping. Use a custom lens for coercion or optional removal. */
export function fieldLens<Source extends object, Key extends SourceKey<Source>>(
  key: Key,
): ValueLens<Source, Source[Key]> {
  return customLens({
    reads: [key],
    writes: [key],
    get: (source) => source[key],
    put: (value) => {
      const set: Partial<Source> = {};
      Object.defineProperty(set, key, {
        value,
        enumerable: true,
        configurable: true,
      });
      return { set };
    },
  });
}

export function readOnlyLens<Source extends object, View>(
  reads: readonly SourceKey<Source>[],
  get: (source: Source) => View,
): ValueLens<Source, View> {
  return customLens({
    reads,
    writes: [],
    get,
    put: () => {
      throw new Error('This lens is read-only');
    },
  });
}

export type RecordBindings<Source, View> = {
  [Key in keyof View]: ValueLens<Source, View[Key]>;
};

/** Independent fields read the same original snapshot. Overlapping writes
 * must be represented as one composite lens, rather than depend on order. */
export function recordLens<Source extends object, View extends object>(
  bindings: RecordBindings<Source, View>,
  validate?: (view: View, previous: Source) => void,
): ValueLens<Source, View> {
  const keys = Object.keys(bindings) as Extract<keyof View, string>[];
  const entries = keys.map((key) => [key, bindings[key]] as const);
  const owners = new Map<string, string>();
  for (const [key, lens] of entries)
    for (const field of lens.writes) {
      const owner = owners.get(field);
      if (owner !== undefined)
        throw new Error(`Field ${field} is owned by both ${owner} and ${key}`);
      owners.set(field, key);
    }
  return customLens({
    reads: entries.flatMap(([, lens]) => [...lens.reads]),
    writes: entries.flatMap(([, lens]) => [...lens.writes]),
    equal: (a, b) =>
      Object.keys(a).length === keys.length &&
      Object.keys(b).length === keys.length &&
      entries.every(
        ([key, lens]) =>
          Object.hasOwn(a, key) &&
          Object.hasOwn(b, key) &&
          lens.equal(a[key], b[key]),
      ),
    get: (source) =>
      Object.fromEntries(
        entries.map(([key, lens]) => [key, lens.get(source)]),
      ) as View,
    put: (view, previous) => {
      if (
        Object.keys(view).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(view, key))
      )
        throw new Error('View must contain exactly the declared lens fields');
      validate?.(view, previous);
      const set: Partial<Source> = {};
      const unset: SourceKey<Source>[] = [];
      for (const [key, lens] of entries) {
        const result = lens.put(view[key], previous);
        for (const field of lens.writes)
          if (Object.hasOwn(result, field))
            Object.defineProperty(set, field, {
              value: result[field],
              enumerable: true,
              configurable: true,
            });
          else unset.push(field);
      }
      return { set, unset };
    },
  });
}

/** Sequential composition: put through the inner view, then the outer source.
 * Domain compatibility remains the caller's responsibility. */
export function composeLenses<Source, Middle, View>(
  outer: ValueLens<Source, Middle>,
  inner: ValueLens<Middle, View>,
): ValueLens<Source, View> {
  return Object.freeze({
    reads: outer.reads,
    writes: outer.writes,
    equal: inner.equal,
    get: (source: Source): View => inner.get(outer.get(source)),
    put: (view: View, previous: Source): Source =>
      outer.put(inner.put(view, outer.get(previous)), previous),
  });
}

/** Executable examples, not a proof for all inputs or a distributed protocol.
 * Unsupported edits throw. Source equality can express a normalization policy. */
export function checkLensLaws<Source, View>(
  lens: ValueLens<Source, View>,
  source: Source,
  view: View,
  sourceEqual: LensEquality<Source> = lensEqual,
): { getPut: boolean; putGet: boolean; stablePut: boolean } {
  const updated = lens.put(view, source);
  return {
    getPut: sourceEqual(lens.put(lens.get(source), source), source),
    putGet: lens.equal(lens.get(updated), view),
    stablePut: sourceEqual(lens.put(view, updated), updated),
  };
}
