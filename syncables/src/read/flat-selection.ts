// @wc-ignore-file
/** Catalog-defined entity identity and saved read selections. No provider knowledge. */
import type { OpenApiDocument } from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { canonicalJson } from '../client/replace.js';
import {
  crudResourcesOf,
  discoverReadModel,
  isRecord,
  listOperation,
  type QuerySelection,
} from './model.js';
import {
  describeResourceFields,
  type ResourceFieldDescription,
} from './resource-fields.js';
import { resolveReference } from './references.js';
import { fieldValue, validateIdentityTemplate } from './identity-path.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { operationAllowsAnonymous } from './navigation.js';
import { segmentProblem } from './segment.js';
import {
  bindPath,
  Budget,
  DEFAULT_READ_LIMITS,
  type ReadLimits,
} from './pages.js';
import {
  deriveOntology,
  ontologyShortname,
  type Ontology,
} from './ontology.js';
import { projectReadRecord, type ReadRecord } from './read.js';
import {
  bindCollection,
  describeCollections,
  describeResourcePresentation,
  relatedCollectionReads,
  resolveCollectionNavigation,
  readBoundCollection,
  validateCollectionRead,
  validateCollectionNavigationRead,
  type BoundCollection,
  type CollectionDescription,
  type CollectionNavigation,
} from './navigation.js';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from './transport.js';

export type IdentityValue = string | number;
export type TypedReadContext = Record<string, IdentityValue>;
export interface EntityIdentity {
  resource: string;
  template: string;
  values: [string, IdentityValue][];
  path: string;
  key: string;
}
export interface EntityTypeDescription {
  resource: string;
  identity?: {
    urlTemplate: string;
    bindings: Record<string, { field: string }>;
  };
  collections: CollectionDescription[];
  resourceFields?: ResourceFieldDescription[];
  relationships: {
    resource: string;
    via: RelationshipSelector;
    title: string;
  }[];
  schema?: Record<string, unknown>;
  presentation: CollectionDescription['presentation'];
}
export interface OriginRecord {
  entity: EntityIdentity;
  record: Record<string, unknown>;
  context: TypedReadContext;
  read: BoundCollection;
}
export interface RelationshipSelector {
  collection: string;
  kind: 'identity' | 'responseLink';
  reference?: string;
  link?: string;
}
export interface ReadSelection {
  version: 1;
  resource: string;
  source:
    | { kind: 'bound'; bound: BoundCollection }
    | { kind: 'related'; origin: OriginRecord; via: RelationshipSelector }
    | {
        kind: 'fanout';
        from: ReadSelection;
        via: RelationshipSelector;
        entities?: EntityIdentity[];
      };
}
export type FieldEvidence =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'absent' };
export interface ReadProvenance {
  read: BoundCollection;
  origin?: EntityIdentity;
  via?: RelationshipSelector;
  detail?: { operationId: string; path: string; status: number };
}
export interface EntityObservation {
  entity: EntityIdentity;
  raw: Record<string, unknown>;
  context: TypedReadContext;
  projected: ReadRecord;
  fields: Record<string, FieldEvidence>;
  representationKey: string;
  partitionKey: string;
  provenance: ReadProvenance;
}
export interface SelectionPartition {
  key: string;
  role: 'discovery' | 'target';
  bound: BoundCollection;
  provenance: ReadProvenance;
  complete: boolean;
  error?: string;
  notComplete?: string;
}
export interface SelectionReadResult {
  resource: string;
  key: string;
  observations: EntityObservation[];
  partitions: SelectionPartition[];
  complete: boolean;
  errors: string[];
}
export interface CompileReadSelectionOptions {
  origins?: readonly OriginRecord[];
  querySelection?: QuerySelection;
  maxPartitions?: number;
  publicOnly?: boolean;
}
export interface CompiledReadSelection {
  readonly key: string;
  readonly resource: string;
  readonly selection: ReadSelection;
  allows(request: TransportRequest): boolean;
  observe(
    request: TransportRequest,
    response: TransportResponse,
  ): Promise<EntityObservation[]>;
}
export interface ReadSelectionOptions extends CompileReadSelectionOptions {
  transport: Transport;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
}

export function scalar(value: unknown): IdentityValue {
  if (
    (typeof value === 'string' && !segmentProblem(value)) ||
    (typeof value === 'number' && Number.isSafeInteger(value))
  )
    return value;
  throw new Error('Identity requires a nonempty safe string or safe integer');
}
function strings(context: TypedReadContext): Record<string, string> {
  return Object.fromEntries(
    Object.entries(context).map(([k, v]) => [k, String(scalar(v))]),
  );
}
function identityDefinition(
  document: OpenApiDocument,
  resource: string,
): { template: string; bindings: Record<string, unknown> } {
  const definition = crudResourcesOf(document)[resource];
  const identity = isRecord(definition) ? definition['identity'] : undefined;
  if (
    !isRecord(identity) ||
    typeof identity['urlTemplate'] !== 'string' ||
    (identity['bindings'] !== undefined && !isRecord(identity['bindings']))
  )
    throw new Error(`Resource ${resource} has no canonical CRUD identity`);
  const template = identity['urlTemplate'];
  validateIdentityTemplate(template, resource, 'Entity');
  if (/[?#]/.test(template)) throw new Error('Entity identity must be a path');
  return {
    template,
    bindings: (identity['bindings'] ?? {}) as Record<string, unknown>,
  };
}
/** A context variable's declared path schema supplies its transport type. */
function contextValue(
  document: OpenApiDocument,
  template: string,
  name: string,
  value: unknown,
  resource: string,
): IdentityValue {
  const item = document.paths[template];
  const pathParameters = (path: string): unknown[] => {
    const p = document.paths[path];
    return [
      ...(Array.isArray(p?.['parameters']) ? p['parameters'] : []),
      ...(p?.get?.parameters ?? []),
      ...(p?.post?.parameters ?? []),
    ];
  };
  const matching = (parameters: unknown[]): Record<string, unknown>[] =>
    parameters
      .filter(isRecord)
      .filter((p) => p['in'] === 'path' && p['name'] === name);
  const exact = matching([
    ...(Array.isArray(item?.['parameters']) ? item['parameters'] : []),
    ...(item?.get?.parameters ?? []),
  ]);
  const candidates = exact.length
    ? exact
    : matching(
        discoverReadModel(document)
          .collections.filter(
            (c) => c.resource === resource && c.contextParams.includes(name),
          )
          .flatMap((c) => pathParameters(c.url)),
      );
  const types = new Set(
    candidates
      .map((p) =>
        isRecord(p) && isRecord(p['schema']) ? p['schema']['type'] : undefined,
      )
      .filter(Boolean),
  );
  if (types.size > 1) throw new Error('Ambiguous canonical context datatype');
  const parameter = candidates[0];
  const schema =
    isRecord(parameter) && isRecord(parameter['schema'])
      ? parameter['schema']
      : undefined;
  if (schema?.['type'] === 'integer' || schema?.['type'] === 'number') {
    if (typeof value === 'number') return scalar(value);
    if (typeof value === 'string' && /^-?(0|[1-9]\d*)$/.test(value))
      return scalar(Number(value));
    throw new Error('Invalid integer canonical context');
  }
  if (schema?.['type'] === 'string' && typeof value === 'number')
    return scalar(String(value));
  return scalar(value);
}
export function resolveEntityIdentity(
  document: OpenApiDocument,
  options: {
    resource: string;
    record: Record<string, unknown>;
    context?: TypedReadContext;
  },
): EntityIdentity {
  return entityIdentity(resolveRefs(document), options);
}
/** Internal prepared-document path for repeated declared field resolution. */
export function preparedEntityIdentity(
  document: OpenApiDocument,
  options: Parameters<typeof resolveEntityIdentity>[1],
): EntityIdentity {
  return entityIdentity(document, options);
}
function entityIdentity(
  doc: OpenApiDocument,
  options: {
    resource: string;
    record: Record<string, unknown>;
    context?: TypedReadContext;
  },
  referenceBindings?: Record<string, unknown>,
): EntityIdentity {
  const { template, bindings: ownBindings } = identityDefinition(
    doc,
    options.resource,
  );
  const bindings = referenceBindings ?? ownBindings;
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  if (!names.length || new Set(names).size !== names.length)
    throw new Error('Invalid canonical identity variables');
  const values: [string, IdentityValue][] = names.map((name) => {
    const binding = bindings[name];
    if (binding !== undefined) {
      if (!isRecord(binding) || typeof binding['field'] !== 'string')
        throw new Error('Invalid canonical identity binding');
      const value = fieldValue(options.record, binding['field']);
      return [
        name,
        referenceBindings && ownBindings[name] === undefined
          ? contextValue(doc, template, name, value, options.resource)
          : scalar(value),
      ];
    }
    return [
      name,
      contextValue(
        doc,
        template,
        name,
        options.context?.[name],
        options.resource,
      ),
    ];
  });
  const path = bindPath(template, strings(Object.fromEntries(values)));
  return {
    resource: options.resource,
    template,
    values,
    path,
    key: canonicalJson([options.resource, template, values]),
  };
}
/** Resolve explicit Reference Object bindings into the same typed identity as a full target record. */
export function resolveReferenceEntityIdentity(
  document: OpenApiDocument,
  options: {
    sourceResource: string;
    reference: string;
    record: Record<string, unknown>;
    context?: TypedReadContext;
  },
): EntityIdentity | undefined {
  const doc = document;
  const context = options.context ?? {};
  const target = resolveReference(
    doc,
    options.sourceResource,
    options.reference,
    options.record,
    strings(context),
  );
  if (!target) return undefined;
  const source = crudResourcesOf(doc)[options.sourceResource];
  const refs = isRecord(source) ? source['references'] : undefined;
  const ref = isRecord(refs) ? refs[options.reference] : undefined;
  if (!isRecord(ref) || !isRecord(ref['bindings']))
    throw new Error('Invalid declared Reference Object');
  return entityIdentity(
    doc,
    { resource: target.resource, record: options.record, context },
    ref['bindings'],
  );
}

export function describeEntityTypes(
  document: OpenApiDocument,
): EntityTypeDescription[] {
  const doc = resolveRefs(document);
  const collections = describeCollections(doc);
  const resourceFields = new Map(
    Object.keys(crudResourcesOf(doc)).map((resource) => [
      resource,
      describeResourceFields(doc, resource),
    ]),
  );
  const referenced = [...resourceFields.values()].flatMap((fields) =>
    fields.flatMap((field) => field.targets.map((target) => target.resource)),
  );
  return [
    ...new Set([...collections.map((c) => c.resource), ...referenced]),
  ].map((resource) => {
    const group = collections.filter((c) => c.resource === resource);
    const raw = crudResourcesOf(doc)[resource];
    const identity =
      isRecord(raw) && isRecord(raw['identity']) ? raw['identity'] : undefined;
    return {
      resource,
      collections: group,
      ...(resourceFields.get(resource)?.length
        ? { resourceFields: resourceFields.get(resource)! }
        : {}),
      relationships: collections.flatMap((c) =>
        c.relationships
          .filter((r) => r.parentResource === resource)
          .map((r) => ({
            resource: c.resource,
            title: c.presentation.title,
            via: {
              collection: c.name,
              kind: r.kind,
              ...(r.reference ? { reference: r.reference } : {}),
              ...(r.link ? { link: r.link } : {}),
            },
          })),
      ),
      presentation:
        group[0]?.presentation ?? describeResourcePresentation(doc, resource),
      ...(isRecord(raw) && isRecord(raw['schema'])
        ? { schema: structuredClone(raw['schema']) }
        : {}),
      ...(identity
        ? {
            identity: structuredClone(identity) as unknown as NonNullable<
              EntityTypeDescription['identity']
            >,
          }
        : {}),
    };
  });
}

function object(
  value: unknown,
  keys: string[],
  required = keys,
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    Object.keys(value).some((k) => !keys.includes(k)) ||
    required.some((k) => !Object.hasOwn(value, k))
  )
    throw new Error('Invalid saved read selection object');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096)
    throw new Error('Invalid saved read selection string');
  return value;
}
function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) throw new Error('Invalid string bindings');
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, text(v)]),
  );
}
function parseBound(value: unknown): BoundCollection {
  const v = object(value, [
    'collection',
    'resource',
    'pathParams',
    'path',
    'method',
    'query',
    'body',
  ]);
  if ((v['method'] !== 'GET' && v['method'] !== 'POST') || !isRecord(v['body']))
    throw new Error('Invalid bound collection');
  return {
    collection: text(v['collection']),
    resource: text(v['resource']),
    pathParams: stringMap(v['pathParams']),
    path: text(v['path']),
    method: v['method'],
    query: stringMap(v['query']),
    body: structuredClone(v['body']),
  };
}
function parseEntity(value: unknown): EntityIdentity {
  const v = object(value, ['resource', 'template', 'values', 'path', 'key']);
  if (!Array.isArray(v['values'])) throw new Error('Invalid entity bindings');
  const values: [string, IdentityValue][] = v['values'].map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new Error('Invalid typed entity binding');
    return [text(pair[0]), scalar(pair[1])];
  });
  const resource = text(v['resource']),
    template = text(v['template']);
  validateIdentityTemplate(template, resource, 'Saved entity');
  const names = [...template.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
  if (
    /[?#]/.test(template) ||
    !names.length ||
    new Set(names).size !== names.length ||
    canonicalJson(names) !== canonicalJson(values.map(([name]) => name))
  )
    throw new Error('Invalid saved entity identity template');
  const expected = {
    resource,
    template,
    values,
    path: bindPath(template, strings(Object.fromEntries(values))),
    key: canonicalJson([resource, template, values]),
  };
  if (v['path'] !== expected.path || v['key'] !== expected.key)
    throw new Error('Entity identity does not match its bindings');
  return expected;
}
function parseOrigin(value: unknown): OriginRecord {
  const v = object(value, ['entity', 'record', 'context', 'read']);
  if (!isRecord(v['record']) || !isRecord(v['context']))
    throw new Error('Invalid origin record');
  const context = Object.fromEntries(
    Object.entries(v['context']).map(([k, val]) => [k, scalar(val)]),
  );
  return {
    entity: parseEntity(v['entity']),
    record: structuredClone(v['record']),
    context,
    read: parseBound(v['read']),
  };
}
function parseVia(value: unknown): RelationshipSelector {
  const v = object(
    value,
    ['collection', 'kind', 'reference', 'link'],
    ['collection', 'kind'],
  );
  if (v['kind'] !== 'identity' && v['kind'] !== 'responseLink')
    throw new Error('Invalid relationship selector');
  if (
    v['kind'] === 'identity' &&
    (v['reference'] !== undefined || v['link'] !== undefined)
  )
    throw new Error('Identity relationship cannot carry a Link');
  return {
    collection: text(v['collection']),
    kind: v['kind'],
    ...(v['reference'] !== undefined
      ? { reference: text(v['reference']) }
      : {}),
    ...(v['link'] !== undefined ? { link: text(v['link']) } : {}),
  };
}
/** Constraints are sets of typed canonical identities, independent of locale/input order. */
function parseEntitySet(values: unknown[]): EntityIdentity[] {
  const unique = new Map<string, EntityIdentity>();
  for (const raw of values) {
    const entity = parseEntity(raw),
      previous = unique.get(entity.key);
    if (previous && canonicalJson(previous) !== canonicalJson(entity))
      throw new Error('Inconsistent duplicate entity identity');
    unique.set(entity.key, entity);
  }
  return [...unique.values()].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
}
/** Strict JSON boundary, bounded independently of a catalog or transport. */
export function parseReadSelection(value: unknown): ReadSelection {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length > 1024 * 1024)
    throw new Error('Saved selection is too large');
  function parse(raw: unknown, depth: number): ReadSelection {
    if (depth > 8) throw new Error('Saved selection nesting exceeds limit');
    const v = object(raw, ['version', 'resource', 'source']);
    if (v['version'] !== 1)
      throw new Error('Unsupported saved selection version');
    const s = v['source'];
    if (!isRecord(s)) throw new Error('Invalid selection source');
    let source: ReadSelection['source'];
    switch (s['kind']) {
      case 'bound':
        object(s, ['kind', 'bound']);
        source = { kind: 'bound', bound: parseBound(s['bound']) };
        break;
      case 'related':
        object(s, ['kind', 'origin', 'via']);
        source = {
          kind: 'related',
          origin: parseOrigin(s['origin']),
          via: parseVia(s['via']),
        };
        break;
      case 'fanout':
        object(s, ['kind', 'from', 'via', 'entities'], ['kind', 'from', 'via']);
        if (
          s['entities'] !== undefined &&
          (!Array.isArray(s['entities']) || s['entities'].length > 256)
        )
          throw new Error('Invalid fanout entity constraint');
        source = {
          kind: 'fanout',
          from: parse(s['from'], depth + 1),
          ...(Array.isArray(s['entities'])
            ? {
                entities: parseEntitySet(s['entities']),
              }
            : {}),
          via: parseVia(s['via']),
        };
        break;
      default:
        throw new Error('Unknown selection source kind');
    }
    return { version: 1, resource: text(v['resource']), source };
  }
  return parse(value, 0);
}
export function readSelectionKey(value: unknown): string {
  const selection = parseReadSelection(value);
  function key(s: ReadSelection): unknown {
    const source = s.source;
    return [
      s.resource,
      source.kind,
      source.kind === 'bound'
        ? [source.bound.collection, source.bound.pathParams]
        : source.kind === 'related'
          ? [source.origin.entity.key, source.via]
          : [
              key(source.from),
              source.via,
              source.entities?.map((e) => e.key) ?? null,
            ],
    ];
  }
  return canonicalJson(key(selection));
}
function partitionKey(provenance: ReadProvenance): string {
  return canonicalJson(provenance);
}
export function projectEntityObservation(
  document: OpenApiDocument,
  options: {
    collection: CollectionDescription;
    record: Record<string, unknown>;
    context?: TypedReadContext;
    provenance: ReadProvenance;
    ontology?: Ontology;
  },
): EntityObservation {
  return projectObservation(resolveRefs(document), options);
}
function projectObservation(
  document: OpenApiDocument,
  options: Parameters<typeof projectEntityObservation>[1],
): EntityObservation {
  const { collection, record, provenance } = options;
  const context = options.context ?? {};
  const projected = projectReadRecord(document, {
    collection,
    record,
    context: strings(context),
    ...(options.ontology ? { ontology: options.ontology } : {}),
  });
  const fields: Record<string, FieldEvidence> = Object.fromEntries(
    collection.presentation.columns.map((column) => {
      const field = column.field,
        property = ontologyShortname(field);
      return [
        property,
        !Object.hasOwn(record, field)
          ? { kind: 'absent' }
          : record[field] === null
            ? { kind: 'null' }
            : { kind: 'value', value: projected.values[property] },
      ];
    }),
  );
  return {
    entity: entityIdentity(document, {
      resource: collection.resource,
      record,
      context,
    }),
    raw: structuredClone(record),
    context: structuredClone(context),
    projected,
    fields,
    representationKey: canonicalJson([collection.resource, collection.name]),
    partitionKey: partitionKey(provenance),
    provenance: structuredClone(provenance),
  };
}

const collectionCache = new WeakMap<OpenApiDocument, CollectionDescription[]>();
function collection(
  document: OpenApiDocument,
  name: string,
): CollectionDescription {
  let all = collectionCache.get(document);
  if (!all) {
    all = describeCollections(document);
    collectionCache.set(document, all);
  }
  const found = all.filter((c) => c.name === name);
  if (found.length !== 1)
    throw new Error('Unknown or ambiguous selected collection');
  return found[0]!;
}
function canonicalBound(
  document: OpenApiDocument,
  bound: BoundCollection,
  options: CompileReadSelectionOptions,
): BoundCollection {
  const expected = bindCollection(document, {
    collection: bound.collection,
    context: bound.pathParams,
    ...(options.querySelection ? { selection: options.querySelection } : {}),
  });
  const c = collection(document, bound.collection);
  const operation = listOperation(document, c.url, c.method)!;
  const paging =
    resolveEffectiveScheme(document, operation)?.scheme.request
      ?.queryParameters ?? {};
  const stableQuery = (query: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(query).filter(([k]) => paging[k]?.role !== 'pageSize'),
    );
  if (
    canonicalJson({ ...bound, query: stableQuery(bound.query) }) !==
    canonicalJson({ ...expected, query: stableQuery(expected.query) })
  )
    throw new Error(
      'Saved bound collection differs from current catalog recipe',
    );
  if (
    options.publicOnly &&
    !collection(document, bound.collection).allowsAnonymous
  )
    throw new Error('Selected collection requires authentication');
  return expected;
}
function normalize(
  document: OpenApiDocument,
  value: unknown,
  options: CompileReadSelectionOptions,
): ReadSelection {
  const parsed = parseReadSelection(value);
  function visit(s: ReadSelection): ReadSelection {
    const source = s.source;
    collection(
      document,
      source.kind === 'bound' ? source.bound.collection : source.via.collection,
    );
    if (source.kind === 'bound') {
      const bound = canonicalBound(document, source.bound, options);
      if (s.resource !== bound.resource)
        throw new Error('Selection resource mismatch');
      return { ...s, source: { kind: 'bound', bound } };
    }
    const target = collection(document, source.via.collection);
    if (
      s.resource !== target.resource ||
      (options.publicOnly && !target.allowsAnonymous)
    )
      throw new Error('Invalid selected target resource or security');
    if (source.kind === 'fanout') {
      const from = visit(source.from);
      if (
        !target.relationships.some(
          (r) =>
            r.parentResource === from.resource &&
            r.kind === source.via.kind &&
            r.reference === source.via.reference &&
            r.link === source.via.link,
        )
      )
        throw new Error('Undeclared fanout relationship');
      if (
        source.entities?.some(
          (entity) =>
            entity.resource !== from.resource ||
            entity.template !==
              identityDefinition(document, from.resource).template,
        )
      )
        throw new Error('Fanout entity constraint resource mismatch');
      if (
        options.publicOnly &&
        target.relationships.some(
          (r) =>
            r.parentResource === from.resource &&
            r.kind === source.via.kind &&
            r.reference === source.via.reference &&
            r.link === source.via.link &&
            r.sourcePath &&
            !operationAllowsAnonymous(
              document,
              document.paths[r.sourcePath]?.get ?? { responses: {} },
            ),
        )
      )
        throw new Error('Source detail requires authentication');
      return { ...s, source: { ...source, from } };
    }
    const replacement = options.origins?.find(
      (o) => o.entity.key === source.origin.entity.key,
    );
    const origin = replacement ? parseOrigin(replacement) : source.origin;
    canonicalBound(document, origin.read, options);
    if (
      origin.read.resource !== origin.entity.resource ||
      Object.entries(origin.read.pathParams).some(
        ([k, v]) => String(origin.context[k]) !== v,
      ) ||
      entityIdentity(document, {
        resource: origin.entity.resource,
        record: origin.record,
        context: origin.context,
      }).key !== origin.entity.key
    )
      throw new Error('Origin record identity or context mismatch');
    navigation(document, origin, source.via, options);
    return { ...s, source: { ...source, origin } };
  }
  return visit(parsed);
}
function navigation(
  document: OpenApiDocument,
  origin: OriginRecord,
  via: RelationshipSelector,
  options: CompileReadSelectionOptions,
): CollectionNavigation {
  const matches = relatedCollectionReads(document, {
    resource: origin.entity.resource,
    record: origin.record,
    context: strings(origin.context),
  }).filter(
    (n) =>
      n.collection === via.collection &&
      (via.kind === 'identity'
        ? n.kind === 'direct'
        : n.kind === 'responseLink' &&
          n.reference === via.reference &&
          n.link === via.link),
  );
  if (matches.length !== 1)
    throw new Error('Unknown or ambiguous selected relationship');
  const nav = matches[0]!;
  if (options.publicOnly) {
    if (!collection(document, nav.collection).allowsAnonymous)
      throw new Error('Target requires authentication');
    if (nav.kind !== 'direct') {
      const operation = document.paths[nav.source.template]?.get;
      if (!operation || !operationAllowsAnonymous(document, operation))
        throw new Error('Source detail requires authentication');
    }
  }
  return nav;
}

type Scope = BoundCollection | CollectionNavigation;
const isBound = (scope: Scope): scope is BoundCollection => !('kind' in scope);
interface Hooks {
  scope(scope: Scope): void;
}
class MissingProof extends Error {}
function signature(request: TransportRequest): string {
  return canonicalJson([
    request.method,
    request.url.href,
    request.body ?? null,
  ]);
}
async function execute(
  document: OpenApiDocument,
  selection: ReadSelection,
  options: ReadSelectionOptions,
  hooks: Hooks,
): Promise<SelectionReadResult> {
  const partitions: SelectionPartition[] = [];
  const errors: string[] = [];
  const max = options.maxPartitions ?? 64;
  if (!Number.isSafeInteger(max) || max < 1 || max > 256)
    throw new Error('Invalid partition limit');
  const limits = { ...DEFAULT_READ_LIMITS, ...options.limits };
  const budget = new Budget(
    options.transport,
    { ...limits, maxRetries: 0 },
    options.sleep,
  );
  const ontology = deriveOntology(document);
  let records = 0,
    attempts = 0;
  const transport: Transport = (request) =>
    budget.send({ ...request, purpose: request.purpose ?? 'list' });
  async function boundRead(
    bound: BoundCollection,
    provenance: ReadProvenance,
    role: SelectionPartition['role'],
    inherited: TypedReadContext = {},
  ): Promise<EntityObservation[]> {
    if (++attempts > max) throw new Error('Selection partition limit exceeded');
    hooks.scope(bound);
    const partition: SelectionPartition = {
      key: partitionKey(provenance),
      role,
      bound,
      provenance,
      complete: false,
    };
    partitions.push(partition);
    const accepted: EntityObservation[] = [];
    try {
      const result = await readBoundCollection(document, bound, {
        transport,
        recordIdentity: (record, definition, context) =>
          entityIdentity(document, {
            resource: definition.resource,
            record,
            context,
          }).key,
        limits: {
          ...limits,
          maxRecords: Math.max(1, limits.maxRecords - records),
          timeoutMs: budget.remainingMs(),
        },
      });
      const c = collection(document, bound.collection);
      const typedContext: TypedReadContext = Object.fromEntries(
        Object.entries(bound.pathParams).map(([name, value]) => [
          name,
          inherited[name] !== undefined && String(inherited[name]) === value
            ? inherited[name]!
            : contextValue(document, c.url, name, value, c.resource),
        ]),
      );
      for (const snapshot of result.collections) {
        for (const record of snapshot.items) {
          if (++records > limits.maxRecords)
            throw new Error('Selection record budget exceeded');
          accepted.push(
            projectObservation(document, {
              collection: c,
              record,
              context: typedContext,
              provenance,
              ontology,
            }),
          );
        }
        partition.complete = snapshot.complete;
        if (snapshot.error) partition.error = snapshot.error;
        if (snapshot.notComplete) partition.notComplete = snapshot.notComplete;
      }
      if (result.errors.length) {
        partition.error = result.errors.join('; ');
        partition.complete = false;
      }
      if (partition.error) errors.push(partition.error);
    } catch (error) {
      partition.error = error instanceof Error ? error.message : String(error);
      errors.push(partition.error);
    }
    return accepted;
  }
  async function related(
    origin: OriginRecord,
    via: RelationshipSelector,
    role: SelectionPartition['role'],
  ): Promise<EntityObservation[]> {
    if (attempts >= max) throw new Error('Selection partition limit exceeded');
    const nav = navigation(document, origin, via, options);
    hooks.scope(nav);
    let detail: ReadProvenance['detail'];
    const verified: Transport = async (request) => {
      const response = await transport(request);
      if (
        nav.kind !== 'direct' &&
        response.status >= 200 &&
        response.status < 300
      ) {
        const body: unknown = JSON.parse(response.body);
        if (
          !isRecord(body) ||
          entityIdentity(document, {
            resource: origin.entity.resource,
            record: body,
            context: origin.context,
          }).key !== origin.entity.key
        )
          throw new Error(
            'Navigation response does not identify the selected origin',
          );
        detail = {
          operationId: nav.source.operationId,
          path: nav.source.path,
          status: response.status,
        };
      }
      return response;
    };
    const bound = await resolveCollectionNavigation(document, nav, {
      transport: verified,
    });
    canonicalBound(document, bound, options);
    const provenance: ReadProvenance = {
      read: bound,
      origin: origin.entity,
      via,
      ...(detail ? { detail } : {}),
    };
    return boundRead(bound, provenance, role, {
      ...origin.context,
      ...Object.fromEntries(origin.entity.values),
    });
  }
  async function run(
    s: ReadSelection,
    role: SelectionPartition['role'],
  ): Promise<EntityObservation[]> {
    const source = s.source;
    if (source.kind === 'bound')
      return boundRead(source.bound, { read: source.bound }, role);
    if (source.kind === 'related')
      return related(source.origin, source.via, role);
    const origins = await run(source.from, 'discovery');
    const seen = new Set<string>(),
      output: EntityObservation[] = [];
    for (const observation of origins) {
      if (
        seen.has(observation.entity.key) ||
        (source.entities &&
          !source.entities.some(
            (entity) => entity.key === observation.entity.key,
          ))
      )
        continue;
      seen.add(observation.entity.key);
      try {
        output.push(
          ...(await related(
            {
              entity: observation.entity,
              record: observation.raw,
              context: observation.context,
              read: observation.provenance.read,
            },
            source.via,
            role,
          )),
        );
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    return output;
  }
  let observations: EntityObservation[] = [];
  try {
    observations = await run(selection, 'target');
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return {
    resource: selection.resource,
    key: readSelectionKey(selection),
    observations,
    partitions,
    complete: !errors.length && partitions.every((p) => p.complete),
    errors,
  };
}
export async function readSelection(
  document: OpenApiDocument,
  value: unknown,
  options: ReadSelectionOptions,
): Promise<SelectionReadResult> {
  const doc = resolveRefs(document),
    selection = normalize(doc, value, options);
  return execute(doc, selection, options, { scope: () => {} });
}
/** Host-local authority state. Only observed provider responses unlock descendants. */
export function compileReadSelection(
  document: OpenApiDocument,
  value: unknown,
  options: CompileReadSelectionOptions = {},
): CompiledReadSelection {
  const doc = resolveRefs(document),
    selection = normalize(doc, value, options);
  let scopes: Scope[] = [];
  function seed(s: ReadSelection): void {
    if (s.source.kind === 'fanout') seed(s.source.from);
    else if (s.source.kind === 'bound') scopes.push(s.source.bound);
    else scopes.push(navigation(doc, s.source.origin, s.source.via, options));
  }
  seed(selection);
  const journal = new Map<string, TransportResponse>();
  const emitted = new Map<string, string>();
  let observing = false;
  let frontier = new Set<string>();
  function declaredQuery(
    bound: BoundCollection,
    request: TransportRequest,
  ): boolean {
    const c = collection(doc, bound.collection);
    const paging =
      resolveEffectiveScheme(doc, listOperation(doc, c.url, c.method)!)?.scheme
        .request?.queryParameters ?? {};
    return [...request.url.searchParams.keys()].every(
      (name) =>
        Object.hasOwn(bound.query, name) ||
        [
          'page',
          'offset',
          'pageToken',
          'cursor',
          'pageSize',
          'windowStart',
          'windowEnd',
          'windowRange',
        ].includes(paging[name]?.role ?? '') ||
        frontier.has(signature(request)),
    );
  }
  const allows = (request: TransportRequest): boolean =>
    scopes.some((scope) =>
      isBound(scope)
        ? validateCollectionRead(doc, scope, request) &&
          declaredQuery(scope, request)
        : scope.kind === 'direct'
          ? validateCollectionRead(doc, scope.bound, request) &&
            declaredQuery(scope.bound, request)
          : validateCollectionNavigationRead(doc, scope, request),
    );
  return {
    key: readSelectionKey(selection),
    resource: selection.resource,
    selection: structuredClone(selection),
    allows,
    async observe(request, response): Promise<EntityObservation[]> {
      if (observing || !allows(request))
        throw new Error('Response outside selected read authority');
      if (
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        typeof response.body !== 'string' ||
        response.body.length > 5 * 1024 * 1024 ||
        journal.size >= 1024
      )
        throw new Error('Invalid or excessive response proof');
      observing = true;
      try {
        journal.set(signature(request), structuredClone(response));
        const next: Scope[] = [];
        const nextFrontier = new Set<string>();
        const result = await execute(
          doc,
          selection,
          {
            ...options,
            limits: { maxRequests: 1024, maxRetries: 0 },
            transport: async (candidate) => {
              nextFrontier.add(signature(candidate));
              const captured = journal.get(signature(candidate));
              if (!captured)
                throw new MissingProof('Response proof not yet observed');
              return structuredClone(captured);
            },
          },
          {
            scope: (scope) => {
              next.push(scope);
            },
          },
        );
        scopes = next;
        frontier = nextFrontier;
        const observed: EntityObservation[] = [];
        for (const observation of result.observations) {
          const key = canonicalJson([
            observation.entity.key,
            observation.representationKey,
            observation.partitionKey,
          ]);
          const stamp = canonicalJson([
            observation.raw,
            observation.context,
            observation.fields,
          ]);
          if (emitted.get(key) === stamp) continue;
          emitted.set(key, stamp);
          observed.push(structuredClone(observation));
        }
        return observed;
      } finally {
        observing = false;
      }
    },
  };
}
