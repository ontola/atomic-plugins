import type { OpenApiDocument } from '../openapi/types.js';
import { resolveRefs } from '../openapi/resolve-refs.js';
import { declaredThrottling } from '../throttling/throttling.js';
import {
  applySelection,
  asText,
  discoverReadModel,
  listOperation,
  rootParameters,
  upstreamOf,
  type QuerySelection,
  type ReadCollection,
  type ReadModel,
} from './model.js';
import {
  bindPath,
  Budget,
  BudgetExhausted,
  walkPages,
  type ReadLimits,
} from './pages.js';
import { captureReadResponses, type StoreReadResponse } from './responses.js';
import type { Transport } from './transport.js';

export interface CollectionReadOptions {
  transport: Transport;
  constants?: Record<string, string>;
  selection?: QuerySelection;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
  storeResponse?: StoreReadResponse;
  probe?: boolean;
  /** Legacy path-pair discovery is opt-in for the existing client API. */
  legacy?: { identityField?: string };
  /**
   * A budget shared with requests the caller makes after the read (the
   * client's deletion-evidence reads). When given, `limits`, `sleep` and
   * `storeResponse` are not used: the budget's own transport and limits are.
   */
  budget?: Budget;
  /** Called per accepted record, before it is added to its collection. */
  onRecord?: (
    value: Record<string, unknown>,
    collection: ReadCollection,
    path: Record<string, string>,
  ) => void;
}

export interface CollectionSnapshot {
  collection: ReadCollection;
  pathParams: Record<string, string>;
  items: Record<string, unknown>[];
  /** False when a page, identity check, storage hook or budget failed. */
  complete: boolean;
  error?: string;
}

export interface CollectionReadResult {
  collections: CollectionSnapshot[];
  errors: string[];
}

interface Origin {
  value: Record<string, unknown>;
  path: Record<string, string>;
}

export class ProbeDone extends Error {}

/** Every combination of provider values, one parent record per provider collection. */
function invocations(
  collection: ReadCollection,
  model: ReadModel,
  constants: Record<string, string>,
  origins: Map<string, Origin[]>,
): Record<string, string>[] {
  const groups = new Map<string, { param: string; field: string }[]>();
  for (const param of collection.contextParams) {
    if (param in constants) {
      continue;
    }
    const provider = model.providers.get(param);
    if (!provider) {
      continue;
    }
    groups.set(provider.collection, [
      ...(groups.get(provider.collection) ?? []),
      { param, field: provider.field },
    ]);
  }

  let combos: Record<string, string>[] = [{ ...constants }];
  for (const [source, params] of groups) {
    const next: Record<string, string>[] = [];
    for (const combo of combos) {
      for (const parent of origins.get(source) ?? []) {
        const values = { ...parent.path, ...combo };
        for (const { param, field } of params) {
          values[param] = asText(parent.value[field]);
        }
        if (params.every(({ param }) => values[param])) {
          next.push(values);
        }
      }
    }
    combos = next;
  }

  const seen = new Set<string>();
  return combos.filter((combo) => {
    const key = JSON.stringify(
      collection.contextParams.map((p) => combo[p] ?? ''),
    );
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/** Raw provider collections, using the same traversal as the typed reader and local replica. */
export async function readCollections(
  document: OpenApiDocument,
  options: CollectionReadOptions,
): Promise<CollectionReadResult> {
  const doc = resolveRefs(document);
  const model = discoverReadModel(doc, options.legacy);
  applySelection(doc, model, options.selection);
  const constants = options.constants ?? {};
  for (const param of rootParameters(model)) {
    if (!constants[param]) throw new Error(`Enter a value for ${param}`);
  }
  const budget =
    options.budget ??
    new Budget(
      captureReadResponses(options.transport, options.storeResponse),
      options.limits,
      options.sleep,
      declaredThrottling(doc),
    );
  const upstream = upstreamOf(doc);
  const collections: CollectionSnapshot[] = [];
  const errors: string[] = [];
  const origins = new Map<string, Origin[]>();
  const identities = new Set<string>();
  let count = 0;
  let exhausted = false;
  let pending = [...model.collections];
  while (pending.length && !exhausted) {
    const waiting: ReadCollection[] = [];
    let progressed = false;
    for (const collection of pending) {
      const sources = collection.contextParams
        .filter((p) => !(p in constants))
        .map((p) => model.providers.get(p)?.collection);
      if (sources.some((s) => s === undefined || s === collection.name)) {
        errors.push(`${collection.name}: its context has no provider`);
        progressed = true;
        continue;
      }
      if (!sources.every((source) => origins.has(source as string))) {
        waiting.push(collection);
        continue;
      }
      progressed = true;
      const read: Origin[] = [];
      for (const path of invocations(collection, model, constants, origins)) {
        const snapshot: CollectionSnapshot = {
          collection,
          pathParams: path,
          items: [],
          complete: false,
        };
        collections.push(snapshot);
        try {
          const operation = listOperation(
            doc,
            collection.url,
            collection.method,
          );
          // Preserve the legacy client's observable 405 for a paired collection without GET.
          if (
            !operation &&
            !(options.legacy && doc.components?.['crudResources'] === undefined)
          ) {
            throw new Error(
              `${collection.url} declares no ${collection.method} operation`,
            );
          }
          for await (const page of walkPages({
            document: doc,
            operation: operation ?? { responses: {} },
            budget,
            upstream,
            path: bindPath(collection.url, path),
            method: collection.method,
            query: collection.listQuery,
            body: collection.listBody,
            // The declared envelope, if any; else walkPages locates the array.
            ...(collection.itemsField !== undefined
              ? { itemsField: collection.itemsField }
              : {}),
          })) {
            if (options.probe) throw new ProbeDone();
            for (const value of page.items) {
              const id = asText(value[collection.idField]);
              const key = JSON.stringify([
                collection.resource,
                collection.contextParams.map((p) => path[p]),
                id,
              ]);
              if (!id || identities.has(key)) {
                throw new Error(
                  'Missing or repeated record identity; pagination may not be forwarded by the proxy',
                );
              }
              if (count >= budget.limits.maxRecords) {
                throw new BudgetExhausted(
                  `Read exceeds ${budget.limits.maxRecords} records; narrow its scope`,
                );
              }
              options.onRecord?.(value, collection, path);
              identities.add(key);
              count += 1;
              snapshot.items.push(value);
            }
          }
          snapshot.complete = true;
          read.push(...snapshot.items.map((value) => ({ value, path })));
        } catch (error) {
          if (error instanceof ProbeDone)
            return { collections: [], errors: [] };
          if (options.probe) throw error;
          snapshot.error =
            error instanceof Error ? error.message : String(error);
          errors.push(`${collection.name}: ${snapshot.error}`);
          if (error instanceof BudgetExhausted) {
            exhausted = true;
            break;
          }
        }
      }
      origins.set(collection.name, read);
      if (exhausted) break;
    }
    if (!progressed) {
      for (const c of waiting)
        errors.push(`${c.name}: its parent collection could not be read`);
      break;
    }
    pending = waiting;
  }
  if (options.probe) throw new Error('No collection available to check');
  return { collections, errors };
}
