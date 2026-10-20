import { readFile } from 'node:fs/promises';
import { loadOpenApiDocument } from '../openapi/load.js';
import {
  discoverReadModel,
  listOperation,
  upstreamOf,
  isRecord,
} from '../read/model.js';
import {
  Budget,
  walkPages,
  bindPath,
  PageStatusError,
  type WalkOutcome,
} from '../read/pages.js';
import {
  declaredThrottling,
  classifyThrottling,
  type ThrottlingVerdict,
} from '../throttling/throttling.js';
import { resolveEffectiveScheme } from '../pagination/autodetect.js';
import { readNestedField } from '../pagination/response-parser.js';
import { isListTombstone } from '../read/list-tombstones.js';
import {
  PostgresArchive,
  createCachingTransport,
  indexJson,
  renderJson,
  nodeHash,
  type JsonGraph,
  type GraphNode,
  type GraphValue,
  type ArchiveScope,
} from '../postgres/index.js';
import type { Transport, TransportResponse } from '../read/transport.js';
import type { OpenApiDocument } from '../openapi/types.js';
import { GitAtomicStore } from './git-store.js';
import {
  collectionScope,
  itemSubject,
  type CollectionConfig,
} from './config.js';

export const SOURCE_JSON = 'urn:syncables:property:source-json';
export const SOURCE_ID = 'urn:syncables:property:source-id';
const IS_A = 'https://atomicdata.dev/properties/is-a';
const SOURCE_CLASS = 'urn:syncables:class:source-record';
const schema = (): Map<string, string> =>
  new Map([
    [
      SOURCE_CLASS,
      JSON.stringify({
        '@id': SOURCE_CLASS,
        [IS_A]: ['https://atomicdata.dev/classes/Class'],
        'https://atomicdata.dev/properties/requires': [SOURCE_ID, SOURCE_JSON],
      }),
    ],
    [
      SOURCE_ID,
      JSON.stringify({
        '@id': SOURCE_ID,
        [IS_A]: ['https://atomicdata.dev/classes/Property'],
        'https://atomicdata.dev/properties/datatype':
          'https://atomicdata.dev/datatypes/string',
      }),
    ],
    [
      SOURCE_JSON,
      JSON.stringify({
        '@id': SOURCE_JSON,
        [IS_A]: ['https://atomicdata.dev/classes/Property'],
        'https://atomicdata.dev/properties/datatype':
          'https://atomicdata.dev/datatypes/json',
      }),
    ],
  ]);
function objectRefs(
  graph: JsonGraph,
  parsed: unknown,
): WeakMap<object, string> {
  const refs = new WeakMap<object, string>();
  const visit = (value: GraphValue, current: unknown): void => {
    if (value[0] !== 'ref') return;
    const node = JSON.parse(graph.nodes.get(value[1])!) as GraphNode;
    if (current && typeof current === 'object') refs.set(current, value[1]);
    if (node[2] === 'object' && isRecord(current))
      for (const [key, child] of node[3] as [string, GraphValue][])
        visit(child, current[key]);
    if (node[2] === 'array' && Array.isArray(current))
      (node[3] as GraphValue[]).forEach((child, i) => visit(child, current[i]));
  };
  visit(['ref', graph.root], parsed);
  return refs;
}
function adaptIncremental(document: OpenApiDocument): OpenApiDocument {
  const doc = structuredClone(document);
  const schemes: unknown = doc.components?.['paginationSchemes'];
  if (isRecord(schemes))
    for (const entry of Object.values(schemes))
      if (isRecord(entry) && entry.type === 'incrementalSync') {
        entry.type = 'pageToken';
        entry['x-syncables-incremental'] = true;
      }
  return doc;
}
export interface PreparedCollection {
  source: CollectionConfig;
  document: OpenApiDocument;
  scope: string;
}
export async function prepareCollection(
  owner: string,
  source: CollectionConfig,
): Promise<PreparedCollection> {
  const original = await readFile(source.document, 'utf8');
  const document = adaptIncremental(await loadOpenApiDocument(source.document));
  return {
    source,
    document,
    scope: collectionScope(owner, source, nodeHash(original)),
  };
}
export interface SyncCollectionOptions {
  prepared: PreparedCollection;
  archive: PostgresArchive;
  store: GitAtomicStore;
  auth: ArchiveScope;
  upstream: Transport;
  signal?: AbortSignal;
}
export interface CollectionSyncResult {
  revision: string;
  run: string;
  records: number;
  strategy: 'full' | 'bootstrap' | 'delta';
}
export class SyncRetryError extends Error {
  constructor(
    readonly retryAt?: number,
    readonly blocked = false,
  ) {
    super(blocked ? 'Source blocked automatic reads' : 'Source deferred reads');
  }
}
/** Each successful read publishes one complete Git tree after raw archival. */
export async function syncCollection(
  options: SyncCollectionOptions,
): Promise<CollectionSyncResult> {
  const { prepared, archive, store, auth } = options;
  const { document, source, scope } = prepared;
  if (source.connection !== auth.connection)
    throw new Error('Collection does not match the authenticated connection');
  const model = discoverReadModel(document);
  const matches = model.collections.filter((c) => c.name === source.collection);
  if (matches.length !== 1)
    throw new Error('Unknown or ambiguous metadata collection');
  const collection = matches[0];
  if (collection.method !== 'GET')
    throw new Error('This read-only daemon supports GET collections only');
  for (const key of collection.contextParams)
    if (!Object.hasOwn(source.bindings, key))
      throw new Error('Configure all parent bindings before syncing');
  const operation = listOperation(document, collection.url, collection.method);
  if (!operation) throw new Error('Collection declares no read operation');
  const inherited = document.paths[collection.url]?.parameters;
  const parameters = [
    ...(Array.isArray(inherited) ? inherited : []),
    ...(operation.parameters ?? []),
  ];
  for (const [key, value] of Object.entries(source.query)) {
    if (
      !parameters.some((p) => isRecord(p) && p.in === 'query' && p.name === key)
    )
      throw new Error(
        'Configured query parameter is not declared by the read operation',
      );
    if (
      Object.hasOwn(collection.listQuery, key) &&
      collection.listQuery[key] !== value
    )
      throw new Error(
        'Configured query cannot replace a fixed collection value',
      );
  }
  if (parameters.some((p) => isRecord(p) && p['x-time-zone'] !== undefined))
    throw new Error(
      'Zoned filter conversion is not supported by this daemon stage',
    );
  const scheme = resolveEffectiveScheme(document, operation)?.scheme;
  if (scheme?.type === 'rangeWindow')
    throw new Error(
      'Range-window collections need coverage support before daemon publication',
    );
  const incremental = scheme?.['x-syncables-incremental'] === true;
  for (const [key, field] of Object.entries(
    scheme?.request?.queryParameters ?? {},
  ))
    if (
      Object.hasOwn(source.query, key) &&
      ['syncToken', 'pageToken', 'pageNumber', 'offset'].includes(
        field.role ?? '',
      )
    )
      throw new Error('Paging and sync checkpoints are managed by the daemon');
  const tokenFields = Object.entries(
    scheme?.request?.queryParameters ?? {},
  ).filter(([, field]) => field.role === 'syncToken');
  if (
    incremental &&
    (tokenFields.length !== 1 ||
      Object.values(scheme?.request?.bodyFields ?? {}).some(
        (field) => field.role === 'syncToken',
      ) ||
      Object.values(scheme?.request?.headerFields ?? {}).some(
        (field) => field.role === 'syncToken',
      ))
  )
    throw new Error(
      'Incremental daemon reads require one query syncToken field',
    );
  const expected = await store.head(scope);
  const previous = expected ? await store.context(scope, expected) : {};
  const priorToken =
    previous.authorizationContext === auth.authorizationContext &&
    typeof previous.syncToken === 'string'
      ? previous.syncToken
      : undefined;
  let token = incremental ? priorToken : undefined;
  for (let bootstrap = 0; bootstrap < 2; bootstrap++) {
    const strategy = incremental ? (token ? 'delta' : 'bootstrap') : 'full';
    const run = await archive.createRun(
      auth,
      'collection ' + source.name + ' ' + strategy,
    );
    let finished = false;
    let verdict: ThrottlingVerdict | undefined;
    try {
      let graph: JsonGraph | undefined;
      let last: TransportResponse | undefined;
      const live = createCachingTransport({
        archive,
        scope: auth,
        run,
        mode: 'live',
        upstream: async (request) => {
          if (options.signal?.aborted) throw new Error('Sync stopped');
          return options.upstream(request);
        },
        onResponse: ({ response }) => {
          last = response;
          verdict = classifyThrottling(declaredThrottling(document), {
            ...response,
            receivedAt: Date.now(),
          });
          if (verdict?.meaning === 'blocked')
            throw new SyncRetryError(undefined, true);
          graph =
            response.status >= 200 && response.status < 300
              ? indexJson(response.body, { maxBytes: archive.maxBodyBytes })
              : undefined;
        },
      });
      const budget = new Budget(
        live,
        { maxRecords: 5000, maxRequests: 1000, timeoutMs: 120_000 },
        async (ms) => {
          if (options.signal?.aborted) throw new Error('Sync stopped');
          await new Promise<void>((done, reject) => {
            const stop = (): void => {
              clearTimeout(timer);
              reject(new Error('Sync stopped'));
            };
            const timer = setTimeout(() => {
              options.signal?.removeEventListener('abort', stop);
              done();
            }, ms);
            options.signal?.addEventListener('abort', stop, { once: true });
          });
        },
        declaredThrottling(document),
      );
      const resources =
        token && expected
          ? new Map(
              (await store.list(scope, expected)).map((text) => [
                (JSON.parse(text) as { '@id': string })['@id'],
                text,
              ]),
            )
          : schema();
      const seen = new Set<string>();
      const query = { ...collection.listQuery, ...source.query };
      if (token) query[tokenFields[0][0]] = token;
      const outcome: WalkOutcome = { complete: false };
      let count = 0;
      for await (const page of walkPages({
        document,
        operation,
        budget,
        upstream: upstreamOf(document),
        path: bindPath(collection.url, source.bindings),
        method: 'GET',
        query,
        body: {},
        outcome,
        ...(collection.itemsField === undefined
          ? {}
          : { itemsField: collection.itemsField }),
        ...(collection.emptyWhenAbsent ? { emptyWhenAbsent: true } : {}),
      })) {
        if (!graph) throw new Error('Missing graph for collection page');
        const currentGraph: JsonGraph = graph;
        const refs = objectRefs(currentGraph, page.body);
        for (const item of page.items) {
          const idValue = item[collection.idField];
          if (
            !(typeof idValue === 'string' && idValue) &&
            !(typeof idValue === 'number' && Number.isSafeInteger(idValue))
          )
            throw new Error('Missing or unsafe numeric record identity');
          const id = String(idValue);
          if (seen.has(id) || ++count > 5000)
            throw new Error(
              'Repeated identity or collection exceeds record limit',
            );
          seen.add(id);
          const subject = itemSubject(
            auth.owner,
            source,
            collection.resource,
            id,
          );
          if (
            collection.listTombstone &&
            isListTombstone(collection.listTombstone, item)
          ) {
            resources.delete(subject);
            continue;
          }
          const root = refs.get(item);
          if (!root)
            throw new Error('Cannot locate original item in response graph');
          const raw = await renderJson(
            root,
            async (hash) => currentGraph.nodes.get(hash)!,
          );
          const prefix = JSON.stringify({
            '@id': subject,
            [IS_A]: [SOURCE_CLASS],
            [SOURCE_ID]: id,
          });
          resources.set(
            subject,
            prefix.slice(0, -1) +
              ',' +
              JSON.stringify(SOURCE_JSON) +
              ':' +
              raw +
              '}',
          );
        }
      }
      if (!outcome.complete || options.signal?.aborted)
        throw new Error(
          'Collection read incomplete; previous snapshot retained',
        );
      let nextToken: string | undefined;
      if (incremental) {
        const fields = Object.entries(
          scheme?.response?.bodyFields ?? {},
        ).filter(([, field]) => field.role === 'nextSyncToken');
        const headers = Object.entries(scheme?.response?.headers ?? {}).filter(
          ([, field]) => field.role === 'nextSyncToken',
        );
        if (fields.length + headers.length !== 1 || !last)
          throw new Error(
            'Incremental scheme needs one terminal nextSyncToken',
          );
        const response: TransportResponse = last;
        const found = fields.length
          ? readNestedField(
              JSON.parse(response.body) as Record<string, unknown>,
              fields[0][0],
            )
          : response.headers[headers[0][0].toLowerCase()];
        if (typeof found !== 'string' || !found)
          throw new Error(
            'Missing terminal nextSyncToken; previous checkpoint retained',
          );
        nextToken = found;
      }
      await archive.finishRun(auth.owner, run);
      finished = true;
      const revision = await store.commit(
        {
          scope,
          resources,
          context: {
            owner: auth.owner,
            connection: auth.connection,
            authorizationContext: auth.authorizationContext,
            collection: source.name,
            resource: collection.resource,
            platform: source.platform,
            account: source.account,
            run,
            strategy,
            mapping: 'source-json-ad-v1',
            ...(nextToken ? { syncToken: nextToken } : {}),
          },
        },
        expected,
        options.signal,
      );
      return { revision, run, records: resources.size - 3, strategy };
    } catch (error) {
      if (!finished)
        await archive.finishRun(auth.owner, run, false).catch(() => {});
      if (
        error instanceof PageStatusError &&
        error.status === 410 &&
        token &&
        bootstrap === 0
      ) {
        token = undefined;
        continue;
      }
      if (verdict?.meaning === 'blocked')
        throw new SyncRetryError(undefined, true);
      if (verdict?.retryAt !== undefined && verdict.retryAt > Date.now())
        throw new SyncRetryError(verdict.retryAt);
      throw error;
    }
  }
  throw new Error('Incremental bootstrap failed');
}
