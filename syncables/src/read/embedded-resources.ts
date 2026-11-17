// @wc-ignore-file
/** Experimental API embeddings, explicitly declared on a CRUD Resource Object. */
import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { isRecord } from './model.js';
import {
  fieldValue,
  resolveBoundIdentity,
  validateIdentityTemplate,
} from './identity-path.js';

export interface EmbeddedResourceDeclaration {
  field: string;
  resource: string;
  cardinality: 'one' | 'many';
  schema: SchemaObject;
  identity: { urlTemplate: string; bindings: Record<string, unknown> };
}

export interface ResolvedEmbeddedObject {
  resource: string;
  path: string;
  /** Bound target identity variables, including inherited request scope. */
  values: Record<string, string>;
  /** The original embedded object, not a fetched or expanded copy. */
  object: Record<string, unknown>;
}

export interface EmbeddedResourceResolution {
  field: string;
  resource: string;
  cardinality: 'one' | 'many';
  present: boolean;
  /** Complete source field, retained even when only one array member is bad. */
  original: unknown;
  status: 'resolved' | 'unresolved';
  /** Empty on any unresolved field; consumers must not retain partial links. */
  objects: ResolvedEmbeddedObject[];
  diagnostics: { index?: number; message: string }[];
}

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

// Deliberately the simple dot-path vocabulary used by identity field bindings.
// Names are own object properties; brackets and whitespace have no meaning.
const DOT_PATH = /^[^.\s[\]]+(?:\.[^.\s[\]]+)*$/u;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_VARIABLES = new Set(['__proto__', 'constructor', 'prototype']);

function checkField(field: unknown, where: string): asserts field is string {
  if (
    typeof field !== 'string' ||
    !DOT_PATH.test(field) ||
    [...field].some((char) => char < ' ' || char === '\u007f')
  )
    throw new Error(`${where}: expected a nonempty dot-path`);
}

/**
 * Parse every declaration before projecting any records. The document must be
 * prepared with its schema references resolved, as by loadOpenApiDocument.
 * Schema references describe shape only and never select a target resource.
 */
export function embeddedResourcesOf(
  document: OpenApiDocument,
  sourceResource: string,
): EmbeddedResourceDeclaration[] {
  const resources = document.components?.['crudResources'];
  const source = isRecord(resources)
    ? own(resources, sourceResource)
    : undefined;
  if (!isRecord(source))
    throw new Error(`${sourceResource} is not a crudResources key`);
  const raw = own(source, 'x-embeddedResources');
  if (raw === undefined) return [];
  const where = `crudResources.${sourceResource}.x-embeddedResources`;
  if (!isRecord(raw)) throw new Error(`${where}: expected an object`);
  const declarations: EmbeddedResourceDeclaration[] = [];

  for (const [field, entry] of Object.entries(raw)) {
    checkField(field, where);
    if (
      declarations.some(
        (other) =>
          field.startsWith(`${other.field}.`) ||
          other.field.startsWith(`${field}.`),
      )
    )
      throw new Error(`${where}.${field}: overlapping source field paths`);
    const at = `${where}.${field}`;
    if (!isRecord(entry)) throw new Error(`${at}: expected an object`);
    for (const key of Object.keys(entry))
      if (key !== 'resource' && key !== 'cardinality' && !key.startsWith('x-'))
        throw new Error(`${at}.${key}: unknown field`);
    const resource = own(entry, 'resource');
    const target =
      typeof resource === 'string' && isRecord(resources)
        ? own(resources, resource)
        : undefined;
    if (typeof resource !== 'string' || !isRecord(target))
      throw new Error(`${at}.resource must name a declared CRUD resource`);
    const cardinality = own(entry, 'cardinality');
    if (cardinality !== 'one' && cardinality !== 'many')
      throw new Error(`${at}.cardinality must be one or many`);
    const schema = own(target, 'schema');
    if (
      !isRecord(schema) ||
      own(schema, '$ref') !== undefined ||
      (own(schema, 'type') !== undefined && own(schema, 'type') !== 'object') ||
      (own(schema, 'properties') !== undefined &&
        !isRecord(own(schema, 'properties'))) ||
      (own(schema, 'type') !== 'object' && !isRecord(own(schema, 'properties')))
    )
      throw new Error(
        `${at}: ${resource}.schema must be a resolved object schema`,
      );
    const identity = own(target, 'identity');
    const template = isRecord(identity)
      ? own(identity, 'urlTemplate')
      : undefined;
    if (typeof template !== 'string')
      throw new Error(`${at}: ${resource}.identity.urlTemplate is required`);
    validateIdentityTemplate(template, resource, at);
    const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    if (
      names.some(
        (name) => !VARIABLE.test(name) || RESERVED_VARIABLES.has(name),
      ) ||
      /[{}]/.test(template.replace(/\{[^}]+\}/g, ''))
    )
      throw new Error(`${at}: malformed identity template variables`);
    const declaredBindings = isRecord(identity)
      ? own(identity, 'bindings')
      : undefined;
    if (declaredBindings !== undefined && !isRecord(declaredBindings))
      throw new Error(`${at}: ${resource}.identity.bindings must be an object`);
    const bindings: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(declaredBindings ?? {})) {
      if (!names.includes(name))
        throw new Error(
          `${at}: binding ${name} is not an identity template variable`,
        );
      const path = isRecord(binding) ? own(binding, 'field') : undefined;
      checkField(path, `${at}: identity.bindings.${name}.field`);
      bindings[name] = { field: path };
    }
    declarations.push({
      field,
      resource,
      cardinality,
      schema,
      identity: { urlTemplate: template, bindings },
    });
  }
  return declarations;
}

/**
 * Resolve one parsed field without requests or recursive expansion. Values not
 * representing complete, identifiable objects keep the whole original field.
 */
export function resolveEmbeddedResource(
  declaration: EmbeddedResourceDeclaration,
  sourceObject: Record<string, unknown>,
  requestContext: Record<string, string> = {},
): EmbeddedResourceResolution {
  const { field, resource, cardinality, identity } = declaration;
  const parts = field.split('.');
  const parent =
    parts.length === 1
      ? sourceObject
      : fieldValue(sourceObject, parts.slice(0, -1).join('.'));
  const key = parts[parts.length - 1];
  const present = isRecord(parent) && Object.hasOwn(parent, key);
  const original = present ? parent[key] : undefined;
  const result: EmbeddedResourceResolution = {
    field,
    resource,
    cardinality,
    present,
    original,
    status: 'resolved',
    objects: [],
    diagnostics: [],
  };
  if (cardinality === 'one' && (original === undefined || original === null))
    return result;
  const values = cardinality === 'one' ? [original] : original;
  if (!Array.isArray(values)) {
    result.status = 'unresolved';
    result.diagnostics.push({
      message: `${field}: expected an array of embedded objects`,
    });
    return result;
  }
  for (let index = 0; index < values.length; index++) {
    const object = values[index];
    const diagnostic = (message: string): void => {
      result.diagnostics.push(
        cardinality === 'many' ? { index, message } : { message },
      );
    };
    if (!isRecord(object)) {
      diagnostic(`${field}: expected an embedded object`);
      continue;
    }
    try {
      const resolved = resolveBoundIdentity(
        resource,
        identity.urlTemplate,
        identity.bindings,
        object,
        requestContext,
        `x-embeddedResources.${field}`,
      );
      if (resolved) result.objects.push({ ...resolved, object });
    } catch (error) {
      diagnostic(
        error instanceof Error
          ? error.message
          : 'Embedded identity could not be resolved',
      );
    }
  }
  if (result.diagnostics.length) {
    result.status = 'unresolved';
    result.objects = [];
  }
  return result;
}
