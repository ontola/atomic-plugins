import type { SchemaObject } from '../openapi/types.js';

let stringCounter = 0;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * The most items or characters one array or string gets, whatever
 * `minItems` or `minLength` asks: past this a value is short of its
 * minimum rather than exhausting memory (`2 ** 30` would throw a
 * `RangeError`).
 */
const LENGTH_CAP = 10_000;

/**
 * The most array items and padding characters one `generateFromSchema`
 * call makes in all, so nested minimums (`minItems: 10000` inside
 * `minItems: 10000`) cannot multiply to 1e8 values. Past it, arrays are
 * empty and strings unpadded, short of their minimums.
 */
const SIZE_BUDGET = 100_000;

/** What is left of `SIZE_BUDGET` in one call. */
interface Budget {
  left: number;
}

/** Takes up to `wanted` from `budget`; returns what was granted. */
function take(budget: Budget, wanted: number): number {
  const granted = Math.max(0, Math.min(wanted, budget.left));
  budget.left -= granted;
  return granted;
}

/** `-0` as `0`, so a generated number serializes and compares plainly. */
const plain = (value: number): number => (value === 0 ? 0 : value);

/**
 * The next float above (`up`) or below `value`, for bounds past 2^53. At
 * `±Number.MAX_VALUE`, where the next one is infinite, `value` itself: the
 * bound is then not kept strictly, but the value stays a finite number.
 */
function nextFloat(value: number, up: boolean): number {
  if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  const bits = view.getBigUint64(0);
  view.setBigUint64(0, value > 0 === up ? bits + 1n : bits - 1n);
  const next = view.getFloat64(0);
  return Number.isFinite(next) ? next : value;
}

/** `value + 1`, or the next float above it where `+ 1` rounds back. */
const above = (value: number): number =>
  value + 1 > value ? value + 1 : nextFloat(value, true);

/** `value - 1`, or the next float below it where `- 1` rounds back. */
const below = (value: number): number =>
  value - 1 < value ? value - 1 : nextFloat(value, false);

/**
 * The smallest positive integer that is a multiple of `step` (5 for
 * 2.5, 1 for 0.5 or 1/3), from a short search of `step * k` for k up to
 * 1,000; undefined when none is found, and `multipleOf` is then not
 * followed.
 */
function integerStep(step: number): number | undefined {
  for (let k = 1; k <= 1000; k += 1) {
    const multiple = step * k;
    if (Number.isInteger(multiple)) return multiple;
  }
  return undefined;
}

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;

/**
 * The type to generate. OpenAPI 3.1 (JSON Schema) allows a list, such as
 * `['string', 'null']`: the first type that is not `null` is generated,
 * and `null` only when the list holds nothing else.
 */
function typeOf(schema: SchemaObject): string | undefined {
  const type: unknown = schema.type;
  if (typeof type === 'string') return type;
  if (!Array.isArray(type)) return undefined;
  const named = type.find(
    (entry): entry is string => typeof entry === 'string' && entry !== 'null',
  );
  return named ?? (type.includes('null') ? 'null' : undefined);
}

/**
 * Synthesizes a value matching a JSON Schema, preferring an `example`
 * on the schema itself when present, then the first of `examples`, then
 * `const`, then the first `enum` value.
 */
export function generateFromSchema(schema: SchemaObject | undefined): unknown {
  return generate(schema, { left: SIZE_BUDGET });
}

function generate(schema: SchemaObject | undefined, budget: Budget): unknown {
  if (!schema) {
    return null;
  }
  if (schema.example !== undefined) {
    return schema.example;
  }
  const examples: unknown = schema['examples'];
  if (Array.isArray(examples) && examples.length > 0) {
    return examples[0];
  }
  if (Object.hasOwn(schema, 'const')) {
    return schema['const'];
  }
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.allOf) {
    return schema.allOf.reduce<Record<string, unknown>>((merged, sub) => {
      const value = generate(sub, budget);
      return value && typeof value === 'object'
        ? { ...merged, ...(value as Record<string, unknown>) }
        : merged;
    }, {});
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generate(schema.oneOf[0], budget);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generate(schema.anyOf[0], budget);
  }

  switch (typeOf(schema)) {
    case 'string':
      return generateString(schema, budget);
    case 'integer':
      return generateInteger(schema);
    case 'number':
      return generateNumber(schema);
    case 'boolean':
      return true;
    case 'array':
      return generateArray(schema, budget);
    case 'object':
    case undefined:
      return generateObject(schema, budget);
    default:
      return null;
  }
}

function generateObject(
  schema: SchemaObject,
  budget: Budget,
): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    result[key] = generate(propertySchema, budget);
  }
  return result;
}

/**
 * One item, or `minItems` of them (at most `LENGTH_CAP`, and only what
 * is left of the call's `SIZE_BUDGET`), but never more than `maxItems`.
 * `uniqueItems` is not followed: the items may be equal.
 */
function generateArray(schema: SchemaObject, budget: Budget): unknown[] {
  const least = Math.min(
    LENGTH_CAP,
    Math.max(1, count(schema['minItems']) ?? 0),
  );
  const most = count(schema['maxItems']);
  const length = take(
    budget,
    most === undefined ? least : Math.min(least, most),
  );
  return Array.from({ length }, () => generate(schema.items, budget));
}

/**
 * The bounds a number must keep. OpenAPI 3.0 writes an exclusive bound as
 * `minimum` with `exclusiveMinimum: true`; 3.1 (JSON Schema) as a number
 * in `exclusiveMinimum`. Where both are given, the tighter one holds.
 */
function bounds(schema: SchemaObject): {
  low?: number;
  lowExclusive: boolean;
  high?: number;
  highExclusive: boolean;
} {
  let low = finite(schema.minimum);
  let lowExclusive = low !== undefined && schema['exclusiveMinimum'] === true;
  const exclusiveLow = finite(schema['exclusiveMinimum']);
  if (
    exclusiveLow !== undefined &&
    (low === undefined || exclusiveLow >= low)
  ) {
    low = exclusiveLow;
    lowExclusive = true;
  }
  let high = finite(schema['maximum']);
  let highExclusive = high !== undefined && schema['exclusiveMaximum'] === true;
  const exclusiveHigh = finite(schema['exclusiveMaximum']);
  if (
    exclusiveHigh !== undefined &&
    (high === undefined || exclusiveHigh <= high)
  ) {
    high = exclusiveHigh;
    highExclusive = true;
  }
  return {
    ...(low === undefined ? {} : { low }),
    lowExclusive,
    ...(high === undefined ? {} : { high }),
    highExclusive,
  };
}

/**
 * The least integer the lower bound allows, or 1 (or the upper bound,
 * when that is below 1) without one; then the next multiple of
 * `multipleOf`'s smallest integer multiple (`integerStep`). Where no
 * integer fits, the least one the lower bound allows. Past 2^53 the next
 * integer is the next float (`above`, `below`).
 */
function generateInteger(schema: SchemaObject): number {
  const { low, lowExclusive, high, highExclusive } = bounds(schema);
  const least =
    low === undefined
      ? undefined
      : lowExclusive
        ? above(Math.floor(low))
        : Math.ceil(low);
  const most =
    high === undefined
      ? undefined
      : highExclusive
        ? below(Math.ceil(high))
        : Math.floor(high);
  let value = least ?? Math.min(1, most ?? 1);
  const multipleOf = finite(schema['multipleOf']);
  const step =
    multipleOf !== undefined && multipleOf > 0
      ? integerStep(multipleOf)
      : undefined;
  if (step !== undefined) {
    const stepped = Math.ceil(value / step) * step;
    if (most === undefined || stepped <= most || least !== undefined)
      value = stepped;
    else value = Math.floor(most / step) * step;
  }
  return plain(value);
}

/**
 * An inclusive `minimum` when the bounds allow it (as before), else 1,
 * else a number inside the bounds; then, with `multipleOf`, the nearest
 * multiple at or above it that the bounds allow, else at or below it.
 * The multiple is `multipleOf * k` in floating point, so a step such as
 * 0.1 gives 0.30000000000000004 for 3, which a validator dividing in
 * floating point may still refuse. Where no multiple fits, the bounds
 * win and `multipleOf` is not followed.
 */
function generateNumber(schema: SchemaObject): number {
  const { low, lowExclusive, high, highExclusive } = bounds(schema);
  const fits = (value: number): boolean =>
    (low === undefined || (lowExclusive ? value > low : value >= low)) &&
    (high === undefined || (highExclusive ? value < high : value <= high));
  let value: number;
  if (low !== undefined && !lowExclusive && fits(low)) value = low;
  else if (fits(1)) value = 1;
  else if (high !== undefined && !highExclusive && fits(high)) value = high;
  else if (low !== undefined && high !== undefined) value = (low + high) / 2;
  else if (low !== undefined) value = above(low);
  else value = below(high as number);
  const step = finite(schema['multipleOf']);
  // A value that already divides evenly is kept: `ceil(1 / 1e-300) * 1e-300`
  // is 0.9999999999999999, not 1.
  if (step !== undefined && step > 0 && !Number.isInteger(value / step)) {
    const k = Math.ceil(value / step);
    const candidates = [k, k + 1, k - 1, k - 2].map((n) => n * step);
    const multiple = candidates.find(fits);
    if (multiple !== undefined) value = multiple;
  }
  return plain(value);
}

/**
 * A string for its `format`, or `string-<n>` padded to `minLength` (at
 * most `LENGTH_CAP`, and only by what is left of the call's
 * `SIZE_BUDGET`) and cut at `maxLength`. `maxLength` is not
 * followed for a formatted string (a `date-time` is 24 characters
 * whatever it says), and `pattern` is not followed at all.
 */
function generateString(schema: SchemaObject, budget: Budget): string {
  switch (schema.format) {
    case 'date-time':
      return new Date(0).toISOString();
    case 'date':
      return new Date(0).toISOString().slice(0, 10);
    case 'uuid':
      return '00000000-0000-4000-8000-000000000000';
    case 'email':
      return 'user@example.com';
    case 'uri':
    case 'url':
      return 'https://example.com';
    default: {
      stringCounter += 1;
      const value = `string-${stringCounter}`;
      const minimum = count(schema['minLength']);
      const least =
        minimum === undefined ? undefined : Math.min(minimum, LENGTH_CAP);
      const most = count(schema['maxLength']);
      const padded =
        least !== undefined && value.length < least
          ? value.padEnd(value.length + take(budget, least - value.length), 'x')
          : value;
      return most !== undefined && padded.length > most
        ? padded.slice(0, most)
        : padded;
    }
  }
}
