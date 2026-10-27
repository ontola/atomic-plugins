import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { discoverReadModel } from '../read/model.js';
import {
  indexJson,
  nodeHash,
  type GraphNode,
  type GraphValue,
  type JsonGraph,
} from '../postgres/json-graph.js';
import type { PostgresHistoryStore } from './history-store.js';
import type { PreparedCollection } from './sync.js';
import { SOURCE_ID, SOURCE_JSON } from './sync.js';
import { alias } from './config.js';

export const TABLE_BINDING = 'syncables-atomic-tables-v2';
const P = 'https://atomicdata.dev/properties/';
const C = 'https://atomicdata.dev/classes/';
const D = 'https://atomicdata.dev/datatypes/';
type Ref = { local: string } | { external: string };
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type NativeValue =
  | { type: 'string'; value: string }
  | { type: 'integer' | 'float'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'resource'; value: Ref }
  | { type: 'resources'; value: Ref[] }
  | { type: 'json'; value: JsonValue };
export interface NativeResource {
  key: string;
  parent: Ref;
  classes: Ref[];
  properties: { property: Ref; value: NativeValue }[];
}
export interface NativeTableProjection {
  format: 'atomic-tables-v2';
  owner: string;
  revision: string;
  sources: { collection: string; revision: string; documentHash: string }[];
  resources: NativeResource[];
}
export interface TableSource {
  prepared: PreparedCollection;
  revision: string;
}
const local = (key: string): Ref => ({ local: key });
const external = (key: string): Ref => ({ external: key });
const str = (value: string): NativeValue => ({ type: 'string', value });
const refs = (values: Ref[]): NativeValue => ({
  type: 'resources',
  value: values,
});
const ref = (value: Ref): NativeValue => ({ type: 'resource', value });
function absoluteUri(value: string): boolean {
  try {
    return !!new URL(value).protocol;
  } catch {
    return false;
  }
}
const label = (key: string): string =>
  key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pointer = (path: string[], key: string): string[] => [...path, key];
const identity = (...parts: string[]): string => JSON.stringify(parts);

/** Exact decimal value comparison without passing the original lexeme through Number. */
function decimal(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(value)!;
  let digits = (m[2] + (m[3] ?? '')).replace(/^0+/, '');
  if (!digits) return '0';
  const trailing = /0*$/.exec(digits)![0].length;
  digits = digits.slice(0, digits.length - trailing);
  return (
    m[1] +
    digits +
    'e' +
    (BigInt(m[4] ?? '0') - BigInt(m[3]?.length ?? 0) + BigInt(trailing))
  );
}
function numberValue(lexeme: string): NativeValue {
  const n = Number(lexeme);
  if (
    !Number.isFinite(n) ||
    (Number.isInteger(n) && !Number.isSafeInteger(n)) ||
    decimal(String(n)) !== decimal(lexeme)
  )
    return str(lexeme);
  return { type: Number.isInteger(n) ? 'integer' : 'float', value: n };
}
function node(graph: JsonGraph, value: GraphValue): GraphNode | undefined {
  return value[0] === 'ref'
    ? (JSON.parse(graph.nodes.get(value[1])!) as GraphNode)
    : undefined;
}
function entries(graph: JsonGraph, value: GraphValue): [string, GraphValue][] {
  const n = node(graph, value);
  return n?.[2] === 'object' ? (n[3] as [string, GraphValue][]) : [];
}
function combined(schema: SchemaObject = {}): SchemaObject {
  return {
    ...schema,
    properties: Object.assign(
      {},
      ...(schema.allOf ?? []).map((s) => combined(s).properties),
      schema.properties,
    ) as Record<string, SchemaObject>,
  };
}
/** Carry recursive component references with the field's standalone schema. */
function schemaValue(
  schema: SchemaObject,
  document: OpenApiDocument,
): JsonValue {
  const result = JSON.parse(JSON.stringify(schema)) as Record<
    string,
    JsonValue
  >;
  const definitions: Record<string, JsonValue> = Object.create(null);
  const scan = (value: JsonValue): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    const reference = value.$ref;
    if (
      typeof reference === 'string' &&
      reference.startsWith('#/components/schemas/')
    ) {
      const name = reference
        .split('/')[3]
        .replace(/~1/g, '/')
        .replace(/~0/g, '~');
      if (!Object.hasOwn(definitions, name)) {
        const target = document.components?.schemas?.[name];
        if (!target)
          throw new Error('Unresolved OpenAPI field schema reference');
        definitions[name] = JSON.parse(JSON.stringify(target)) as JsonValue;
        scan(definitions[name]);
      }
    }
    Object.values(value).forEach(scan);
  };
  scan(result);
  if (Object.keys(definitions).length)
    result.components = { schemas: definitions };
  return result;
}

/** Resolved list-response item schema, when the OpenAPI contract declares one. */
export function atomicItemSchema(prepared: PreparedCollection): SchemaObject {
  const collection = discoverReadModel(prepared.document).collections.find(
    (c) => c.name === prepared.source.collection,
  );
  if (!collection) throw new Error('Unknown Atomic table collection');
  const operation =
    prepared.document.paths[collection.url]?.[
      collection.method.toLowerCase() as 'get' | 'post'
    ];
  const response = Object.entries(operation?.responses ?? {}).find(([code]) =>
    /^2\d\d$/.test(code),
  )?.[1];
  let schema = response?.content?.['application/json']?.schema;
  for (const field of collection.itemsField?.split('.').filter(Boolean) ?? [])
    schema = combined(schema).properties?.[field];
  return combined(
    schema?.type === 'array' || schema?.items ? schema.items : schema,
  );
}

/** Build only native Atomic data; original response/JSON-AD text stays in PostgreSQL. */
export async function atomicTablesProjection(
  store: PostgresHistoryStore,
  selected: TableSource[],
): Promise<NativeTableProjection> {
  if (!selected.length || selected.length > 100)
    throw new Error('Select one to 100 collections');
  const resources = new Map<string, NativeResource>();
  const schemaResources = new Set<string>();
  const sources: NativeTableProjection['sources'] = [];
  let bytes = 0;
  const add = (
    key: string,
    parent: Ref,
    classes: Ref[],
    props: [Ref, NativeValue][],
  ): Ref => {
    if (resources.has(key))
      throw new Error('Duplicate Atomic projection identity');
    resources.set(key, {
      key,
      parent,
      classes,
      properties: props.map(([property, value]) => ({ property, value })),
    });
    if (resources.size > 50_000)
      throw new Error('Atomic table projection exceeds 50,000 resources');
    return local(key);
  };
  const folder = (key: string, name: string, parent: Ref): Ref =>
    resources.has(key)
      ? local(key)
      : add(
          key,
          parent,
          [external(C + 'Folder')],
          [[external(P + 'name'), str(name)]],
        );
  const schemas = folder('schemas', 'Schemas', local('drive'));
  const meta = (name: string, datatype: string): Ref => {
    const key = identity('metadata', name);
    if (!resources.has(key)) {
      add(
        key,
        schemas,
        [external(C + 'Property')],
        [
          [external(P + 'name'), str(label(name))],
          [external(P + 'shortname'), str('syncd-' + name)],
          [
            external(P + 'description'),
            str('SyncD projection provenance: ' + name + '.'),
          ],
          [external(P + 'datatype'), ref(external(D + datatype))],
        ],
      );
      schemaResources.add(key);
    }
    return local(key);
  };
  const sourceId = meta('source-id', 'string'),
    sourceSubject = meta('source-subject', 'string'),
    sourceRevision = meta('source-revision', 'string'),
    sourceHash = meta('source-hash', 'string'),
    documentHash = meta('document-hash', 'string');
  for (const selectedSource of [...selected].sort((a, b) =>
    compare(alias(a.prepared.source), alias(b.prepared.source)),
  )) {
    const { prepared, revision: at } = selectedSource;
    if (
      prepared.source.platform.includes('/') ||
      prepared.source.account.includes('/')
    )
      throw new Error('Invalid account identity');
    const name = alias(prepared.source);
    if (sources.some((s) => s.collection === name))
      throw new Error('Duplicate collection selector');
    const revision = await store.revision(at);
    if (revision.scope !== prepared.scope)
      throw new Error('Atomic table revision belongs to another scope');
    const envelope = JSON.parse(revision.context_text) as Record<
      string,
      unknown
    >;
    const savedContext =
      envelope.context &&
      typeof envelope.context === 'object' &&
      !Array.isArray(envelope.context)
        ? (envelope.context as Record<string, unknown>)
        : envelope;
    if (
      savedContext.documentHash !== undefined &&
      savedContext.documentHash !== prepared.documentHash
    )
      throw new Error(
        'Atomic table OpenAPI document does not match the accepted snapshot',
      );
    sources.push({
      collection: name,
      revision: revision.id,
      documentHash: prepared.documentHash,
    });
    const account = folder(
      identity('account', prepared.source.platform, prepared.source.account),
      `${prepared.source.account} (${prepared.source.platform})`,
      local('drive'),
    );
    // A contract operation defines the schema. Account aliases and bound path
    // values select tables, and must not create another copy of that schema.
    const collection = discoverReadModel(prepared.document).collections.find(
      (candidate) => candidate.name === prepared.source.collection,
    )!;
    const operation =
      prepared.document.paths[collection.url]?.[
        collection.method.toLowerCase() as 'get' | 'post'
      ];
    const responseCode =
      Object.keys(operation?.responses ?? {}).find((code) =>
        /^2\d\d$/.test(code),
      ) ?? '';
    const schemaIdentity = nodeHash(
      identity(
        'openapi-operation',
        prepared.documentHash,
        collection.method,
        collection.url,
        responseCode,
        'application/json',
        collection.itemsField ?? '',
        collection.idField,
      ),
    );
    const operationLabel = `${collection.method} ${collection.url}`;
    const schemaLabel = `${prepared.document.info.title} · ${operationLabel}`;
    const schemaFolder = folder(
      identity('schema-folder', schemaIdentity),
      schemaLabel,
      schemas,
    );
    const classes = new Map<string, { ref: Ref; columns: Map<string, Ref> }>();
    const observedColumns = new Set<string>();
    const idField = collection.idField;
    const field = (
      path: string[],
      datatype: string,
      description?: string,
      schema: SchemaObject = {},
    ): Ref => {
      const key = identity(
        'field',
        schemaIdentity,
        JSON.stringify(path),
        datatype,
      );
      if (!resources.has(key)) {
        add(
          key,
          schemaFolder,
          [external(C + 'Property')],
          [
            [
              external(P + 'name'),
              str(
                path.length === 1 && path[0] === idField
                  ? `API ID (${idField})`
                  : path.length === 1 && path[0] === 'name'
                    ? 'API name'
                    : path.length === 1 && path[0] === 'permissions'
                      ? 'Source permissions'
                      : label(path.at(-1) ?? 'Value'),
              ),
            ],
            [
              external(P + 'shortname'),
              str('field-' + nodeHash(key).slice(0, 16)),
            ],
            [
              external(P + 'description'),
              str(
                (description ??
                  `API field ${path.join('.')}; native ${datatype}.`) +
                  (path.length === 1 && path[0] === 'permissions'
                    ? ' Imported provider permissions are data only; they do not grant Atomic read or write access.'
                    : ''),
              ),
            ],
            [external(P + 'datatype'), ref(external(D + datatype))],
            ...(datatype === 'json' && Object.keys(schema).length
              ? ([
                  [
                    external(P + 'jsonSchema'),
                    {
                      type: 'json',
                      value: schemaValue(schema, prepared.document),
                    },
                  ],
                ] as [Ref, NativeValue][])
              : []),
          ],
        );
        schemaResources.add(key);
      }
      return local(key);
    };
    const classFor = (
      path: string[],
    ): { ref: Ref; columns: Map<string, Ref> } => {
      const id = JSON.stringify(path);
      let found = classes.get(id);
      if (!found) {
        found = {
          ref: local(identity('class', schemaIdentity, id)),
          columns: new Map(),
        };
        classes.set(id, found);
      }
      return found;
    };
    const declare = (path: string[], schema: SchemaObject): void => {
      const cls = classFor(path);
      for (const [key, child] of Object.entries(
        combined(schema).properties ?? {},
      )) {
        const dt =
          child.type === 'object' ||
          child.properties ||
          child.type === 'array' ||
          child.items
            ? 'json'
            : child.type === 'integer'
              ? 'integer'
              : child.type === 'number'
                ? 'float'
                : child.type === 'boolean'
                  ? 'boolean'
                  : child.format === 'date-time'
                    ? 'timestamp'
                    : child.format === 'date'
                      ? 'date'
                      : ['uri', 'url', 'uri-reference'].includes(
                            child.format ?? '',
                          )
                        ? 'uri'
                        : 'string';
        cls.columns.set(
          key + ':' + dt,
          field(
            pointer(path, key),
            dt,
            typeof child.description === 'string'
              ? child.description
              : undefined,
            child,
          ),
        );
      }
    };
    const jsonValue = (
      graph: JsonGraph,
      v: GraphValue,
      depth = 0,
    ): JsonValue => {
      if (depth > 64) throw new Error('Atomic table nesting exceeds 64 levels');
      switch (v[0]) {
        case 'null':
          return null;
        case 'boolean':
        case 'string':
          return v[1];
        // Reuse the scalar precision policy: unsafe numbers remain exact text.
        case 'number':
          return numberValue(v[1]).value as number | string;
        case 'ref': {
          const n = node(graph, v)!;
          if (n[2] === 'array')
            return (n[3] as GraphValue[]).map((child) =>
              jsonValue(graph, child, depth + 1),
            );
          if (n[2] !== 'object') throw new Error('Unexpected API scalar node');
          const out: { [key: string]: JsonValue } = Object.create(null);
          for (const [key, child] of n[3] as [string, GraphValue][])
            out[key] = jsonValue(graph, child, depth + 1);
          return out;
        }
      }
    };
    const itemSchema = atomicItemSchema(prepared);
    declare([], itemSchema);
    // Observed fields may still be retained on rows and shown by their table,
    // but they do not change the declared Class when account data changes.
    const declaredColumns = new Map(
      [...classes].map(([path, cls]) => [path, [...cls.columns.values()]]),
    );
    const tableKey = identity('table', name),
      rowClass = classFor([]);
    const value = (
      graph: JsonGraph,
      v: GraphValue,
      schema: SchemaObject,
    ): { datatype: string; value: NativeValue } | undefined => {
      switch (v[0]) {
        case 'null':
          return undefined;
        case 'boolean':
          return {
            datatype: 'boolean',
            value: { type: 'boolean', value: v[1] },
          };
        case 'number': {
          let n = numberValue(v[1]);
          if (schema.type === 'number' && n.type === 'integer')
            n = { type: 'float', value: n.value };
          return { datatype: n.type, value: n };
        }
        case 'string': {
          if (
            schema.format === 'date-time' &&
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(
              v[1],
            ) &&
            Number.isSafeInteger(Date.parse(v[1]))
          )
            return {
              datatype: 'timestamp',
              value: { type: 'integer', value: Date.parse(v[1]) },
            };
          return {
            datatype:
              schema.format === 'date' &&
              /^\d{4}-\d{2}-\d{2}$/.test(v[1]) &&
              Number.isFinite(Date.parse(v[1])) &&
              new Date(v[1]).toISOString().slice(0, 10) === v[1]
                ? 'date'
                : ['uri', 'url', 'uri-reference'].includes(
                      schema.format ?? '',
                    ) && absoluteUri(v[1])
                  ? 'uri'
                  : 'string',
            value: str(v[1]),
          };
        }
        case 'ref':
          return {
            datatype: 'json',
            value: { type: 'json', value: jsonValue(graph, v) },
          };
      }
    };
    const object = (
      graph: JsonGraph,
      v: GraphValue,
      key: string,
      path: string[],
      parent: Ref,
      schema: SchemaObject,
      extra: [Ref, NativeValue][] = [],
    ): void => {
      const fields = entries(graph, v),
        cls = classFor(path);
      const title = ['title', 'name', 'displayName', 'summary', 'login']
        .map((k) => fields.find(([name]) => name === k))
        .find((f) => f?.[1][0] === 'string');
      const props: [Ref, NativeValue][] = [
        [
          external(P + 'name'),
          str(
            title?.[1][0] === 'string'
              ? title[1][1]
              : label(path.at(-1) ?? prepared.source.name),
          ),
        ],
        ...extra,
      ];
      for (const [fieldName, child] of fields) {
        const projected = value(
          graph,
          child,
          combined(schema).properties?.[fieldName] ?? {},
        );
        if (!projected) continue;
        const prop = field(
          pointer(path, fieldName),
          projected.datatype,
          undefined,
          combined(schema).properties?.[fieldName],
        );
        const columnKey = fieldName + ':' + projected.datatype;
        cls.columns.set(columnKey, prop);
        if (path.length === 0) observedColumns.add(columnKey);
        props.push([prop, projected.value]);
      }
      add(key, parent, [cls.ref], props);
    };
    for (const [subject, root] of Object.entries(revision.resources).sort(
      ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
    )) {
      const raw = await store.render(root);
      bytes += Buffer.byteLength(raw);
      if (bytes > 16 * 1024 * 1024)
        throw new Error(
          'Atomic table projection exceeds the 16 MiB source limit',
        );
      const graph = indexJson(raw, { maxBytes: 16 * 1024 * 1024 });
      if (graph.root !== root)
        throw new Error('Atomic table source hash mismatch');
      const fields = new Map(entries(graph, ['ref', graph.root]));
      if (!fields.has(SOURCE_ID)) continue;
      if (
        fields.get('@id')?.[0] !== 'string' ||
        fields.get('@id')?.[1] !== subject
      )
        throw new Error('Atomic table source subject mismatch');
      const source = fields.get(SOURCE_JSON);
      if (!source || node(graph, source)?.[2] !== 'object')
        throw new Error('Atomic table source record must hold an object');
      const id = fields.get(SOURCE_ID)!;
      if (id[0] !== 'string')
        throw new Error('Atomic table source ID must be text');
      const key = identity('row', name, subject);
      object(graph, source, key, [], local(tableKey), itemSchema, [
        [sourceId, str(id[1])],
        [sourceSubject, str(subject)],
        [sourceRevision, str(revision.id)],
        [sourceHash, str(nodeHash(raw))],
      ]);
    }
    for (const [path, cls] of classes) {
      const key = (cls.ref as { local: string }).local;
      if (resources.has(key)) continue;
      add(
        key,
        schemaFolder,
        [external(C + 'Class')],
        [
          [
            external(P + 'name'),
            str(
              path === '[]'
                ? `${prepared.document.info.title} · ${typeof itemSchema.title === 'string' ? itemSchema.title : (operation?.operationId ?? operationLabel)} item`
                : JSON.parse(path).join('.') + ' record',
            ),
          ],
          [
            external(P + 'shortname'),
            str('record-' + nodeHash(key).slice(0, 16)),
          ],
          [
            external(P + 'description'),
            str(
              `Native Atomic fields from ${operationLabel}, application/json response ${responseCode}, items ${collection.itemsField || '(root)'}, OpenAPI ${prepared.documentHash}. Original responses remain in PostgreSQL.`,
            ),
          ],
          [external(P + 'requires'), refs([external(P + 'name')])],
          [
            external(P + 'recommends'),
            refs([
              ...(declaredColumns.get(path) ?? []),
              ...(path === '[]'
                ? [sourceId, sourceSubject, sourceRevision, sourceHash]
                : []),
            ]),
          ],
        ],
      );
      schemaResources.add(key);
    }
    const priorities = [
      'number',
      'title',
      'name',
      'state',
      'status',
      'user',
      'author',
      'labels',
      'comments',
      'updated_at',
      'created_at',
      'html_url',
      'id',
    ];
    const columns = [...rowClass.columns]
      // The core title already displays the source title; keep its native field
      // available without spending a second default column on the same text.
      .filter(([key]) => key !== 'title:string')
      .sort(([a], [b]) => {
        const rank = (s: string): number => {
          const i = priorities.indexOf(s.split(':')[0]);
          return i < 0 ? 100 : i;
        };
        return (
          Number(observedColumns.has(b)) - Number(observedColumns.has(a)) ||
          rank(a) - rank(b) ||
          compare(a, b)
        );
      })
      .map(([, v]) => v);
    const viewKey = identity('view', name);
    add(
      tableKey,
      account,
      [external(C + 'Table')],
      [
        [external(P + 'name'), str(prepared.source.name)],
        [external(P + 'classtype'), ref(rowClass.ref)],
        [
          external(P + 'description'),
          str(
            `API collection ${name}. Read-only projection from SyncD; local replica edits do not write back to the provider.`,
          ),
        ],
        [sourceRevision, str(revision.id)],
        [documentHash, str(prepared.documentHash)],
        [external(P + 'table-views'), refs([local(viewKey)])],
        [external(P + 'table-default-view'), ref(local(viewKey))],
      ],
    );
    add(
      viewKey,
      local(tableKey),
      [external(C + 'View')],
      [
        [external(P + 'name'), str('All records')],
        [external(P + 'view-kind'), str('table')],
        [
          external(P + 'view-columns'),
          refs([external(P + 'name'), ...columns.slice(0, 9)]),
        ],
      ],
    );
  }
  // Schema must be materialized before rows are validated; identities are allocated first.
  const ordered = [...resources.values()].sort(
    (a, b) =>
      Number(schemaResources.has(b.key)) - Number(schemaResources.has(a.key)) ||
      compare(a.key, b.key),
  );
  const content = {
    format: 'atomic-tables-v2' as const,
    owner: store.owner,
    sources,
    resources: ordered,
  };
  const projection = {
    ...content,
    revision: nodeHash(JSON.stringify(content)),
  };
  if (Buffer.byteLength(JSON.stringify(projection)) > 64 * 1024 * 1024)
    throw new Error('Atomic table graph exceeds 64 MiB');
  return projection;
}
