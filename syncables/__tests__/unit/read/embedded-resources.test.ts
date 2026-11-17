// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { OpenApiDocument } from '../../../src/openapi/types.js';
import { resolveRefs } from '../../../src/openapi/resolve-refs.js';
import {
  embeddedResourcesOf,
  resolveEmbeddedResource,
  type EmbeddedResourceDeclaration,
} from '../../../src/read/embedded-resources.js';

function document(): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Invented work records', version: '1' },
    paths: {},
    components: {
      schemas: {
        Person: {
          type: 'object',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
        },
        Label: {
          type: 'object',
          properties: { id: { type: 'integer' }, name: { type: 'string' } },
        },
      },
      crudResources: {
        issue: {
          schema: {
            type: 'object',
            properties: { user: { $ref: '#/components/schemas/Person' } },
          },
          'x-embeddedResources': {
            user: { resource: 'person', cardinality: 'one' },
            labels: { resource: 'label', cardinality: 'many' },
          },
        },
        person: {
          schema: { $ref: '#/components/schemas/Person' },
          identity: {
            urlTemplate: '/people/{personId}',
            bindings: { personId: { field: 'id' } },
          },
        },
        label: {
          schema: { $ref: '#/components/schemas/Label' },
          identity: {
            urlTemplate: '/repos/{owner}/{repo}/labels/{labelId}',
            bindings: { labelId: { field: 'id' } },
          },
        },
      },
    },
  };
}

function resources(
  doc: OpenApiDocument,
): Record<string, Record<string, unknown>> {
  return doc.components!['crudResources'] as Record<
    string,
    Record<string, unknown>
  >;
}

function declarations(): EmbeddedResourceDeclaration[] {
  return embeddedResourcesOf(resolveRefs(document()), 'issue');
}

describe('experimental embedded resources', () => {
  it('uses target identity bindings and retains the original embedded object', () => {
    const user = { id: 7, name: 'Sample person', supervisor: { id: 8 } };
    const source = { id: 'parent-id-is-not-the-person-id', user };
    const [declaration] = declarations();
    const result = resolveEmbeddedResource(declaration, source, {
      personId: 'wrong-context-id',
    });

    expect(result).toMatchObject({
      field: 'user',
      resource: 'person',
      cardinality: 'one',
      present: true,
      status: 'resolved',
      diagnostics: [],
    });
    expect(result.original).toBe(user);
    expect(result.objects).toEqual([
      {
        resource: 'person',
        path: '/people/7',
        values: { personId: '7' },
        object: user,
      },
    ]);
    expect(result.objects[0].object).toBe(user);
    expect(user.supervisor).toEqual({ id: 8 }); // No recursive expansion.
  });

  it('inherits original repository request context and preserves array order', () => {
    const labels = [
      { id: 2, name: 'Second' },
      { id: 1, name: 'First' },
      { id: 2, name: 'Second' },
    ];
    const result = resolveEmbeddedResource(
      declarations()[1],
      { owner: 'wrong-record-owner', repo: 'wrong-record-repo', labels },
      {
        owner: 'sample owner',
        repo: 'paper/sketches',
        labelId: 'wrong-context-id',
      },
    );

    expect(result.status).toBe('resolved');
    expect(result.objects.map((object) => object.path)).toEqual([
      '/repos/sample%20owner/paper%2Fsketches/labels/2',
      '/repos/sample%20owner/paper%2Fsketches/labels/1',
      '/repos/sample%20owner/paper%2Fsketches/labels/2',
    ]);
    expect(result.objects[0].values).toEqual({
      owner: 'sample owner',
      repo: 'paper/sketches',
      labelId: '2',
    });
    expect(result.original).toBe(labels);
  });

  it('distinguishes optional absent/null scalar values from an actual empty array', () => {
    const [single, multiple] = declarations();
    expect(resolveEmbeddedResource(single, {})).toMatchObject({
      present: false,
      original: undefined,
      status: 'resolved',
      objects: [],
      diagnostics: [],
    });
    expect(resolveEmbeddedResource(single, { user: null })).toMatchObject({
      present: true,
      original: null,
      status: 'resolved',
      objects: [],
      diagnostics: [],
    });
    expect(resolveEmbeddedResource(multiple, { labels: [] })).toMatchObject({
      present: true,
      original: [],
      status: 'resolved',
      objects: [],
      diagnostics: [],
    });
  });

  it.each([
    undefined,
    null,
    'a string label',
    ['one', 'two'],
    [null],
    [{ id: 1 }, 'legacy label', { id: 2 }],
  ])(
    'preserves the whole many-valued field %j when it cannot resolve every member',
    (labels) => {
      const result = resolveEmbeddedResource(
        declarations()[1],
        { labels },
        { owner: 'sample', repo: 'paper' },
      );
      expect(result.status).toBe('unresolved');
      expect(result.objects).toEqual([]);
      expect(result.original).toBe(labels);
      expect(result.diagnostics.length).toBeGreaterThan(0);
      if (Array.isArray(labels) && labels.length === 3)
        expect(result.diagnostics[0].index).toBe(1);
    },
  );

  it.each(['person-name', [], 7, false, { name: 'No identity' }, { id: null }])(
    'keeps malformed or unidentifiable scalar data %j as fallback',
    (user) => {
      const result = resolveEmbeddedResource(
        declarations()[0],
        { user },
        { personId: 'context-does-not-replace-a-binding' },
      );
      expect(result.status).toBe('unresolved');
      expect(result.objects).toEqual([]);
      expect(result.original).toBe(user);
      expect(result.diagnostics).toHaveLength(1);
    },
  );

  it.each([
    '',
    '.',
    '..',
    ' padded',
    'padded ',
    '\0',
    '\ud800',
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])(
    'rejects an unsafe identity segment %j without losing its source object',
    (id) => {
      const user = { id, name: 'Sample' };
      const result = resolveEmbeddedResource(declarations()[0], { user });
      expect(result.status).toBe('unresolved');
      expect(result.objects).toEqual([]);
      expect(result.original).toBe(user);
      expect(result.diagnostics).toHaveLength(1);
    },
  );

  it('reports missing or unsafe inherited scope and never reads prototype values', () => {
    const declaration = declarations()[1];
    for (const context of [
      {},
      { owner: '..', repo: 'paper' },
      Object.create({ owner: 'sample', repo: 'paper' }) as Record<
        string,
        string
      >,
    ]) {
      const result = resolveEmbeddedResource(
        declaration,
        { labels: [{ id: 1 }] },
        context,
      );
      expect(result.status).toBe('unresolved');
      expect(result.objects).toEqual([]);
    }
    expect(
      resolveEmbeddedResource(declarations()[0], {
        user: Object.create({ id: 7 }),
      }).status,
    ).toBe('unresolved');
  });

  it('reads explicit nested source and target binding paths with own-property rules', () => {
    const doc = resolveRefs(document());
    resources(doc).issue['x-embeddedResources'] = {
      'details.user': { resource: 'person', cardinality: 'one' },
    };
    resources(doc).person.identity = {
      urlTemplate: '/people/{personId}',
      bindings: { personId: { field: 'identity.id' } },
    };
    const user = { identity: { id: 42 }, name: 'Nested sample' };
    expect(
      resolveEmbeddedResource(embeddedResourcesOf(doc, 'issue')[0], {
        details: { user },
      }).objects[0].path,
    ).toBe('/people/42');
  });

  it('does not assign resource identity semantics to schema $refs', () => {
    const doc = resolveRefs(document());
    delete resources(doc).issue['x-embeddedResources'];
    expect(embeddedResourcesOf(doc, 'issue')).toEqual([]);
    resources(doc).issue['x-embeddedResources'] = {
      user: { resource: 'undeclared', cardinality: 'one' },
    };
    expect(() => embeddedResourcesOf(doc, 'issue')).toThrow(
      /must name a declared CRUD resource/,
    );
    expect(() => embeddedResourcesOf(document(), 'issue')).toThrow(
      /resolved object schema/,
    );
  });

  it('allows a target identity whose variables all come from explicit request context', () => {
    const doc = resolveRefs(document());
    resources(doc).person.identity = { urlTemplate: '/people/{personId}' };
    const parsed = embeddedResourcesOf(doc, 'issue')[0];
    expect(
      resolveEmbeddedResource(
        parsed,
        { user: { name: 'Scoped person' } },
        { personId: 'declared-scope' },
      ).objects[0].path,
    ).toBe('/people/declared-scope');
  });

  it.each([
    { type: 'string', properties: {} },
    { type: 'object', properties: [] },
    true,
    {},
  ])('rejects a target with no object schema shape %j', (schema) => {
    const doc = resolveRefs(document());
    resources(doc).person.schema = schema;
    expect(() => embeddedResourcesOf(doc, 'issue')).toThrow(
      /resolved object schema/,
    );
  });

  it('requires explicitly declared source/target resources, schema and identity', () => {
    expect(() =>
      embeddedResourcesOf(resolveRefs(document()), 'missing'),
    ).toThrow(/not a crudResources key/);
    for (const field of ['schema', 'identity']) {
      const doc = resolveRefs(document());
      delete resources(doc).person[field];
      expect(() => embeddedResourcesOf(doc, 'issue')).toThrow(
        field === 'schema'
          ? /resolved object schema/
          : /identity.urlTemplate is required/,
      );
    }
  });

  it.each([
    null,
    [],
    true,
    { user: null },
    { user: { resource: 'person', cardinality: 'some' } },
    { user: { resource: 'person', cardinality: 'one', nameField: 'name' } },
    {
      user: { resource: 'person', cardinality: 'one' },
      'user.child': { resource: 'person', cardinality: 'one' },
    },
  ])(
    'rejects malformed declaration metadata %j before any item resolution',
    (extension) => {
      const doc = resolveRefs(document());
      resources(doc).issue['x-embeddedResources'] = extension;
      expect(() => embeddedResourcesOf(doc, 'issue')).toThrow();
    },
  );

  it.each(['', '.user', 'user..name', 'user[0]', ' user', 'user.\nname'])(
    'rejects malformed source field path %j',
    (field) => {
      const doc = resolveRefs(document());
      resources(doc).issue['x-embeddedResources'] = {
        [field]: { resource: 'person', cardinality: 'one' },
      };
      expect(() => embeddedResourcesOf(doc, 'issue')).toThrow(/dot-path/);
    },
  );

  it.each([
    {
      urlTemplate: 'https://example.invalid/{personId}',
      bindings: { personId: { field: 'id' } },
    },
    {
      urlTemplate: '/\\example.invalid/{personId}',
      bindings: { personId: { field: 'id' } },
    },
    {
      urlTemplate: '/people/{personId}',
      bindings: { personId: { field: 'id..bad' } },
    },
    {
      urlTemplate: '/people/{personId}',
      bindings: { wrongVariable: { field: 'id' } },
    },
    { urlTemplate: '/people/{personId}', bindings: [] },
    { urlTemplate: '/people/{__proto__}', bindings: {} },
    { urlTemplate: '/people/{unclosed', bindings: {} },
  ])('rejects malformed target identity metadata %j', (identity) => {
    const doc = resolveRefs(document());
    resources(doc).person.identity = identity;
    expect(() => embeddedResourcesOf(doc, 'issue')).toThrow();
  });
});
