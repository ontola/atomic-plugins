import type {
  JsonValue,
  NativeResource,
  NativeTableProjection,
  NativeValue,
} from './atomic-tables.js';
import { canonicalProjectionJson } from './atomic-projection-contract.js';
import { nodeHash } from '../postgres/json-graph.js';

export interface OwnedListProfile {
  id: string;
  version: string;
  rootClassName: string;
  listClassName: string;
  itemClassName: string;
  listAt: string[];
  itemsAt: string[];
  childrenAt?: string[];
  itemFields: {
    shortname: string;
    name: string;
    path: string[];
    datatype: 'string' | 'boolean' | 'integer';
    optional?: boolean;
    displayName?: boolean;
  }[];
}
export interface OwnedListSelection {
  rowKey: string;
  bodyPropertyKey: string;
}
type Ref = NativeResource['parent'];
type Pair = NativeResource['properties'][number];
const P = 'https://atomicdata.dev/properties/';
const C = 'https://atomicdata.dev/classes/';
const D = 'https://atomicdata.dev/datatypes/';
const local = (key: string): Ref => ({ local: key });
const external = (key: string): Ref => ({ external: key });
const str = (value: string): NativeValue => ({ type: 'string', value });
const ref = (value: Ref): NativeValue => ({ type: 'resource', value });
const refs = (value: Ref[]): NativeValue => ({ type: 'resources', value });
const pair = (property: Ref, value: NativeValue): Pair => ({ property, value });
const prop = (name: string, value: NativeValue): Pair =>
  pair(external(P + name), value);
const pointer = (path: string[]): string =>
  path.length
    ? '/' +
      path
        .map((part) => part.replace(/~/g, '~0').replace(/\//g, '~1'))
        .join('/')
    : '';
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value;
function path(value: unknown, empty = true): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    (empty || value.length > 0) &&
    value.every(
      (part) =>
        typeof part === 'string' &&
        part.length > 0 &&
        part.length <= 256 &&
        !['__proto__', 'prototype', 'constructor'].includes(part),
    )
  );
}
function validateProfile(profile: OwnedListProfile): void {
  if (
    !record(profile) ||
    Object.keys(profile).some(
      (key) =>
        ![
          'id',
          'version',
          'rootClassName',
          'listClassName',
          'itemClassName',
          'listAt',
          'itemsAt',
          'childrenAt',
          'itemFields',
        ].includes(key),
    ) ||
    ![
      profile.id,
      profile.version,
      profile.rootClassName,
      profile.listClassName,
      profile.itemClassName,
    ].every(text) ||
    !path(profile.listAt) ||
    !path(profile.itemsAt) ||
    (profile.childrenAt !== undefined && !path(profile.childrenAt, false)) ||
    !Array.isArray(profile.itemFields) ||
    profile.itemFields.length > 64
  )
    throw new Error('Malformed owned-list profile');
  const names = new Set<string>();
  let displayNames = 0;
  for (const field of profile.itemFields) {
    if (
      !record(field) ||
      Object.keys(field).some(
        (key) =>
          ![
            'shortname',
            'name',
            'path',
            'datatype',
            'optional',
            'displayName',
          ].includes(key),
      ) ||
      !text(field.shortname) ||
      !text(field.name) ||
      !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(field.shortname) ||
      names.has(field.shortname) ||
      [
        'position',
        'parent-item',
        'child-items',
        'source-path',
        'items',
        'body',
        'original-body',
      ].includes(field.shortname) ||
      !path(field.path, false) ||
      !['string', 'boolean', 'integer'].includes(field.datatype) ||
      (field.optional !== undefined && typeof field.optional !== 'boolean') ||
      (field.displayName !== undefined &&
        typeof field.displayName !== 'boolean') ||
      (field.displayName && field.datatype !== 'string')
    )
      throw new Error('Malformed or duplicate owned-list item field');
    names.add(field.shortname);
    if (field.displayName) displayNames++;
  }
  if (displayNames > 1)
    throw new Error('Owned-list profile permits one display name field');
  if (Buffer.byteLength(JSON.stringify(profile)) > 64 * 1024)
    throw new Error('Owned-list profile exceeds 64 KiB bound');
}
/** Validate JSON before canonicalization, including unknown fields retained verbatim. */
function validateJson(value: unknown): asserts value is JsonValue {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 250_000 || depth > 64)
      throw new Error('Owned-list JSON depth or node bound exceeded');
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'string'
    )
      return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || value === null)
      throw new Error('Owned-list body must be JSON');
    if (active.has(value)) throw new Error('Cyclic owned-list JSON body');
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('Owned-list body must contain plain JSON objects');
    active.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i))
          throw new Error(
            'Owned-list body must not contain sparse JSON arrays',
          );
        visit(value[i], depth + 1);
      }
    } else for (const child of Object.values(value)) visit(child, depth + 1);
    active.delete(value);
  };
  visit(value, 0);
}
function at(value: unknown, path: string[]): unknown {
  for (const segment of path) {
    if (!record(value) || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return value;
}
function coreClass(resource: NativeResource, name: string): boolean {
  return resource.classes.some(
    (cls) => 'external' in cls && cls.external === C + name,
  );
}
function externalValue(
  resource: NativeResource,
  name: string,
): NativeValue | undefined {
  return resource.properties.find(
    (pair) =>
      'external' in pair.property && pair.property.external === P + name,
  )?.value;
}

/** A bounded, immutable snapshot import. Profiles supply every source-specific path. */
export function projectOwnedList(
  base: NativeTableProjection,
  selection: OwnedListSelection,
  profile: OwnedListProfile,
): NativeTableProjection {
  validateProfile(profile);
  if (
    base.format !== 'atomic-tables-v2' ||
    !text(base.owner) ||
    !selection.rowKey ||
    !selection.bodyPropertyKey ||
    base.resources.length > 50_000
  )
    throw new Error('Invalid owned-list source projection or selection');
  const source = new Map<string, NativeResource>();
  for (const resource of base.resources) {
    if (!resource.key || resource.key === 'drive' || source.has(resource.key))
      throw new Error('Duplicate or invalid source resource key');
    source.set(resource.key, resource);
  }
  const root = source.get(selection.rowKey),
    oldBody = source.get(selection.bodyPropertyKey);
  if (!root || !oldBody || !coreClass(oldBody, 'Property'))
    throw new Error('Missing owned-list source row or body Property');
  const checkedParents = new Set<string>();
  const checkParents = (resource: NativeResource): void => {
    const active = new Set<string>();
    let current: NativeResource | undefined = resource;
    while (current) {
      if (active.has(current.key))
        throw new Error('Cyclic owned-list source parent chain');
      if (checkedParents.has(current.key)) break;
      active.add(current.key);
      if (active.size > 256)
        throw new Error('Owned-list source parent depth bound exceeded');
      const parent = current.parent;
      if ('external' in parent || parent.local === 'drive') break;
      current = source.get(parent.local);
      if (!current) throw new Error('Dangling owned-list source parent');
    }
    for (const id of active) checkedParents.add(id);
  };
  checkParents(root);
  checkParents(oldBody);
  const bodies = root.properties.filter(
    (pair) =>
      'local' in pair.property &&
      pair.property.local === selection.bodyPropertyKey,
  );
  if (
    bodies.length !== 1 ||
    bodies[0].value.type !== 'json' ||
    JSON.stringify(externalValue(oldBody, 'datatype')) !==
      JSON.stringify(ref(external(D + 'json')))
  )
    throw new Error('Owned-list source body must be one native JSON Property');
  const body = bodies[0].value.value;
  validateJson(body);
  const encodedBody = canonicalProjectionJson(body);
  if (Buffer.byteLength(encodedBody) > 16 * 1024 * 1024)
    throw new Error('Owned-list body exceeds 16 MiB bound');
  const oldClasses = root.classes.filter(
    (cls) =>
      'local' in cls &&
      source.has(cls.local) &&
      coreClass(source.get(cls.local)!, 'Class'),
  );
  if (oldClasses.length !== 1 || !('local' in oldClasses[0]))
    throw new Error('Owned-list source needs exactly one declared local Class');
  const oldClassKey = oldClasses[0].local;
  const profileHash = nodeHash(
    canonicalProjectionJson(JSON.parse(JSON.stringify(profile))),
  );
  const bodyHash = nodeHash(encodedBody);
  const namespace = nodeHash(
    canonicalProjectionJson([profile.id, base.owner, root.key]),
  );
  const key = (...parts: string[]): string =>
    JSON.stringify(['owned-list', namespace, ...parts]);
  const schemaKey = (...parts: string[]): string =>
    JSON.stringify(['owned-list-schema', profile.id, profileHash, ...parts]);
  const rootSchemaHash = nodeHash(
    canonicalProjectionJson([source.get(oldClassKey), oldBody]),
  );
  const rootKey = key('root'),
    listKey = key('list'),
    importKey = JSON.stringify([
      'owned-list-import',
      nodeHash(canonicalProjectionJson([profile.id, base.owner])),
    ]),
    schemasKey = schemaKey('schemas');
  const rootClassKey = schemaKey('root', rootSchemaHash),
    listClassKey = schemaKey('list'),
    itemClassKey = schemaKey('item');
  const bodyKey = schemaKey('property', 'body'),
    originalBodyKey = schemaKey('property', 'original-body', rootSchemaHash);
  const output = new Map<string, NativeResource>();
  const add = (resource: NativeResource): void => {
    if (output.has(resource.key))
      throw new Error('Duplicate owned-list output key');
    output.set(resource.key, resource);
  };
  const make = (
    key: string,
    parent: Ref,
    classes: Ref[],
    properties: Pair[],
  ): NativeResource => ({ key, parent, classes, properties });
  add(
    make(
      importKey,
      local('drive'),
      [external(C + 'Folder')],
      [prop('name', str(profile.rootClassName + ' list imports'))],
    ),
  );
  add(
    make(
      schemasKey,
      local(importKey),
      [external(C + 'Folder')],
      [prop('name', str(profile.rootClassName + ' list schemas'))],
    ),
  );
  const property = (
    shortname: string,
    name: string,
    datatype: string,
    target?: string,
    description = `Owned-list snapshot ${name.toLowerCase()} (${datatype}) for profile ${profile.id}@${profile.version}.`,
  ): string => {
    const id = schemaKey('property', shortname);
    add(
      make(
        id,
        local(schemasKey),
        [external(C + 'Property')],
        [
          prop('name', str(name)),
          prop('shortname', str('owned-list-' + shortname)),
          prop('description', str(description)),
          prop('datatype', ref(external(D + datatype))),
          ...(target ? [prop('classtype', ref(local(target)))] : []),
        ],
      ),
    );
    return id;
  };
  property(
    'body',
    'Body',
    'atomicURL',
    listClassKey,
    'Owned typed list derived from the original body JSON retained on this root resource.',
  );
  add(
    make(
      originalBodyKey,
      local(schemasKey),
      [external(C + 'Property')],
      [
        prop('name', str('Original body')),
        prop('shortname', str('owned-list-original-body')),
        prop(
          'description',
          str(
            'Complete original source body JSON, retaining all fields independently of the typed list projection.',
          ),
        ),
        prop('datatype', ref(external(D + 'json'))),
        ...oldBody.properties
          .filter(
            (pair) =>
              'external' in pair.property &&
              pair.property.external === P + 'jsonSchema',
          )
          .map((pair) => structuredClone(pair)),
      ],
    ),
  );
  const itemsKey = property('items', 'Items', 'resourceArray', itemClassKey);
  const childrenKey = property(
    'child-items',
    'Child items',
    'resourceArray',
    itemClassKey,
  );
  const parentItemKey = property(
    'parent-item',
    'Parent item',
    'atomicURL',
    itemClassKey,
  );
  const positionKey = property('position', 'Position', 'integer');
  const pathKey = property('source-path', 'Source path', 'string');
  const sourceRootKey = property(
    'source-root-key',
    'Source root key',
    'string',
  );
  const profileHashKey = property('profile-hash', 'Profile hash', 'string');
  const bodyHashKey = property('body-hash', 'Body hash', 'string');
  const fields = profile.itemFields.map((field) => ({
    field,
    key: property(
      'field-' + field.shortname,
      field.name,
      field.datatype,
      undefined,
      `Typed ${field.datatype} at ${pointer(field.path)} relative to an original list item; ${field.optional ? 'absence remains absent' : 'a value is required'}.`,
    ),
  }));
  const schemaStates = new Map<string, 'visiting' | 'done'>();
  const remap = (reference: Ref): Ref => {
    if ('external' in reference) return structuredClone(reference);
    if (reference.local === oldClassKey) return local(rootClassKey);
    if (reference.local === selection.bodyPropertyKey) return local(bodyKey);
    copySchema(reference.local);
    return local(reference.local);
  };
  const remapValue = (value: NativeValue): NativeValue =>
    value.type === 'resource'
      ? ref(remap(value.value))
      : value.type === 'resources'
        ? refs(value.value.map(remap))
        : structuredClone(value);
  const remapProperties = (resource: NativeResource): Pair[] => {
    const seen = new Set<string>();
    return resource.properties.map((entry) => {
      const name = canonicalProjectionJson(entry.property);
      if (seen.has(name))
        throw new Error('Duplicate owned-list source property');
      seen.add(name);
      return pair(remap(entry.property), remapValue(entry.value));
    });
  };
  function copySchema(id: string): void {
    if (schemaStates.has(id)) return; // Recursive schema types are legal; data recursion is not.
    const resource = source.get(id);
    if (
      !resource ||
      !(coreClass(resource, 'Class') || coreClass(resource, 'Property'))
    )
      throw new Error(
        'Dangling reference or non-schema dependency in owned-list source',
      );
    checkParents(resource);
    schemaStates.set(id, 'visiting');
    add(
      make(
        id,
        local(schemasKey),
        resource.classes.map(remap),
        remapProperties(resource),
      ),
    );
    schemaStates.set(id, 'done');
  }
  const originalClass = source.get(oldClassKey)!;
  checkParents(originalClass);
  const classProperties = remapProperties(originalClass).filter(
    (pair) =>
      !(
        'external' in pair.property &&
        [P + 'name', P + 'shortname'].includes(pair.property.external)
      ),
  );
  const recommends = classProperties.find(
    (pair) =>
      'external' in pair.property &&
      pair.property.external === P + 'recommends',
  );
  if (recommends && recommends.value.type !== 'resources')
    throw new Error('Malformed source Class recommendations');
  if (recommends?.value.type === 'resources')
    recommends.value.value.push(local(originalBodyKey));
  else
    classProperties.push(
      prop('recommends', refs([local(bodyKey), local(originalBodyKey)])),
    );
  if (
    !classProperties.some(
      (entry) =>
        'external' in entry.property &&
        entry.property.external === P + 'description',
    )
  )
    classProperties.push(
      prop(
        'description',
        str(
          'Snapshot root with an owned typed list and the complete original body JSON.',
        ),
      ),
    );
  add(
    make(
      rootClassKey,
      local(schemasKey),
      [external(C + 'Class')],
      [
        prop('name', str(profile.rootClassName)),
        prop('shortname', str('owned-list-root-' + profileHash.slice(0, 16))),
        ...classProperties,
      ],
    ),
  );
  const declareClass = (
    id: string,
    name: string,
    required: Ref[],
    recommended: Ref[],
  ): void =>
    add(
      make(
        id,
        local(schemasKey),
        [external(C + 'Class')],
        [
          prop('name', str(name)),
          prop('shortname', str('owned-list-' + nodeHash(id).slice(0, 16))),
          prop(
            'description',
            str(
              `${name} owned snapshot component for profile ${profile.id}@${profile.version}; source body JSON remains on the root resource.`,
            ),
          ),
          prop('requires', refs(required)),
          prop('recommends', refs(recommended)),
        ],
      ),
    );
  declareClass(
    listClassKey,
    profile.listClassName,
    [external(P + 'name'), local(itemsKey)],
    [local(bodyHashKey)],
  );
  declareClass(
    itemClassKey,
    profile.itemClassName,
    [
      external(P + 'name'),
      local(positionKey),
      ...fields
        .filter(({ field }) => !field.optional)
        .map(({ key }) => local(key)),
    ],
    [
      ...fields.map(({ key }) => local(key)),
      local(parentItemKey),
      local(childrenKey),
      local(pathKey),
    ],
  );
  const rootName = externalValue(root, 'name');
  if (!rootName || rootName.type !== 'string')
    throw new Error('Owned-list source row needs a native name');
  const rootProperties = remapProperties(root).filter(
    (entry) => !('local' in entry.property && entry.property.local === bodyKey),
  );
  rootProperties.push(
    pair(local(bodyKey), ref(local(listKey))),
    pair(local(originalBodyKey), structuredClone(bodies[0].value)),
    pair(local(sourceRootKey), str(root.key)),
    pair(local(profileHashKey), str(profileHash)),
    pair(local(bodyHashKey), str(bodyHash)),
  );
  add(make(rootKey, local(importKey), root.classes.map(remap), rootProperties));
  const sourceList = at(body, profile.listAt),
    top = at(sourceList, profile.itemsAt);
  if (!Array.isArray(top))
    throw new Error('Owned-list profile must select an item array');
  let count = 0;
  const renderItems = (
    items: unknown[],
    sourcePath: string[],
    parentItem?: string,
  ): string[] =>
    items.map((item, index) => {
      if (++count > 5000)
        throw new Error('Owned-list exceeds the 5000 item bound');
      if (!record(item)) throw new Error('Owned-list item must be an object');
      const itemPath = [...sourcePath, String(index)],
        id = key('item', bodyHash, pointer(itemPath)),
        position = count - 1;
      const properties: Pair[] = [
        pair(local(positionKey), { type: 'integer', value: position }),
        pair(local(pathKey), str(pointer(itemPath))),
      ];
      let name: string | undefined;
      for (const { field, key } of fields) {
        const value = at(item, field.path);
        if (value === undefined && field.optional) continue;
        if (
          field.datatype === 'integer'
            ? !Number.isSafeInteger(value)
            : typeof value !== field.datatype
        )
          throw new Error(
            'Missing or mistyped owned-list item field: ' + field.shortname,
          );
        const native = { type: field.datatype, value } as NativeValue;
        properties.push(pair(local(key), native));
        if (field.displayName) name = value as string;
      }
      properties.unshift(
        prop(
          'name',
          str(name?.trim() ? name : 'List item ' + String(position + 1)),
        ),
      );
      if (parentItem)
        properties.push(pair(local(parentItemKey), ref(local(parentItem))));
      const childValue = profile.childrenAt
        ? at(item, profile.childrenAt)
        : undefined;
      if (childValue !== undefined) {
        if (!Array.isArray(childValue))
          throw new Error('Owned-list children must be an array');
        const childIds = renderItems(
          childValue,
          [...itemPath, ...profile.childrenAt!],
          id,
        );
        properties.push(pair(local(childrenKey), refs(childIds.map(local))));
      }
      add(make(id, local(listKey), [local(itemClassKey)], properties));
      return id;
    });
  const topIds = renderItems(top, [...profile.listAt, ...profile.itemsAt]);
  const viewKey = key('view');
  add(
    make(
      listKey,
      local(rootKey),
      // The data browser selects its built-in view from the first Class.
      [external(C + 'Table'), local(listClassKey)],
      [
        prop('name', str(rootName.value + ' · ' + profile.listClassName)),
        prop('classtype', ref(local(itemClassKey))),
        pair(local(itemsKey), refs(topIds.map(local))),
        pair(local(bodyHashKey), str(bodyHash)),
        prop('table-views', refs([local(viewKey)])),
        prop('table-default-view', ref(local(viewKey))),
      ],
    ),
  );
  add(
    make(
      viewKey,
      local(listKey),
      [external(C + 'View')],
      [
        prop('name', str('Ordered items')),
        prop('view-kind', str('table')),
        prop(
          'view-columns',
          refs([
            external(P + 'name'),
            ...fields
              .filter(({ field }) => !field.displayName)
              .map(({ key }) => local(key)),
            local(positionKey),
          ]),
        ),
        prop('view-sort-by', ref(local(positionKey))),
        prop('view-sort-desc', { type: 'boolean', value: false }),
      ],
    ),
  );
  const schemaRank = (resource: NativeResource): number =>
    coreClass(resource, 'Property') ? 0 : coreClass(resource, 'Class') ? 1 : 2;
  const ordered = [...output.values()].sort(
    (a, b) =>
      schemaRank(a) - schemaRank(b) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  if (ordered.length > 50_000)
    throw new Error('Owned-list graph exceeds 50000 resource bound');
  const keys = new Set(['drive', ...output.keys()]);
  const checkRef = (reference: Ref): void => {
    if ('local' in reference) {
      if (!keys.has(reference.local))
        throw new Error('Dangling owned-list output reference');
    } else {
      try {
        new URL(reference.external);
      } catch {
        throw new Error('Invalid owned-list external reference');
      }
    }
  };
  for (const resource of ordered) {
    if (resource.key.length > 8192 || !resource.classes.length)
      throw new Error('Invalid owned-list output resource');
    checkRef(resource.parent);
    resource.classes.forEach(checkRef);
    const properties = new Set<string>();
    for (const entry of resource.properties) {
      const propertyKey = canonicalProjectionJson(entry.property);
      if (properties.has(propertyKey))
        throw new Error('Duplicate owned-list output property');
      properties.add(propertyKey);
      checkRef(entry.property);
      if (entry.value.type === 'resource') checkRef(entry.value.value);
      if (entry.value.type === 'resources') entry.value.value.forEach(checkRef);
    }
  }
  const content = {
    format: 'atomic-tables-v2' as const,
    owner: base.owner,
    sources: structuredClone(base.sources),
    resources: ordered,
  };
  const encoded = canonicalProjectionJson(content);
  if (Buffer.byteLength(encoded) > 48 * 1024 * 1024)
    throw new Error('Owned-list graph exceeds 48 MiB bound');
  return { ...content, revision: nodeHash(encoded) };
}
