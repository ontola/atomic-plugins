import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  recursiveAtomicProjector,
  ATOMIC as P,
  META,
  atomicSchemaId,
} from '../../../src/daemon/recursive-atomic.js';
import { SOURCE_ID, SOURCE_JSON } from '../../../src/daemon/sync.js';
import { nodeHash, indexJson } from '../../../src/postgres/json-graph.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';

const document: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Invented API', version: '1' },
  paths: {},
  components: {
    crudResources: { note: { schema: { $ref: '#/components/schemas/Note' } } },
    schemas: {
      Note: {
        type: 'object',
        required: ['title'],
        properties: {
          title: { type: 'string' },
          checked: { type: 'boolean', default: false },
          child: { $ref: '#/components/schemas/Note' },
          tags: { type: 'array', items: { type: 'string', nullable: true } },
          amount: { type: 'number' },
          nullable: { type: 'string', nullable: true },
        },
      },
    },
  },
};
const hash = nodeHash(JSON.stringify(document));
const projector = () =>
  recursiveAtomicProjector({
    document,
    documentHash: hash,
    resource: 'note',
    namespace: 'invented/source/notes',
  });
const input = (body: string) => ({
  'urn:test:1': `{"@id":"urn:test:1","${SOURCE_ID}":"1","${SOURCE_JSON}":${body}}`,
});
const read = (result: ReturnType<ReturnType<typeof projector>['project']>) =>
  Object.fromEntries(
    Object.entries(result.resources).map(([id, raw]) => [id, JSON.parse(raw)]),
  );
const field = (path: string, name: string) =>
  atomicSchemaId(hash, path + '/properties/' + name + '/property');
const path = '#/components/schemas/Note';

describe('OpenAPI recursive Atomic representation', () => {
  it('resolves reference aliases and rejects alias-only cycles', () => {
    const aliases = structuredClone(document);
    aliases.components!.schemas!.Alias = { $ref: '#/components/schemas/Note' };
    const resources = aliases.components!.crudResources as Record<
      string,
      { schema: { $ref: string } }
    >;
    resources.note.schema.$ref = '#/components/schemas/Alias';
    const create = () =>
      recursiveAtomicProjector({
        document: aliases,
        documentHash: hash,
        resource: 'note',
        namespace: 'alias-test',
      });
    expect(create().project(input('{"title":"Alias"}')).records).toBe(1);
    aliases.components!.schemas!.Alias = { $ref: '#/components/schemas/Alias' };
    expect(create).toThrow('Cyclic OpenAPI schema alias');
  });
  it('makes the source wrapper reference typed rows, retaining boolean fields and recursive refs', () => {
    const result = projector().project(
      input('{"title":"First","checked":false,"child":{"title":"Second"}}'),
    );
    const rows = read(result),
      wrapper = rows['urn:test:1'];
    expect(wrapper[SOURCE_ID]).toBe('1');
    expect(typeof wrapper[SOURCE_JSON]).toBe('string');
    const note = rows[wrapper[SOURCE_JSON]];
    expect(note[field(path, 'title')]).toBe('First');
    expect(note[field(path, 'checked')]).toBe(false);
    expect(rows[field(path, 'checked')][P + 'datatype']).toBe(
      'https://atomicdata.dev/datatypes/boolean',
    );
    const child = rows[note[field(path, 'child')]];
    expect(child[field(path, 'title')]).toBe('Second');
    expect(child[P + 'isA']).toEqual(note[P + 'isA']);
    expect(rows[SOURCE_JSON][P + 'datatype']).toBe(
      'https://atomicdata.dev/datatypes/atomicURL',
    );
  });
  it('preserves array order, duplicates, empty arrays, and null distinct from absence', () => {
    const p = projector();
    const rows = read(
      p.project(
        input('{"title":"","tags":["same",null,"same"],"nullable":null}'),
      ),
    );
    const note = rows[rows['urn:test:1'][SOURCE_JSON]];
    const array = rows[note[field(path, 'tags')]];
    expect(array[META + 'length']).toBe(3);
    const entries = (array[META + 'entries'] as string[]).map((id) => rows[id]);
    expect(new Set(array[META + 'entries'] as string[]).size).toBe(3);
    expect(entries.map((entry) => entry[META + 'index'])).toEqual([0, 1, 2]);
    expect(entries[1][META + 'null']).toBe(true);
    const value = atomicSchemaId(hash, path + '/properties/tags/item-value');
    expect([entries[0][value], entries[2][value]]).toEqual(['same', 'same']);
    expect(note[META + 'null-properties']).toEqual([field(path, 'nullable')]);
    expect(note).not.toHaveProperty(field(path, 'checked'));
    const empty = read(p.project(input('{"title":"Empty","tags":[]}')));
    const emptyArray =
      empty[empty[empty['urn:test:1'][SOURCE_JSON]][field(path, 'tags')]];
    expect(emptyArray[META + 'length']).toBe(0);
    expect(emptyArray[META + 'entries']).toEqual([]);
  });
  it('does not round numeric lexemes or turn them into string properties', () => {
    const result = projector().project(
      input('{"title":"Numbers","amount":9007199254740993123.00100}'),
    );
    const noteId = read(result)['urn:test:1'][SOURCE_JSON];
    expect(result.resources[noteId]).toContain('9007199254740993123.00100');
    expect(result.resources[noteId]).not.toContain(
      '"9007199254740993123.00100"',
    );
    expect(indexJson(result.resources[noteId]).nodes.size).toBeGreaterThan(0);
    expect(read(result)[field(path, 'amount')][P + 'datatype']).toBe(
      'https://atomicdata.dev/datatypes/float',
    );
  });
  it('keeps declared schema IDs stable on empty reads, refresh, and source value changes', () => {
    const p = projector(),
      empty = read(p.project({}));
    const first = read(
      p.project(input('{"title":"First","unexpected":{"extra":[1,1]}}')),
    );
    const again = read(p.project({}));
    const noteClass = atomicSchemaId(hash, path);
    expect(first[noteClass]).toEqual(empty[noteClass]);
    expect(again).toEqual(empty);
    expect(
      Object.values(empty).some((row) => row[P + 'classtype'] === noteClass),
    ).toBe(true);
  });
  it('rejects declared type mismatches and unresolvable refs instead of weakening the schema', () => {
    expect(() =>
      projector().project(input('{"title":"Bad","checked":"false"}')),
    ).toThrow('OpenAPI type');
    expect(() =>
      projector().project(input('{"title":"Bad","checked":null}')),
    ).toThrow('Null violates');
    const bad = structuredClone(document);
    bad.components!.schemas!.Note.properties!.child.$ref = '#/missing';
    expect(() =>
      recursiveAtomicProjector({
        document: bad,
        documentHash: hash,
        resource: 'note',
        namespace: 'test',
      }),
    ).toThrow('Unresolved');
  });
  it('compiles the complete pinned Keep OAD, including checklist recursion, without account data', () => {
    const raw = readFileSync(
      new URL('../../../examples/daemon/google-keep.json', import.meta.url),
      'utf8',
    );
    const result = recursiveAtomicProjector({
      document: JSON.parse(raw),
      documentHash: nodeHash(raw),
      resource: 'note',
      namespace: 'keep-test',
    }).project({});
    const rows = read(result);
    const checked = Object.values(rows).filter(
      (row) => row[P + 'name'] === 'checked',
    );
    expect(checked).toHaveLength(1);
    expect(checked[0][P + 'datatype']).toBe(
      'https://atomicdata.dev/datatypes/boolean',
    );
  });
});
