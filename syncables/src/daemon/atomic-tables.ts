import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';
import { discoverReadModel, isRecord } from '../read/model.js';
import {
  embeddedResourcesOf,
  resolveEmbeddedResource,
  type EmbeddedResourceDeclaration,
} from '../read/embedded-resources.js';
import {
  projectionModels,
  canonicalProjectionJson,
  type AtomicTablesProjectionOptions,
} from './atomic-projection-contract.js';
export type {
  AtomicTablesProjectionOptions,
  ProjectionContract,
} from './atomic-projection-contract.js';
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
function graphJsonValue(
  graph: JsonGraph,
  value: GraphValue,
  depth = 0,
): JsonValue {
  if (depth > 64) throw new Error('Atomic table nesting exceeds 64 levels');
  switch (value[0]) {
    case 'null':
      return null;
    case 'boolean':
    case 'string':
      return value[1];
    case 'number':
      return numberValue(value[1]).value as number | string;
    case 'ref': {
      const current = node(graph, value)!;
      if (current[2] === 'array')
        return (current[3] as GraphValue[]).map((child) =>
          graphJsonValue(graph, child, depth + 1),
        );
      if (current[2] !== 'object')
        throw new Error('Unexpected API scalar node');
      return Object.fromEntries(
        (current[3] as [string, GraphValue][]).map(([key, child]) => [
          key,
          graphJsonValue(graph, child, depth + 1),
        ]),
      );
    }
  }
}
function graphAt(
  graph: JsonGraph,
  value: GraphValue,
  path: string[],
): GraphValue | undefined {
  let current: GraphValue | undefined = value;
  for (const key of path)
    current =
      current && entries(graph, current).find(([name]) => name === key)?.[1];
  return current;
}
function resourceClassIdentity(documentHash: string, resource: string): string {
  return nodeHash(identity('openapi-resource', documentHash, resource));
}
function resourceSchema(
  prepared: PreparedCollection,
  resource: string,
): SchemaObject {
  const definition = prepared.document.components?.crudResources;
  const declared =
    isRecord(definition) && isRecord(definition[resource])
      ? definition[resource].schema
      : undefined;
  if (isRecord(declared)) return combined(declared as SchemaObject);
  // Collections/operations are alternate views of one declared CRUD resource.
  const schemas = discoverReadModel(prepared.document)
    .collections.filter((collection) => collection.resource === resource)
    .sort((a, b) => compare(a.name, b.name))
    .map((collection) =>
      atomicItemSchema({
        ...prepared,
        source: { ...prepared.source, collection: collection.name },
      }),
    );
  return {
    ...schemas[0],
    properties: Object.assign(
      {},
      ...schemas.map((schema) => schema.properties),
    ) as Record<string, SchemaObject>,
  };
}
interface ProjectionContributor {
  collection: string;
  revision: string;
  documentHash: string;
  subject: string;
  sourceHash: string;
  projectionContractHash?: string;
}
function contributionValue(
  contributors: Map<string, ProjectionContributor>,
): JsonValue {
  const all = [...contributors.values()].sort((a, b) =>
    compare(canonicalProjectionJson(a), canonicalProjectionJson(b)),
  );
  return {
    sources: JSON.parse(JSON.stringify(all.slice(0, 100))) as JsonValue[],
    omitted: Math.max(0, all.length - 100),
  };
}
interface ProjectionRow {
  key: string;
  subject: string;
  id: string;
  hash: string;
  graph: JsonGraph;
  value: GraphValue;
  original: Record<string, unknown>;
  relations: Map<
    string,
    {
      declaration: EmbeddedResourceDeclaration;
      keys?: string[];
      fallback?: JsonValue;
    }
  >;
  displayName?: string;
  contributors?: Map<string, ProjectionContributor>;
}
interface ProjectionTable {
  prepared: PreparedCollection;
  originalHash: string;
  name: string;
  tableKey: string;
  tableName: string;
  revision: string;
  resource: string;
  schema: SchemaObject;
  schemaIdentity: string;
  rows: ProjectionRow[];
  declarations: EmbeddedResourceDeclaration[];
  diagnostics: string[];
  contributors: Map<string, ProjectionContributor>;
  contractHash?: string;
  referenced: boolean;
}
function diagnostic(table: ProjectionTable, message: string): void {
  if (table.diagnostics.length < 100)
    table.diagnostics.push(message.slice(0, 500));
}
function targetKey(
  owner: string,
  prepared: PreparedCollection,
  resource: string,
  path: string,
): string {
  return identity(
    'referenced-row',
    TABLE_BINDING,
    owner,
    prepared.source.platform,
    prepared.source.account,
    prepared.document.servers?.[0]?.url ?? '',
    resource,
    path,
  );
}
function mergeSummaries(observations: Record<string, JsonValue>[]): {
  value: Record<string, JsonValue>;
  conflicts: string[];
} {
  const conflicts: string[] = [];
  const merge = (
    values: JsonValue[],
    path: string[],
    depth = 0,
  ): JsonValue | undefined => {
    if (depth > 64)
      throw new Error('Atomic embedded summaries exceed 64 levels');
    if (
      values.every(
        (value) =>
          canonicalProjectionJson(value) === canonicalProjectionJson(values[0]),
      )
    )
      return values[0];
    if (values.every(isRecord)) {
      const result: Record<string, JsonValue> = Object.create(null);
      for (const key of [
        ...new Set(values.flatMap((value) => Object.keys(value as object))),
      ].sort()) {
        const present = values.filter((value) =>
          Object.hasOwn(value as object, key),
        );
        const combined = merge(
          present.map((value) => (value as Record<string, JsonValue>)[key]),
          [...path, key],
          depth + 1,
        );
        if (combined !== undefined) result[key] = combined;
      }
      return result;
    }
    conflicts.push(path.join('.'));
    return undefined;
  };
  return {
    value: merge(observations, []) as Record<string, JsonValue>,
    conflicts,
  };
}
async function projectionTables(
  store: PostgresHistoryStore,
  selected: TableSource[],
  options: AtomicTablesProjectionOptions,
): Promise<ProjectionTable[]> {
  const models = projectionModels(
    selected.map((source) => source.prepared),
    options,
  );
  const tables: ProjectionTable[] = [];
  let bytes = 0;
  // Validate every model, including its annotations, before reading records.
  for (const source of [...selected].sort((a, b) =>
    compare(alias(a.prepared.source), alias(b.prepared.source)),
  )) {
    const original = source.prepared;
    if (
      original.source.platform.includes('/') ||
      original.source.account.includes('/')
    )
      throw new Error('Invalid account identity');
    const name = alias(original.source);
    if (tables.some((table) => table.name === name))
      throw new Error('Duplicate collection selector');
    const model = models.get(original.documentHash)!;
    const prepared = { ...original, document: model.document };
    const collections = discoverReadModel(prepared.document).collections.filter(
      (collection) => collection.name === prepared.source.collection,
    );
    if (collections.length !== 1)
      throw new Error('Unknown or ambiguous Atomic table collection');
    const resource = collections[0].resource;
    tables.push({
      prepared,
      originalHash: original.documentHash,
      name,
      tableKey: identity('table', name),
      tableName: prepared.source.name,
      revision: source.revision,
      resource,
      schema: resourceSchema(prepared, resource),
      schemaIdentity: resourceClassIdentity(original.documentHash, resource),
      declarations: embeddedResourcesOf(prepared.document, resource),
      rows: [],
      diagnostics: [],
      contributors: new Map(),
      referenced: false,
      ...(model.hash ? { contractHash: model.hash } : {}),
    });
  }
  for (const table of tables) {
    const revision = await store.revision(table.revision);
    if (revision.scope !== table.prepared.scope)
      throw new Error('Atomic table revision belongs to another scope');
    const envelope = JSON.parse(revision.context_text) as Record<
      string,
      unknown
    >;
    const context = isRecord(envelope.context) ? envelope.context : envelope;
    if (context.documentHash !== table.originalHash)
      throw new Error(
        'Atomic table OpenAPI document does not match the accepted snapshot',
      );
    table.revision = revision.id;
    for (const [subject, root] of Object.entries(revision.resources).sort(
      ([a], [b]) => compare(a, b),
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
      table.rows.push({
        key: identity('row', table.name, subject),
        subject,
        id: id[1],
        hash: nodeHash(raw),
        graph,
        value: source,
        original: (JSON.parse(raw) as Record<string, Record<string, unknown>>)[
          SOURCE_JSON
        ],
        relations: new Map(),
      });
    }
  }
  const full = new Map<string, { key: string; model: string }>();
  for (const table of tables) {
    const resources = table.prepared.document.components?.crudResources;
    const definition = isRecord(resources)
      ? resources[table.resource]
      : undefined;
    if (!isRecord(definition) || !isRecord(definition.identity)) continue;
    for (const row of table.rows) {
      try {
        const declaration: EmbeddedResourceDeclaration = {
          field: 'record',
          cardinality: 'one',
          resource: table.resource,
          schema: table.schema,
          identity:
            definition.identity as EmbeddedResourceDeclaration['identity'],
        };
        const resolved = resolveEmbeddedResource(
          declaration,
          { record: row.original },
          table.prepared.source.bindings,
        );
        const found = resolved.objects[0];
        if (resolved.status === 'resolved' && found) {
          const key = targetKey(
            store.owner,
            table.prepared,
            table.resource,
            found.path,
          );
          if (!full.has(key))
            full.set(key, { key: row.key, model: table.originalHash });
        }
      } catch {
        /* An unresolved full identity does not invalidate the accepted source row. */
      }
    }
  }
  const groups = new Map<string, ProjectionTable>();
  const summaries = new Map<
    string,
    {
      table: ProjectionTable;
      path: string;
      observations: Record<string, JsonValue>[];
      contributors: Map<string, ProjectionContributor>;
    }
  >();
  for (const table of tables) {
    for (const declaration of table.declarations) {
      const key = identity(
        'referenced-model',
        table.originalHash,
        targetKey(store.owner, table.prepared, declaration.resource, ''),
      );
      const existingGroup = groups.get(key);
      if (!existingGroup) {
        const definitions = table.prepared.document.components!
          .crudResources as Record<string, Record<string, unknown>>;
        const collection =
          Object.keys(
            (definitions[declaration.resource].collections ?? {}) as object,
          ).sort()[0] ?? declaration.resource;
        groups.set(key, {
          ...table,
          name: identity('referenced', key),
          tableKey: identity('referenced-table', key),
          tableName: `${collection} (referenced)`,
          resource: declaration.resource,
          schema: declaration.schema,
          schemaIdentity: resourceClassIdentity(
            table.originalHash,
            declaration.resource,
          ),
          rows: [],
          declarations: [],
          diagnostics: [],
          contributors: new Map(),
          referenced: true,
        });
      }
    }
    for (const row of table.rows) {
      for (const declaration of table.declarations) {
        const resolved = resolveEmbeddedResource(
          declaration,
          row.original,
          table.prepared.source.bindings,
        );
        const source = graphAt(
          row.graph,
          row.value,
          declaration.field.split('.'),
        );
        if (resolved.status === 'unresolved') {
          if (source)
            row.relations.set(declaration.field, {
              declaration,
              fallback: graphJsonValue(row.graph, source),
            });
          for (const issue of resolved.diagnostics)
            diagnostic(
              table,
              `${row.subject}: ${declaration.field}${issue.index === undefined ? '' : `[${issue.index}]`}: ${issue.message}`,
            );
          continue;
        }
        const keys: string[] = [];
        for (const [index, found] of resolved.objects.entries()) {
          const key = targetKey(
            store.owner,
            table.prepared,
            found.resource,
            found.path,
          );
          const selectedTarget = full.get(key);
          if (selectedTarget && selectedTarget.model !== table.originalHash)
            throw new Error(
              'Referenced identity belongs to multiple source models; an explicit model mapping is required',
            );
          keys.push(selectedTarget?.key ?? key);
          if (selectedTarget) continue;
          const group = groups.get(
            identity(
              'referenced-model',
              table.originalHash,
              targetKey(store.owner, table.prepared, found.resource, ''),
            ),
          )!;
          let summary = summaries.get(key);
          if (summary && summary.table.originalHash !== table.originalHash)
            throw new Error(
              'Referenced identity belongs to multiple source models; an explicit model mapping is required',
            );
          if (!summary) {
            summary = {
              table: group,
              path: found.path,
              observations: [],
              contributors: new Map(),
            };
            summaries.set(key, summary);
          }
          const contributor: ProjectionContributor = {
            collection: table.name,
            revision: table.revision,
            documentHash: table.originalHash,
            subject: row.subject,
            sourceHash: row.hash,
            ...(table.contractHash
              ? { projectionContractHash: table.contractHash }
              : {}),
          };
          const contributorKey = canonicalProjectionJson(contributor);
          summary.contributors.set(contributorKey, contributor);
          group.contributors.set(contributorKey, contributor);
          const embedded =
            declaration.cardinality === 'many'
              ? (source && (node(row.graph, source)?.[3] as GraphValue[]))?.[
                  index
                ]
              : source;
          if (!embedded)
            throw new Error(
              'Embedded source graph does not match its resolved field',
            );
          summary.observations.push(
            graphJsonValue(row.graph, embedded) as Record<string, JsonValue>,
          );
        }
        if (resolved.present)
          row.relations.set(declaration.field, { declaration, keys });
      }
    }
  }
  for (const [key, summary] of [...summaries].sort(([a], [b]) =>
    compare(a, b),
  )) {
    const merged = mergeSummaries(summary.observations);
    for (const field of merged.conflicts)
      diagnostic(
        summary.table,
        `${summary.path}: conflicting embedded field ${field}; omitted`,
      );
    const graph = indexJson(canonicalProjectionJson(merged.value));
    const conflictingName = merged.conflicts.some((field) =>
      ['title', 'name', 'displayName', 'summary', 'login'].includes(
        field.split('.')[0],
      ),
    );
    summary.table.rows.push({
      key,
      id: summary.path,
      subject: summary.path,
      hash: graph.root,
      graph,
      value: ['ref', graph.root],
      original: merged.value,
      relations: new Map(),
      contributors: summary.contributors,
      ...(conflictingName ? { displayName: summary.path } : {}),
    });
  }
  return [
    ...tables,
    ...[...groups.values()].sort((a, b) => compare(a.tableKey, b.tableKey)),
  ];
}

export async function atomicTablesProjection(
  store: PostgresHistoryStore,
  selected: TableSource[],
  options: AtomicTablesProjectionOptions = {},
): Promise<NativeTableProjection> {
  if (!selected.length || selected.length > 100)
    throw new Error('Select one to 100 collections');
  const tables = await projectionTables(store, selected, options);
  const resources = new Map<string, NativeResource>();
  const schemaResources = new Set<string>();
  const sources: NativeTableProjection['sources'] = [];
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
  const projectionContract = meta('projection-contract-hash', 'string');
  const projectionDiagnostics = meta('projection-diagnostics', 'json');
  const sourceContributors = meta('source-contributors', 'json');
  const embeddedNullFields = meta('embedded-null-fields', 'json');
  for (const table of tables) {
    const { prepared, name, schemaIdentity } = table;
    const revision = { id: table.revision };
    if (!table.referenced)
      sources.push({
        collection: name,
        revision: revision.id,
        documentHash: table.originalHash,
      });
    const account = folder(
      identity('account', prepared.source.platform, prepared.source.account),
      `${prepared.source.account} (${prepared.source.platform})`,
      local('drive'),
    );
    const schemaLabel = `${prepared.document.info.title} · ${table.resource}`;
    const schemaFolder = folder(
      identity('schema-folder', schemaIdentity),
      schemaLabel,
      schemas,
    );
    const collection = {
      idField:
        discoverReadModel(prepared.document).collections.find(
          (candidate) => candidate.resource === table.resource,
        )?.idField ?? 'id',
    };
    const classes = new Map<string, { ref: Ref; columns: Map<string, Ref> }>();
    const observedColumns = new Set<string>();
    const idField = collection.idField;
    const field = (
      path: string[],
      datatype: string,
      description?: string,
      schema: SchemaObject = {},
      targetClass?: Ref,
    ): Ref => {
      const key = identity(
        'field',
        schemaIdentity,
        JSON.stringify(path),
        datatype,
        ...(targetClass ? [canonicalProjectionJson(targetClass)] : []),
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
            ...(targetClass
              ? ([[external(P + 'classtype'), ref(targetClass)]] as [
                  Ref,
                  NativeValue,
                ][])
              : []),
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
    const relationField = (declaration: EmbeddedResourceDeclaration): Ref =>
      field(
        declaration.field.split('.'),
        declaration.cardinality === 'one' ? 'atomicURL' : 'resourceArray',
        `Explicit embedded ${declaration.resource} reference; observed summaries are partial.`,
        {},
        local(
          identity(
            'class',
            resourceClassIdentity(table.originalHash, declaration.resource),
            '[]',
          ),
        ),
      );
    const declare = (path: string[], schema: SchemaObject): void => {
      const cls = classFor(path);
      for (const [key, child] of Object.entries(
        combined(schema).properties ?? {},
      )) {
        const relation =
          !key.includes('.') &&
          table.declarations.find((declaration) => declaration.field === key);
        if (relation) {
          cls.columns.set(
            key +
              ':' +
              (relation.cardinality === 'one' ? 'atomicURL' : 'resourceArray'),
            relationField(relation),
          );
          continue;
        }
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
      for (const declaration of table.declarations.filter((entry) =>
        entry.field.includes('.'),
      ))
        cls.columns.set(
          declaration.field +
            ':' +
            (declaration.cardinality === 'one' ? 'atomicURL' : 'resourceArray'),
          relationField(declaration),
        );
    };
    const itemSchema = table.schema;
    declare([], itemSchema);
    // Observed fields may still be retained on rows and shown by their table,
    // but they do not change the declared Class when account data changes.
    const declaredColumns = new Map(
      [...classes].map(([path, cls]) => [path, [...cls.columns.values()]]),
    );
    const tableKey = table.tableKey,
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
            value: { type: 'json', value: graphJsonValue(graph, v) },
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
      extra: [Ref, NativeValue][],
      row: ProjectionRow,
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
            row.displayName ??
              (title?.[1][0] === 'string'
                ? title[1][1]
                : table.referenced
                  ? row.subject
                  : label(path.at(-1) ?? prepared.source.name)),
          ),
        ],
        ...extra,
      ];
      const nullFields: string[][] = [];
      for (const [fieldName, child] of fields) {
        const relation = fieldName.includes('.')
          ? undefined
          : row.relations.get(fieldName);
        if (relation?.keys !== undefined) continue;
        // Atomic top-level null means deletion; preserve this observation as metadata.
        if (table.referenced && child[0] === 'null') {
          nullFields.push(pointer(path, fieldName));
          continue;
        }
        let projected =
          relation && Object.hasOwn(relation, 'fallback')
            ? {
                datatype: 'json',
                value: { type: 'json' as const, value: relation.fallback! },
              }
            : value(
                graph,
                child,
                combined(schema).properties?.[fieldName] ?? {},
              );
        if (!projected) continue;
        if (projected.value.type === 'json' && projected.value.value === null) {
          nullFields.push(pointer(path, fieldName));
          continue;
        }
        const nested = [...row.relations].filter(
          ([name, entry]) =>
            !fieldName.includes('.') &&
            name.split('.')[0] === fieldName &&
            entry.keys !== undefined,
        );
        if (nested.length && projected.value.type === 'json') {
          const remainder = structuredClone(projected.value.value);
          for (const [name] of nested) {
            const segments = name.split('.').slice(1);
            let at: JsonValue = remainder;
            for (const segment of segments.slice(0, -1))
              at = isRecord(at) ? (at[segment] as JsonValue) : null;
            if (isRecord(at)) delete at[segments.at(-1)!];
          }
          projected = {
            datatype: 'json',
            value: { type: 'json', value: remainder },
          };
        }
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
      if (nullFields.length)
        props.push([
          embeddedNullFields,
          {
            type: 'json',
            value: nullFields.sort((a, b) =>
              compare(JSON.stringify(a), JSON.stringify(b)),
            ),
          },
        ]);
      for (const [name, relation] of row.relations) {
        if (
          relation.keys === undefined ||
          (relation.declaration.cardinality === 'one' && !relation.keys.length)
        )
          continue;
        const property = relationField(relation.declaration);
        const datatype =
          relation.declaration.cardinality === 'one'
            ? 'atomicURL'
            : 'resourceArray';
        const columnKey = name + ':' + datatype;
        cls.columns.set(columnKey, property);
        observedColumns.add(columnKey);
        props.push([
          property,
          relation.declaration.cardinality === 'one'
            ? ref(local(relation.keys[0]))
            : refs(relation.keys.map(local)),
        ]);
      }
      add(key, parent, [cls.ref], props);
    };
    for (const row of table.rows) {
      object(
        row.graph,
        row.value,
        row.key,
        [],
        local(tableKey),
        itemSchema,
        [
          [sourceId, str(row.id)],
          [sourceSubject, str(row.subject)],
          ...(table.referenced
            ? ([
                [
                  sourceContributors,
                  { type: 'json', value: contributionValue(row.contributors!) },
                ],
              ] as [Ref, NativeValue][])
            : ([
                [sourceRevision, str(revision.id)],
                [sourceHash, str(row.hash)],
              ] as [Ref, NativeValue][])),
        ],
        row,
      );
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
                ? `${prepared.document.info.title} · ${typeof itemSchema.title === 'string' ? itemSchema.title : table.resource} record`
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
              `Native Atomic fields for CRUD resource ${table.resource}, OpenAPI ${table.originalHash}. Original responses remain in PostgreSQL.`,
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
        [external(P + 'name'), str(table.tableName)],
        [external(P + 'classtype'), ref(rowClass.ref)],
        [
          external(P + 'description'),
          str(
            table.referenced
              ? `Referenced ${table.resource} summaries observed in accepted records; a partial subset, not a complete API collection. Read-only projection from SyncD.`
              : `API collection ${name}. Read-only projection from SyncD; local replica edits do not write back to the provider.`,
          ),
        ],
        ...(table.referenced
          ? ([
              [
                sourceContributors,
                { type: 'json', value: contributionValue(table.contributors) },
              ],
            ] as [Ref, NativeValue][])
          : ([
              [sourceRevision, str(revision.id)],
              [documentHash, str(table.originalHash)],
            ] as [Ref, NativeValue][])),
        ...(!table.referenced && table.contractHash
          ? ([[projectionContract, str(table.contractHash)]] as [
              Ref,
              NativeValue,
            ][])
          : []),
        ...(table.diagnostics.length
          ? ([
              [
                projectionDiagnostics,
                { type: 'json', value: [...new Set(table.diagnostics)].sort() },
              ],
            ] as [Ref, NativeValue][])
          : []),
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
