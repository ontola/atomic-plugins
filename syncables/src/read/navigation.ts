// @wc-ignore-file
import type {
  OpenApiDocument,
  OperationObject,
  SchemaObject,
} from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { canonicalJson } from '../client/replace.js';
import {
  applySelection,
  crudResourcesOf,
  discoverReadModel,
  isRecord,
  listOperation,
  upstreamOf,
  type QuerySelection,
  type ReadCollection,
} from './model.js';
import {
  resolveBoundIdentity,
  validateIdentityTemplate,
} from './identity-path.js';
import { resolveReference } from './references.js';
import { responseBodyValue } from './principal.js';
import { bindPath } from './pages.js';
import {
  deriveOntology,
  flattenSchema,
  ontologyShortname,
  type Datatype,
} from './ontology.js';
import { segmentProblem } from './segment.js';
import {
  readCollections,
  type CollectionReadOptions,
  type CollectionReadResult,
} from './collections.js';
import type { Transport, TransportRequest } from './transport.js';

export interface CollectionRelationship {
  kind: 'identity' | 'responseLink';
  parentResource: string;
  reference?: string;
  sourcePath?: string;
  link?: string;
  bindings: Record<string, string>;
}
export interface CollectionDescription extends ReadCollection {
  relationships: CollectionRelationship[];
  entrypoints: CollectionEntrypoint[];
  schema?: Record<string, unknown>;
  requiresAuthentication: boolean;
  allowsAnonymous: boolean;
  presentation: { title: string; columns: CollectionColumn[] };
  inputs: CollectionInput[];
}
export interface CollectionColumn {
  field: string;
  property: string;
  label: string;
  datatype: Datatype;
  format?: string;
  labels?: Record<string, string>;
}
export interface CollectionInput {
  name: string;
  location: 'path';
  required: true;
  title: string;
  description?: string;
  schema?: Record<string, unknown>;
}
export interface CollectionEntrypoint {
  sourcePath: string;
  method: 'GET';
  operationId: string;
  inputs: CollectionInput[];
  allowsAnonymous: boolean;
  link: string;
}
interface NavigationSource {
  path: string;
  template: string;
  method: 'GET';
  operationId: string;
  pathParams: Record<string, string>;
}
export interface BoundCollection {
  collection: string;
  resource: string;
  pathParams: Record<string, string>;
  path: string;
  method: 'GET' | 'POST';
  query: Record<string, string>;
  body: Record<string, unknown>;
}
export type CollectionNavigation =
  | {
      kind: 'direct';
      collection: string;
      resource: string;
      parentResource: string;
      bound: BoundCollection;
    }
  | {
      kind: 'responseLink';
      collection: string;
      resource: string;
      parentResource: string;
      reference: string;
      source: NavigationSource;
      link: string;
    }
  | {
      kind: 'entrypoint';
      collection: string;
      resource: string;
      source: NavigationSource;
      link: string;
    };
export interface BindCollectionOptions {
  collection: string;
  context?: Record<string, string>;
  selection?: QuerySelection;
}
function uniqueCollection(
  document: OpenApiDocument,
  name: string,
  selection?: QuerySelection,
): ReadCollection {
  const model = discoverReadModel(document);
  if (selection) applySelection(document, model, selection);
  const found = model.collections.filter((c) => c.name === name);
  if (found.length !== 1 || !found[0])
    throw new Error(`Unknown or ambiguous collection ${name}`);
  return found[0];
}
function fields(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw)
      .filter(
        ([, binding]) =>
          isRecord(binding) && typeof binding['field'] === 'string',
      )
      .map(([name, binding]) => [
        name,
        (binding as Record<string, unknown>)['field'] as string,
      ]),
  );
}
function operations(
  document: OpenApiDocument,
): { path: string; operation: OperationObject }[] {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    ['get', 'post', 'put', 'patch', 'delete'].flatMap((method) => {
      const operation = item[method];
      return isRecord(operation)
        ? [{ path, operation: operation as unknown as OperationObject }]
        : [];
    }),
  );
}
interface LinkTarget {
  name: string;
  collection: ReadCollection;
  parameters: Record<string, unknown>;
  status: string;
}
function linkTargets(
  document: OpenApiDocument,
  operation: OperationObject,
): LinkTarget[] {
  const result: LinkTarget[] = [];
  const collections = discoverReadModel(document).collections;
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (!/^2\d\d$/.test(status) || !isRecord(response)) continue;
    const links = response['links'];
    if (!isRecord(links)) continue;
    for (const [name, link] of Object.entries(links)) {
      if (
        !isRecord(link) ||
        link['server'] !== undefined ||
        link['requestBody'] !== undefined ||
        !isRecord(link['parameters'])
      )
        continue;
      const candidates = collections.filter((c) => {
        const op = listOperation(document, c.url, c.method);
        if (!op) return false;
        const ref = `#/paths/${c.url.replace(/~/g, '~0').replace(/\//g, '~1')}/${c.method.toLowerCase()}`;
        return typeof link['operationId'] === 'string'
          ? op.operationId === link['operationId'] &&
              operations(document).filter(
                (o) => o.operation.operationId === link['operationId'],
              ).length === 1
          : link['operationRef'] === ref;
      });
      // A Link to an operation shared by fixed-query collections is ambiguous.
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      const parameters = link['parameters'];
      if (
        !candidate ||
        (link['operationId'] !== undefined &&
          link['operationRef'] !== undefined)
      )
        continue;
      const names = Object.keys(parameters).map((name) =>
        name.startsWith('path.') ? name.slice(5) : name,
      );
      if (
        new Set(names).size !== names.length ||
        !candidate.contextParams.every((name) => names.includes(name)) ||
        names.some((name) => !candidate.contextParams.includes(name))
      )
        continue;
      const supported = Object.values(parameters).every((value) => {
        if (typeof value === 'number') return Number.isSafeInteger(value);
        if (typeof value !== 'string') return false;
        if (!value.startsWith('$')) return !segmentProblem(value);
        if (value.startsWith('$request.path.'))
          return (
            typeof operation.operationId === 'string' &&
            operations(document).some(
              (source) =>
                source.operation === operation &&
                source.path.includes(`{${value.slice(14)}}`),
            )
          );
        try {
          responseBodyValue(value, null);
          return true;
        } catch {
          return false;
        }
      });
      if (!supported) continue;
      if (candidate)
        result.push({
          name,
          collection: candidate,
          parameters: link['parameters'],
          status,
        });
    }
  }
  return result;
}
function anonymous(
  document: OpenApiDocument,
  operation: OperationObject,
): boolean {
  const security = Object.hasOwn(operation, 'security')
    ? operation['security']
    : document['security'];
  if (security === undefined) return true;
  if (
    !Array.isArray(security) ||
    !security.every(
      (value) =>
        isRecord(value) &&
        Object.values(value).every(
          (scopes) =>
            Array.isArray(scopes) &&
            scopes.every((scope) => typeof scope === 'string'),
        ),
    )
  )
    return false;
  return (
    security.length === 0 ||
    security.some((value) => Object.keys(value).length === 0)
  );
}
function pathInputs(
  document: OpenApiDocument,
  path: string,
  operation: OperationObject | undefined,
): CollectionInput[] {
  const pathParameters = document.paths[path]?.['parameters'];
  const parameters = [
    ...(Array.isArray(pathParameters) ? pathParameters : []),
    ...(operation?.parameters ?? []),
  ].filter(isRecord);
  return [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => {
    const parameter = parameters
      .filter((p) => p['in'] === 'path' && p['name'] === name)
      .at(-1);
    const schema = parameter?.['schema'];
    return {
      name: name!,
      location: 'path',
      required: true,
      title:
        isRecord(schema) && typeof schema['title'] === 'string'
          ? schema['title']
          : name!,
      ...(typeof parameter?.['description'] === 'string'
        ? { description: parameter['description'] }
        : {}),
      ...(isRecord(schema) ? { schema: structuredClone(schema) } : {}),
    };
  });
}
function entrypoints(
  document: OpenApiDocument,
  collection: ReadCollection,
): CollectionEntrypoint[] {
  const result: CollectionEntrypoint[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    const op = item.get;
    if (
      !op?.operationId ||
      op.requestBody ||
      op['servers'] !== undefined ||
      item['servers'] !== undefined
    )
      continue;
    const parameters = [
      ...(Array.isArray(item['parameters']) ? item['parameters'] : []),
      ...(op.parameters ?? []),
    ].filter(isRecord);
    if (parameters.some((p) => p['required'] === true && p['in'] !== 'path'))
      continue;
    try {
      validateIdentityTemplate(path, collection.resource, 'Entrypoint');
      if (/[?#]/.test(path)) continue;
    } catch {
      continue;
    }
    if (
      operations(document).filter(
        (source) => source.operation.operationId === op.operationId,
      ).length !== 1
    )
      continue;
    for (const linked of linkTargets(document, op))
      if (
        linked.collection.name === collection.name &&
        linked.collection.resource === collection.resource
      ) {
        const value: CollectionEntrypoint = {
          sourcePath: path,
          method: 'GET',
          operationId: op.operationId,
          inputs: pathInputs(document, path, op),
          allowsAnonymous: anonymous(document, op),
          link: linked.name,
        };
        if (
          !result.some(
            (existing) => canonicalJson(existing) === canonicalJson(value),
          )
        )
          result.push(value);
      }
  }
  return result;
}

function relationships(
  document: OpenApiDocument,
  collection: ReadCollection,
): CollectionRelationship[] {
  const result: CollectionRelationship[] = [];
  const resources = crudResourcesOf(document);
  for (const [parentResource, raw] of Object.entries(resources)) {
    if (!isRecord(raw)) continue;
    const identity = isRecord(raw['identity']) ? raw['identity'] : {};
    const bindings = fields(identity['bindings']);
    if (
      collection.contextParams.length &&
      collection.contextParams.some((p) => bindings[p]) &&
      collection.contextParams.every(
        (p) =>
          typeof identity['urlTemplate'] === 'string' &&
          identity['urlTemplate'].includes(`{${p}}`),
      )
    )
      result.push({
        kind: 'identity',
        parentResource,
        bindings: Object.fromEntries(
          collection.contextParams
            .filter((p) => bindings[p])
            .map((p) => [p, bindings[p]!]),
        ),
      });
    const references = isRecord(raw['references']) ? raw['references'] : {};
    for (const [reference, value] of Object.entries(references)) {
      if (!isRecord(value) || typeof value['resource'] !== 'string') continue;
      const target = resources[value['resource']];
      const address =
        isRecord(target) && isRecord(target['identity'])
          ? target['identity']['urlTemplate']
          : undefined;
      if (typeof address !== 'string') continue;
      const operation = document.paths[address]?.get;
      const crud = operation?.['x-crud'];
      if (
        !operation ||
        !operation.operationId ||
        !isRecord(crud) ||
        crud['action'] !== 'read' ||
        crud['resource'] !== value['resource']
      )
        continue;
      for (const linked of linkTargets(document, operation))
        if (
          linked.collection.name === collection.name &&
          linked.collection.resource === collection.resource
        )
          result.push({
            kind: 'responseLink',
            parentResource,
            reference,
            sourcePath: address,
            link: linked.name,
            bindings: fields(value['bindings']),
          });
    }
  }
  return result;
}
/** Full public collection metadata; no network or global first-provider guessing. */
export function describeCollections(
  document: OpenApiDocument,
): CollectionDescription[] {
  const doc = resolveRefs(document);
  const resources = crudResourcesOf(doc);
  const ontology = deriveOntology(doc);
  const datatypes = new Map(
    ontology.terms
      .filter((t) => t.kind === 'property')
      .map((t) => [t.shortname, t.datatype]),
  );
  return discoverReadModel(doc).collections.map((collection) => {
    const raw = resources[collection.resource];
    const schema = isRecord(raw) ? raw['schema'] : undefined;
    const flat = flattenSchema(
      isRecord(schema) ? (schema as SchemaObject) : undefined,
    );
    return {
      ...collection,
      relationships: relationships(doc, collection),
      entrypoints: entrypoints(doc, collection),
      allowsAnonymous: anonymous(
        doc,
        listOperation(doc, collection.url, collection.method) ?? {
          responses: {},
        },
      ),
      requiresAuthentication: !anonymous(
        doc,
        listOperation(doc, collection.url, collection.method) ?? {
          responses: {},
        },
      ),
      presentation: {
        title:
          typeof flat['title'] === 'string' ? flat['title'] : collection.name,
        columns: Object.entries(flat.properties ?? {}).flatMap(
          ([field, property]) => {
            const shortname = ontologyShortname(field);
            const datatype = datatypes.get(shortname);
            if (!datatype) return [];
            const labels: Record<string, string> = {};
            if (Array.isArray(property.oneOf))
              for (const option of property.oneOf) {
                if (
                  Array.isArray(option.enum) &&
                  option.enum.length === 1 &&
                  typeof option['title'] === 'string'
                )
                  labels[String(option.enum[0])] = option['title'];
              }
            return [
              {
                field,
                property: shortname,
                label:
                  typeof property['title'] === 'string'
                    ? property['title']
                    : field,
                datatype,
                ...(typeof property.format === 'string'
                  ? { format: property.format }
                  : {}),
                ...(Object.keys(labels).length ? { labels } : {}),
              },
            ];
          },
        ),
      },
      inputs: pathInputs(
        doc,
        collection.url,
        listOperation(doc, collection.url, collection.method)!,
      ),
      ...(isRecord(schema) ? { schema: structuredClone(schema) } : {}),
    };
  });
}
/** Bind exactly one collection definition to supplied path context. */
export function bindCollection(
  document: OpenApiDocument,
  options: BindCollectionOptions,
): BoundCollection {
  const doc = resolveRefs(document);
  const c = uniqueCollection(doc, options.collection, options.selection);
  validateIdentityTemplate(c.url, c.resource, 'Collection');
  if (/[?#]/.test(c.url))
    throw new Error('Collection template must contain only a path');
  const pathParams: Record<string, string> = {};
  for (const param of c.contextParams) {
    const value = options.context?.[param];
    if (typeof value !== 'string' || segmentProblem(value))
      throw new Error(`Missing or invalid collection parameter ${param}`);
    pathParams[param] = value;
  }
  if (!listOperation(doc, c.url, c.method))
    throw new Error('Collection has no list operation');
  return {
    collection: c.name,
    resource: c.resource,
    pathParams,
    path: bindPath(c.url, pathParams),
    method: c.method,
    query: { ...c.listQuery },
    body: structuredClone(c.listBody),
  };
}
export interface BindCollectionNavigationOptions {
  collection: string;
  sourcePath: string;
  context?: Record<string, string>;
}
/** Bind a catalog-declared source GET; no request or parent record is fabricated. */
export function bindCollectionNavigation(
  document: OpenApiDocument,
  options: BindCollectionNavigationOptions,
): CollectionNavigation {
  const doc = resolveRefs(document);
  const c = uniqueCollection(doc, options.collection);
  const matches = entrypoints(doc, c).filter(
    (entry) => entry.sourcePath === options.sourcePath,
  );
  const entry = matches[0];
  if (matches.length !== 1 || !entry)
    throw new Error('Unknown or ambiguous collection entrypoint');
  const pathParams: Record<string, string> = {};
  for (const input of entry.inputs) {
    const value = options.context?.[input.name];
    if (typeof value !== 'string' || segmentProblem(value))
      throw new Error(`Missing or invalid entrypoint parameter ${input.name}`);
    pathParams[input.name] = value;
  }
  return {
    kind: 'entrypoint',
    collection: c.name,
    resource: c.resource,
    source: {
      path: bindPath(entry.sourcePath, pathParams),
      template: entry.sourcePath,
      method: 'GET',
      operationId: entry.operationId,
      pathParams,
    },
    link: entry.link,
  };
}

export interface RelatedCollectionOptions {
  resource: string;
  record: Record<string, unknown>;
  context?: Record<string, string>;
}
/** Materialize child navigation using only declared identity/reference bindings. */
export function relatedCollectionReads(
  document: OpenApiDocument,
  options: RelatedCollectionOptions,
): CollectionNavigation[] {
  const doc = resolveRefs(document);
  const raw = crudResourcesOf(doc)[options.resource];
  if (!isRecord(raw)) throw new Error('Unknown parent resource');
  const result: CollectionNavigation[] = [];
  for (const c of describeCollections(doc))
    for (const relation of c.relationships.filter(
      (r) => r.parentResource === options.resource,
    )) {
      if (relation.kind === 'identity') {
        const identity = isRecord(raw['identity']) ? raw['identity'] : {};
        const resolved = resolveBoundIdentity(
          options.resource,
          String(identity['urlTemplate']),
          identity['bindings'],
          options.record,
          options.context ?? {},
          'Parent identity',
        );
        if (resolved)
          result.push({
            kind: 'direct',
            collection: c.name,
            resource: c.resource,
            parentResource: options.resource,
            bound: bindCollection(doc, {
              collection: c.name,
              context: { ...options.context, ...resolved.values },
            }),
          });
      } else if (relation.reference && relation.sourcePath && relation.link) {
        const resolved = resolveReference(
          doc,
          options.resource,
          relation.reference,
          options.record,
          options.context,
        );
        if (!resolved) continue;
        const operation = doc.paths[relation.sourcePath]?.get;
        if (operation?.operationId)
          result.push({
            kind: 'responseLink',
            collection: c.name,
            resource: c.resource,
            parentResource: options.resource,
            reference: relation.reference,
            source: {
              path: resolved.path,
              template: relation.sourcePath,
              method: 'GET',
              operationId: operation.operationId,
              pathParams: resolved.values,
            },
            link: relation.link,
          });
      }
    }
  const seen = new Set<string>();
  return result.filter((value) => {
    const key = canonicalJson(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function requestUrl(document: OpenApiDocument, path: string): URL {
  const base = upstreamOf(document);
  if (base.username || base.password || base.search || base.hash)
    throw new Error('Unsafe OpenAPI server');
  const url = new URL(base.href);
  url.pathname = base.pathname.replace(/\/$/, '') + path;
  return url;
}
/** Validate the sole source detail GET declared by a saved navigation. */
export function validateCollectionNavigationRead(
  document: OpenApiDocument,
  navigation: CollectionNavigation,
  request: TransportRequest,
): boolean {
  try {
    if (navigation.kind === 'direct')
      return validateCollectionRead(document, navigation.bound, request);
    const doc = resolveRefs(document);
    const c = uniqueCollection(doc, navigation.collection);
    const relation =
      navigation.kind === 'entrypoint'
        ? entrypoints(doc, c).some(
            (entry) =>
              entry.sourcePath === navigation.source.template &&
              entry.operationId === navigation.source.operationId &&
              entry.link === navigation.link,
          )
        : relationships(doc, c).some(
            (r) =>
              r.kind === 'responseLink' &&
              r.parentResource === navigation.parentResource &&
              r.reference === navigation.reference &&
              r.sourcePath === navigation.source.template &&
              r.link === navigation.link,
          );
    const op = doc.paths[navigation.source.template]?.get;
    if (
      !relation ||
      !op ||
      op.operationId !== navigation.source.operationId ||
      request.method !== 'GET' ||
      request.body !== undefined ||
      request.url.search ||
      request.url.hash ||
      request.url.username ||
      request.url.password ||
      navigation.source.method !== 'GET'
    )
      return false;
    validateIdentityTemplate(
      navigation.source.template,
      c.resource,
      'Navigation source',
    );
    if (
      /[?#]/.test(navigation.source.template) ||
      bindPath(navigation.source.template, navigation.source.pathParams) !==
        navigation.source.path ||
      Object.values(navigation.source.pathParams).some(
        (v) => typeof v !== 'string' || segmentProblem(v),
      )
    )
      return false;
    const expected = requestUrl(doc, navigation.source.path);
    return (
      request.url.origin === expected.origin &&
      request.url.pathname === expected.pathname
    );
  } catch {
    return false;
  }
}

export interface ValidateCollectionEntryReadOptions {
  publicOnly?: boolean;
  collection?: string;
  sourcePath?: string;
}
/** Match root setup lookups to declared source GETs; never allow arbitrary API GETs. */
export function validateCollectionEntryRead(
  document: OpenApiDocument,
  request: TransportRequest,
  options: ValidateCollectionEntryReadOptions = {},
): boolean {
  try {
    if (
      request.method !== 'GET' ||
      request.body !== undefined ||
      request.url.search ||
      request.url.hash ||
      request.url.username ||
      request.url.password
    )
      return false;
    const doc = resolveRefs(document);
    const base = upstreamOf(doc);
    if (request.url.origin !== base.origin) return false;
    for (const c of discoverReadModel(doc).collections) {
      if (options.collection && c.name !== options.collection) continue;
      for (const entry of entrypoints(doc, c)) {
        if (
          (options.publicOnly && !entry.allowsAnonymous) ||
          (options.sourcePath && entry.sourcePath !== options.sourcePath)
        )
          continue;
        const template = base.pathname.replace(/\/$/, '') + entry.sourcePath;
        const variables: string[] = [];
        const escaped = template
          .split(/(\{[^}]+\})/g)
          .map((part) => {
            if (part.startsWith('{') && part.endsWith('}')) {
              variables.push(part.slice(1, -1));
              return '([^/]+)';
            }
            return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .join('');
        const match = new RegExp(`^${escaped}$`).exec(request.url.pathname);
        if (!match) continue;
        const context = Object.fromEntries(
          variables.map((name, i) => [name, decodeURIComponent(match[i + 1]!)]),
        );
        const nav = bindCollectionNavigation(doc, {
          collection: c.name,
          sourcePath: entry.sourcePath,
          context,
        });
        if (validateCollectionNavigationRead(doc, nav, request)) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/** Resolve an actual source response, then bind its standard OpenAPI Link. */
export async function resolveCollectionNavigation(
  document: OpenApiDocument,
  navigation: CollectionNavigation,
  options: { transport: Transport },
): Promise<BoundCollection> {
  const doc = resolveRefs(document);
  if (navigation.kind === 'direct')
    return bindCollection(doc, {
      collection: navigation.collection,
      context: navigation.bound.pathParams,
    });
  const c = uniqueCollection(doc, navigation.collection);
  const op = doc.paths[navigation.source.template]?.get;
  if (
    !op ||
    op.operationId !== navigation.source.operationId ||
    bindPath(navigation.source.template, navigation.source.pathParams) !==
      navigation.source.path
  )
    throw new Error('Invalid navigation source');
  for (const value of Object.values(navigation.source.pathParams))
    if (segmentProblem(value)) throw new Error('Unsafe navigation source');
  const request: TransportRequest = {
    url: requestUrl(doc, navigation.source.path),
    method: 'GET',
    headers: {},
    purpose: 'navigation',
  };
  if (!validateCollectionNavigationRead(doc, navigation, request))
    throw new Error('Request outside collection navigation');
  const response = await options.transport(request);
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Navigation source returned HTTP ${response.status}`);
  const body: unknown = JSON.parse(response.body);
  const target = linkTargets(doc, op).find(
    (link) =>
      link.name === navigation.link &&
      link.status === String(response.status) &&
      link.collection.name === navigation.collection,
  );
  if (!target) throw new Error('Response has no declared collection Link');
  const context: Record<string, string> = {};
  for (const [rawName, selector] of Object.entries(target.parameters)) {
    const name = rawName.startsWith('path.') ? rawName.slice(5) : rawName;
    if (!c.contextParams.includes(name))
      throw new Error('Only path Link parameters are supported');
    const value =
      typeof selector === 'string' && selector.startsWith('$response.body#')
        ? responseBodyValue(selector, body)
        : typeof selector === 'string' && selector.startsWith('$request.path.')
          ? navigation.source.pathParams[selector.slice(14)]
          : typeof selector === 'string' && selector.startsWith('$')
            ? undefined
            : selector;
    if (typeof value === 'number' && !Number.isSafeInteger(value))
      throw new Error('Unsafe numeric Link binding');
    if (typeof value !== 'string' && typeof value !== 'number')
      throw new Error(`Missing Link binding ${name}`);
    context[name] = String(value);
  }
  return bindCollection(doc, { collection: navigation.collection, context });
}
/** Endpoint scope only; authentication and permission grants belong to the host. */
export function validateCollectionRead(
  document: OpenApiDocument,
  bound: BoundCollection,
  request: TransportRequest,
): boolean {
  try {
    const doc = resolveRefs(document);
    const c = uniqueCollection(doc, bound.collection);
    const expected = bindCollection(doc, {
      collection: bound.collection,
      context: bound.pathParams,
    });
    if (
      bound.resource !== expected.resource ||
      bound.path !== expected.path ||
      bound.method !== expected.method ||
      request.method !== expected.method
    )
      return false;
    const url = requestUrl(doc, expected.path);
    if (
      request.url.origin !== url.origin ||
      request.url.pathname !== url.pathname ||
      request.url.username ||
      request.url.password ||
      request.url.hash
    )
      return false;
    const operation = listOperation(doc, c.url, c.method)!;
    const scheme = resolveEffectiveScheme(doc, operation)?.scheme;
    const paging = scheme?.request?.queryParameters ?? {};
    const declared = new Set(
      [
        ...(Array.isArray(doc.paths[c.url]?.['parameters'])
          ? (doc.paths[c.url]!['parameters'] as unknown[])
          : []),
        ...(operation.parameters ?? []),
      ]
        .filter(isRecord)
        .filter((p) => p['in'] === 'query')
        .map((p) => String(p['name'])),
    );
    for (const [key, value] of Object.entries(expected.query))
      if (
        bound.query[key] !== value ||
        request.url.searchParams.get(key) !== value
      )
        return false;
    for (const [key, value] of Object.entries(bound.query))
      if (
        request.url.searchParams.get(key) !== value ||
        (!Object.hasOwn(expected.query, key) && !declared.has(key))
      )
        return false;
    for (const key of request.url.searchParams.keys()) {
      if (request.url.searchParams.getAll(key).length !== 1) return false;
      if (Object.hasOwn(bound.query, key)) continue;
      if (
        ![
          'page',
          'offset',
          'pageToken',
          'cursor',
          'pageSize',
          'windowStart',
          'windowEnd',
          'windowRange',
        ].includes(paging[key]?.role ?? '') &&
        !(scheme?.type === 'nextLink' && declared.has(key))
      )
        return false;
    }
    if (request.method === 'GET') return request.body === undefined;
    const resource = crudResourcesOf(doc)[c.resource];
    const definitions = isRecord(resource)
      ? resource['collections']
      : undefined;
    const definition = isRecord(definitions) ? definitions[c.name] : undefined;
    if (
      request.body === undefined &&
      isRecord(definition) &&
      (definition['listBody'] !== undefined ||
        definition['x-list-body'] !== undefined)
    )
      return false;
    const actual: unknown =
      request.body === undefined ? {} : JSON.parse(request.body);
    if (
      !isRecord(actual) ||
      canonicalJson(bound.body) !== canonicalJson(expected.body)
    )
      return false;
    const pageBody = scheme?.request?.bodyFields ?? {};
    const walk = (
      value: Record<string, unknown>,
      declared: unknown,
      prefix = '',
    ): boolean =>
      Object.entries(value).every(([key, v]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        const fixed =
          isRecord(declared) && Object.hasOwn(declared, key)
            ? declared[key]
            : undefined;
        if (fixed !== undefined && canonicalJson(fixed) === canonicalJson(v))
          return true;
        if (isRecord(v))
          return (
            (isRecord(fixed) ||
              Object.keys(pageBody).some((key) =>
                key.startsWith(`${path}.`),
              )) &&
            walk(v, fixed, path)
          );
        return [
          'page',
          'offset',
          'pageToken',
          'cursor',
          'pageSize',
          'windowStart',
          'windowEnd',
          'windowRange',
        ].includes(pageBody[path]?.role ?? '');
      });
    const fixed = (
      value: Record<string, unknown>,
      received: unknown,
    ): boolean =>
      isRecord(received) &&
      Object.entries(value).every(
        ([key, v]) =>
          Object.hasOwn(received, key) &&
          (isRecord(v)
            ? fixed(v, received[key])
            : canonicalJson(received[key]) === canonicalJson(v)),
      );
    return walk(actual, expected.body) && fixed(expected.body, actual);
  } catch {
    return false;
  }
}
export type BoundCollectionReadOptions = Omit<
  CollectionReadOptions,
  'constants' | 'collectionNames' | 'selection' | 'legacy' | 'budget'
>;
/** Read one bound instance through shared pagination without sibling discovery. */
export async function readBoundCollection(
  document: OpenApiDocument,
  bound: BoundCollection,
  options: BoundCollectionReadOptions,
): Promise<CollectionReadResult> {
  const expected = bindCollection(document, {
    collection: bound.collection,
    context: bound.pathParams,
  });
  if (
    bound.resource !== expected.resource ||
    bound.path !== expected.path ||
    bound.method !== expected.method ||
    canonicalJson(bound.body) !== canonicalJson(expected.body)
  )
    throw new Error('Invalid bound collection');
  const transport: Transport = async (request) => {
    if (!validateCollectionRead(document, bound, request))
      throw new Error('Request outside bound collection');
    return options.transport(request);
  };
  const doc = resolveRefs(document);
  const c = uniqueCollection(doc, bound.collection);
  const operation = listOperation(doc, c.url, c.method)!;
  const parameters = [
    ...(Array.isArray(doc.paths[c.url]?.['parameters'])
      ? (doc.paths[c.url]!['parameters'] as unknown[])
      : []),
    ...(operation.parameters ?? []),
  ].filter(isRecord);
  for (const key of Object.keys(bound.query)) {
    if (
      !Object.hasOwn(expected.query, key) &&
      !parameters.some((p) => p['in'] === 'query' && p['name'] === key)
    )
      throw new Error(`Unknown query parameter ${key}`);
  }
  for (const [key, value] of Object.entries(expected.query))
    if (bound.query[key] !== value)
      throw new Error(`Changed fixed query ${key}`);
  // Put the caller's declared selection onto this collection only. This
  // preserves distinct aliases sharing a path rather than selecting by URL.
  const resources = crudResourcesOf(doc);
  const resource = resources[c.resource] as Record<string, unknown>;
  const collections = resource['collections'] as Record<string, unknown>;
  const definition = collections[c.name] as Record<string, unknown>;
  definition['listQuery'] = { ...bound.query };
  return readCollections(doc, {
    ...options,
    transport,
    constants: bound.pathParams,
    collectionNames: [bound.collection],
  });
}
