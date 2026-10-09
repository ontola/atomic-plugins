// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { OpenApiDocument } from '../../../src/browser.js';
import {
  deriveRuntimeClass,
  readRuntimeMembers,
  runtimeSchemasOf,
  type RuntimeSchema,
} from '../../../src/read/runtime-schemas.js';
import { userDefinedColumns } from '../../fixtures/runtime-schemas.js';

// The spec's own reading tests (`openapi-extensions/spec/runtime-schemas/
// test_validate.py`, `ReadingTests`), on the same TABLE and ROW, against
// deriveRuntimeClass and readRuntimeMembers, the ports of its
// `derive_class` and `read_members`. Each case names the Python test it
// mirrors.

const TABLE = {
  id: 't1',
  properties: {
    Estimate: { id: 'a%3Ab', name: 'Estimate', type: 'number', number: {} },
    Stage: {
      id: 'c%3Ad',
      name: 'Stage',
      type: 'select',
      select: {
        options: [
          { id: 'opt-1', name: 'Doing', color: 'blue' },
          { id: 'opt-2', name: 'Done', color: 'green' },
        ],
      },
    },
    Tags: {
      id: 'e%3Af',
      name: 'Tags',
      type: 'multi_select',
      multi_select: {
        options: [{ id: 'tag-1', name: 'urgent', color: 'red' }],
      },
    },
    Due: {
      id: 'g%3Ah',
      name: 'Due',
      type: 'formula',
      formula: { expression: 'now()' },
    },
  },
};

const ROW = {
  id: 'r1',
  parent: { table_id: 't1' },
  properties: {
    Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
    Stage: {
      id: 'c%3Ad',
      type: 'select',
      select: { id: 'opt-1', name: 'Doing', color: 'blue' },
    },
    Tags: {
      id: 'e%3Af',
      type: 'multi_select',
      multi_select: [{ id: 'tag-1', name: 'urgent' }],
    },
    Due: {
      id: 'g%3Ah',
      type: 'formula',
      formula: { type: 'string', string: 'x' },
    },
  },
};

type Json = Record<string, unknown>;
const copy = <T>(value: T): T => structuredClone(value);

/** The example's row declaration, changed by `change`, as the reader parses it. */
function runtime(
  change: (declaration: Json) => void = () => {},
): RuntimeSchema {
  const document = copy(userDefinedColumns);
  const crud = document.components!['crudResources'] as Record<string, Json>;
  change(crud['row']!['x-runtime-schema'] as Json);
  const failures = new Map<string, string>();
  const parsed = runtimeSchemasOf(document as OpenApiDocument, failures);
  expect([...failures]).toEqual([]);
  return parsed.get('row')!;
}

/** `match: key` without memberId and memberType, as the Python key tests. */
const byKey = (declaration: Json): void => {
  declaration['match'] = 'key';
  delete declaration['memberId'];
  delete declaration['memberType'];
};

const read = (
  schema: RuntimeSchema,
  table: unknown,
  row: Json,
): ReturnType<typeof readRuntimeMembers> =>
  readRuntimeMembers(schema, deriveRuntimeClass(schema, table), row);

const properties = (row: Json): Json => row['properties'] as Json;
const tableProperties = (table: Json): Record<string, Json> =>
  table['properties'] as Record<string, Json>;

describe('Runtime Schemas reference cases (ReadingTests)', () => {
  it('test_derive_class_keys_by_id_and_skips_undescribed_types', () => {
    const derived = deriveRuntimeClass(runtime(), TABLE);
    expect(Object.keys(derived.properties).sort()).toEqual([
      'a%3Ab',
      'c%3Ad',
      'e%3Af',
    ]);
    expect(derived.undescribed).toEqual(['g%3Ah']);
    const stage = derived.properties['c%3Ad']!;
    expect([stage.name, stage.type, stage.multiple]).toEqual([
      'Stage',
      'select',
      false,
    ]);
    expect(stage.options).toEqual({ 'opt-1': 'Doing', 'opt-2': 'Done' });
    expect(derived.properties['e%3Af']!.multiple).toBe(true);
  });

  it('test_read_members', () => {
    const result = read(runtime(), TABLE, ROW);
    expect(result.values).toEqual({
      'a%3Ab': 3,
      'c%3Ad': 'opt-1',
      'e%3Af': ['tag-1'],
    });
    expect(result.undescribed).toEqual(['Due']);
    expect(result.unmatched).toEqual([]);
  });

  it('test_rename_keeps_the_property_and_its_values', () => {
    const table = copy(TABLE) as Json;
    const columns = tableProperties(table);
    columns['Points'] = { ...columns['Estimate'], name: 'Points' };
    delete columns['Estimate'];
    const row = copy(ROW) as Json;
    properties(row)['Points'] = properties(row)['Estimate'];
    delete properties(row)['Estimate'];
    const schema = runtime();
    const derived = deriveRuntimeClass(schema, table);
    expect(derived.properties['a%3Ab']!.name).toBe('Points');
    expect(readRuntimeMembers(schema, derived, row).values['a%3Ab']).toBe(3);
    // A row read before the rename, under the old key, still matches by id.
    expect(readRuntimeMembers(schema, derived, ROW).values['a%3Ab']).toBe(3);
  });

  it('test_unknown_member_is_unmatched_not_guessed', () => {
    const row = copy(ROW) as Json;
    properties(row)['New'] = { id: 'z%3Az', type: 'number', number: 1 };
    const result = read(runtime(), TABLE, row);
    expect(result.unmatched).toEqual(['New']);
    expect(result.values).not.toHaveProperty('z%3Az');
  });

  it('test_retyped_definition_leaves_old_members_unmatched', () => {
    const table = copy(TABLE) as Json;
    tableProperties(table)['Estimate']!['type'] = 'checkbox';
    const result = read(runtime(), table, ROW);
    expect(result.unmatched).toContain('Estimate');
    expect(result.values).not.toHaveProperty('a%3Ab');
  });

  it('test_absent_member_is_no_value_and_null_select_stays_null', () => {
    const row = copy(ROW) as Json;
    delete properties(row)['Estimate'];
    (properties(row)['Stage'] as Json)['select'] = null;
    const { values } = read(runtime(), TABLE, row);
    expect(values).not.toHaveProperty('a%3Ab');
    expect(values['c%3Ad']).toBeNull();
  });

  it('test_removed_option_is_kept_as_its_id', () => {
    const table = copy(TABLE) as Json;
    (tableProperties(table)['Stage']!['select'] as Json)['options'] = [
      { id: 'opt-2', name: 'Done' },
    ];
    expect(read(runtime(), table, ROW).values['c%3Ad']).toBe('opt-1');
  });

  it.each([
    [{ name: 'Doing' }, [{ id: 'tag-1' }]], // option ref without an id
    ['opt-1', [{ id: 'tag-1' }]], // not an object
    [{ id: 'opt-1' }, { id: 'tag-1' }], // multiple, but not an array
    [{ id: 'opt-1' }, [{ id: 'tag-1' }, { x: 1 }]], // one ref without an id
    [{ id: 'opt-1' }, [{ id: 7 }]], // an id that is not a string
  ])(
    'test_wrong_option_shapes_are_invalid_not_values (%j, %j)',
    (stage, tags) => {
      const row = copy(ROW) as Json;
      (properties(row)['Stage'] as Json)['select'] = stage;
      (properties(row)['Tags'] as Json)['multi_select'] = tags;
      const result = read(runtime(), TABLE, row);
      const badStage =
        typeof stage !== 'object' || stage === null || !('id' in stage);
      const badTags =
        JSON.stringify(tags) !== JSON.stringify([{ id: 'tag-1' }]);
      const expected = [
        ...(badStage ? ['Stage'] : []),
        ...(badTags ? ['Tags'] : []),
      ];
      expect(result.invalid).toEqual(expected);
      // Never a sentinel as a value: a scalar, a list or null.
      for (const value of Object.values(result.values))
        expect(
          value === null ||
            Array.isArray(value) ||
            ['number', 'string', 'boolean'].includes(typeof value),
        ).toBe(true);
      if (badStage) expect(result.values).not.toHaveProperty('c%3Ad');
      if (badTags) expect(result.values).not.toHaveProperty('e%3Af');
    },
  );

  it('test_member_without_value_path_has_no_value', () => {
    const row = copy(ROW) as Json;
    delete (properties(row)['Estimate'] as Json)['number'];
    const result = read(runtime(), TABLE, row);
    expect(result.values).not.toHaveProperty('a%3Ab');
    expect([result.unmatched, result.invalid]).toEqual([[], []]);
  });

  it('test_duplicate_definition_ids_get_no_property', () => {
    const table = copy(TABLE) as Json;
    tableProperties(table)['Copy'] = {
      ...tableProperties(table)['Estimate'],
      name: 'Copy',
    };
    const schema = runtime();
    const derived = deriveRuntimeClass(schema, table);
    expect(derived.duplicates).toEqual(['a%3Ab']);
    expect(derived.properties).not.toHaveProperty('a%3Ab');
    const result = readRuntimeMembers(schema, derived, ROW);
    expect(result.values).not.toHaveProperty('a%3Ab');
    expect(result.undescribed).toContain('Estimate');
  });

  it('test_no_describer_gives_an_empty_class', () => {
    const schema = runtime();
    const derived = deriveRuntimeClass(schema, {});
    expect([
      derived.properties,
      derived.undescribed,
      derived.duplicates,
    ]).toEqual([{}, [], []]);
    const result = readRuntimeMembers(schema, derived, ROW);
    expect(result.values).toEqual({});
    expect([...result.unmatched].sort()).toEqual([
      'Due',
      'Estimate',
      'Stage',
      'Tags',
    ]);
  });

  it('test_option_without_a_name_is_kept_with_none', () => {
    const table = copy(TABLE) as Json;
    (
      (tableProperties(table)['Stage']!['select'] as Json)['options'] as Json[]
    ).push({ id: 'opt-3' });
    const options = deriveRuntimeClass(runtime(), table).properties['c%3Ad']!
      .options!;
    expect(options['opt-3']).toBeNull();
    expect(options['opt-1']).toBe('Doing');
  });

  it('test_duplicate_option_ids_keep_the_first_and_are_reported', () => {
    const table = copy(TABLE) as Json;
    (
      (tableProperties(table)['Stage']!['select'] as Json)['options'] as Json[]
    ).push({ id: 'opt-1', name: 'Again' });
    const derived = deriveRuntimeClass(runtime(), table);
    expect(derived.properties['c%3Ad']!.options!['opt-1']).toBe('Doing');
    expect(derived.duplicateOptions).toEqual({ 'c%3Ad': ['opt-1'] });
  });

  it('test_two_members_matching_one_definition_conflict', () => {
    const row = copy(ROW) as Json;
    properties(row)['Old estimate'] = {
      id: 'a%3Ab',
      type: 'number',
      number: 5,
    };
    const result = read(runtime(), TABLE, row);
    expect([...result.conflicting].sort()).toEqual([
      'Estimate',
      'Old estimate',
    ]);
    expect(result.values).not.toHaveProperty('a%3Ab');
  });

  it('test_key_matching_by_name_reports_undescribed_and_duplicate_names', () => {
    let schema = runtime(byKey);
    let result = read(schema, TABLE, ROW);
    // Due is a formula: undescribed, not unmatched, so no needless re-read.
    expect(result.undescribed).toEqual(['Due']);
    expect(result.unmatched).toEqual([]);
    schema = runtime((declaration) => {
      byKey(declaration);
      (declaration['describedBy'] as Json)['shape'] = 'array';
    });
    const table = {
      properties: [
        { id: 'x1', name: 'Points', type: 'number' },
        { id: 'x2', name: 'Points', type: 'number' },
      ],
    };
    const derived = deriveRuntimeClass(schema, table);
    expect(derived.duplicateNames).toEqual(['Points']);
    result = readRuntimeMembers(schema, derived, {
      properties: { Points: { number: 3 } },
    });
    expect([result.unmatched, result.values]).toEqual([['Points'], {}]);
  });

  it('test_repeated_id_with_another_name_is_undescribed_under_key_matching', () => {
    const schema = runtime((declaration) => {
      byKey(declaration);
      (declaration['describedBy'] as Json)['shape'] = 'array';
    });
    const table = {
      properties: [
        { id: 'x1', name: 'Points', type: 'number' },
        { id: 'x1', name: 'Score', type: 'number' },
      ],
    };
    const derived = deriveRuntimeClass(schema, table);
    expect(derived.duplicates).toEqual(['x1']);
    const result = readRuntimeMembers(schema, derived, {
      properties: { Points: { number: 1 }, Score: { number: 2 } },
    });
    expect([...result.undescribed].sort()).toEqual(['Points', 'Score']);
    expect(result.unmatched).toEqual([]);
  });

  it('test_a_name_that_is_not_a_string_does_not_crash', () => {
    const table = copy(TABLE) as Json;
    tableProperties(table)['Estimate']!['name'] = { text: 'Estimate' };
    const schema = runtime();
    const derived = deriveRuntimeClass(schema, table);
    expect(derived.properties['a%3Ab']!.name).toBe('Estimate'); // the map key
    expect(readRuntimeMembers(schema, derived, ROW).values['a%3Ab']).toBe(3);
  });

  it('test_array_definitions_and_key_matching', () => {
    // §7.2: definitions in an array, members keyed by id, the member is
    // the value. A document of its own, with a `form` describer.
    const document = {
      openapi: '3.0.3',
      info: { title: 'Forms', version: '1.0.0' },
      paths: {},
      components: {
        crudResources: {
          form: {
            identity: {
              urlTemplate: '/forms/{formId}',
              bindings: { formId: { field: 'id' } },
            },
          },
          entry: {
            identity: {
              urlTemplate: '/entries/{entryId}',
              bindings: { entryId: { field: 'id' } },
            },
            references: {
              form: {
                resource: 'form',
                bindings: { formId: { field: 'form_id' } },
              },
            },
            'x-runtime-schema': {
              field: 'fields',
              keyedBy: 'id',
              match: 'key',
              describedBy: {
                reference: 'form',
                definitions: 'fields',
                shape: 'array',
              },
              definition: { id: 'id', name: 'label', type: 'kind' },
              types: { text: { value: '', schema: { type: 'string' } } },
            },
          },
        },
      },
    } as unknown as OpenApiDocument;
    const schema = runtimeSchemasOf(document).get('entry')!;
    const form = {
      fields: [
        { id: 'f1', label: 'Name', kind: 'text' },
        { id: 'f2', label: 'Photo', kind: 'file' },
      ],
    };
    const derived = deriveRuntimeClass(schema, form);
    expect(derived.properties['f1']!.name).toBe('Name');
    expect(
      readRuntimeMembers(schema, derived, {
        fields: { f1: 'Ada', f2: 'x.png', f9: '?' },
      }),
    ).toEqual({
      values: { f1: 'Ada' },
      unmatched: ['f9'],
      undescribed: ['f2'],
      invalid: [],
      conflicting: [],
    });
  });
});

describe('Runtime Schemas: keys that are Object.prototype names (#435 re-review)', () => {
  it('leaves a member whose id is constructor unmatched, under match: id without memberType', () => {
    const schema = runtime((d) => delete d['memberType']);
    const row = copy(ROW) as Json;
    properties(row)['Odd'] = { id: 'constructor', type: 'number', number: 1 };
    properties(row)['Odder'] = { id: 'toString', type: 'number', number: 2 };
    const result = read(schema, TABLE, row);
    expect(result.unmatched).toEqual(['Odd', 'Odder']);
    expect(result.values).toEqual({
      'a%3Ab': 3,
      'c%3Ad': 'opt-1',
      'e%3Af': ['tag-1'],
    });
  });

  it('takes a definition type named toString as undescribed, unless the document describes it', () => {
    const table = copy(TABLE) as Json;
    tableProperties(table)['Odd'] = { id: 'o1', name: 'Odd', type: 'toString' };
    const row = copy(ROW) as Json;
    properties(row)['Odd'] = { id: 'o1', type: 'toString', toString: 'x' };
    let schema = runtime();
    expect(deriveRuntimeClass(schema, table).undescribed).toEqual([
      'g%3Ah',
      'o1',
    ]);
    expect(read(schema, table, row).undescribed).toEqual(['Due', 'Odd']);
    schema = runtime((d) => {
      (d['types'] as Json)['toString'] = {
        value: 'toString',
        schema: { type: 'string' },
      };
    });
    expect(read(schema, table, row).values['o1']).toBe('x');
  });

  it('keeps a definition id and an option id __proto__ as ordinary keys', () => {
    // JSON.parse makes "__proto__" an own key, as a provider's body would.
    const table = JSON.parse(`{
      "properties": {
        "Proto": { "id": "__proto__", "name": "Proto", "type": "number" },
        "Stage": { "id": "c%3Ad", "name": "Stage", "type": "select",
                   "select": { "options": [ { "id": "__proto__", "name": "Odd" } ] } }
      }
    }`) as Json;
    const row = JSON.parse(`{
      "properties": {
        "Proto": { "id": "__proto__", "type": "number", "number": 4 },
        "Stage": { "id": "c%3Ad", "type": "select", "select": { "id": "__proto__" } }
      }
    }`) as Json;
    const schema = runtime();
    const derived = deriveRuntimeClass(schema, table);
    expect(Object.keys(derived.properties)).toEqual(['__proto__', 'c%3Ad']);
    expect(derived.names['__proto__']).toBe('Proto');
    expect(Object.keys(derived.properties['c%3Ad']!.options!)).toEqual([
      '__proto__',
    ]);
    const result = readRuntimeMembers(schema, derived, row);
    expect(Object.keys(result.values)).toEqual(['__proto__', 'c%3Ad']);
    expect(result.values['__proto__']).toBe(4);
    expect(result.values['c%3Ad']).toBe('__proto__');
  });
});

describe('Runtime Schemas: declarations the reader refuses', () => {
  const failure = (change: (declaration: Json) => void): string | undefined => {
    const document = copy(userDefinedColumns);
    const crud = document.components!['crudResources'] as Record<string, Json>;
    change(crud['row']!['x-runtime-schema'] as Json);
    const failures = new Map<string, string>();
    runtimeSchemasOf(document as OpenApiDocument, failures);
    return failures.get('row');
  };

  it.each([
    [
      'an empty segment',
      (d: Json): void => void (d['field'] = 'a..b'),
      /malformed dot-path/,
    ],
    [
      'an unclosed bracket',
      (d: Json): void => void (d['memberId'] = '["a.b'),
      /memberId: malformed dot-path/,
    ],
    [
      'an empty field',
      (d: Json): void => void (d['field'] = ''),
      /field must not be empty/,
    ],
    [
      'no types',
      (d: Json): void => void (d['types'] = {}),
      /at least one entry/,
    ],
    [
      'a type without a schema',
      (d: Json): void =>
        void delete (d['types'] as Record<string, Json>)['number']!['schema'],
      /types\.number\.schema is required/,
    ],
    [
      'multiple without options',
      (d: Json): void =>
        void ((d['types'] as Record<string, Json>)['number']!['multiple'] =
          true),
      /multiple needs options/,
    ],
  ])('refuses %s', (_name, change, message) => {
    expect(failure(change)).toMatch(message);
  });

  it('accepts a bracketed segment and an empty value path (§3, §4.4)', () => {
    expect(
      failure((d) => {
        d['field'] = 'data.["user.fields"].values';
        (d['types'] as Record<string, Json>)['number']!['value'] = '';
      }),
    ).toBeUndefined();
  });
});
