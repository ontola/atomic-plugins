/** Strict, provider-independent subset of CRUD Causality used by local sends. */
import { isRecord, discoverReadModel } from '../read/model.js';
import { segmentProblem } from '../read/segment.js';
import { sameJson } from '../client/replace.js';
import type { PreparedCollection } from './sync.js';

type ObjectValue = Record<string, unknown>;
function object(value: unknown, description: string): ObjectValue {
  if (!isRecord(value))
    throw new Error('Missing or unsupported ' + description);
  return value;
}
export class WriteModel {
  readonly resource: string;
  readonly identity: ObjectValue;
  readonly createPath: string;
  private readonly schema: ObjectValue;
  private readonly generated: Set<string>;
  constructor(readonly prepared: PreparedCollection) {
    const { document, source } = prepared;
    const collections = discoverReadModel(document).collections.filter(
      (c) => c.name === source.collection,
    );
    if (collections.length !== 1)
      throw new Error('Select one declared CRUD collection');
    this.resource = collections[0].resource;
    const resources = object(
      document.components?.crudResources,
      'CRUD resources',
    );
    const declaration = object(resources[this.resource], 'CRUD resource');
    this.identity = object(declaration.identity, 'resource identity');
    const bindings = object(this.identity.bindings, 'identity bindings');
    const variables = Object.keys(bindings);
    const template = this.identity.urlTemplate;
    if (
      variables.length !== 1 ||
      typeof template !== 'string' ||
      template.split('{' + variables[0] + '}').length !== 2
    )
      throw new Error('Sending requires one identity variable occurring once');
    const field = object(bindings[variables[0]], 'identity binding').field;
    if (typeof field !== 'string' || !field || field.includes('.'))
      throw new Error('Sending requires one scalar identity field');
    // Refuse unsupported addressing before a non-idempotent create is dispatched.
    this.id({ [field]: 'syncables-validation' });
    this.itemPath('syncables-validation', 'delete');
    const creates = Object.entries(document.paths).filter(([, path]) => {
      const crud = path.post?.['x-crud'];
      return (
        isRecord(crud) &&
        crud.action === 'create' &&
        crud.resource === this.resource
      );
    });
    if (creates.length !== 1)
      throw new Error('Sending requires one declared create operation');
    const [path, item] = creates[0];
    this.createPath = this.bind(path, source.bindings);
    if (item.post?.['x-write-precondition'] !== undefined)
      throw new Error(
        'Unsupported write precondition; sender refuses this operation',
      );
    const crud = object(item.post?.['x-crud'], 'create declaration');
    // Compound creates and URL-derived identities need a different delivery protocol.
    if (
      crud.followUps !== undefined ||
      !isRecord(crud.url) ||
      crud.url.source !== 'template'
    )
      throw new Error('Unsupported compound or URL-derived create');
    const added =
      crud.addedFields === undefined
        ? {}
        : object(crud.addedFields, 'added fields');
    this.generated = new Set(
      Object.entries(added).map(([key, value]) => {
        if (
          key.includes('.') ||
          !isRecord(value) ||
          value.source !== 'generated'
        )
          throw new Error('Unsupported create added-field declaration');
        return key;
      }),
    );
    const body = object(item.post?.requestBody, 'JSON create body');
    const content = object(body.content, 'JSON create content');
    this.schema = object(
      object(content['application/json'], 'JSON create content').schema,
      'create schema',
    );
  }
  private bind(
    template: string,
    values: Record<string, unknown>,
    bindings: ObjectValue = {},
  ): string {
    if (
      !template.startsWith('/') ||
      template.startsWith('//') ||
      /[?#]/.test(template)
    )
      throw new Error('Unsupported resource URL');
    const result = template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
      const value = values[key];
      if (typeof value !== 'string' || segmentProblem(value))
        throw new Error('Invalid path binding: ' + key);
      const binding = bindings[key];
      if (
        isRecord(binding) &&
        binding['x-path-segments'] !== undefined &&
        typeof binding['x-path-segments'] !== 'boolean'
      )
        throw new Error('Invalid resource-name encoding declaration');
      const parts =
        isRecord(binding) && binding['x-path-segments'] === true
          ? value.split('/')
          : [value];
      if (parts.some((part) => segmentProblem(part) !== undefined))
        throw new Error('Invalid resource name');
      return parts.map((part) => encodeURIComponent(part)).join('/');
    });
    if (/[{}]/.test(result)) throw new Error('Unbound resource path');
    return result;
  }
  id(record: ObjectValue): string {
    const bindings = object(this.identity.bindings, 'identity bindings');
    const fields = Object.values(bindings).map(
      (binding) => object(binding, 'identity binding').field,
    );
    if (
      fields.length !== 1 ||
      typeof fields[0] !== 'string' ||
      fields[0].includes('.')
    )
      throw new Error('Sending requires one scalar identity field');
    const id = record[fields[0]];
    if (typeof id !== 'string' || segmentProblem(id))
      throw new Error('Response has no usable resource identity');
    this.itemPath(id, 'get');
    return id;
  }
  itemPath(id: string, method: 'get' | 'delete'): string {
    const template = this.identity.urlTemplate;
    if (typeof template !== 'string') throw new Error('Missing identity URL');
    const bindings = object(this.identity.bindings, 'identity bindings');
    if (Object.keys(bindings).length !== 1)
      throw new Error('Sending requires one identity binding');
    const values: Record<string, unknown> = {
      ...this.prepared.source.bindings,
      [Object.keys(bindings)[0]]: id,
    };
    const path = this.bind(template, values, bindings);
    // The canonical declaration must authorize this action. Proxy aliases may
    // expose an equivalent concrete route but never grant another action.
    if (
      method === 'delete' &&
      this.prepared.document.paths[template]?.delete?.[
        'x-write-precondition'
      ] !== undefined
    )
      throw new Error(
        'Unsupported write precondition; sender refuses this operation',
      );
    const crud = this.prepared.document.paths[template]?.[method]?.['x-crud'];
    if (
      !isRecord(crud) ||
      crud.resource !== this.resource ||
      crud.action !== (method === 'get' ? 'read' : 'delete')
    )
      throw new Error('Undeclared item operation');
    return path;
  }
  /** Recursive resource schemas retain local refs after eager document loading. */
  private resolveSchema(input: ObjectValue): ObjectValue {
    let schema = input;
    const seen = new Set<string>();
    while (schema.$ref !== undefined) {
      const ref = schema.$ref;
      if (
        typeof ref !== 'string' ||
        !ref.startsWith('#/') ||
        seen.has(ref) ||
        seen.size >= 32
      )
        throw new Error('Unsupported or cyclic writable schema reference');
      seen.add(ref);
      let resolved: unknown = this.prepared.document;
      for (const part of decodeURIComponent(ref.slice(2)).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!isRecord(resolved) || !Object.hasOwn(resolved, key))
          throw new Error('Unresolved writable schema reference');
        resolved = resolved[key];
      }
      const siblings = { ...schema };
      delete siblings.$ref;
      schema = {
        ...object(resolved, 'referenced writable schema'),
        ...siblings,
      };
    }
    return schema;
  }
  /** Only declared writable properties may reach a create. Unknown fields fail closed. */
  payload(value: ObjectValue, strict = false): ObjectValue {
    const project = (
      rawSchema: ObjectValue,
      input: unknown,
      at: string,
    ): unknown => {
      const schema = this.resolveSchema(rawSchema);
      if (schema.readOnly === true) {
        if (strict) throw new Error('Output-only field: ' + at);
        return undefined;
      }
      if (schema.type === 'object' || schema.properties !== undefined) {
        if (!isRecord(input)) throw new Error('Expected object at ' + at);
        const properties = object(
          schema.properties,
          'writable properties at ' + at,
        );
        const result = Object.create(null) as ObjectValue;
        for (const [key, child] of Object.entries(input)) {
          if (at === '' && this.generated.has(key)) {
            if (strict) throw new Error('Generated field: ' + key);
            continue;
          }
          if (!Object.hasOwn(properties, key))
            throw new Error('Undeclared field: ' + at + key);
          const property = this.resolveSchema(
            object(properties[key], 'property schema'),
          );
          const projected = project(property, child, at + key + '.');
          if (
            projected !== undefined &&
            !(
              Object.hasOwn(property, 'default') &&
              sameJson(projected, property.default)
            )
          )
            result[key] = projected;
        }
        return result;
      }
      if (schema.type === 'array') {
        if (!Array.isArray(input)) throw new Error('Expected array at ' + at);
        return input.map((item) =>
          project(object(schema.items, 'array item schema'), item, at),
        );
      }
      if (
        !['string', 'boolean', 'integer', 'number'].includes(
          String(schema.type),
        )
      )
        throw new Error('Unsupported writable schema at ' + at);
      if (typeof input !== (schema.type === 'integer' ? 'number' : schema.type))
        throw new Error('Invalid value at ' + at);
      if (
        typeof input === 'number' &&
        (!Number.isFinite(input) ||
          Math.abs(input) > Number.MAX_SAFE_INTEGER ||
          (schema.type === 'integer' && !Number.isInteger(input)))
      )
        throw new Error('Unsafe number at ' + at);
      if (Array.isArray(schema.enum) && !schema.enum.includes(input))
        throw new Error('Invalid enum at ' + at);
      return input;
    };
    return project(this.schema, value, '') as ObjectValue;
  }
}

/** Disjoint object edits merge; competing scalar/array edits require a new explicit edit. */
export function mergeEdit(
  base: ObjectValue,
  desired: ObjectValue,
  remote: ObjectValue,
): ObjectValue {
  const merge = (
    before: unknown,
    local: unknown,
    current: unknown,
    path: string,
  ): unknown => {
    if (sameJson(local, before)) return current;
    if (sameJson(current, before) || sameJson(local, current)) return local;
    if (isRecord(before) && isRecord(local) && isRecord(current)) {
      const output = Object.create(null) as ObjectValue;
      for (const key of new Set([
        ...Object.keys(before),
        ...Object.keys(local),
        ...Object.keys(current),
      ])) {
        const value = merge(
          before[key],
          local[key],
          current[key],
          path + '/' + key,
        );
        if (value !== undefined) output[key] = value;
      }
      return output;
    }
    throw new Error('Concurrent edit at ' + (path || '/'));
  };
  return merge(base, desired, remote, '') as ObjectValue;
}
