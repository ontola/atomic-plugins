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
  /** The definition's `name` when it is a string; else its map key (with `keyedBy: name`); else its id. */
  name: string;
  /** The definition's type, a key of the declaration's `types`. */
  type: string;
  /** The Type Object's `schema` for the value. */
  schema: SchemaObject;
  /** The definition's key in a `map`-shaped describer; absent for `array`. */
  key?: string;
  /** Present when the declaration names a `description` field; `null` when the definition has none. */
  description?: unknown;
  /**
   * For an option type: option id to its name (`null` when the option has
   * no string name), as the definition lists them; of a repeated option id,
   * the first.
   */
  options?: Record<string, string | null>;
  /** For an option type: whether a value is an array of option references. */
  multiple?: boolean;
}

/** The class one describer defines (§5.1). */
export interface RuntimeClass {
  properties: Record<string, RuntimeProperty>;
  /** Definition ids whose type has no Type Object (§5.4); no property. */
  undescribed: string[];
  /** Every definition's name, by id (the first, for a repeated id), described or not. */
  names: Record<string, string>;
  /** Definition ids that occur more than once (§5.1); no property. */
  duplicates: string[];
  /** Names two or more definitions share: under `match: key` with `keyedBy: name`, a member keyed by one matches nothing. */
  duplicateNames: string[];
  /** The other names a repeated id goes by, to that id, so a member keyed by one is undescribed. */
  duplicateIdNames: Record<string, string>;
  /** Option ids an option definition lists more than once, by definition id; the first is kept. */
  duplicateOptions: Record<string, string[]>;
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
  /**
   * Present when the item has no class to be read against: its reference
   * identifies no describer, or the describer could not be read (§5.5).
   * Every member is then unmatched, and none was interpreted.
   */
  noClass?: true;
  /** Values by definition id. An option value is its option id, or an array of them. */
  values: Record<string, unknown>;
  /** Member keys matched to no definition (or under a type the definition no longer has). */
  unmatched: string[];
  /** Member keys whose definition's type is undescribed, or whose id is duplicated. */
  undescribed: string[];
  /** Member keys whose option value has the wrong shape, or whose `memberId` is present but not a string. */
  invalid: string[];
  /** Member keys of two or more members that match one definition; none gives a value. */
  conflicting: string[];
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

/**
 * Every record this module builds from provider or document keys is
 * created without a prototype, and read through `own`: a definition,
 * option or type named `constructor`, `toString` or `__proto__` is an
 * ordinary key, never an inherited member.
 */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** `record[key]` when `record` has it as its own property, else undefined. */
function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const SEGMENT = /\["([^"]+)"\]|([^.[\]]+)/y;

/**
 * Dot-path segments (§3): `.`-separated, `["a.b"]` for a segment holding a
 * dot; `''` is no segment. Throws on a malformed path (an empty segment, an
 * unclosed bracket), as the spec's `segments()` does.
 */
function segments(path: string): string[] {
  if (path === '') return [];
  const out: string[] = [];
  let position = 0;
  for (;;) {
    SEGMENT.lastIndex = position;
    const match = SEGMENT.exec(path);
    if (!match) throw new Error(`malformed dot-path ${JSON.stringify(path)}`);
    out.push((match[1] ?? match[2]) as string);
    position = SEGMENT.lastIndex;
    if (position === path.length) return out;
    if (path[position] !== '.')
      throw new Error(`malformed dot-path ${JSON.stringify(path)}`);
    position += 1;
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

/** A dot-path field of the declaration: a string that parses (`''` only where `empty` allows it). */
function dotPath(value: unknown, where: string, empty = false): string {
  const path = text(value, where);
  if (path === '' && !empty) throw new Error(`${where} must not be empty`);
  try {
    segments(path);
  } catch (error) {
    throw new Error(`${where}: ${(error as Error).message}`);
  }
  return path;
}

/**
 * The resources of `document` that declare `x-runtime-schema`, with their
 * declarations. A declaration the reader cannot use (a missing required
 * field, a malformed dot-path, no `types`, a type without `schema`, an
 * unknown reference) is left out, and its message put in `failures` by
 * resource.
 */
export function runtimeSchemasOf(
  document: OpenApiDocument,
  failures: Map<string, string> = new Map(),
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
      failures.set(
        resource,
        error instanceof Error ? error.message : String(error),
      );
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
    ? own(references, referenceName)
    : undefined;
  if (!isRecord(reference))
    throw new Error(
      `${where}.describedBy.reference names no reference ${referenceName}`,
    );
  const target = own(resources, asText(reference['resource']));
  const identity = isRecord(target) ? target['identity'] : undefined;
  if (!isRecord(identity) || typeof identity['urlTemplate'] !== 'string')
    throw new Error(
      `${where}: reference ${referenceName} names no resource with an identity.urlTemplate`,
    );
  const bindings = dict<string>();
  if (isRecord(reference['bindings']))
    for (const [variable, binding] of Object.entries(reference['bindings'])) {
      if (isRecord(binding))
        bindings[variable] = dotPath(
          binding['field'],
          `${where}: reference ${referenceName} binding ${variable}.field`,
        );
    }
  if (!Object.keys(types).length)
    throw new Error(`${where}.types must have at least one entry`);
  const typeObjects = dict<TypeObject>();
  for (const [kind, type] of Object.entries(types)) {
    const here = `${where}.types.${kind}`;
    if (!isRecord(type)) throw new Error(`${here} must be an object`);
    if (!isRecord(type['schema']))
      throw new Error(`${here}.schema is required`);
    const options = type['options'];
    if (options !== undefined && !isRecord(options))
      throw new Error(`${here}.options must be an object`);
    if (type['multiple'] !== undefined && !options)
      throw new Error(`${here}.multiple needs options`);
    typeObjects[kind] = {
      value: dotPath(type['value'], `${here}.value`, true),
      schema: type['schema'] as SchemaObject,
      ...(options
        ? {
            options: {
              field: dotPath(options['field'], `${here}.options.field`),
              id: dotPath(options['id'], `${here}.options.id`),
              name: dotPath(options['name'], `${here}.options.name`),
              valueId: dotPath(options['valueId'], `${here}.options.valueId`),
            },
            multiple: type['multiple'] === true,
          }
        : {}),
    };
  }
  const optional = (value: unknown, name: string): string | undefined =>
    value === undefined ? undefined : dotPath(value, `${where}.${name}`);
  const memberId = optional(raw['memberId'], 'memberId');
  const memberType = optional(raw['memberType'], 'memberType');
  const definitionName = optional(definition['name'], 'definition.name');
  const description = optional(
    definition['description'],
    'definition.description',
  );
  return {
    field: dotPath(raw['field'], `${where}.field`),
    keyedBy,
    match,
    ...(memberId !== undefined ? { memberId } : {}),
    ...(memberType !== undefined ? { memberType } : {}),
    describedBy: {
      definitions: dotPath(
        describedBy['definitions'],
        `${where}.describedBy.definitions`,
      ),
      shape,
    },
    definition: {
      id: dotPath(definition['id'], `${where}.definition.id`),
      type: dotPath(definition['type'], `${where}.definition.type`),
      ...(definitionName !== undefined ? { name: definitionName } : {}),
      ...(description !== undefined ? { description } : {}),
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
  // Without a prototype, so a template variable named `__proto__` that
  // nothing binds is missing, not Object.prototype.
  const values = Object.assign(dict<string>(), context);
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

/**
 * §5.1: the class one describer defines, after the spec's `derive_class`.
 * A definition without a string id and type is skipped; a name that is not
 * a string is replaced by the map key (with `keyedBy: name`), else the id.
 *
 * Order: a `map`-shaped describer is walked in JavaScript's own key order,
 * which puts integer-like keys (`"2"`, `"10"`) first, in ascending order,
 * before the others in the order the JSON gives them. So "the first" of a
 * repeated definition id, and the order of `names`, `undescribed` and the
 * other lists, can differ from the JSON text, and from the Python
 * reference's dict order, when a map has integer-like keys. The same holds
 * for an item's members.
 */
export function deriveRuntimeClass(
  runtime: RuntimeSchema,
  describer: unknown,
): RuntimeClass {
  const fields = runtime.definition;
  const derived: RuntimeClass = {
    properties: dict(),
    undescribed: [],
    names: dict(),
    duplicates: [],
    duplicateNames: [],
    duplicateIdNames: dict(),
    duplicateOptions: dict(),
  };
  const seen = new Set<string>();
  const nameCount = new Map<string, number>();
  for (const [key, definition] of definitionsOf(runtime, describer)) {
    if (!isRecord(definition)) continue;
    const id = at(definition, fields.id);
    const kind = at(definition, fields.type);
    if (typeof id !== 'string' || typeof kind !== 'string') continue;
    let name =
      fields.name === undefined ? MISSING : at(definition, fields.name);
    if (typeof name !== 'string')
      name = key !== undefined && runtime.keyedBy === 'name' ? key : id;
    const named = name as string;
    if (seen.has(id)) {
      if (!derived.duplicates.includes(id)) derived.duplicates.push(id);
      // Every name a repeated id goes by points at it, so a member keyed by
      // any of them is undescribed rather than unmatched.
      derived.duplicateIdNames[named] = id;
      continue;
    }
    seen.add(id);
    derived.names[id] = named;
    nameCount.set(named, (nameCount.get(named) ?? 0) + 1);
    const type = own(runtime.types, kind);
    if (!type) {
      derived.undescribed.push(id);
      continue;
    }
    const property: RuntimeProperty = {
      name: named,
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
      const options = dict<string | null>();
      for (const option of Array.isArray(listed) ? listed : []) {
        const optionId = at(option, type.options.id);
        if (typeof optionId !== 'string') continue;
        if (Object.hasOwn(options, optionId)) {
          const repeated = own(derived.duplicateOptions, id) ?? [];
          repeated.push(optionId);
          derived.duplicateOptions[id] = repeated;
          continue;
        }
        const optionName = at(option, type.options.name);
        options[optionId] = typeof optionName === 'string' ? optionName : null;
      }
      property.options = options;
      property.multiple = type.multiple === true;
    }
    derived.properties[id] = property;
  }
  for (const id of derived.duplicates) {
    delete derived.properties[id];
    const i = derived.undescribed.indexOf(id);
    if (i >= 0) derived.undescribed.splice(i, 1);
  }
  derived.duplicateNames = [...nameCount]
    .filter(([, count]) => count > 1)
    .map(([name]) => name);
  return derived;
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
 * §5.1 to §5.4: one item's members against a class, after the spec's
 * `read_members`. Without a class (the describer could not be read, or the
 * item identifies none), every member is unmatched (§5.5).
 */
export function readRuntimeMembers(
  runtime: RuntimeSchema,
  derived: RuntimeClass | undefined,
  item: Record<string, unknown>,
): Omit<RuntimeMembers, 'describer'> {
  const result: Omit<RuntimeMembers, 'describer'> = {
    values: dict(),
    unmatched: [],
    undescribed: [],
    invalid: [],
    conflicting: [],
  };
  const members = at(item, runtime.field);
  if (!isRecord(members)) return result;
  if (!derived) {
    result.unmatched.push(...Object.keys(members));
    return result;
  }
  const { properties } = derived;
  const skipped = new Set([...derived.undescribed, ...derived.duplicates]);
  // Under match: key, a member's key names its definition: every
  // definition's id or name (described or not), never a name two share.
  const byKey = new Map<string, string>();
  if (runtime.keyedBy === 'id') {
    for (const id of Object.keys(derived.names)) byKey.set(id, id);
    for (const id of skipped) byKey.set(id, id);
  } else {
    const ambiguous = new Set(derived.duplicateNames);
    for (const [id, name] of Object.entries(derived.names))
      if (!ambiguous.has(name)) byKey.set(name, id);
    for (const [name, id] of Object.entries(derived.duplicateIdNames))
      byKey.set(name, id);
  }
  const matched = new Map<string, string[]>();
  for (const [key, member] of Object.entries(members)) {
    const id =
      runtime.match === 'id'
        ? at(member, runtime.memberId as string)
        : (byKey.get(key) ?? MISSING);
    if (id !== MISSING && typeof id !== 'string') {
      // A memberId that is present but not a string (an object, an array, a
      // number, null, a boolean) names no definition: invalid, no value.
      result.invalid.push(key);
      continue;
    }
    if (typeof id === 'string' && skipped.has(id)) {
      result.undescribed.push(key);
      continue;
    }
    const property = typeof id === 'string' ? own(properties, id) : undefined;
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
    matched.set(id as string, [...(matched.get(id as string) ?? []), key]);
  }
  for (const [id, keys] of matched) {
    if (keys.length > 1) {
      result.conflicting.push(...keys);
      continue;
    }
    const key = keys[0] as string;
    const property = own(properties, id) as RuntimeProperty;
    const type = own(runtime.types, property.type) as TypeObject;
    let value = at(members[key], type.value);
    // No value at the type's path: the item holds no value (§4.4), not null.
    if (value === MISSING) continue;
    if (type.options) {
      value = optionIds(value, type.options.valueId, type.multiple === true);
      if (value === MISSING) {
        result.invalid.push(key);
        continue;
      }
    }
    result.values[id] = value;
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
 * class and interprets the items. Describers are keyed per resource and
 * path: two resources naming one path read it twice, each with its own
 * declaration. A describer for which a member matched no definition is read
 * once more; under `match: id` the items with an unmatched member are then
 * interpreted again (§5.2). A describer that cannot be read, budget errors
 * included, leaves its items without a class (§5.5), and is named in
 * `errors`.
 */
export async function interpretRuntimeItems(
  schemas: Map<string, RuntimeSchema>,
  items: RuntimeItem[],
  budget: Budget,
  upstream: URL,
  errors: string[] = [],
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
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${entry.resource}: describer ${entry.path}: ${message}`);
      // A failed re-read keeps the class the first read derived.
      if (!entry.class) entry.error = message;
    }
  };
  const interpret = (
    entry: RuntimeItem,
    describer: RuntimeDescriber | undefined,
  ): boolean => {
    const runtime = schemas.get(entry.resource) as RuntimeSchema;
    const members = readRuntimeMembers(runtime, describer?.class, entry.item);
    entry.set({
      ...(describer ? { describer: describer.path } : {}),
      ...(describer?.class ? {} : { noClass: true as const }),
      ...members,
    });
    return members.unmatched.length > 0;
  };
  // Describers are read one at a time, on purpose: each read goes through
  // the read's shared Budget (request count, deadline, throttling waits),
  // in the same order every time, and a read of many items naming one
  // describer must not send it several times at once.
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
    // Interpreting again is safe only when members match by id (§5.2);
    // under match: key the items keep what the first class gave them.
    const runtime = schemas.get(describer.resource) as RuntimeSchema;
    if (runtime.match === 'id')
      for (const entry of unmatched) interpret(entry, describer);
  }
  return [...describers.values()];
}
