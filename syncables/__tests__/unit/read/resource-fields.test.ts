// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import * as refs from '../../../src/openapi/resolve-refs.js';
import {
  prepareDocument,
  describeResourceFields,
  resolveResourceField,
  describeEntityTypes,
  deriveOntology,
  resolveEntityIdentity,
  embeddedResourcesOf,
  describeCollections,
  bindCollection,
  projectEntityObservation,
  type ResourceFieldDescription,
  type OpenApiDocument,
} from '../../../src/browser.js';

function fixture(): OpenApiDocument {
  return prepareDocument({
    openapi: '3.0.3',
    info: { title: 'Invented work tracker', version: '1' },
    servers: [{ url: 'https://example.test' }],
    components: {
      crudResources: {
        ticket: {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              owner: { type: 'object' },
              reviewers: { type: 'array', items: { type: 'object' } },
              sponsorId: { type: 'integer', nullable: true },
            },
          },
          identity: {
            urlTemplate: '/tickets/{ticket_id}',
            bindings: { ticket_id: { field: 'id' } },
          },
          collections: {
            tickets: { urlTemplate: '/workspaces/{workspace_id}/tickets' },
          },
          references: {
            sponsor: {
              resource: 'person',
              required: false,
              bindings: {
                person_id: { field: 'sponsorId' },
                workspace_id: { field: 'workspaceId' },
              },
            },
          },
          'x-embeddedResources': {
            owner: {
              representation: 'object',
              cardinality: 'one',
              discriminator: {
                field: 'kind',
                mapping: { Person: 'person', Team: 'team' },
              },
            },
            reviewers: { resource: 'person', cardinality: 'many' },
            sponsorId: {
              representation: 'identity',
              cardinality: 'one',
              reference: 'sponsor',
            },
          },
        },
        person: {
          schema: {
            type: 'object',
            required: ['id', 'name', 'email'],
            properties: {
              id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
              name: { type: 'string' },
              email: { type: 'string', nullable: true },
              active: { type: 'boolean' },
            },
          },
          identity: {
            urlTemplate: '/workspaces/{workspace_id}/people/{person_id}',
            bindings: { person_id: { field: 'id' } },
          },
        },
        team: {
          schema: {
            type: 'object',
            properties: { id: { type: 'integer' }, name: { type: 'string' } },
          },
          identity: {
            urlTemplate: '/teams/{team_id}',
            bindings: { team_id: { field: 'id' } },
          },
        },
      },
    },
    paths: {
      '/workspaces/{workspace_id}/tickets': {
        get: {
          operationId: 'tickets',
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          'x-crud': {
            action: 'list',
            resource: 'ticket',
            collection: 'tickets',
          },
          responses: {
            '200': {
              description: 'Tickets',
              content: {
                'application/json': {
                  schema: { type: 'array', items: { type: 'object' } },
                },
              },
            },
          },
        },
      },
      '/workspaces/{workspace_id}/people/{person_id}': {
        get: {
          parameters: [
            {
              name: 'workspace_id',
              in: 'path',
              required: true,
              schema: { type: 'integer' },
            },
          ],
          responses: { '200': { description: 'Person' } },
        },
      },
    },
  });
}
const field = (doc: OpenApiDocument, name: string): ResourceFieldDescription =>
  describeResourceFields(doc, 'ticket').find((item) => item.field === name)!;

describe('declared stored resource fields', () => {
  it('exposes actual ontology keys and reference-only entity types without inventing reads', () => {
    const doc = fixture(),
      descriptions = describeResourceFields(doc, 'ticket');
    expect(
      descriptions.map((item) => [
        item.field,
        item.property,
        item.representation,
        item.cardinality,
      ]),
    ).toEqual([
      ['owner', 'owner', 'object', 'one'],
      ['reviewers', 'reviewers', 'object', 'many'],
      ['sponsorId', 'sponsorid', 'identity', 'one'],
    ]);
    const keys = new Set(
      deriveOntology(doc)
        .terms.filter((term) => term.kind === 'property')
        .map((term) => term.shortname),
    );
    for (const item of descriptions) expect(keys.has(item.property)).toBe(true);
    expect(descriptions[0].targets.map((item) => item.resource)).toEqual([
      'person',
      'team',
    ]);
    expect(describeEntityTypes(doc)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: 'ticket',
          resourceFields: descriptions,
        }),
        expect.objectContaining({ resource: 'person', collections: [] }),
        expect.objectContaining({ resource: 'team', collections: [] }),
      ]),
    );
  });
  it('projects only supplied partial fields without requests, required-field fabrication or recursive expansion', () => {
    const doc = fixture(),
      fetch = vi.spyOn(globalThis, 'fetch');
    const owner = {
      kind: 'Person',
      id: 7,
      active: false,
      email: null,
      supervisor: { id: 8 },
    };
    const result = resolveResourceField(
      doc,
      field(doc, 'owner'),
      { id: 999, owner },
      { workspace_id: '3' },
    );
    expect(result).toMatchObject({
      status: 'resolved',
      original: owner,
      objects: [
        {
          resource: 'person',
          partial: true,
          object: owner,
          fields: {
            id: { kind: 'value', value: 7 },
            name: { kind: 'absent' },
            email: { kind: 'null' },
            active: { kind: 'value', value: false },
          },
          entity: {
            resource: 'person',
            values: [
              ['workspace_id', 3],
              ['person_id', 7],
            ],
          },
        },
      ],
    });
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].entity).toEqual(
      resolveEntityIdentity(doc, {
        resource: 'person',
        record: owner,
        context: { workspace_id: '3' },
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
  it('preserves typed IDs and distinguishes polymorphic targets with the same numeric identifier', () => {
    const doc = fixture(),
      owner = field(doc, 'owner');
    const number = resolveResourceField(
      doc,
      owner,
      { owner: { kind: 'Person', id: 7 } },
      { workspace_id: 3 },
    ).objects[0];
    const string = resolveResourceField(
      doc,
      owner,
      { owner: { kind: 'Person', id: '7' } },
      { workspace_id: 3 },
    ).objects[0];
    const team = resolveResourceField(doc, owner, {
      owner: { kind: 'Team', id: 7 },
    }).objects[0];
    expect(number.entity.key).not.toBe(string.entity.key);
    expect(number.entity.key).not.toBe(team.entity.key);
    expect(team.resource).toBe('team');
  });
  it.each([
    {},
    { kind: 'Unknown', id: 7 },
    { kind: 'Person', id: null },
    Object.create({ kind: 'Team', id: 7 }),
  ])('retains %j when discriminator or identity is unproven', (owner) => {
    const doc = fixture();
    expect(
      resolveResourceField(
        doc,
        field(doc, 'owner'),
        { owner },
        { workspace_id: 3 },
      ),
    ).toMatchObject({ original: owner, status: 'unresolved', objects: [] });
  });
  it('preserves the whole array if one member is invalid', () => {
    const doc = fixture(),
      reviewers = [{ id: 1 }, { id: null }, { id: 2 }];
    expect(
      resolveResourceField(
        doc,
        field(doc, 'reviewers'),
        { reviewers },
        { workspace_id: 3 },
      ),
    ).toMatchObject({
      original: reviewers,
      status: 'unresolved',
      objects: [],
      diagnostics: [{ index: 1 }],
    });
    const repeated = resolveResourceField(
      doc,
      field(doc, 'reviewers'),
      { reviewers: [{ id: 1 }, { id: 1 }] },
      { workspace_id: 3 },
    ).objects;
    expect(repeated).toHaveLength(2);
    expect(repeated[0].entity.key).toBe(repeated[1].entity.key);
  });
  it('explicitly associates scalar storage with a composite Reference Object and contextual identity', () => {
    const doc = fixture();
    const result = resolveResourceField(
      doc,
      field(doc, 'sponsorId'),
      { sponsorId: 7, workspaceId: 9 },
      { workspace_id: 3 },
    );
    expect(result).toMatchObject({
      status: 'resolved',
      property: 'sponsorid',
      objects: [
        {
          resource: 'person',
          partial: true,
          fields: {},
          entity: {
            values: [
              ['workspace_id', 9],
              ['person_id', 7],
            ],
          },
        },
      ],
    });
    expect(result.objects[0].object).toBeUndefined();
    expect(result.objects[0].entity).toEqual(
      resolveEntityIdentity(doc, {
        resource: 'person',
        record: { id: 7 },
        context: { workspace_id: 9 },
      }),
    );
    expect(
      resolveResourceField(doc, field(doc, 'sponsorId'), { sponsorId: null })
        .objects,
    ).toEqual([]);
    expect(
      resolveResourceField(doc, field(doc, 'sponsorId'), {
        sponsorId: [7],
        workspaceId: 9,
      }),
    ).toMatchObject({ status: 'unresolved', original: [7], objects: [] });
  });
  it('does not invent storage associations from an ordinary reference or object schema', () => {
    const doc = fixture();
    delete (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).ticket['x-embeddedResources'];
    expect(describeResourceFields(doc, 'ticket')).toEqual([]);
  });
  it('leaves raw root projection compatible while resolving only explicit resource fields', () => {
    const doc = fixture(),
      collection = describeCollections(doc)[0];
    const owner = { kind: 'Team', id: 7, name: 'Team name' };
    const raw = { id: 1, owner };
    const root = projectEntityObservation(doc, {
      collection,
      record: raw,
      context: { workspace_id: 3 },
      provenance: {
        read: bindCollection(doc, {
          collection: 'tickets',
          context: { workspace_id: '3' },
        }),
      },
    });
    expect(root.projected.values.owner).toEqual(owner);
    expect(root.raw).toEqual(raw);
    resolveResourceField(doc, field(doc, 'owner'), root.raw, root.context);
    expect(root.projected.values.owner).toEqual(owner);
    expect(raw).toEqual({ id: 1, owner });
  });
  it('exposes declared nested field property keys without replacing the raw parent object', () => {
    const doc = fixture();
    const resource = (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).ticket;
    resource['x-embeddedResources'] = {
      'details.contact': { resource: 'person', cardinality: 'one' },
    };
    const descriptor = describeResourceFields(doc, 'ticket')[0];
    expect(descriptor.property).toBe('details-contact');
    expect(deriveOntology(doc).terms).toContainEqual(
      expect.objectContaining({
        kind: 'property',
        shortname: 'details-contact',
      }),
    );
    expect(
      resolveResourceField(
        doc,
        descriptor,
        { details: { contact: { id: 8 }, note: 'Retained' } },
        { workspace_id: 3 },
      ).objects[0].entity.values,
    ).toEqual([
      ['workspace_id', 3],
      ['person_id', 8],
    ]);
  });
  it('keeps legacy static parser behavior and fails closed on new variants with no fixed-resource fallback', () => {
    const doc = fixture();
    expect(() => embeddedResourcesOf(doc, 'ticket')).toThrow('unknown field');
    const resource = (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).ticket;
    resource['x-embeddedResources'] = {
      reviewers: { resource: 'person', cardinality: 'many' },
    };
    expect(embeddedResourcesOf(doc, 'ticket')[0]).toMatchObject({
      field: 'reviewers',
      resource: 'person',
      cardinality: 'many',
    });
  });
  it('inherits unbound scalar reference scope and keeps number/string target identifiers distinct', () => {
    const doc = fixture();
    const resource = (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).ticket;
    (
      resource.references as Record<string, Record<string, unknown>>
    ).sponsor.bindings = { person_id: { field: 'sponsorId' } };
    const descriptor = field(doc, 'sponsorId');
    const number = resolveResourceField(
      doc,
      descriptor,
      { sponsorId: 7 },
      { workspace_id: '9' },
    ).objects[0];
    const string = resolveResourceField(
      doc,
      descriptor,
      { sponsorId: '7' },
      { workspace_id: '9' },
    ).objects[0];
    expect(number.entity.values).toEqual([
      ['workspace_id', 9],
      ['person_id', 7],
    ]);
    expect(number.entity.key).not.toBe(string.entity.key);
    expect(
      resolveResourceField(
        doc,
        descriptor,
        { sponsorId: 7 },
        Object.create({ workspace_id: 9 }),
      ).status,
    ).toBe('unresolved');
  });
  it('defaults representation only when absent and permits discriminator extension metadata', () => {
    const doc = fixture();
    const resource = (
      doc.components!.crudResources as Record<string, Record<string, unknown>>
    ).ticket;
    resource['x-embeddedResources'] = {
      owner: { representation: null, resource: 'person', cardinality: 'one' },
    };
    expect(() => describeResourceFields(doc, 'ticket')).toThrow(
      'representation',
    );
    resource['x-embeddedResources'] = {
      owner: {
        cardinality: 'one',
        discriminator: {
          field: 'kind',
          mapping: { Person: 'person' },
          'x-description': 'Public declarative extension',
        },
      },
    };
    expect(describeResourceFields(doc, 'ticket')[0].targets[0].resource).toBe(
      'person',
    );
  });
  it.each([NaN, 1.5, '', ' padded', '\0'])(
    'rejects unsafe identity scalar %j even if the associated reference gets its complete identity from context',
    (sponsorId) => {
      const doc = fixture();
      const resource = (
        doc.components!.crudResources as Record<string, Record<string, unknown>>
      ).ticket;
      (
        resource.references as Record<string, Record<string, unknown>>
      ).sponsor.bindings = {};
      const result = resolveResourceField(
        doc,
        field(doc, 'sponsorId'),
        { sponsorId },
        { workspace_id: 3, person_id: 7 },
      );
      expect(result).toMatchObject({
        status: 'unresolved',
        objects: [],
        original: sponsorId,
      });
    },
  );
  it('keeps omitted arrays absent and diagnoses incomplete optional scalar identities instead of silently clearing a link', () => {
    const doc = fixture();
    expect(
      resolveResourceField(
        doc,
        field(doc, 'reviewers'),
        {},
        { workspace_id: 3 },
      ),
    ).toMatchObject({ status: 'resolved', present: false, objects: [] });
    expect(
      resolveResourceField(
        doc,
        field(doc, 'reviewers'),
        { reviewers: null },
        { workspace_id: 3 },
      ).status,
    ).toBe('unresolved');
    expect(
      resolveResourceField(
        doc,
        field(doc, 'sponsorId'),
        { sponsorId: 7, workspaceId: null },
        { workspace_id: 3 },
      ),
    ).toMatchObject({
      status: 'unresolved',
      original: 7,
      objects: [],
      diagnostics: [expect.anything()],
    });
  });
  it('uses a stable private document snapshot for repeated rows and ignores forged caller descriptor targets', () => {
    const doc = fixture(),
      descriptor = field(doc, 'owner');
    const resolve = vi.spyOn(refs, 'resolveRefs');
    try {
      resolveResourceField(
        doc,
        descriptor,
        { owner: { kind: 'Person', id: 1 } },
        { workspace_id: 3 },
      );
      const warmCalls = resolve.mock.calls.length;
      descriptor.targets[0].resource = 'team';
      descriptor.discriminator!.mapping.Person = 'team';
      for (let id = 2; id < 102; id++) {
        const result = resolveResourceField(
          doc,
          descriptor,
          { owner: { kind: 'Person', id } },
          { workspace_id: 3 },
        );
        expect(result.objects[0].resource).toBe('person');
      }
      expect(resolve.mock.calls.length).toBe(warmCalls);
      expect(
        describeResourceFields(doc, 'ticket')[0].discriminator!.mapping.Person,
      ).toBe('person');
    } finally {
      resolve.mockRestore();
    }
  });
  it('rejects contradictory variants, identity arrays and undeclared references before projection', () => {
    for (const entry of [
      {
        resource: 'person',
        representation: 'object',
        cardinality: 'one',
        discriminator: { field: 'kind', mapping: { Person: 'person' } },
      },
      { representation: 'identity', cardinality: 'many', reference: 'sponsor' },
      { representation: 'identity', cardinality: 'one', reference: 'missing' },
      {
        representation: 'object',
        cardinality: 'one',
        discriminator: { field: 'kind', mapping: { Person: 'undeclared' } },
      },
    ]) {
      const doc = fixture();
      (
        doc.components!.crudResources as Record<string, Record<string, unknown>>
      ).ticket['x-embeddedResources'] = { owner: entry };
      expect(() => describeResourceFields(doc, 'ticket')).toThrow();
    }
  });
});
