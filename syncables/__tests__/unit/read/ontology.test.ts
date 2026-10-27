// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { datatypeOf } from '../../../src/read/ontology.js';
import {
  DATATYPES,
  deriveOntology,
  readPlatform,
  type OpenApiDocument,
  type SchemaObject,
  type Transport,
} from '../../../src/browser.js';

// The ontology readPlatform types values by (deriveOntology): an OpenAPI
// 3.1 type list, a title or field name without a letter or digit, and a
// field typed differently in two resources. Invented documents.

function document(
  properties: Record<string, unknown>,
  title = 'Notes API',
  more: Record<string, unknown> = {},
): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title, version: '1' },
    servers: [{ url: 'https://api.example.com' }],
    paths: {
      '/notes': {
        get: {
          responses: {
            '200': {
              description: 'Notes',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
    },
    components: {
      crudResources: {
        note: {
          schema: { type: 'object', properties },
          identity: {
            urlTemplate: '/notes/{noteId}',
            bindings: { noteId: { field: 'id' } },
          },
          collections: { notes: { urlTemplate: '/notes' } },
        },
        ...more,
      },
    },
  } as unknown as OpenApiDocument;
}

describe('datatypeOf', () => {
  it.each([
    [{ type: ['string', 'null'], format: 'date-time' }, DATATYPES.timestamp],
    [{ type: ['null', 'string'], format: 'date' }, DATATYPES.date],
    [{ type: ['string', 'null'] }, DATATYPES.string],
    [{ type: ['integer', 'null'] }, DATATYPES.integer],
    [{ type: ['number'] }, DATATYPES.float],
    [{ type: ['boolean', 'null'] }, DATATYPES.boolean],
    [{ type: ['string', 'integer'] }, undefined],
    [{ type: ['null'] }, undefined],
    [{ type: [] }, undefined],
  ])('reads the OpenAPI 3.1 type list of %j', (schema, datatype) => {
    expect(datatypeOf(schema as unknown as SchemaObject)).toBe(datatype);
  });
});

describe('deriveOntology', () => {
  it('types a nullable 3.1 field by its one non-null type', () => {
    const terms = deriveOntology(
      document({
        id: { type: 'string' },
        due: { type: ['string', 'null'], format: 'date-time' },
        count: { type: ['integer', 'null'] },
      }),
    ).terms;
    expect(
      Object.fromEntries(terms.map((t) => [t.shortname, t.datatype])),
    ).toMatchObject({
      due: DATATYPES.timestamp,
      count: DATATYPES.integer,
    });
  });

  it('falls back to the default base for a title without a letter or digit', () => {
    const terms = deriveOntology(
      document({ id: { type: 'string' } }, '日本語'),
    ).terms;
    expect(terms.map((t) => t.path)).toEqual([
      'ontology/property/id',
      'ontology/class/note',
    ]);
  });

  it('gives no term to a field without a letter or digit', () => {
    const terms = deriveOntology(
      document({ id: { type: 'string' }, _: { type: 'string' } }),
    ).terms;
    expect(terms.map((t) => t.path)).toEqual([
      'notes-api/property/id',
      'notes-api/class/note',
    ]);
  });

  it('refuses a resource name without a letter or digit', () => {
    expect(() =>
      deriveOntology(
        document({ id: { type: 'string' } }, 'Notes API', {
          _: {
            schema: { type: 'object', properties: {} },
            collections: { other: { urlTemplate: '/other' } },
          },
        }),
      ),
    ).toThrow(/"_" has no letter or digit/);
  });

  it('types a field json once two resources disagree, and keeps it so', () => {
    const terms = deriveOntology(
      document({ id: { type: 'string' }, size: { type: 'integer' } }, 'X', {
        box: {
          schema: { type: 'object', properties: { size: { type: 'string' } } },
        },
        bag: {
          schema: { type: 'object', properties: { size: { type: 'integer' } } },
        },
      }),
    ).terms;
    expect(terms.find((t) => t.shortname === 'size')?.datatype).toBe(
      DATATYPES.json,
    );
  });
});

describe('readPlatform', () => {
  it('converts a nullable 3.1 date-time field to a timestamp', async () => {
    const transport: Transport = async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify([
        { id: 'n1', due: '2026-10-15T12:00:00Z' },
        { id: 'n2', due: null },
      ]),
    });
    const { records } = await readPlatform(
      document({
        id: { type: 'string' },
        due: { type: ['string', 'null'], format: 'date-time' },
      }),
      { platform: 'notes', constants: {}, transport },
    );
    expect(records.map((r) => r.values)).toEqual([
      { id: 'n1', due: Date.parse('2026-10-15T12:00:00Z') },
      { id: 'n2' },
    ]);
  });
});
