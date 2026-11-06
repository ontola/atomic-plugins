import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import {
  indexJson,
  nodeHash,
  type GraphNode,
  type GraphValue,
  type JsonGraph,
} from '../postgres/json-graph.js';
import { SOURCE_ID, SOURCE_JSON } from './sync.js';

export const RECURSIVE_FORMAT = 'syncd-braid-atomic-v1';
export const ATOMIC = 'https://atomicdata.dev/properties/';
export const META = 'urn:syncables:atomic:v1:';
const C = 'https://atomicdata.dev/classes/';
const D = 'https://atomicdata.dev/datatypes/';
const escapePointer = (key: string): string =>
  key.replaceAll('~', '~0').replaceAll('/', '~1');
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integerLexeme = (text: string): boolean => {
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  if (/^-?0(?:\.0*)?$/.test(mantissa)) return true;
  const fraction = mantissa.split('.')[1] ?? '';
  const trailing = /0*$/.exec(fraction)![0].length;
  return BigInt(exponent) - BigInt(fraction.length - trailing) >= 0n;
};
const numeric = Symbol('number-lexeme');
type RawNumber = { [numeric]: string };
type Value =
  | string
  | boolean
  | number
  | null
  | RawNumber
  | Value[]
  | { [key: string]: Value };
const encode = (value: Value): string => {
  if (value && typeof value === 'object' && numeric in value)
    return (value as RawNumber)[numeric];
  if (Array.isArray(value)) return '[' + value.map(encode).join(',') + ']';
  if (record(value))
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + ':' + encode(v as Value))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
};
interface Shape {
  id: string;
  path: string;
  schema: SchemaObject;
  kind:
    | 'object'
    | 'array'
    | 'string'
    | 'boolean'
    | 'integer'
    | 'number'
    | 'unknown';
  fields: Map<string, { id: string; shape: Shape }>;
  items?: Shape;
}
export interface RecursiveAtomicProjection {
  resources: Record<string, string>;
  rootClass: string;
  rootTable: string;
  records: number;
}

/** Schema IDs depend on pinned OAD bytes and JSON Pointer, never observed rows. */
export function atomicSchemaId(documentHash: string, pointer: string): string {
  return META + 'schema:' + nodeHash(JSON.stringify([documentHash, pointer]));
}

/** Compile a raw (not ref-inlined) OAD. Local refs share classes, including cycles.
 * Objects are rows; arrays are rows with indexed occurrence rows. No source value
 * is serialized into a JSON field. Original field contracts remain schema metadata.
 */
export function recursiveAtomicProjector(options: {
  document: OpenApiDocument;
  documentHash: string;
  resource: string;
  namespace: string;
}) {
  const { document, documentHash, resource, namespace } = options;
  if (!/^[a-f0-9]{64}$/.test(documentHash))
    throw Error('Invalid OpenAPI document hash');
  const resources = document.components?.crudResources;
  const declaration = record(resources) ? resources[resource] : undefined;
  if (!record(declaration) || !record(declaration.schema))
    throw Error('CRUD resource needs its OpenAPI schema');
  const shapes = new Map<string, Shape>();
  const schemaRows: Record<string, Value> = {};
  const id = (path: string): string => atomicSchemaId(documentHash, path);
  const label = (path: string): string =>
    path.split('/').at(-1)?.replaceAll('~1', '/').replaceAll('~0', '~') ||
    resource;
  const putProperty = (
    subject: string,
    name: string,
    datatype: string,
    extra: Record<string, Value> = {},
  ): void => {
    schemaRows[subject] = {
      '@id': subject,
      [ATOMIC + 'isA']: [C + 'Property'],
      [ATOMIC + 'shortname']:
        name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase() || 'value',
      [ATOMIC + 'name']: name,
      [ATOMIC + 'datatype']: D + datatype,
      ...extra,
    };
  };
  putProperty(SOURCE_ID, 'source-id', 'string');
  putProperty(META + 'entries', 'entries', 'resourceArray');
  putProperty(META + 'index', 'index', 'integer');
  putProperty(META + 'length', 'length', 'integer');
  putProperty(META + 'null-properties', 'null-properties', 'resourceArray');
  putProperty(META + 'null', 'null', 'boolean');
  for (const [name, datatype] of [
    ['string', 'string'],
    ['number', 'float'],
    ['boolean', 'boolean'],
    ['reference', 'atomicURL'],
  ])
    putProperty(META + 'value-' + name, 'value-' + name, datatype);
  const resolve = (pointer: string): SchemaObject => {
    if (!pointer.startsWith('#/'))
      throw Error('Only local OpenAPI schema references are supported');
    let value: unknown = document;
    for (const segment of pointer.slice(2).split('/'))
      value = record(value)
        ? value[segment.replaceAll('~1', '/').replaceAll('~0', '~')]
        : undefined;
    if (!record(value))
      throw Error('Unresolved OpenAPI schema reference: ' + pointer);
    return value as SchemaObject;
  };
  const compile = (input: SchemaObject, path: string): Shape => {
    if (!record(input)) throw Error('Expected an OpenAPI schema object');
    const aliases = new Set<string>();
    while (typeof input.$ref === 'string') {
      if (aliases.has(input.$ref)) throw Error('Cyclic OpenAPI schema alias');
      aliases.add(input.$ref);
      if (Object.keys(input).some((k) => k !== '$ref' && k !== 'description'))
        throw Error('Unsupported schema reference siblings');
      path = input.$ref;
      input = resolve(path);
    }
    if (
      input.required !== undefined &&
      (!Array.isArray(input.required) ||
        input.required.some((name) => typeof name !== 'string'))
    )
      throw Error('Invalid OpenAPI required fields');
    if (input.properties !== undefined && !record(input.properties))
      throw Error('Invalid OpenAPI properties');
    const previous = shapes.get(path);
    if (previous) return previous;
    // Fail visibly rather than choosing a branch and weakening a declared union.
    if (input.oneOf || input.anyOf || input.allOf)
      throw Error('Composed OpenAPI schemas need an explicit projection');
    const kind =
      input.type ??
      (input.properties ? 'object' : input.items ? 'array' : 'unknown');
    if (
      ![
        'object',
        'array',
        'string',
        'boolean',
        'integer',
        'number',
        'unknown',
      ].includes(kind)
    )
      throw Error('Unsupported OpenAPI schema type');
    const shape: Shape = {
      id: id(path),
      path,
      schema: input,
      kind: kind as Shape['kind'],
      fields: new Map(),
    };
    shapes.set(path, shape);
    if (shape.kind === 'object') {
      for (const [name, schema] of Object.entries(input.properties ?? {})) {
        const fieldPath = path + '/properties/' + escapePointer(name);
        const child = compile(schema, fieldPath);
        const property = id(fieldPath + '/property');
        shape.fields.set(name, { id: property, shape: child });
        propertyFor(property, name, child, schema);
      }
    } else if (shape.kind === 'array') {
      shape.items = compile(input.items ?? {}, path + '/items');
      propertyFor(
        id(path + '/item-value'),
        'value',
        shape.items,
        input.items ?? {},
      );
      schemaRows[id(path + '/entry')] = {
        '@id': id(path + '/entry'),
        [ATOMIC + 'isA']: [C + 'Class'],
        [ATOMIC + 'name']: label(path) + ' entry',
        [ATOMIC + 'requires']: [META + 'index'],
        [ATOMIC + 'recommends']: [id(path + '/item-value'), META + 'null'],
      };
    }
    if (
      shape.kind === 'object' ||
      shape.kind === 'array' ||
      shape.kind === 'unknown'
    ) {
      const required = new Set(input.required ?? []);
      for (const name of required)
        if (!shape.fields.has(name))
          throw Error('Required OpenAPI field has no declared schema');
      schemaRows[shape.id] = {
        '@id': shape.id,
        [ATOMIC + 'isA']: [C + 'Class'],
        [ATOMIC + 'name']: label(path),
        [ATOMIC + 'shortname']: label(path)
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, '-'),
        [META + 'document-hash']: documentHash,
        [META + 'schema-path']: path,
        [META + 'definition']: input as Value,
        [ATOMIC + 'requires']:
          shape.kind === 'array'
            ? [META + 'length']
            : [...shape.fields]
                .filter(
                  ([name, field]) =>
                    required.has(name) && field.shape.schema.nullable !== true,
                )
                .map(([, field]) => field.id),
        [ATOMIC + 'recommends']:
          shape.kind === 'array'
            ? [META + 'entries']
            : [...shape.fields]
                .filter(
                  ([name, field]) =>
                    !required.has(name) || field.shape.schema.nullable === true,
                )
                .map(([, field]) => field.id),
      };
    }
    return shape;
  };
  function propertyFor(
    subject: string,
    name: string,
    shape: Shape,
    definition: SchemaObject,
  ): void {
    const linked = ['object', 'array', 'unknown'].includes(shape.kind);
    const datatype = linked
      ? 'atomicURL'
      : shape.kind === 'number'
        ? 'float'
        : shape.kind;
    putProperty(subject, name, datatype, {
      [META + 'definition']: definition as Value,
      ...(linked ? { [ATOMIC + 'classtype']: shape.id } : {}),
    });
  }
  const root = compile(
    declaration.schema as SchemaObject,
    '#/components/crudResources/' + escapePointer(resource) + '/schema',
  );
  if (root.kind !== 'object')
    throw Error('Source resource must have an object schema');
  (schemaRows[root.id] as Record<string, Value>)[META + 'resource'] = resource;
  putProperty(SOURCE_JSON, 'source-json', 'atomicURL');
  const wrapperClass = id('#/syncd/' + escapePointer(resource));
  schemaRows[wrapperClass] = {
    '@id': wrapperClass,
    [ATOMIC + 'isA']: [C + 'Class'],
    [ATOMIC + 'name']: resource + ' source records',
    [ATOMIC + 'requires']: [SOURCE_ID, SOURCE_JSON],
    [ATOMIC + 'recommends']: [],
    [META + 'source-class']: root.id,
  };
  const dataset = META + 'dataset:' + nodeHash(namespace);
  const tableId = (klass: string): string =>
    dataset + ':table:' + nodeHash(klass);
  const rootTable = tableId(wrapperClass);
  const declaredPaths = new Set(shapes.keys());
  const declaredSubjects = new Set(Object.keys(schemaRows));
  return {
    rootClass: root.id,
    /** Fresh result per accepted snapshot; no account data mutates the schema. */
    project(inputs: Record<string, string>): RecursiveAtomicProjection {
      for (const path of shapes.keys())
        if (!declaredPaths.has(path)) shapes.delete(path);
      for (const subject of Object.keys(schemaRows))
        if (!declaredSubjects.has(subject)) delete schemaRows[subject];
      const output: Record<string, Value> = { ...schemaRows };
      const table = (klass: string): string => {
        const subject = tableId(klass);
        if (!output[subject])
          output[subject] = {
            '@id': subject,
            [ATOMIC + 'isA']: [C + 'Table'],
            [ATOMIC + 'classtype']: klass,
            [ATOMIC + 'parent']: dataset,
            [ATOMIC + 'name']: String(
              (schemaRows[klass] as Record<string, Value> | undefined)?.[
                ATOMIC + 'name'
              ] ?? 'Values',
            ),
          };
        return subject;
      };
      // Empty collections still advertise every declared object and array class.
      for (const [subject, definition] of Object.entries(schemaRows)) {
        const classes = (definition as Record<string, Value>)[ATOMIC + 'isA'];
        if (Array.isArray(classes) && classes.includes(C + 'Class'))
          table(subject);
      }
      table(wrapperClass);
      let count = 0;
      let totalNodes = 0;
      const visit = (
        graph: JsonGraph,
        value: GraphValue,
        shape: Shape,
        key: string,
        depth: number,
      ): Value => {
        if (depth > 128 || ++totalNodes > 100000)
          throw Error('Recursive Atomic projection exceeds node/depth limit');
        if (value[0] === 'null') {
          if (
            shape.kind !== 'unknown' &&
            shape.schema.nullable !== true &&
            !shape.schema.enum?.includes(null)
          )
            throw Error('Null violates OpenAPI field at ' + shape.path);
          return null;
        }
        if (shape.kind === 'unknown') {
          const subject = dataset + ':value:' + nodeHash(key + '/unknown');
          const row: Record<string, Value> = {
            '@id': subject,
            [ATOMIC + 'isA']: [shape.id],
            [ATOMIC + 'parent']: table(shape.id),
          };
          if (value[0] === 'ref') {
            const kind = (
              JSON.parse(graph.nodes.get(value[1])!) as GraphNode
            )[2];
            if (kind === 'scalar') throw Error('Unexpected scalar node');
            row[META + 'value-reference'] = visit(
              graph,
              value,
              compile({ type: kind }, shape.path + '/' + kind),
              key,
              depth + 1,
            );
          } else
            row[META + 'value-' + value[0]] =
              value[0] === 'number' ? { [numeric]: value[1] } : value[1];
          output[subject] = row;
          return subject;
        }
        if (value[0] !== 'ref') {
          const actual =
            value[0] === 'number'
              ? integerLexeme(value[1])
                ? 'integer'
                : 'number'
              : value[0];
          if (
            shape.kind !== actual &&
            !(shape.kind === 'number' && actual === 'integer')
          )
            throw Error(
              'Source value does not match OpenAPI type at ' + shape.path,
            );
          return value[0] === 'number' ? { [numeric]: value[1] } : value[1];
        }
        const node = JSON.parse(graph.nodes.get(value[1])!) as GraphNode;
        const actual = node[2];
        if (!['object', 'array'].includes(actual) || shape.kind !== actual)
          throw Error(
            'Source object/array does not match OpenAPI schema at ' +
              shape.path,
          );
        const subject = dataset + ':value:' + nodeHash(key);
        const row: Record<string, Value> = {
          '@id': subject,
          [ATOMIC + 'isA']: [shape.id],
          [ATOMIC + 'parent']: table(shape.id),
        };
        output[subject] = row;
        if (actual === 'object') {
          const entries = node[3] as [string, GraphValue][];
          for (const name of shape.schema.required ?? [])
            if (!entries.some(([key]) => key === name))
              throw Error('Missing required OpenAPI field: ' + name);
          const nulls: Value[] = [];
          for (const [name, child] of entries) {
            let field = shape.fields.get(name);
            if (!field) {
              if (shape.schema.additionalProperties === false)
                throw Error('Undeclared OpenAPI field: ' + name);
              // Undeclared values are preserved, but never added to the declared class.
              const additional = record(shape.schema.additionalProperties)
                ? (shape.schema.additionalProperties as SchemaObject)
                : {};
              const path =
                shape.path + '/additionalProperties/' + escapePointer(name);
              const childShape = compile(additional, path);
              field = { id: id(path + '/property'), shape: childShape };
              propertyFor(field.id, name, childShape, additional);
              output[field.id] = schemaRows[field.id];
            }
            const projected = visit(
              graph,
              child,
              field.shape,
              key + '/' + escapePointer(name),
              depth + 1,
            );
            if (projected === null) nulls.push(field.id);
            else row[field.id] = projected;
          }
          if (nulls.length) row[META + 'null-properties'] = nulls;
        } else {
          const values = node[3] as GraphValue[];
          row[META + 'length'] = values.length;
          row[META + 'entries'] = values.map((child, index) => {
            const entry = subject + ':entry:' + index;
            const projected = visit(
              graph,
              child,
              shape.items ?? compile({}, shape.path + '/items'),
              key + '/' + index,
              depth + 1,
            );
            output[entry] = {
              '@id': entry,
              [ATOMIC + 'isA']: [id(shape.path + '/entry')],
              [ATOMIC + 'parent']: table(id(shape.path + '/entry')),
              [META + 'index']: index,
              ...(projected === null
                ? { [META + 'null']: true }
                : { [id(shape.path + '/item-value')]: projected }),
            };
            return entry;
          });
        }
        return subject;
      };
      for (const [subject, raw] of Object.entries(inputs)) {
        const graph = indexJson(raw, { maxBytes: 32 * 1024 * 1024 });
        const node = JSON.parse(graph.nodes.get(graph.root)!) as GraphNode;
        if (node[2] !== 'object') throw Error('Expected source wrapper object');
        const fields = new Map(node[3] as [string, GraphValue][]);
        if (!fields.has(SOURCE_ID)) continue;
        if (
          !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|^`\\]*$/.test(subject) ||
          output[subject]
        )
          throw Error('Invalid or colliding source resource subject');
        if (
          fields.get('@id')?.[0] !== 'string' ||
          fields.get('@id')?.[1] !== subject ||
          fields.get(SOURCE_ID)?.[0] !== 'string' ||
          !fields.has(SOURCE_JSON)
        )
          throw Error('Invalid source wrapper identity');
        const nested = visit(
          graph,
          fields.get(SOURCE_JSON)!,
          root,
          subject + '/source-json',
          0,
        );
        output[subject] = {
          '@id': subject,
          [ATOMIC + 'isA']: [wrapperClass],
          [ATOMIC + 'parent']: rootTable,
          [SOURCE_ID]: fields.get(SOURCE_ID)![1] as string,
          [SOURCE_JSON]: nested,
        };
        count++;
      }
      // Additional-property schemas are included only as metadata, not class fields.
      for (const [subject, row] of Object.entries(schemaRows))
        if (!output[subject]) output[subject] = row;
      return {
        resources: Object.fromEntries(
          Object.entries(output)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([subject, value]) => [subject, encode(value)]),
        ),
        rootClass: wrapperClass,
        rootTable,
        records: count,
      };
    },
  };
}
