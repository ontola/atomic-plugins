// @wc-ignore-file
import type { OpenApiDocument, ParameterObject } from '../openapi/types.js';
import { isRecord } from '../read/model.js';

/**
 * CRUD Causality 0.5.0 compound creates (§4.7), after the reference
 * `compound_create`, `missing_value` and `follow_up_request` in
 * `openapi-extensions/spec/crud-causality/validate.py`: a create whose
 * `x-crud.followUps` lists fields that may need a follow-up update of the
 * created object (GitHub's issue `labels`, which the create may silently
 * drop, then added with a second request).
 */

/** Where a bound value comes from (§4.7.1 BindSource). */
export interface BindSource {
  from: 'created' | 'planned' | 'missing';
  field: string;
}

/** One Follow-up Object, with its operation resolved. */
export interface FollowUp {
  field: string;
  create: 'include' | 'omit';
  itemKey?: string;
  operation: string;
  /** The follow-up operation's path template and method. */
  path: string;
  method: 'POST' | 'PUT' | 'PATCH';
  bind: Record<string, BindSource>;
}

/** A filled follow-up request (§4.7.1 `bind`). */
export interface FollowUpRequest {
  path: Record<string, string>;
  query: Record<string, string>;
  header: Record<string, string>;
  body?: unknown;
}

const MISSING = Symbol('missing');
export type Missing = typeof MISSING;
export const NOTHING_MISSING: Missing = MISSING;

/** A dot-path's names (literal, as §3 of CRUD Causality reads them). */
function names(path: string): string[] {
  return path.split('.');
}

/** The value at a dot-path, or MISSING. */
export function valueAt(value: unknown, path: string): unknown {
  let node = value;
  for (const name of names(path)) {
    if (!isRecord(node) || !Object.hasOwn(node, name)) return MISSING;
    node = node[name];
  }
  return node;
}

function setAt(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = names(path);
  let node = target;
  for (const name of parts.slice(0, -1)) {
    if (!isRecord(node[name])) node[name] = {};
    node = node[name] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

function dropAt(target: Record<string, unknown>, path: string): void {
  const parts = names(path);
  let node: unknown = target;
  for (const name of parts.slice(0, -1)) {
    if (!isRecord(node)) return;
    node = node[name];
  }
  if (isRecord(node)) delete node[parts[parts.length - 1] as string];
}

const wellFormed = (path: unknown): path is string =>
  typeof path === 'string' && path !== '' && names(path).every((n) => n);

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => sameJson(value, b[i]))
    );
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameJson(a[key], b[key]))
  );
}

const METHODS = ['post', 'put', 'patch'] as const;

/**
 * The `followUps` of a create's `x-crud`, each with its operation resolved:
 * undefined when the create declares none. Throws, with a reason, when the
 * declaration cannot be used (a missing field, a `create` other than
 * `include`/`omit`, an operation that is not exactly one `update` of the
 * same resource, a bind key or source this client cannot fill, a path
 * parameter neither bound nor carried from the create): a create that went
 * ahead without its follow-ups would silently drop a field.
 */
export function parseFollowUps(
  document: OpenApiDocument,
  crud: Record<string, unknown>,
  createPath: string,
): FollowUp[] | undefined {
  const raw = crud['followUps'];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || !raw.length)
    throw new Error('declares followUps that are not a nonempty array');
  const createVariables = new Set(
    [...createPath.matchAll(/\{([^}]+)\}/g)].map((m) => m[1] as string),
  );
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const where = `followUps[${index}]`;
    if (!isRecord(entry)) throw new Error(`${where} is not an object`);
    const { field, create, itemKey, operation, bind } = entry;
    if (!wellFormed(field)) throw new Error(`${where}.field is not a dot-path`);
    if (seen.has(field))
      throw new Error(`${where}: field ${field} has more than one follow-up`);
    seen.add(field);
    if (create !== 'include' && create !== 'omit')
      throw new Error(`${where}.create is neither include nor omit`);
    if (itemKey !== undefined && !wellFormed(itemKey))
      throw new Error(`${where}.itemKey is not a dot-path`);
    const found: {
      path: string;
      method: FollowUp['method'];
      op: Record<string, unknown>;
    }[] = [];
    for (const [path, item] of Object.entries(document.paths ?? {}))
      for (const method of METHODS) {
        const op = item?.[method] as Record<string, unknown> | undefined;
        if (isRecord(op) && op['operationId'] === operation)
          found.push({
            path,
            method: method.toUpperCase() as FollowUp['method'],
            op,
          });
      }
    if (found.length !== 1)
      throw new Error(
        `${where}.operation ${String(operation)} names ${found.length} operations, not one`,
      );
    const target = found[0]!;
    const targetCrud = target.op['x-crud'];
    if (
      !isRecord(targetCrud) ||
      targetCrud['action'] !== 'update' ||
      targetCrud['resource'] !== crud['resource']
    )
      throw new Error(
        `${where}.operation ${String(operation)} is not an update of ${String(crud['resource'])}`,
      );
    if (!isRecord(bind)) throw new Error(`${where}.bind is not an object`);
    const parsed: Record<string, BindSource> = {};
    const boundPath = new Set<string>();
    for (const [key, source] of Object.entries(bind)) {
      const [kind, ...rest] = key.split('.');
      const name = rest.join('.');
      if (
        key !== 'body' &&
        !(kind === 'body' && wellFormed(name)) &&
        !((kind === 'path' || kind === 'query' || kind === 'header') && name)
      )
        throw new Error(`${where}.bind.${key} is not a key this client fills`);
      if (kind === 'path') boundPath.add(name);
      if (
        !isRecord(source) ||
        (source['from'] !== 'created' &&
          source['from'] !== 'planned' &&
          source['from'] !== 'missing') ||
        !wellFormed(source['field'])
      )
        throw new Error(`${where}.bind.${key} is not {from, field}`);
      if (source['from'] === 'missing' && source['field'] !== field)
        throw new Error(
          `${where}.bind.${key}: from missing needs the follow-up's own field`,
        );
      parsed[key] = {
        from: source['from'],
        field: source['field'],
      };
    }
    if (
      Object.hasOwn(parsed, 'body') &&
      Object.keys(parsed).some((k) => k.startsWith('body.'))
    )
      throw new Error(`${where}.bind: body excludes body.<field> keys`);
    for (const variable of [...target.path.matchAll(/\{([^}]+)\}/g)].map(
      (m) => m[1] as string,
    ))
      if (!boundPath.has(variable) && !createVariables.has(variable))
        throw new Error(
          `${where}.bind: path parameter ${variable} is neither bound nor carried from the create`,
        );
    const parameters = (target.op['parameters'] ?? []) as ParameterObject[];
    for (const parameter of parameters)
      if (
        (parameter.in === 'query' || parameter.in === 'header') &&
        parameter.required &&
        !Object.hasOwn(parsed, `${parameter.in}.${parameter.name}`)
      )
        throw new Error(
          `${where}.bind: required ${parameter.in} parameter ${parameter.name} is not bound`,
        );
    return {
      field,
      create,
      ...(itemKey !== undefined ? { itemKey } : {}),
      operation: String(operation),
      path: target.path,
      method: target.method,
      bind: parsed,
    };
  });
}

/** The create body: without every `omit` field (§4.7.2 step 1). */
export function withoutOmitted(
  followUps: FollowUp[] | undefined,
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (!followUps?.some((f) => f.create === 'omit')) return body;
  const copy = structuredClone(body);
  for (const followUp of followUps)
    if (followUp.create === 'omit') dropAt(copy, followUp.field);
  return copy;
}

/**
 * §4.7.2 step 4: the part of the planned value the created object does not
 * show, or NOTHING_MISSING. For an array, the planned items whose value
 * (through `itemKey`) is not among the object's items; else the planned
 * value unless the object's equals it.
 */
export function missingValue(
  followUp: FollowUp,
  planned: unknown,
  created: unknown,
): unknown {
  const wanted = valueAt(planned, followUp.field);
  if (wanted === MISSING) return MISSING;
  const shown = valueAt(created, followUp.field);
  if (Array.isArray(wanted)) {
    const items = Array.isArray(shown) ? shown : [];
    const values = items.map((item) =>
      followUp.itemKey && isRecord(item)
        ? valueAt(item, followUp.itemKey)
        : item,
    );
    const rest = wanted.filter(
      (item) => !values.some((value) => sameJson(value, item)),
    );
    return rest.length ? rest : MISSING;
  }
  return shown !== MISSING && sameJson(shown, wanted) ? MISSING : wanted;
}

/**
 * The follow-up request filled by `bind` (§4.7.1): path parameters start
 * from the create's `context`. Undefined when a bound value resolves to
 * nothing: such a request is never sent (§4.7.2 step 4).
 */
export function followUpRequest(
  followUp: FollowUp,
  planned: unknown,
  created: unknown,
  missing: unknown,
  context: Record<string, string>,
): FollowUpRequest | undefined {
  const request: FollowUpRequest = {
    path: { ...context },
    query: {},
    header: {},
  };
  for (const [key, source] of Object.entries(followUp.bind)) {
    const value =
      source.from === 'missing'
        ? missing
        : valueAt(source.from === 'created' ? created : planned, source.field);
    if (value === MISSING) return undefined;
    const [kind, ...rest] = key.split('.');
    const name = rest.join('.');
    if (key === 'body') request.body = value;
    else if (kind === 'body') {
      if (!isRecord(request.body)) request.body = {};
      setAt(request.body as Record<string, unknown>, name, value);
    } else {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      request[kind as 'path' | 'query' | 'header'][name] = text;
    }
  }
  return request;
}
