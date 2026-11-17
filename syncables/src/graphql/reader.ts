// @wc-ignore-file
/**
 * GraphQL Integration 0.2 collection reader. Descriptions must come from a
 * validated bundle; schema/query validation and authorization belong to the
 * operation executor. This module never accepts query text or an endpoint.
 */
export interface GraphQLCollection {
  id: string;
  operation: string;
  items: string[];
  identity: string[];
  pagination:
    | {
        type: 'cursor';
        pageSizeVariable: string;
        cursorVariable: string;
        hasNextPage: string[];
        endCursor: string[];
      }
    | {
        type: 'offset';
        pageSizeVariable: string;
        offsetVariable: string;
        termination: 'emptyPage';
      };
}

/** A connection-aware executor must enforce the pinned operation and policy. */
export type GraphQLExecutor = (request: {
  operationId: string;
  variables: Record<string, unknown>;
}) => Promise<{ status: number; body: string }>;

export interface GraphQLReadOptions {
  execute: GraphQLExecutor;
  /** Includes an explicit page size; excludes the traversal-position variable. */
  variables: Record<string, unknown>;
  limits?: {
    maxPages?: number;
    maxItems?: number;
    maxResponseBytes?: number;
  };
}

export interface GraphQLReadResult {
  items: Record<string, unknown>[];
  traversalComplete: boolean;
  /** A finished traversal alone never establishes deletion evidence. */
  absenceEvidence: false;
  error?: string;
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function atPath(value: unknown, path: string[]): unknown {
  requireValue(
    Array.isArray(path) &&
      path.length > 0 &&
      path.every((key) => /^[A-Za-z_][\w]*$/.test(key)),
    'Invalid response path',
  );
  for (const key of path) {
    requireValue(
      object(value) && Object.hasOwn(value, key),
      'Missing or null collection response path',
    );
    value = value[key];
  }
  return value;
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Read one concrete collection with explicit cursor/offset termination. The
 * executor receives only an operation ID and variables, never query text.
 * Prior fully validated pages survive failures; no failed page is accepted.
 * The result is not a REST collection snapshot and must not drive pruning.
 */
export async function readGraphQLCollection(
  collection: GraphQLCollection,
  options: GraphQLReadOptions,
): Promise<GraphQLReadResult> {
  const result: GraphQLReadResult = {
    items: [],
    traversalComplete: false,
    absenceEvidence: false,
  };
  try {
    const maxPages = options.limits?.maxPages ?? 100;
    const maxItems = options.limits?.maxItems ?? 10_000;
    const maxBytes = options.limits?.maxResponseBytes ?? 1_048_576;
    requireValue(
      [maxPages, maxItems, maxBytes].every(positiveInteger),
      'Read limits must be positive integers',
    );
    requireValue(
      collection.id && collection.operation,
      'Collection and operation IDs are required',
    );
    const paging = collection.pagination;
    requireValue(
      paging.type === 'cursor' || paging.type === 'offset',
      'Unsupported pagination type',
    );
    if (paging.type === 'offset')
      requireValue(
        paging.termination === 'emptyPage',
        'Unsupported offset termination',
      );
    const position =
      paging.type === 'cursor' ? paging.cursorVariable : paging.offsetVariable;
    requireValue(
      position && position !== paging.pageSizeVariable,
      'Invalid pagination variables',
    );
    requireValue(
      object(options.variables) && !Object.hasOwn(options.variables, position),
      'Caller cannot supply traversal position',
    );
    const variables = structuredClone(options.variables);
    const pageSize = variables[paging.pageSizeVariable];
    requireValue(
      typeof pageSize === 'number' &&
        positiveInteger(pageSize) &&
        pageSize <= 2_147_483_647,
      'Explicit positive GraphQL Int page size required',
    );
    variables[position] = paging.type === 'cursor' ? null : 0;
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      let response: { status: number; body: string };
      try {
        response = await options.execute({
          operationId: collection.operation,
          variables: structuredClone(variables),
        });
      } catch {
        throw new Error('GraphQL executor failed');
      }
      requireValue(
        Number.isInteger(response.status) &&
          response.status >= 200 &&
          response.status < 300,
        'GraphQL HTTP request failed',
      );
      requireValue(
        typeof response.body === 'string' &&
          new TextEncoder().encode(response.body).length <= maxBytes,
        'Invalid or oversized GraphQL body',
      );
      let payload: unknown;
      try {
        payload = JSON.parse(response.body);
      } catch {
        throw new Error('Invalid GraphQL JSON response');
      }
      requireValue(object(payload), 'GraphQL response must be an object');
      requireValue(
        !Object.hasOwn(payload, 'errors') ||
          (Array.isArray(payload['errors']) && payload['errors'].length === 0),
        'GraphQL response contains errors',
      );
      requireValue(object(payload['data']), 'GraphQL data must be an object');
      const items = atPath(payload['data'], collection.items);
      requireValue(Array.isArray(items), 'Collection items must be an array');
      requireValue(
        items.length <= pageSize,
        'Response exceeds requested page size',
      );
      requireValue(
        result.items.length + items.length <= maxItems,
        'Collection item limit exceeded',
      );
      const pageIds = new Set<string>();
      for (const item of items) {
        requireValue(object(item), 'Collection item must be an object');
        const id = atPath(item, collection.identity);
        requireValue(
          typeof id === 'string' && id.length > 0,
          'Collection identity must be a nonempty string',
        );
        requireValue(
          !seenIds.has(id) && !pageIds.has(id),
          'Duplicate collection identity',
        );
        pageIds.add(id);
      }
      let finished: boolean;
      if (paging.type === 'cursor') {
        const more = atPath(payload['data'], paging.hasNextPage);
        const next = atPath(payload['data'], paging.endCursor);
        requireValue(typeof more === 'boolean', 'hasNextPage must be Boolean');
        requireValue(
          next === null || typeof next === 'string',
          'endCursor must be String or null',
        );
        if (more) {
          requireValue(
            typeof next === 'string' &&
              next.length > 0 &&
              !seenCursors.has(next),
            'Missing or repeated cursor',
          );
          seenCursors.add(next);
          variables[position] = next;
        }
        finished = !more;
      } else {
        finished = items.length === 0;
        const next = (variables[position] as number) + pageSize;
        requireValue(
          finished || next <= 2_147_483_647,
          'GraphQL offset exceeds Int range',
        );
        variables[position] = next;
      }
      result.items.push(...structuredClone(items as Record<string, unknown>[]));
      for (const id of pageIds) seenIds.add(id);
      if (finished) {
        result.traversalComplete = true;
        return result;
      }
    }
    throw new Error('Collection page limit exceeded');
  } catch (error) {
    result.error =
      error instanceof Error ? error.message : 'Invalid GraphQL read';
  }
  return result;
}
