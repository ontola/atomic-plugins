import { describe, expect, it } from 'vitest';
import { generateFromSchema } from '../../../src/fake-data/generate.js';

describe('generateFromSchema', () => {
  it('returns the schema example when present', () => {
    expect(generateFromSchema({ type: 'string', example: 'fixed' })).toBe(
      'fixed',
    );
  });

  it('returns the first enum value when present', () => {
    expect(generateFromSchema({ type: 'string', enum: ['a', 'b'] })).toBe('a');
  });

  it('generates an object from properties', () => {
    const value = generateFromSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        age: { type: 'integer' },
        active: { type: 'boolean' },
      },
    });

    expect(value).toEqual({
      name: expect.any(String),
      age: expect.any(Number),
      active: true,
    });
  });

  it('generates an array with one item matching the items schema', () => {
    const value = generateFromSchema({
      type: 'array',
      items: { type: 'string' },
    });

    expect(value).toEqual([expect.any(String)]);
  });

  it('merges allOf branches into a single object', () => {
    const value = generateFromSchema({
      allOf: [
        { type: 'object', properties: { name: { type: 'string' } } },
        {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      ],
    });

    expect(value).toEqual({
      name: expect.any(String),
      id: '00000000-0000-4000-8000-000000000000',
    });
  });

  it('returns null for an undefined schema', () => {
    expect(generateFromSchema(undefined)).toBeNull();
  });
});

// A generated value satisfies the schema it came from: the mock server
// seeds records and answers responses with these.
describe('generateFromSchema keeps to its schema', () => {
  it.each([
    [{ type: ['string', 'null'] }, expect.stringMatching(/^string-\d+$/)],
    [{ type: ['null', 'integer'] }, 1],
    [{ type: ['null'] }, null],
    [{ type: 'null' }, null],
    [
      { type: ['object', 'null'], properties: { a: { type: 'boolean' } } },
      { a: true },
    ],
  ])('reads the OpenAPI 3.1 type list %j', (schema, value) => {
    expect(generateFromSchema(schema as never)).toEqual(value);
  });

  it('prefers examples[0], then const, over enum and type', () => {
    expect(
      generateFromSchema({
        type: 'string',
        examples: ['e1', 'e2'],
        enum: ['a'],
      }),
    ).toBe('e1');
    expect(generateFromSchema({ type: 'integer', const: 7 })).toBe(7);
    expect(generateFromSchema({ type: 'string', const: null })).toBeNull();
  });

  it.each([
    ['maximum below 1', { type: 'integer', maximum: 0 }, 0],
    [
      '3.0 exclusiveMinimum',
      { type: 'integer', minimum: 1, exclusiveMinimum: true },
      2,
    ],
    ['3.1 exclusiveMinimum', { type: 'integer', exclusiveMinimum: 5 }, 6],
    ['3.1 exclusiveMaximum', { type: 'integer', exclusiveMaximum: 1 }, 0],
    [
      '3.0 exclusiveMaximum',
      { type: 'integer', maximum: 1, exclusiveMaximum: true },
      0,
    ],
    ['a fractional minimum', { type: 'integer', minimum: 0.5 }, 1],
    ['multipleOf', { type: 'integer', minimum: 1, multipleOf: 5 }, 5],
    [
      'multipleOf under a maximum',
      { type: 'integer', maximum: -1, multipleOf: 4 },
      -4,
    ],
    ['a kept inclusive minimum', { type: 'integer', minimum: 0 }, 0],
  ])('an integer under %s', (_label, schema, value) => {
    expect(generateFromSchema(schema as never)).toBe(value);
  });

  it.each([
    ['maximum below 1', { type: 'number', maximum: 0.25 }, 0.25],
    [
      '3.1 exclusive bounds',
      { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
      0.5,
    ],
    [
      '3.0 exclusiveMinimum',
      { type: 'number', minimum: 2, exclusiveMinimum: true },
      3,
    ],
    ['a kept inclusive minimum', { type: 'number', minimum: 0 }, 0],
  ])('a number under %s', (_label, schema, value) => {
    expect(generateFromSchema(schema as never)).toBe(value);
  });

  it('pads to minLength and cuts at maxLength', () => {
    const long = generateFromSchema({
      type: 'string',
      minLength: 20,
    }) as string;
    expect(long).toHaveLength(20);
    expect(long).toMatch(/^string-\d+x+$/);
    expect(generateFromSchema({ type: 'string', maxLength: 3 })).toBe('str');
  });

  it('keeps minItems and maxItems', () => {
    expect(
      generateFromSchema({
        type: 'array',
        items: { type: 'boolean' },
        minItems: 3,
      }),
    ).toEqual([true, true, true]);
    expect(
      generateFromSchema({
        type: 'array',
        items: { type: 'boolean' },
        maxItems: 0,
      }),
    ).toEqual([]);
  });
});
