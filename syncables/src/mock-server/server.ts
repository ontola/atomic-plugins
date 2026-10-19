import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { generateFromSchema } from '../fake-data/generate.js';
import {
  discoverResources,
  type ResourceRoute,
} from '../resources/discover.js';
import type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  SchemaObject,
} from '../openapi/types.js';
import { findRoute } from '../routing/router.js';
import {
  resolveEffectiveScheme,
  type EffectiveScheme,
} from '../pagination/autodetect.js';
import {
  itemSchemaFor as paginationItemSchemaFor,
  locateItemsField,
} from '../pagination/items.js';
import { setNestedField } from '../pagination/response-parser.js';
import { pageStart } from '../pagination/request-builder.js';
import { ResourceStore } from './store.js';

export interface MockServer {
  listen(port?: number): Promise<{ port: number; url: string }>;
  close(): Promise<void>;
}

const SEED_COUNT = 3;
/** Total fake items generated for a paginated list endpoint, once per path template. */
const PAGINATED_TOTAL_COUNT = 7;
/** Page size used when the request doesn't specify one. */
const DEFAULT_PAGE_SIZE = 3;

export function createMockServer(document: OpenApiDocument): MockServer {
  const paths = document.paths as unknown as Record<
    string,
    Record<string, OperationObject | undefined>
  >;
  const resources = discoverResources(paths);
  const store = new ResourceStore();
  const paginatedLists = new Map<string, Record<string, unknown>[]>();
  const replays: IdempotentReplays = new Map();
  const server: Server = createServer((req, res) => {
    handleRequest(
      req,
      res,
      document,
      paths,
      resources,
      store,
      paginatedLists,
      replays,
    ).catch((error: unknown) => {
      sendJson(res, 500, { error: String(error) });
    });
  });

  return {
    listen(port = 0): Promise<{ port: number; url: string }> {
      return new Promise((resolve) => {
        server.listen(port, () => {
          const address = server.address();
          const actualPort =
            typeof address === 'object' && address ? address.port : port;
          resolve({ port: actualPort, url: `http://127.0.0.1:${actualPort}` });
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * The create answered for each idempotency key, per collection: the body
 * the key was first sent with, and the record created for it.
 */
type IdempotentReplays = Map<
  string,
  { body: string; record: Record<string, unknown> }
>;

/**
 * The `Idempotency-Key` header parameter (any case) a create operation or
 * its path item declares, as the client looks for it.
 */
function declaredIdempotencyHeader(
  pathItem: Record<string, unknown> | undefined,
  operation: OperationObject,
): string | undefined {
  const parameters = [
    ...((pathItem?.['parameters'] as ParameterObject[] | undefined) ?? []),
    ...(operation.parameters ?? []),
  ];
  return parameters.find(
    (p) => p.in === 'header' && /^idempotency-key$/i.test(p.name),
  )?.name;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  document: OpenApiDocument,
  paths: Record<string, Record<string, OperationObject | undefined>>,
  resources: ResourceRoute[],
  store: ResourceStore,
  paginatedLists: Map<string, Record<string, unknown>[]>,
  replays: IdempotentReplays,
): Promise<void> {
  // Real absolute base (not a placeholder), needed to build working
  // nextLink URLs for paginated responses.
  const url = new URL(
    req.url ?? '/',
    `http://${req.headers.host ?? 'localhost'}`,
  );
  const method = (req.method ?? 'GET').toLowerCase();
  const match = findRoute(Object.keys(paths), url.pathname);

  if (!match) {
    sendJson(res, 404, { error: 'Not Found' });
    return;
  }

  const operation = paths[match.template]?.[method];
  if (!operation) {
    sendJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  if (method === 'get') {
    let effective: ReturnType<typeof resolveEffectiveScheme>;
    try {
      effective = resolveEffectiveScheme(document, operation);
    } catch (error) {
      // The document's explicit x-pagination cannot be applied: the mock
      // cannot serve the operation as the document describes it.
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (effective) {
      handlePaginatedListRequest(
        match.template,
        operation,
        effective,
        url,
        paginatedLists,
        res,
      );
      return;
    }
  }

  const raw =
    method === 'post' || method === 'put' || method === 'patch'
      ? await readBody(req)
      : undefined;
  const body = raw?.json;

  const resource = resources.find(
    (route) =>
      route.collectionPath === match.template ||
      route.itemPath === match.template,
  );

  if (resource?.itemPath === match.template) {
    const id = match.params[resource.itemParam] ?? '';
    handleItemRequest(method, id, resource, store, body, res);
    return;
  }

  if (resource?.collectionPath === match.template) {
    const header =
      method === 'post'
        ? declaredIdempotencyHeader(
            paths[match.template] as Record<string, unknown> | undefined,
            operation,
          )
        : undefined;
    const value = header ? req.headers[header.toLowerCase()] : undefined;
    const key = typeof value === 'string' && value !== '' ? value : undefined;
    if (key !== undefined) {
      // A create the document declares idempotent, sent again with the
      // same key: the first answer again, not a second record. The same
      // key with another body is refused, as the IETF Idempotency-Key
      // draft and Stripe do. Bodies compare as JSON with sorted keys, or
      // as text when they are not JSON (bodyFingerprint).
      const seen = replays.get(`${match.template}\n${key}`);
      if (seen) {
        if (raw && seen.body === bodyFingerprint(raw))
          sendJson(res, 201, seen.record);
        else
          sendJson(res, 422, {
            error: 'Idempotency-Key reused with a different request body',
          });
        return;
      }
    }
    const record = handleCollectionRequest(
      req,
      method,
      resource,
      operation,
      store,
      body,
      res,
    );
    if (key !== undefined && record)
      replays.set(`${match.template}\n${key}`, {
        body: raw ? bodyFingerprint(raw) : '',
        record,
      });
    return;
  }

  respondWithExample(operation, res);
}

function handleItemRequest(
  method: string,
  id: string,
  resource: ResourceRoute,
  store: ResourceStore,
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): void {
  if (method === 'get') {
    const record = store.get(resource.collectionPath, id);
    if (!record) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    sendJson(res, 200, record);
    return;
  }

  if (method === 'put' || method === 'patch') {
    const existing = store.get(resource.collectionPath, id);
    if (!existing && method === 'patch') {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    const updated: Record<string, unknown> =
      method === 'patch' ? { ...existing, ...body, id } : { ...body, id };
    store.put(resource.collectionPath, id, updated);
    sendJson(res, 200, updated);
    return;
  }

  if (method === 'delete') {
    const deleted = store.delete(resource.collectionPath, id);
    if (!deleted) {
      sendJson(res, 404, { error: 'Not Found' });
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
}

function handleCollectionRequest(
  req: IncomingMessage,
  method: string,
  resource: ResourceRoute,
  operation: OperationObject,
  store: ResourceStore,
  body: Record<string, unknown> | undefined,
  res: ServerResponse,
): Record<string, unknown> | undefined {
  if (method === 'get') {
    seedIfEmpty(resource, operation, store);
    const etag = store.etag(resource.collectionPath);
    const lastModified = store.lastModified(resource.collectionPath);
    const headers = conditionalResponseHeaders(etag, lastModified);
    if (isNotModified(req, etag, lastModified)) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    sendJson(res, 200, store.list(resource.collectionPath), headers);
    return undefined;
  }

  if (method === 'post') {
    const itemSchema = itemSchemaFor(operation, [201, 200]);
    const generated = generateFromSchema(itemSchema);
    // Honors a client-supplied id (a common real-world pattern, e.g. a
    // client-generated UUID primary key) rather than always assigning its
    // own, so a caller doesn't have to reconcile its own id with a
    // different server-assigned one.
    const id =
      typeof body?.['id'] === 'string' && body['id'] !== ''
        ? body['id']
        : randomUUID();
    const record: Record<string, unknown> = {
      ...(generated && typeof generated === 'object' ? generated : {}),
      ...body,
      id,
    };
    store.put(resource.collectionPath, record['id'] as string, record);
    sendJson(res, 201, record);
    return record;
  }

  sendJson(res, 405, { error: 'Method Not Allowed' });
  return undefined;
}

/** A dot-path's value in an item: own properties, names split on `.`. */
function itemValue(item: unknown, path: string): unknown {
  let current: unknown = item;
  for (const name of path.split('.'))
    current =
      current !== null &&
      typeof current === 'object' &&
      Object.hasOwn(current, name)
        ? (current as Record<string, unknown>)[name]
        : undefined;
  return current;
}

/**
 * The first query parameter with `role`. For a page token the caller asks
 * for `pageToken`, then `cursor`: both are the request roles a `pageToken`
 * scheme sends its next token in (a `cursor` field takes `nextCursor`),
 * and this server answers either with an offset as its token.
 */
function fieldNameForRole(
  scheme: EffectiveScheme['scheme'],
  role: string,
): string | undefined {
  const entry = Object.entries(scheme.request?.queryParameters ?? {}).find(
    ([, field]) => field.role === role,
  );
  return entry?.[0];
}

function buildNextLink(
  url: URL,
  nextOffset: number,
  pageSize: number,
  offsetParam: string | undefined,
  pageParam: string | undefined,
  pageSizeParam: string | undefined,
): string {
  const next = new URL(url.toString());
  if (offsetParam) {
    next.searchParams.set(offsetParam, String(nextOffset));
  }
  if (pageParam) {
    next.searchParams.set(
      pageParam,
      String(Math.floor(nextOffset / pageSize) + 1),
    );
  }
  if (pageSizeParam) {
    next.searchParams.set(pageSizeParam, String(pageSize));
  }
  return next.toString();
}

/**
 * Serves a GET operation whose pagination scheme was resolved by
 * `resolveEffectiveScheme`: generates a fixed-size fake dataset once per
 * path template, slices it according to the request's pagination
 * parameters, and reports accurate metadata at the scheme's declared
 * (possibly nested) response fields.
 */
function handlePaginatedListRequest(
  pathTemplate: string,
  operation: OperationObject,
  effective: EffectiveScheme,
  url: URL,
  paginatedLists: Map<string, Record<string, unknown>[]>,
  res: ServerResponse,
): void {
  const { scheme } = effective;
  const responseSchema = responseSchemaFor(operation, [200]);

  // Pagination Schemes 0.9.0 §4.3.3: the query field whose value is a
  // field of the previous page's last item.
  const itemCursor = Object.entries(scheme.request?.queryParameters ?? {}).find(
    ([, field]) => typeof field.fromLastItem === 'string',
  );
  const itemPath = itemCursor?.[1].fromLastItem;
  let items = paginatedLists.get(pathTemplate);
  if (!items) {
    const itemSchema = paginationItemSchemaFor(responseSchema, scheme);
    items = Array.from({ length: PAGINATED_TOTAL_COUNT }, () => {
      const generated = generateFromSchema(itemSchema);
      // generateFromSchema prefers a schema's own `example` when present,
      // which is great for a single realistic value but means every
      // generated item would otherwise share the exact same id (e.g.
      // Spotify's SimplifiedAlbumObject.id has a fixed example) — so, as
      // with resource seeding below, each item gets its own fresh id.
      return {
        ...(generated && typeof generated === 'object'
          ? (generated as Record<string, unknown>)
          : { value: generated }),
        id: randomUUID(),
      };
    });
    // Each item gets its own value at the item cursor's path too (a
    // schema's fixed example would repeat it), in list order.
    if (itemPath && itemPath !== 'id')
      items.forEach((item, i) =>
        setNestedField(item, itemPath, `item_${String(i).padStart(6, '0')}`),
      );
    paginatedLists.set(pathTemplate, items);
  }

  const offsetParam = fieldNameForRole(scheme, 'offset');
  const pageParam = fieldNameForRole(scheme, 'page');
  const pageSizeParam = fieldNameForRole(scheme, 'pageSize');
  const pageTokenParam =
    fieldNameForRole(scheme, 'pageToken') ?? fieldNameForRole(scheme, 'cursor');

  // A shortPage's numeric size is the full page the server answers.
  const shortSize = scheme.response?.shortPage?.size;
  const defaultSize =
    typeof shortSize === 'number' ? shortSize : DEFAULT_PAGE_SIZE;
  const pageSize = pageSizeParam
    ? Number(url.searchParams.get(pageSizeParam) ?? defaultSize)
    : defaultSize;

  let offset = 0;
  if (itemCursor && itemPath) {
    // After the item whose value the request names; the first page
    // without one. A value no item has answers an empty page, and so does
    // an empty one (`?starting_after=`), which names no item: the client
    // sends no cursor at all on its first request.
    const after = url.searchParams.get(itemCursor[0]);
    if (after !== null) {
      const at = items.findIndex(
        (item) => String(itemValue(item, itemPath)) === after,
      );
      offset = at === -1 ? items.length : at + 1;
    }
  } else if (offsetParam) {
    offset = Number(url.searchParams.get(offsetParam) ?? '0');
  } else if (pageParam) {
    const start = pageStart(scheme);
    const page = Number(url.searchParams.get(pageParam) ?? String(start));
    offset = (page - start) * pageSize;
  } else if (pageTokenParam) {
    const token = url.searchParams.get(pageTokenParam);
    offset = token ? Number(token) : 0;
  }

  const slice = items.slice(offset, offset + pageSize);
  const hasMore = offset + pageSize < items.length;
  const nextOffset = offset + pageSize;

  const generatedBody = generateFromSchema(responseSchema);
  const body: Record<string, unknown> =
    generatedBody && typeof generatedBody === 'object'
      ? (generatedBody as Record<string, unknown>)
      : {};

  const itemsField = locateItemsField(responseSchema, scheme);
  if (itemsField) {
    body[itemsField] = slice;
  }

  for (const [path, field] of Object.entries(
    scheme.response?.bodyFields ?? {},
  )) {
    switch (field.role) {
      case 'totalCount':
        setNestedField(body, path, items.length);
        break;
      case 'pageSize':
        setNestedField(body, path, slice.length);
        break;
      case 'currentPage':
        setNestedField(body, path, Math.floor(offset / pageSize) + 1);
        break;
      case 'totalPages':
        setNestedField(body, path, Math.ceil(items.length / pageSize));
        break;
      case 'hasMore':
        setNestedField(body, path, hasMore);
        break;
      case 'nextPageToken':
      case 'nextCursor':
        setNestedField(body, path, hasMore ? String(nextOffset) : null);
        break;
      case 'nextLink':
        setNestedField(
          body,
          path,
          hasMore
            ? buildNextLink(
                url,
                nextOffset,
                pageSize,
                offsetParam,
                pageParam,
                pageSizeParam,
              )
            : null,
        );
        break;
      default:
        break;
    }
  }

  sendJson(res, 200, body);
}

function seedIfEmpty(
  resource: ResourceRoute,
  operation: OperationObject,
  store: ResourceStore,
): void {
  if (store.has(resource.collectionPath)) {
    return;
  }
  const itemSchema = itemSchemaFor(operation, [200]);
  for (let i = 0; i < SEED_COUNT; i += 1) {
    const generated = generateFromSchema(itemSchema);
    const record: Record<string, unknown> = {
      ...(generated && typeof generated === 'object' ? generated : {}),
      id: randomUUID(),
    };
    store.put(resource.collectionPath, record['id'] as string, record);
  }
}

function itemSchemaFor(
  operation: OperationObject,
  codes: number[],
): SchemaObject | undefined {
  const schema = responseSchemaFor(operation, codes);
  return schema?.type === 'array' ? schema.items : schema;
}

function responseSchemaFor(
  operation: OperationObject,
  codes: number[],
): SchemaObject | undefined {
  for (const code of codes) {
    const schema =
      operation.responses[String(code)]?.content?.['application/json']?.schema;
    if (schema) {
      return schema;
    }
  }
  return undefined;
}

function respondWithExample(
  operation: OperationObject,
  res: ServerResponse,
): void {
  const codes = Object.keys(operation.responses);
  const successCode = codes.find((code) => code.startsWith('2')) ?? codes[0];
  if (!successCode) {
    res.writeHead(204);
    res.end();
    return;
  }

  const content =
    operation.responses[successCode]?.content?.['application/json'];
  if (!content) {
    res.writeHead(Number.parseInt(successCode, 10) || 200);
    res.end();
    return;
  }

  const body = content.example ?? generateFromSchema(content.schema);
  sendJson(res, Number.parseInt(successCode, 10) || 200, body);
}

async function readBody(
  req: IncomingMessage,
): Promise<{ text: string; json: Record<string, unknown> | undefined }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) {
    return { text, json: undefined };
  }
  try {
    return { text, json: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { text, json: undefined };
  }
}

/** JSON with every object's keys sorted, so key order does not matter. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * What makes two creates under one idempotency key the same request: the
 * JSON body with its keys sorted, or the body text as sent when it is not
 * JSON (so two different unparseable bodies differ).
 */
function bodyFingerprint(body: {
  text: string;
  json: Record<string, unknown> | undefined;
}): string {
  return body.json === undefined
    ? `text:${body.text}`
    : `json:${canonicalJson(body.json)}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (body === undefined) {
    res.writeHead(status, extraHeaders);
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function conditionalResponseHeaders(
  etag: string | undefined,
  lastModified: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (etag) {
    headers['ETag'] = etag;
  }
  if (lastModified) {
    headers['Last-Modified'] = lastModified;
  }
  return headers;
}

/**
 * Per RFC 7232 §3.3, If-None-Match takes precedence over If-Modified-Since
 * when both are present.
 */
function isNotModified(
  req: IncomingMessage,
  etag: string | undefined,
  lastModified: string | undefined,
): boolean {
  const ifNoneMatch = firstHeaderValue(req.headers['if-none-match']);
  if (ifNoneMatch) {
    return etag !== undefined && ifNoneMatch === etag;
  }

  const ifModifiedSince = firstHeaderValue(req.headers['if-modified-since']);
  if (ifModifiedSince && lastModified) {
    const since = new Date(ifModifiedSince).getTime();
    const modified = new Date(lastModified).getTime();
    return !Number.isNaN(since) && !Number.isNaN(modified) && modified <= since;
  }

  return false;
}

function firstHeaderValue(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
