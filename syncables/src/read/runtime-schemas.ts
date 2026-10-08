import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { asText, isRecord } from './model.js';
import { bindPath, type Budget } from './pages.js';

/**
 * The Runtime Schemas extension (0.1.0-draft,
 * `openapi-extensions/spec/runtime-schemas/`): a CRUD resource whose items
 * hold user-defined values (Notion page properties) names, through one of
 * its CRUD Causality references, the object that describes them (the data
 * source). A read fetches each describer once (and at most once more when a
 * member matches none of its definitions), derives one class per describer,
 * and interprets every item's members against it. A value is never guessed:
 * a member without a value has none (never `null`), and a member that cannot
 * be matched, has an undescribed type, or an option value of the wrong shape
 * is reported, not stored.
 */

/** One property of a derived class, keyed in `RuntimeClass.properties` by the definition's id. */
export interface RuntimeProperty {
  /** The definition's `name`; else its map key (with `keyedBy: name`); else its id. */
  name: unknown;
  /** The definition's type, a key of the declaration's `types`. */
  type: string;
  /** The Type Object's `schema` for the value. */
  schema: SchemaObject;
  /** The definition's key in a `map`-shaped describer; absent for `array`. */
  key?: string;
  /** Present when the declaration names a `description` field; `null` when the definition has none. */
  description?: unknown;
  /** For an option type: option id to its name, as the definition lists them. */
  options?: Record<string, unknown>;
  /** For an option type: whether a value is an array of option references. */
  multiple?: boolean;
}

/** The class one describer defines (§5.1). */
export interface RuntimeClass {
  properties: Record<string, RuntimeProperty>;
  /** Definition ids whose type has no Type Object (§5.4); no property. */
  undescribed: string[];
  /** Definition ids that occur more than once (§5.1); no property. */
  duplicates: string[];
}

/** One describer as the read found it. */
export interface RuntimeDescriber {
  /** The `crudResources` key of the items it describes. */
  resource: string;
  /** The describer's path, relative to `servers[0].url` (the bound identity URL template). */
  path: string;
  /** Absent when the describer could not be read (`error`). */
  class?: RuntimeClass;
  error?: string;
  /** 1, or 2 after a re-read for an unmatched member (§5.2). */
  reads: number;
}

/** One item's members, interpreted (§5.2 to §5.4). */
export interface RuntimeMembers {
  /** The describer's path; absent when the item's reference identifies none. */
  describer?: string;
  /** Values by definition id. An option value is its option id, or an array of them. */
  values: Record<string, unknown>;
  /** Member keys matched to no definition (or under a type the definition no longer has). */
  unmatched: string[];
  /** Member keys whose definition's type is undescribed, or whose id is duplicated. */
  undescribed: string[];
  /** Member keys whose option value has the wrong shape. */
  invalid: string[];
}

interface TypeObject {
  value: string;
  schema: SchemaObject;
  options?: { field: string; id: string; name: string; valueId: string };
  multiple?: boolean;
}

/** A Runtime Schema Object with the reference it names resolved. */
export interface RuntimeSchema {
  field: string;
  keyedBy: 'name' | 'id';
  match: 'id' | 'key';
  memberId?: string;
  memberType?: string;
  describedBy: { definitions: string; shape: 'map' | 'array' };
  definition: { id: string; type: string; name?: string; description?: string };
  types: Record<string, TypeObject>;
  /** The describer's `identity.urlTemplate` and the reference's bindings (variable to item field). */
  describer: { urlTemplate: string; bindings: Record<string, string> };
}

const MISSING = Symbol('missing');

/** Dot-path segments (§3): `.`-separated, `["a.b"]` for a segment holding a dot; `''` is no segment. */
function segments(path: string): string[] {
  if (path === '') return [];
  const out: string[] = [];
  let i = 0;
  for (;;) {
    if (path.startsWith('["', i)) {
      const end = path.indexOf('"]', i + 2);
      if (end < 0) throw new Error(`Unclosed bracket in dot-path ${path}`);
      out.push(path.slice(i + 2, end));
      i = end + 2;
    } else {
      const dot = path.indexOf('.', i);
      const end = dot < 0 ? path.length : dot;
      out.push(path.slice(i, end));
      i = end;
    }
    if (i >= path.length) return out;
    if (path[i] !== '.') throw new Error(`Malformed dot-path ${path}`);
    i += 1;
  }
}

/** The value at a dot-path, or MISSING when any segment is absent. */
function at(value: unknown, path: string): unknown {
  let node = value;
  for (const segment of segments(path)) {
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, segment))
      return MISSING;
    node = node[segment];
  }
  return node;
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') throw new Error(`${where} must be a string`);
  return value;
}

/**
 * The resources of `document` that declare `x-runtime-schema`, with their
 * declarations. A declaration the reader cannot use (a missing required
 * field, an unknown reference) is left out, and named in `errors`.
 */
export function runtimeSchemasOf(
  document: OpenApiDocument,
  errors: string[] = [],
): Map<string, RuntimeSchema> {
  const out = new Map<string, RuntimeSchema>();
  const resources = document.components?.['crudResources'];
  if (!isRecord(resources)) return out;
  for (const [resource, declaration] of Object.entries(resources)) {
    if (!isRecord(declaration) || declaration['x-runtime-schema'] === undefined)
      continue;
    try {
      out.set(resource, runtimeSchema(resource, declaration, resources));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return out;
}

function runtimeSchema(
  resource: string,
  declaration: Record<string, unknown>,
  resources: Record<string, unknown>,
): RuntimeSchema {
  const where = `${resource}.x-runtime-schema`;
  const raw = declaration['x-runtime-schema'];
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const describedBy = raw['describedBy'];
  const definition = raw['definition'];
  const types = raw['types'];
  if (!isRecord(describedBy) || !isRecord(definition) || !isRecord(types))
    throw new Error(`${where} needs describedBy, definition and types`);
  const keyedBy = raw['keyedBy'];
  const match = raw['match'];
  const shape = describedBy['shape'];
  if (keyedBy !== 'name' && keyedBy !== 'id')
    throw new Error(`${where}.keyedBy must be name or id`);
  if (match !== 'id' && match !== 'key')
    throw new Error(`${where}.match must be id or key`);
  if (shape !== 'map' && shape !== 'array')
    throw new Error(`${where}.describedBy.shape must be map or array`);
  if (match === 'id' && typeof raw['memberId'] !== 'string')
    throw new Error(`${where}.memberId is required with match: id`);
  const referenceName = text(
    describedBy['reference'],
    `${where}.describedBy.reference`,
  );
  const references = declaration['references'];
  const reference = isRecord(references)
    ? references[referenceName]
    : undefined;
  if (!isRecord(reference))
    throw new Error(
      `${where}.describedBy.reference names no reference ${referenceName}`,
    );
  const target = resources[asText(reference['resource'])];
  const identity = isRecord(target) ? target['identity'] : undefined;
  if (!isRecord(identity) || typeof identity['urlTemplate'] !== 'string')
    throw new Error(
      `${where}: reference ${referenceName} names no resource with an identity.urlTemplate`,
    );
  const bindings: Record<string, string> = {};
  if (isRecord(reference['bindings']))
    for (const [variable, binding] of Object.entries(reference['bindings'])) {
      if (isRecord(binding) && typeof binding['field'] === 'string')
        bindings[variable] = binding['field'];
    }
  const typeObjects: Record<string, TypeObject> = {};
  for (const [kind, type] of Object.entries(types)) {
    if (!isRecord(type) || typeof type['value'] !== 'string')
      throw new Error(`${where}.types.${kind} needs a value`);
    const options = type['options'];
    typeObjects[kind] = {
      value: type['value'],
      schema: (isRecord(type['schema']) ? type['schema'] : {}) as SchemaObject,
      ...(isRecord(options)
        ? {
            options: {
              field: text(
                options['field'],
                `${where}.types.${kind}.options.field`,
              ),
              id: text(options['id'], `${where}.types.${kind}.options.id`),
              name: text(
                options['name'],
                `${where}.types.${kind}.options.name`,
              ),
              valueId: text(
                options['valueId'],
                `${where}.types.${kind}.options.valueId`,
              ),
            },
            multiple: type['multiple'] === true,
          }
        : {}),
    };
  }
  return {
    field: text(raw['field'], `${where}.field`),
    keyedBy,
    match,
    ...(typeof raw['memberId'] === 'string'
      ? { memberId: raw['memberId'] }
      : {}),
    ...(typeof raw['memberType'] === 'string'
      ? { memberType: raw['memberType'] }
      : {}),
    describedBy: {
      definitions: text(
        describedBy['definitions'],
        `${where}.describedBy.definitions`,
      ),
      shape,
    },
    definition: {
      id: text(definition['id'], `${where}.definition.id`),
      type: text(definition['type'], `${where}.definition.type`),
      ...(typeof definition['name'] === 'string'
        ? { name: definition['name'] }
        : {}),
      ...(typeof definition['description'] === 'string'
        ? { description: definition['description'] }
        : {}),
    },
    types: typeObjects,
    describer: { urlTemplate: identity['urlTemplate'], bindings },
  };
}

/**
 * The describer's path for one item: its reference's bindings read from the
 * item, other variables from the request context. Undefined when a bound
 * field is absent, `null` or empty (§5.5: the item identifies no describer).
 */
export function describerPath(
  runtime: RuntimeSchema,
  item: Record<string, unknown>,
  context: Record<string, string>,
): string | undefined {
  const values = { ...context };
  for (const [variable, field] of Object.entries(runtime.describer.bindings)) {
    const value = at(item, field);
    if (value === MISSING || value === null || value === '') return undefined;
    values[variable] = asText(value);
  }
  try {
    return bindPath(runtime.describer.urlTemplate, values);
  } catch {
    return undefined;
  }
}

function definitionsOf(
  runtime: RuntimeSchema,
  describer: unknown,
): [string | undefined, unknown][] {
  const found = at(describer, runtime.describedBy.definitions);
  if (runtime.describedBy.shape === 'map')
    return isRecord(found) ? Object.entries(found) : [];
  return Array.isArray(found) ? found.map((d) => [undefined, d]) : [];
}

/** §5.1: the class one describer defines. */
export function deriveRuntimeClass(
  runtime: RuntimeSchema,
  describer: unknown,
): RuntimeClass {
  const fields = runtime.definition;
  const properties: Record<string, RuntimeProperty> = {};
  const undescribed: string[] = [];
  const duplicates: string[] = [];
  const seen = new Set<string>();
  for (const [key, definition] of definitionsOf(runtime, describer)) {
    if (!isRecord(definition)) continue;
    const id = at(definition, fields.id);
    const kind = at(definition, fields.type);
    if (typeof id !== 'string' || typeof kind !== 'string') continue;
    if (seen.has(id)) {
      if (!duplicates.includes(id)) duplicates.push(id);
      continue;
    }
    seen.add(id);
    let name =
      fields.name === undefined ? MISSING : at(definition, fields.name);
    if (name === MISSING)
      name = key !== undefined && runtime.keyedBy === 'name' ? key : id;
    const type = runtime.types[kind];
    if (!type) {
      undescribed.push(id);
      continue;
    }
    const property: RuntimeProperty = {
      name,
      type: kind,
      schema: type.schema,
      ...(key !== undefined ? { key } : {}),
    };
    if (fields.description !== undefined) {
      const description = at(definition, fields.description);
      property.description = description === MISSING ? null : description;
    }
    if (type.options) {
      const listed = at(definition, type.options.field);
      const options: Record<string, unknown> = {};
      for (const option of Array.isArray(listed) ? listed : []) {
        const optionId = at(option, type.options.id);
        if (typeof optionId !== 'string') continue;
        const optionName = at(option, type.options.name);
        options[optionId] = optionName === MISSING ? undefined : optionName;
      }
      property.options = options;
      property.multiple = type.multiple === true;
    }
    properties[id] = property;
  }
  for (const id of duplicates) {
    delete properties[id];
    const i = undescribed.indexOf(id);
    if (i >= 0) undescribed.splice(i, 1);
  }
  return { properties, undescribed, duplicates };
}

/** An option value's id or ids, or MISSING when its shape is wrong (§4.5, §5.1). */
function optionIds(
  value: unknown,
  valueId: string,
  multiple: boolean,
): unknown {
  const one = (reference: unknown): string | typeof MISSING => {
    const id = at(reference, valueId);
    return typeof id === 'string' ? id : MISSING;
  };
  if (multiple) {
    if (!Array.isArray(value)) return MISSING;
    const ids = value.map(one);
    return ids.includes(MISSING) ? MISSING : ids;
  }
  return value === null ? null : one(value);
}

/**
 * §5.2 to §5.4: one item's members against a class. Without a class (the
 * describer could not be read, or the item identifies none), every member is
 * unmatched (§5.5).
 */
export function readRuntimeMembers(
  runtime: RuntimeSchema,
  derived: RuntimeClass | undefined,
  item: Record<string, unknown>,
): Omit<RuntimeMembers, 'describer'> {
  const result: Omit<RuntimeMembers, 'describer'> = {
    values: {},
    unmatched: [],
    undescribed: [],
    invalid: [],
  };
  const members = at(item, runtime.field);
  if (!isRecord(members)) return result;
  if (!derived) {
    result.unmatched.push(...Object.keys(members));
    return result;
  }
  const { properties } = derived;
  const byKey = new Map<unknown, string>();
  for (const [id, property] of Object.entries(properties))
    byKey.set(runtime.keyedBy === 'id' ? id : property.name, id);
  const skipped = new Set([...derived.undescribed, ...derived.duplicates]);
  for (const [key, member] of Object.entries(members)) {
    let id: unknown;
    if (runtime.match === 'id') {
      id = at(member, runtime.memberId as string);
    } else {
      id = byKey.get(key) ?? MISSING;
      if (id === MISSING && runtime.keyedBy === 'id' && skipped.has(key))
        id = key;
    }
    if (typeof id === 'string' && skipped.has(id)) {
      result.undescribed.push(key);
      continue;
    }
    const property = typeof id === 'string' ? properties[id] : undefined;
    if (!property) {
      result.unmatched.push(key);
      continue;
    }
    if (
      runtime.memberType !== undefined &&
      at(member, runtime.memberType) !== property.type
    ) {
      result.unmatched.push(key);
      continue;
    }
    const type = runtime.types[property.type] as TypeObject;
    let value = at(member, type.value);
    // No value at the type's path: the item holds no value (§4.4), not null.
    if (value === MISSING) continue;
    if (type.options) {
      value = optionIds(value, type.options.valueId, type.multiple === true);
      if (value === MISSING) {
        result.invalid.push(key);
        continue;
      }
    }
    result.values[id as string] = value;
  }
  return result;
}

/** A read item awaiting interpretation, and where its result goes. */
export interface RuntimeItem {
  resource: string;
  item: Record<string, unknown>;
  context: Record<string, string>;
  set: (members: RuntimeMembers) => void;
}

/**
 * Reads each describer the items name once, through `budget`, derives its
 * class and interprets the items; a describer for which a member matched no
 * definition is read once more and the items with an unmatched member are
 * interpreted again (§5.2). A describer that cannot be read leaves its
 * items without a class (§5.5).
 */
export async function interpretRuntimeItems(
  schemas: Map<string, RuntimeSchema>,
  items: RuntimeItem[],
  budget: Budget,
  upstream: URL,
): Promise<RuntimeDescriber[]> {
  const describers = new Map<string, RuntimeDescriber>();
  const groups = new Map<string, RuntimeItem[]>();
  const read = async (entry: RuntimeDescriber): Promise<void> => {
    entry.reads += 1;
    const url = new URL(upstream.href);
    url.pathname = upstream.pathname.replace(/\/$/, '') + entry.path;
    try {
      const response = await budget.send({
        url,
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`GET ${url.pathname} responded ${response.status}`);
      const body: unknown = JSON.parse(response.body);
      entry.class = deriveRuntimeClass(
        schemas.get(entry.resource) as RuntimeSchema,
        body,
      );
      delete entry.error;
    } catch (error) {
      // A failed re-read keeps the class the first read derived.
      if (!entry.class)
        entry.error = error instanceof Error ? error.message : String(error);
    }
  };
  const interpret = (
    entry: RuntimeItem,
    describer: RuntimeDescriber | undefined,
  ): boolean => {
    const runtime = schemas.get(entry.resource) as RuntimeSchema;
    const members = readRuntimeMembers(runtime, describer?.class, entry.item);
    entry.set(describer ? { describer: describer.path, ...members } : members);
    return members.unmatched.length > 0;
  };
  for (const entry of items) {
    const runtime = schemas.get(entry.resource) as RuntimeSchema;
    const path = describerPath(runtime, entry.item, entry.context);
    if (path === undefined) {
      interpret(entry, undefined);
      continue;
    }
    const key = JSON.stringify([entry.resource, path]);
    if (!describers.has(key)) {
      const describer: RuntimeDescriber = {
        resource: entry.resource,
        path,
        reads: 0,
      };
      describers.set(key, describer);
      await read(describer);
    }
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  for (const [key, group] of groups) {
    const describer = describers.get(key) as RuntimeDescriber;
    const unmatched = group.filter((entry) => interpret(entry, describer));
    if (!unmatched.length || !describer.class) continue;
    await read(describer);
    for (const entry of unmatched) interpret(entry, describer);
  }
  return [...describers.values()];
}
