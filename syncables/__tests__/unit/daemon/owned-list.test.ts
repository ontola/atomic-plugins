import { describe, expect, it } from 'vitest';
import {
  projectOwnedList,
  type OwnedListProfile,
} from '../../../src/daemon/owned-list.js';
import type {
  NativeResource,
  NativeTableProjection,
  NativeValue,
} from '../../../src/daemon/atomic-tables.js';

const P = 'https://atomicdata.dev/properties/';
const C = 'https://atomicdata.dev/classes/';
const D = 'https://atomicdata.dev/datatypes/';
const local = (key: string): { local: string } => ({ local: key });
const external = (key: string): { external: string } => ({ external: key });
const string = (value: string): NativeValue => ({ type: 'string', value });
const resources = (...keys: string[]): NativeValue => ({
  type: 'resources',
  value: keys.map(local),
});
const profile: OwnedListProfile = {
  id: 'invented-owned-list',
  version: '1',
  rootClassName: 'Document',
  listClassName: 'Checklist',
  itemClassName: 'Entry',
  listAt: ['payload'],
  itemsAt: ['entries'],
  childrenAt: ['children'],
  itemFields: [
    {
      shortname: 'text',
      name: 'Text',
      path: ['value', 'text'],
      datatype: 'string',
      displayName: true,
    },
    {
      shortname: 'checked',
      name: 'Checked',
      path: ['done'],
      datatype: 'boolean',
      optional: true,
    },
  ],
};
function fixture(
  body: unknown = {
    payload: {
      entries: [
        {
          value: { text: 'Duplicate' },
          done: false,
          children: [{ value: { text: 'Child' }, done: true }],
        },
        { value: { text: 'Duplicate' } },
      ],
    },
    unknown: { exact: [null, false, 'keep'] },
  },
): NativeTableProjection {
  const property = (key: string, datatype: string): NativeResource => ({
    key,
    parent: local('schemas'),
    classes: [external(C + 'Property')],
    properties: [
      { property: external(P + 'name'), value: string(key) },
      { property: external(P + 'shortname'), value: string(key) },
      {
        property: external(P + 'description'),
        value: string('Invented source field ' + key),
      },
      {
        property: external(P + 'datatype'),
        value: { type: 'resource', value: external(D + datatype) },
      },
    ],
  });
  const bodyProperty = property('body', 'json');
  bodyProperty.properties.push({
    property: external(P + 'jsonSchema'),
    value: {
      type: 'json',
      value: { type: 'object', additionalProperties: true },
    },
  });
  return {
    format: 'atomic-tables-v2',
    owner: 'atomic:agent:invented',
    revision: 'f'.repeat(64),
    sources: [
      {
        collection: 'invented/work/documents',
        revision: 'a'.repeat(64),
        documentHash: 'b'.repeat(64),
      },
    ],
    resources: [
      {
        key: 'schemas',
        parent: local('drive'),
        classes: [external(C + 'Folder')],
        properties: [],
      },
      {
        key: 'class',
        parent: local('schemas'),
        classes: [external(C + 'Class')],
        properties: [
          { property: external(P + 'name'), value: string('Original') },
          { property: external(P + 'shortname'), value: string('original') },
          {
            property: external(P + 'description'),
            value: string('Invented source record schema'),
          },
          { property: external(P + 'requires'), value: resources('title') },
          {
            property: external(P + 'recommends'),
            value: resources('body', 'source-revision'),
          },
        ],
      },
      bodyProperty,
      property('title', 'string'),
      property('source-revision', 'string'),
      {
        key: 'row',
        parent: local('unrelated-table'),
        classes: [local('class')],
        properties: [
          {
            property: external(P + 'name'),
            value: string('Selected document'),
          },
          {
            property: local('body'),
            value: { type: 'json', value: body as never },
          },
          { property: local('title'), value: string('Selected document') },
          { property: local('source-revision'), value: string('a'.repeat(64)) },
        ],
      },
      {
        key: 'other-row',
        parent: local('unrelated-table'),
        classes: [local('class')],
        properties: [
          { property: external(P + 'name'), value: string('Unrelated') },
        ],
      },
      {
        key: 'unrelated-table',
        parent: local('drive'),
        classes: [external(C + 'Table')],
        properties: [],
      },
    ],
  };
}
const propertyName = (r: NativeResource): string | undefined =>
  r.properties.find(
    (pair) =>
      'external' in pair.property && pair.property.external === P + 'name',
  )?.value.value as string | undefined;
function named(plan: NativeTableProjection, name: string): NativeResource {
  return plan.resources.find((r) => propertyName(r) === name)!;
}
function value(
  plan: NativeTableProjection,
  row: NativeResource,
  name: string,
): NativeValue | undefined {
  const property = named(plan, name);
  return row.properties.find(
    (pair) => 'local' in pair.property && pair.property.local === property?.key,
  )?.value;
}
function classed(plan: NativeTableProjection, name: string): NativeResource[] {
  const cls = named(plan, name);
  return plan.resources.filter((r) =>
    r.classes.some((c) => 'local' in c && c.local === cls?.key),
  );
}
const project = (base = fixture(), p = profile): NativeTableProjection =>
  projectOwnedList(base, { rowKey: 'row', bodyPropertyKey: 'body' }, p);

describe('generic snapshot owned-list projection', () => {
  it('opens the typed List with the data browser table view', () => {
    const plan = project();
    const [list] = classed(plan, 'List');
    expect(list.classes[0]).toEqual(external(C + 'Table'));
    expect(list.classes).toContainEqual(local(named(plan, 'List').key));
  });

  it('declares the mandatory Atomic Property and Class schema fields for public signed publication', () => {
    const plan = project();
    for (const resource of plan.resources) {
      const is = (name: string): boolean =>
        resource.classes.some(
          (cls) => 'external' in cls && cls.external === C + name,
        );
      if (!is('Property') && !is('Class')) continue;
      for (const name of ['shortname', 'description']) {
        const field = resource.properties.find(
          (entry) =>
            'external' in entry.property &&
            entry.property.external === P + name,
        )?.value;
        expect(field?.type).toBe('string');
        expect(typeof field?.value === 'string' && field.value.length > 0).toBe(
          true,
        );
      }
      if (is('Property'))
        expect(
          resource.properties.find(
            (entry) =>
              'external' in entry.property &&
              entry.property.external === P + 'datatype',
          )?.value.type,
        ).toBe('resource');
    }
  });
  it('preserves duplicate entries, preorder, explicit false, nesting and exact original JSON', () => {
    const base = fixture(),
      before = structuredClone(base),
      plan = project(base);
    expect(base).toEqual(before);
    const root = classed(plan, 'Document')[0],
      list = classed(plan, 'Checklist')[0],
      items = classed(plan, 'Entry');
    expect(value(plan, root, 'Body')).toEqual({
      type: 'resource',
      value: local(list.key),
    });
    expect(value(plan, root, 'Original body')).toEqual(
      base.resources.find((r) => r.key === 'row')!.properties[1].value,
    );
    expect(list.parent).toEqual(local(root.key));
    expect(list.classes).toContainEqual(external(C + 'Table'));
    expect(items).toHaveLength(3);
    const ordered = [...items].sort(
      (a, b) =>
        (value(plan, a, 'Position')!.value as number) -
        (value(plan, b, 'Position')!.value as number),
    );
    expect(ordered.map(propertyName)).toEqual([
      'Duplicate',
      'Child',
      'Duplicate',
    ]);
    expect(ordered.map((r) => value(plan, r, 'Position')?.value)).toEqual([
      0, 1, 2,
    ]);
    expect(ordered.map((r) => value(plan, r, 'Checked'))).toEqual([
      { type: 'boolean', value: false },
      { type: 'boolean', value: true },
      undefined,
    ]);
    expect(
      ordered.every(
        (item) =>
          JSON.stringify(item.parent) === JSON.stringify(local(list.key)),
      ),
    ).toBe(true);
    expect(value(plan, list, 'Items')).toEqual(
      resources(ordered[0].key, ordered[2].key),
    );
    expect(value(plan, ordered[0], 'Child items')).toEqual(
      resources(ordered[1].key),
    );
    expect(value(plan, ordered[1], 'Parent item')).toEqual({
      type: 'resource',
      value: local(ordered[0].key),
    });
    expect(value(plan, ordered[1], 'Source path')).toEqual(
      string('/payload/entries/0/children/0'),
    );
    expect(value(plan, root, 'source-revision')).toEqual(
      string('a'.repeat(64)),
    );
  });

  it('keeps root/list keys stable but binds unkeyed item identities to the full body snapshot', () => {
    const base = fixture(),
      first = project(base);
    expect(project(base)).toEqual(first);
    const changed = structuredClone(base);
    const body = changed.resources.find((r) => r.key === 'row')!.properties[1]
      .value;
    if (body.type !== 'json') throw Error('fixture');
    (body.value as Record<string, unknown>).unknown = { new: true };
    const second = project(changed);
    expect(classed(second, 'Document')[0].key).toBe(
      classed(first, 'Document')[0].key,
    );
    expect(classed(second, 'Checklist')[0].key).toBe(
      classed(first, 'Checklist')[0].key,
    );
    expect(classed(second, 'Entry').map((r) => r.key)).not.toEqual(
      classed(first, 'Entry').map((r) => r.key),
    );
    expect(second.revision).not.toBe(first.revision);
    expect(second.sources).toEqual(base.sources);
  });

  it('separates cloned root schemas and original JSON properties for heterogeneous source schemas', () => {
    const base = fixture(),
      first = project(base),
      changed = fixture();
    changed.resources
      .find((r) => r.key === 'body')!
      .properties.find(
        (p) =>
          'external' in p.property && p.property.external === P + 'jsonSchema',
      )!.value = {
      type: 'json',
      value: { type: 'object', description: 'Another source schema' },
    };
    const second = project(changed);
    expect(named(second, 'Document').key).not.toBe(
      named(first, 'Document').key,
    );
    expect(named(second, 'Original body').key).not.toBe(
      named(first, 'Original body').key,
    );
    expect(named(second, 'Entry').key).toBe(named(first, 'Entry').key);
    expect(classed(second, 'Document')[0].key).toBe(
      classed(first, 'Document')[0].key,
    );
  });

  it('clones the root schema, uses new typed properties, closes schema refs and excludes all unrelated rows/tables', () => {
    const plan = project(),
      root = classed(plan, 'Document')[0];
    expect(
      plan.resources.some((r) =>
        [
          'row',
          'class',
          'body',
          'other-row',
          'unrelated-table',
          'schemas',
        ].includes(r.key),
      ),
    ).toBe(false);
    expect(value(plan, root, 'title')).toEqual(string('Selected document'));
    const body = named(plan, 'Body'),
      original = named(plan, 'Original body');
    expect(body.key).not.toBe('body');
    expect(body.properties).toContainEqual({
      property: external(P + 'datatype'),
      value: { type: 'resource', value: external(D + 'atomicURL') },
    });
    expect(original.properties).toContainEqual({
      property: external(P + 'datatype'),
      value: { type: 'resource', value: external(D + 'json') },
    });
    expect(original.properties).toContainEqual({
      property: external(P + 'jsonSchema'),
      value: {
        type: 'json',
        value: { type: 'object', additionalProperties: true },
      },
    });
    const keys = new Set(['drive', ...plan.resources.map((r) => r.key)]);
    for (const r of plan.resources) {
      const refs = [
        r.parent,
        ...r.classes,
        ...r.properties.flatMap((p) => [
          p.property,
          ...(p.value.type === 'resource'
            ? [p.value.value]
            : p.value.type === 'resources'
              ? p.value.value
              : []),
        ]),
      ];
      for (const ref of refs)
        if ('local' in ref) expect(keys.has(ref.local)).toBe(true);
    }
    const view = plan.resources.find((r) =>
      r.classes.some((c) => 'external' in c && c.external === C + 'View'),
    )!;
    const viewColumns = view.properties.find(
      (p) =>
        'external' in p.property && p.property.external === P + 'view-columns',
    )!.value;
    expect(viewColumns).toEqual({
      type: 'resources',
      value: [
        external(P + 'name'),
        local(named(plan, 'Checked').key),
        local(named(plan, 'Position').key),
      ],
    });
    expect(view.properties).toContainEqual({
      property: external(P + 'view-sort-by'),
      value: { type: 'resource', value: local(named(plan, 'Position').key) },
    });
  });

  it('accepts an empty list and escapes exact JSON pointer segments', () => {
    expect(
      classed(project(fixture({ payload: { entries: [] } })), 'Entry'),
    ).toHaveLength(0);
    const plan = project(
      fixture({ 'a/b': { '~items': [{ value: { text: 'Exact' } }] } }),
      { ...profile, listAt: ['a/b'], itemsAt: ['~items'] },
    );
    expect(value(plan, classed(plan, 'Entry')[0], 'Source path')).toEqual(
      string('/a~1b/~0items/0'),
    );
  });

  it('retains blank items and distinguishes optional missing text and booleans from empty text and false', () => {
    const optional = {
      ...profile,
      itemFields: profile.itemFields.map((field) => ({
        ...field,
        optional: true,
      })),
    };
    const plan = project(
      fixture({
        payload: { entries: [{}, { value: { text: '' }, done: false }] },
      }),
      optional,
    );
    const items = classed(plan, 'Entry').sort(
      (a, b) =>
        (value(plan, a, 'Position')!.value as number) -
        (value(plan, b, 'Position')!.value as number),
    );
    expect(items).toHaveLength(2);
    expect(items.map(propertyName)).toEqual(['List item 1', 'List item 2']);
    expect(value(plan, items[0], 'Text')).toBeUndefined();
    expect(value(plan, items[0], 'Checked')).toBeUndefined();
    expect(value(plan, items[1], 'Text')).toEqual(string(''));
    expect(value(plan, items[1], 'Checked')).toEqual({
      type: 'boolean',
      value: false,
    });
  });

  it('supports an array at the selected body root without any built-in source keys', () => {
    const rootProfile = { ...profile };
    delete rootProfile.childrenAt;
    const plan = project(
      fixture([{ title: 'Other representation', flag: false }]),
      {
        ...rootProfile,
        listAt: [],
        itemsAt: [],
        itemFields: [
          {
            shortname: 'caption',
            name: 'Caption',
            path: ['title'],
            datatype: 'string',
            displayName: true,
          },
          {
            shortname: 'flag',
            name: 'Flag',
            path: ['flag'],
            datatype: 'boolean',
          },
        ],
      },
    );
    expect(classed(plan, 'Entry').map(propertyName)).toEqual([
      'Other representation',
    ]);
    expect(value(plan, classed(plan, 'Entry')[0], 'Source path')).toEqual(
      string('/0'),
    );
  });

  it.each([
    ['missing list', {}],
    ['non-list', { payload: { entries: {} } }],
    ['missing text', { payload: { entries: [{ done: false }] } }],
    [
      'mistyped checked',
      { payload: { entries: [{ value: { text: 'x' }, done: 'false' }] } },
    ],
    [
      'mistyped integer',
      { payload: { entries: [{ value: { text: 'x' }, rank: 1.2 }] } },
    ],
    [
      'malformed child list',
      { payload: { entries: [{ value: { text: 'x' }, children: {} }] } },
    ],
  ])('rejects malformed %s before producing a plan', (_label, body) => {
    const p =
      _label === 'mistyped integer'
        ? {
            ...profile,
            itemFields: [
              ...profile.itemFields,
              {
                shortname: 'rank',
                name: 'Rank',
                path: ['rank'],
                datatype: 'integer' as const,
                optional: true,
              },
            ],
          }
        : profile;
    expect(() => project(fixture(body), p)).toThrow();
  });

  it('rejects oversized, cyclic and non-JSON bodies', () => {
    expect(() =>
      project(
        fixture({
          payload: {
            entries: Array.from({ length: 5001 }, () => ({
              value: { text: 'x' },
            })),
          },
        }),
      ),
    ).toThrow(/5000|bound|limit/i);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => project(fixture(cyclic))).toThrow(/cycl/i);
    expect(() =>
      project(fixture({ payload: { entries: [] }, invalid: undefined })),
    ).toThrow(/JSON/i);
  });

  it('rejects dangling data references and duplicate keys', () => {
    const base = fixture();
    base.resources
      .find((r) => r.key === 'row')!
      .properties.push({
        property: local('title'),
        value: { type: 'resource', value: local('other-row') },
      });
    expect(() => project(base)).toThrow();
    const duplicate = fixture();
    duplicate.resources.push(duplicate.resources[0]);
    expect(() => project(duplicate)).toThrow(/duplicate/i);
    const dangling = fixture();
    dangling.resources
      .find((r) => r.key === 'class')!
      .properties.push({
        property: external(P + 'recommends'),
        value: resources('missing'),
      });
    expect(() => project(dangling)).toThrow();
  });

  it('rejects missing or cyclic source parents without following unrelated data into the import', () => {
    const cyclic = fixture();
    cyclic.resources.find((r) => r.key === 'unrelated-table')!.parent =
      local('row');
    expect(() => project(cyclic)).toThrow(/cycl/i);
    const missing = fixture();
    missing.resources.find((r) => r.key === 'row')!.parent = local('missing');
    expect(() => project(missing)).toThrow(/dangling/i);
  });

  it.each([
    { ...profile, id: '' },
    { ...profile, version: '' },
    { ...profile, listAt: ['__proto__'] },
    { ...profile, itemFields: [...profile.itemFields, profile.itemFields[0]] },
    {
      ...profile,
      itemFields: [{ ...profile.itemFields[1], displayName: true }],
    },
  ])('rejects malformed profiles', (invalid) => {
    expect(() => project(fixture(), invalid)).toThrow();
  });
});
