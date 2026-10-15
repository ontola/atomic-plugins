import type { SchemaObject } from '../openapi/types.js';

let stringCounter = 0;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

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
      const value = generateFromSchema(sub);
      return value && typeof value === 'object'
        ? { ...merged, ...(value as Record<string, unknown>) }
        : merged;
    }, {});
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateFromSchema(schema.oneOf[0]);
  }
  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateFromSchema(schema.anyOf[0]);
  }

  switch (typeOf(schema)) {
    case 'string':
      return generateString(schema);
    case 'integer':
      return generateInteger(schema);
    case 'number':
      return generateNumber(schema);
    case 'boolean':
      return true;
    case 'array':
      return generateArray(schema);
    case 'object':
    case undefined:
      return generateObject(schema);
    default:
      return null;
  }
}

function generateObject(schema: SchemaObject): Record<string, unknown> {
  const properties = schema.properties ?? {};
  const result: Record<string, unknown> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    result[key] = generateFromSchema(propertySchema);
  }
  return result;
}

/** One item, or `minItems` of them, but never more than `maxItems`. */
function generateArray(schema: SchemaObject): unknown[] {
  const least = Math.max(1, count(schema['minItems']) ?? 0);
  const most = count(schema['maxItems']);
  const length = most === undefined ? least : Math.min(least, most);
  return Array.from({ length }, () => generateFromSchema(schema.items));
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
 * when that is below 1) without one; then the next multiple of an
 * integer `multipleOf`. Where no integer fits, the least one the lower
 * bound allows.
 */
function generateInteger(schema: SchemaObject): number {
  const { low, lowExclusive, high, highExclusive } = bounds(schema);
  const least =
    low === undefined
      ? undefined
      : lowExclusive
        ? Math.floor(low) + 1
        : Math.ceil(low);
  const most =
    high === undefined
      ? undefined
      : highExclusive
        ? Math.ceil(high) - 1
        : Math.floor(high);
  let value = least ?? Math.min(1, most ?? 1);
  const step = finite(schema['multipleOf']);
  if (step !== undefined && step > 0 && Number.isInteger(step)) {
    const stepped = Math.ceil(value / step) * step;
    if (most === undefined || stepped <= most || least !== undefined)
      value = stepped;
    else value = Math.floor(most / step) * step;
  }
  return value;
}

/**
 * An inclusive `minimum` when the bounds allow it (as before), else 1,
 * else a number inside the bounds.
 */
function generateNumber(schema: SchemaObject): number {
  const { low, lowExclusive, high, highExclusive } = bounds(schema);
  const fits = (value: number): boolean =>
    (low === undefined || (lowExclusive ? value > low : value >= low)) &&
    (high === undefined || (highExclusive ? value < high : value <= high));
  if (low !== undefined && !lowExclusive && fits(low)) return low;
  if (fits(1)) return 1;
  if (high !== undefined && !highExclusive && fits(high)) return high;
  if (low !== undefined && high !== undefined) return (low + high) / 2;
  if (low !== undefined) return low + 1;
  return (high as number) - 1;
}

function generateString(schema: SchemaObject): string {
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
      const least = count(schema['minLength']);
      const most = count(schema['maxLength']);
      const padded =
        least !== undefined && value.length < least
          ? value.padEnd(least, 'x')
          : value;
      return most !== undefined && padded.length > most
        ? padded.slice(0, most)
        : padded;
    }
  }
}
