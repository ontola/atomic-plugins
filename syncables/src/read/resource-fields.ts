// @wc-ignore-file
/** Declared supplied objects and explicitly associated identity-only fields. No I/O. */
import type { OpenApiDocument } from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { crudResourcesOf, isRecord } from './model.js';
import {
  embeddedResourcesOf,
  type EmbeddedResourceDeclaration,
} from './embedded-resources.js';
import { fieldValue } from './identity-path.js';
import { deriveOntology, ontologyShortname } from './ontology.js';
import { projectPartialResourceFields } from './read.js';
import {
  preparedEntityIdentity,
  scalar,
  resolveReferenceEntityIdentity,
  type EntityIdentity,
  type FieldEvidence,
  type TypedReadContext,
} from './flat-selection.js';

type Target = Pick<
  EmbeddedResourceDeclaration,
  'resource' | 'schema' | 'identity'
>;
export interface ResourceFieldDescription {
  sourceResource: string;
  field: string;
  /** The actual generated ontology property shortname; not an API URL. */
  property: string;
  representation: 'object' | 'identity';
  cardinality: 'one' | 'many';
  targets: Target[];
  discriminator?: { field: string; mapping: Record<string, string> };
  /** Existing Reference Object name; its bindings read the complete source record. */
  reference?: string;
}
export interface ResolvedResourceFieldObject {
  resource: string;
  entity: EntityIdentity;
  /** Only supplied object data; identity-only references fabricate no record. */
  object?: Record<string, unknown>;
  fields: Record<string, FieldEvidence>;
  partial: true;
}
export interface ResourceFieldResolution {
  field: string;
  property: string;
  cardinality: 'one' | 'many';
  present: boolean;
  original: unknown;
  status: 'resolved' | 'unresolved';
  objects: ResolvedResourceFieldObject[];
  diagnostics: { index?: number; message: string }[];
}
const own = (object: Record<string, unknown>, name: string): unknown =>
  Object.hasOwn(object, name) ? object[name] : undefined;
const DOT_PATH = /^[^.\s[\]]+(?:\.[^.\s[\]]+)*$/u;
function checkField(field: unknown, where: string): asserts field is string {
  if (
    typeof field !== 'string' ||
    !DOT_PATH.test(field) ||
    [...field].some((char) => char < ' ' || char === '\u007f')
  )
    throw new Error(`${where}: expected a nonempty dot-path`);
}

/** Reuse the original strict fixed-target parser, including all identity safety checks. */
function target(
  document: OpenApiDocument,
  source: string,
  field: string,
  resource: string,
): Target {
  const resources = crudResourcesOf(document);
  const declaration = resources[source];
  if (!isRecord(declaration))
    throw new Error('The source resource is not declared');
  const [parsed] = embeddedResourcesOf(
    {
      ...document,
      components: {
        ...document.components,
        crudResources: {
          ...resources,
          [source]: {
            ...declaration,
            'x-embeddedResources': {
              [field]: { resource, cardinality: 'one' },
            },
          },
        },
      },
    },
    source,
  );
  return {
    resource: parsed!.resource,
    schema: parsed!.schema,
    identity: parsed!.identity,
  };
}

interface DocumentFields {
  document: OpenApiDocument;
  descriptions: Map<string, ResourceFieldDescription[]>;
}
const preparedFields = new WeakMap<object, DocumentFields>();
function prepared(document: OpenApiDocument): DocumentFields {
  let current = preparedFields.get(document);
  if (!current) {
    current = { document: resolveRefs(document), descriptions: new Map() };
    preparedFields.set(document, current);
  }
  return current;
}
function canonicalFields(
  document: OpenApiDocument,
  resource: string,
): ResourceFieldDescription[] {
  const state = prepared(document);
  let descriptions = state.descriptions.get(resource);
  if (!descriptions) {
    try {
      descriptions = parseResourceFields(state.document, resource);
      state.descriptions.set(resource, descriptions);
    } catch (error) {
      preparedFields.delete(document);
      throw error;
    }
  }
  return descriptions;
}
/** Read a validated snapshot of a stable prepared catalog document. Caller edits cannot alter resolution. */
export function describeResourceFields(
  document: OpenApiDocument,
  sourceResource: string,
): ResourceFieldDescription[] {
  return structuredClone(canonicalFields(document, sourceResource));
}
/** Parse the complete map before returning any projection descriptors. */
function parseResourceFields(
  doc: OpenApiDocument,
  sourceResource: string,
): ResourceFieldDescription[] {
  const resources = crudResourcesOf(doc);
  const source = own(resources, sourceResource);
  if (!isRecord(source))
    throw new Error(`${sourceResource} is not a crudResources key`);
  const raw = own(source, 'x-embeddedResources');
  if (raw === undefined) return [];
  if (!isRecord(raw)) throw new Error('x-embeddedResources must be an object');
  const ontologyProperties = new Set(
    deriveOntology(doc)
      .terms.filter((term) => term.kind === 'property')
      .map((term) => term.shortname),
  );
  const descriptions: ResourceFieldDescription[] = [];
  const properties = new Map<string, string>();
  for (const [field, entry] of Object.entries(raw)) {
    checkField(field, 'x-embeddedResources');
    if (!isRecord(entry))
      throw new Error(`x-embeddedResources.${field} must be an object`);
    if (
      descriptions.some(
        (other) =>
          field.startsWith(other.field + '.') ||
          other.field.startsWith(field + '.'),
      )
    )
      throw new Error(
        `x-embeddedResources.${field}: overlapping source field paths`,
      );
    const property = ontologyShortname(field);
    if (
      !ontologyProperties.has(property) ||
      !property ||
      (properties.has(property) && properties.get(property) !== field)
    )
      throw new Error('Resource field ontology property collision');
    properties.set(property, field);
    for (const name of Object.keys(entry))
      if (
        ![
          'resource',
          'cardinality',
          'representation',
          'reference',
          'discriminator',
        ].includes(name) &&
        !name.startsWith('x-')
      )
        throw new Error(`x-embeddedResources.${field}.${name}: unknown field`);
    const declaredRepresentation = own(entry, 'representation');
    const representation =
      declaredRepresentation === undefined ? 'object' : declaredRepresentation;
    if (representation !== 'object' && representation !== 'identity')
      throw new Error(
        'Resource field representation must be object or identity',
      );
    const cardinality = own(entry, 'cardinality');
    if (cardinality !== 'one' && cardinality !== 'many')
      throw new Error('Resource field cardinality must be one or many');
    const base = {
      sourceResource,
      field,
      property,
      representation,
      cardinality,
    };
    if (representation === 'identity') {
      if (
        cardinality !== 'one' ||
        own(entry, 'resource') !== undefined ||
        own(entry, 'discriminator') !== undefined
      )
        throw new Error(
          'Identity representation requires cardinality one and an explicit Reference Object',
        );
      const reference = own(entry, 'reference');
      const references = own(source, 'references');
      const ref =
        typeof reference === 'string' && isRecord(references)
          ? own(references, reference)
          : undefined;
      if (
        typeof reference !== 'string' ||
        !reference ||
        !isRecord(ref) ||
        typeof ref.resource !== 'string' ||
        !isRecord(ref.bindings)
      )
        throw new Error(
          'Identity representation must name a declared Reference Object with bindings',
        );
      if (ref.required !== undefined && typeof ref.required !== 'boolean')
        throw new Error('Reference required must be a boolean');
      for (const binding of Object.values(ref.bindings)) {
        if (!isRecord(binding)) throw new Error('Invalid Reference binding');
        checkField(binding.field, 'Reference binding');
      }
      const declaredTarget = target(doc, sourceResource, field, ref.resource);
      const names = [
        ...declaredTarget.identity.urlTemplate.matchAll(/\{([^}]+)\}/g),
      ].map((match) => match[1]);
      if (Object.keys(ref.bindings).some((name) => !names.includes(name)))
        throw new Error('Reference binding is not a target identity variable');
      descriptions.push({
        ...base,
        representation,
        cardinality,
        reference,
        targets: [declaredTarget],
      });
      continue;
    }
    if (own(entry, 'reference') !== undefined)
      throw new Error('Object representation cannot name a Reference Object');
    const discriminator = own(entry, 'discriminator');
    if (discriminator === undefined) {
      const resource = own(entry, 'resource');
      if (typeof resource !== 'string')
        throw new Error('Object representation must name a declared resource');
      descriptions.push({
        ...base,
        representation,
        cardinality,
        targets: [target(doc, sourceResource, field, resource)],
      });
      continue;
    }
    if (own(entry, 'resource') !== undefined || !isRecord(discriminator))
      throw new Error('A discriminator cannot have a fixed target fallback');
    if (
      Object.keys(discriminator).some(
        (name) =>
          !['field', 'mapping'].includes(name) && !name.startsWith('x-'),
      )
    )
      throw new Error('Unknown discriminator field');
    checkField(discriminator.field, 'Discriminator');
    const rawMapping = discriminator.mapping;
    if (!isRecord(rawMapping) || !Object.keys(rawMapping).length)
      throw new Error('Discriminator mapping must be a nonempty object');
    const mapping: Record<string, string> = Object.create(null);
    const targets = new Map<string, Target>();
    for (const [value, resource] of Object.entries(rawMapping)) {
      if (!value || typeof resource !== 'string')
        throw new Error('Invalid discriminator mapping');
      mapping[value] = resource;
      if (!targets.has(resource))
        targets.set(resource, target(doc, sourceResource, field, resource));
    }
    descriptions.push({
      ...base,
      representation,
      cardinality,
      targets: [...targets.values()],
      discriminator: { field: discriminator.field, mapping },
    });
  }
  return descriptions;
}

/** Whole-field resolution; no fetches, recursive expansion or guessed relationships. */
export function resolveResourceField(
  document: OpenApiDocument,
  descriptor: ResourceFieldDescription,
  sourceObject: Record<string, unknown>,
  context: TypedReadContext = {},
): ResourceFieldResolution {
  const declaration = canonicalFields(document, descriptor.sourceResource).find(
    (item) => item.field === descriptor.field,
  );
  if (!declaration)
    throw new Error('The resource field is not declared in this document');
  const { field, property, cardinality } = declaration;
  const parts = field.split('.');
  const parent =
    parts.length === 1
      ? sourceObject
      : fieldValue(sourceObject, parts.slice(0, -1).join('.'));
  const name = parts.at(-1)!;
  const present = isRecord(parent) && Object.hasOwn(parent, name);
  const original = present ? parent[name] : undefined;
  const result: ResourceFieldResolution = {
    field,
    property,
    cardinality,
    present,
    original,
    status: 'resolved',
    objects: [],
    diagnostics: [],
  };
  if (
    !present ||
    original === undefined ||
    (cardinality === 'one' && original === null)
  )
    return result;
  const objects = cardinality === 'many' ? original : [original];
  if (!Array.isArray(objects)) {
    result.status = 'unresolved';
    result.diagnostics.push({
      message: `${field}: expected an array of embedded objects`,
    });
    return result;
  }
  for (let index = 0; index < objects.length; index++) {
    const object = objects[index];
    try {
      if (declaration.representation === 'identity') {
        if (typeof object !== 'string' && typeof object !== 'number')
          throw new Error(
            'Identity representation requires a scalar source field',
          );
        scalar(object);
        const entity = resolveReferenceEntityIdentity(
          prepared(document).document,
          {
            sourceResource: declaration.sourceResource,
            reference: declaration.reference!,
            record: sourceObject,
            context,
          },
        );
        if (!entity)
          throw new Error(
            'The associated Reference Object has no complete target identity',
          );
        result.objects.push({
          resource: entity.resource,
          entity,
          fields: {},
          partial: true,
        });
        continue;
      }
      if (!isRecord(object)) throw new Error('Expected an embedded object');
      const kind = declaration.discriminator
        ? fieldValue(object, declaration.discriminator.field)
        : undefined;
      const resource = declaration.discriminator
        ? typeof kind === 'string' &&
          Object.hasOwn(declaration.discriminator.mapping, kind)
          ? declaration.discriminator.mapping[kind]
          : undefined
        : declaration.targets[0]?.resource;
      if (!resource)
        throw new Error(
          'The embedded resource discriminator is missing or unknown',
        );
      const entity = preparedEntityIdentity(prepared(document).document, {
        resource,
        record: object,
        context,
      });
      result.objects.push({
        resource,
        entity,
        object,
        fields: projectPartialResourceFields(
          prepared(document).document,
          resource,
          object,
        ),
        partial: true,
      });
    } catch (error) {
      result.diagnostics.push({
        ...(cardinality === 'many' ? { index } : {}),
        message:
          error instanceof Error
            ? error.message
            : 'The resource field could not be resolved',
      });
    }
  }
  if (result.diagnostics.length) {
    result.status = 'unresolved';
    result.objects = [];
  }
  return result;
}
