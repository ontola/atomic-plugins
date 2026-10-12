// @wc-ignore-file
import { isRecord } from '../read/model.js';

/**
 * Write Preconditions 0.1.0-draft (`openapi-extensions/spec/write-preconditions/`):
 * the pure client logic, after the reference functions of the spec's
 * `validate.py` (`version_of`, `refusal_of`, `may_send`, `write_answer`,
 * `resolve_unknown`). Keep them in step: the tests mirror its
 * `ClientTests`. Values compare as JSON values, and an absent field equals
 * `null` (§4.5).
 */

/** A JSON scalar a Refusal Object or Body Condition compares with. */
export type Scalar = string | number | boolean | null;

/** A condition on one field: `values`, or `present: true`. */
export interface FieldPredicate {
  field: string;
  values?: Scalar[];
  present?: true;
}

/** §4.4 Refusal Object. */
export interface Refusal extends FieldPredicate {
  /** §4.4.1: read `field` from this resource's object instead. */
  source?: { resource: string };
  /** §4.4.1: refuse only a write whose request body also matches. */
  when?: FieldPredicate;
  description?: string;
}

/** §4.1 Write Precondition Object, with its defaults applied. */
export interface Precondition {
  kind: 'ifMatch' | 'readVerify' | 'none';
  /** §4.3: required for `ifMatch`. */
  version?: { in: 'header' | 'body'; name: string };
  /** `ifMatch`: the header that carries the version. Default `If-Match`. */
  header: string;
  /** `ifMatch`: statuses that mean a conflict. Default `[412]`. */
  conflictStatus: number[];
  refuseWhen: Refusal[];
  /** Explicit `idempotent`, when declared (the default depends on the method). */
  idempotent?: boolean;
}

const KINDS = new Set(['ifMatch', 'readVerify', 'none']);
const FIELDS = new Set([
  'kind',
  'version',
  'header',
  'conflictStatus',
  'refuseWhen',
  'idempotent',
  'description',
]);
const WRITES = new Set(['put', 'patch', 'post', 'delete']);
const VARIABLE = /\{([^{}]+)\}/g;

/** Keys of `value` outside `allowed` that are not `x-` extensions. */
function unknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string> | readonly string[],
): string[] {
  const known = new Set(allowed);
  return Object.keys(value).filter((k) => !known.has(k) && !k.startsWith('x-'));
}

function isScalar(v: unknown): v is Scalar {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean'
  );
}

/**
 * A field predicate (`_predicate` of the spec's validate.py): a nonempty
 * `field` and exactly one of a nonempty `values` array of JSON scalars and
 * `present: true`. A reason when it is not one.
 */
function predicate(
  value: Record<string, unknown>,
  label: string,
): FieldPredicate | string {
  if (typeof value['field'] !== 'string' || !value['field'])
    return `${label}.field: expected a nonempty string`;
  const values = value['values'];
  const present = value['present'];
  if ((values === undefined) === (present === undefined))
    return `${label}: exactly one of values and present`;
  if (present !== undefined)
    return present === true
      ? { field: value['field'], present: true }
      : `${label}.present: expected true`;
  if (!Array.isArray(values) || !values.length || !values.every(isScalar))
    return `${label}.values: expected a nonempty array of JSON scalars`;
  return { field: value['field'], values: values as Scalar[] };
}

/** Where a declaration sits, for the placement rules of §7 (all optional). */
export interface PreconditionPlace {
  /** The operation's method, any case. */
  method?: string;
  /** The operation object, for its `x-crud` action. */
  operation?: Record<string, unknown>;
  /** The document, for a source's `crudResources` entry. */
  document?: Record<string, unknown>;
  /** The operation's path template, for a source's identity variables. */
  path?: string;
}

function crudResources(
  document: Record<string, unknown>,
): Record<string, unknown> {
  const holder =
    'swagger' in document ? document : (document['components'] ?? {});
  const resources = isRecord(holder)
    ? holder['swagger' in document ? 'x-crudResources' : 'crudResources']
    : undefined;
  return isRecord(resources) ? resources : {};
}

function variables(template: string): Set<string> {
  return new Set([...template.matchAll(VARIABLE)].map((m) => m[1] as string));
}

/**
 * The operation's `x-write-precondition`, parsed, or a reason this client
 * cannot use it (`{ refused }`). Undefined when the operation declares
 * none. It refuses what the spec's `validate()` refuses (§7, `_check`):
 * unknown fields, an unknown `kind`, an `ifMatch` without a usable
 * `version`, a `header` or `conflictStatus` (unique integers 400-499) that
 * is not usable or not under `ifMatch`, a non-boolean `idempotent`, and a
 * Refusal Object or `when` it cannot read. With `place`, also the
 * placement rules: a write method, an `x-crud` action of update or delete,
 * or on a create only `kind: none` with source refusals and no
 * `idempotent`; a source naming a `crudResources` key whose identity
 * variables are path parameters of `place.path`. Nothing falls back to a
 * default on bad input: a write is never sent under a precondition other
 * than the one declared.
 */
export function parsePrecondition(
  declared: unknown,
  place: PreconditionPlace = {},
): Precondition | { refused: string } | undefined {
  if (declared === undefined) return undefined;
  const refuse = (reason: string): { refused: string } => ({
    refused: `x-write-precondition ${reason}`,
  });
  if (!isRecord(declared)) return refuse('is not an object');
  const unknown = unknownKeys(declared, FIELDS);
  if (unknown.length) return refuse(`has unknown fields ${unknown.join(', ')}`);
  if (place.method && !WRITES.has(place.method.toLowerCase()))
    return refuse('is only on PUT, PATCH, POST or DELETE');
  const crud = place.operation?.['x-crud'];
  const action = isRecord(crud) ? crud['action'] : undefined;
  const kind = declared['kind'];
  const rawRefusals = declared['refuseWhen'] ?? [];
  if (action === 'create') {
    if (
      kind !== 'none' ||
      !Array.isArray(rawRefusals) ||
      !rawRefusals.length ||
      !rawRefusals.every((r) => isRecord(r) && 'source' in r)
    )
      return refuse('on a create takes only kind none with source refusals');
    if ('idempotent' in declared)
      return refuse(
        'idempotent is not for a create (§4.5 does not cover creates)',
      );
  } else if (isRecord(crud) && action !== 'update' && action !== 'delete')
    return refuse(
      'is on an operation whose x-crud action is not update or delete',
    );
  if (typeof kind !== 'string' || !KINDS.has(kind))
    return refuse(`kind ${JSON.stringify(kind)} is not one this client knows`);
  let version: Precondition['version'];
  if (kind === 'ifMatch') {
    const raw = declared['version'];
    if (
      !isRecord(raw) ||
      (raw['in'] !== 'header' && raw['in'] !== 'body') ||
      typeof raw['name'] !== 'string' ||
      !raw['name'] ||
      unknownKeys(raw, ['in', 'name']).length
    )
      return refuse('ifMatch has no usable version');
    version = { in: raw['in'], name: raw['name'] };
    if (
      'header' in declared &&
      (typeof declared['header'] !== 'string' || !declared['header'])
    )
      return refuse('header is not a nonempty string');
    if ('conflictStatus' in declared) {
      const statuses = declared['conflictStatus'];
      if (
        !Array.isArray(statuses) ||
        !statuses.length ||
        new Set(statuses).size !== statuses.length ||
        !statuses.every(
          (s) =>
            Number.isInteger(s) && (s as number) >= 400 && (s as number) <= 499,
        )
      )
        return refuse('conflictStatus is not unique integers 400-499');
    }
  } else
    for (const field of ['version', 'header', 'conflictStatus'])
      if (field in declared) return refuse(`${field} is only for kind ifMatch`);
  if (!Array.isArray(rawRefusals)) return refuse('refuseWhen is not an array');
  const refuseWhen: Refusal[] = [];
  for (const [index, raw] of rawRefusals.entries()) {
    const label = `refuseWhen[${index}]`;
    if (!isRecord(raw)) return refuse(`${label} is not an object`);
    const own = predicate(raw, label);
    if (typeof own === 'string') return refuse(own);
    if (
      unknownKeys(raw, [
        'field',
        'values',
        'present',
        'source',
        'when',
        'description',
      ]).length
    )
      return refuse(`${label} has unknown fields`);
    const refusal: Refusal = { ...own };
    if (raw['source'] !== undefined) {
      const source = raw['source'];
      if (!isRecord(source) || typeof source['resource'] !== 'string')
        return refuse(`${label}.source is not one this client can read`);
      if (place.document) {
        const resource = crudResources(place.document)[source['resource']];
        if (!isRecord(resource))
          return refuse(`${label}.source.resource is not a crudResources key`);
        const identity = resource['identity'];
        const template =
          isRecord(identity) && typeof identity['urlTemplate'] === 'string'
            ? identity['urlTemplate']
            : '';
        if (place.path !== undefined) {
          const params = variables(place.path);
          const missing = [...variables(template)].filter(
            (v) => !params.has(v),
          );
          if (missing.length)
            return refuse(
              `${label}.source: identity variables ${missing.join(', ')} are not path parameters of ${place.path}`,
            );
        }
      }
      refusal.source = { resource: source['resource'] };
    }
    if (raw['when'] !== undefined) {
      const when = raw['when'];
      if (!isRecord(when)) return refuse(`${label}.when is not an object`);
      const parsed = predicate(when, `${label}.when`);
      if (typeof parsed === 'string') return refuse(parsed);
      if (unknownKeys(when, ['field', 'values', 'present']).length)
        return refuse(`${label}.when has unknown fields`);
      refusal.when = parsed;
    }
    if (typeof raw['description'] === 'string')
      refusal.description = raw['description'];
    refuseWhen.push(refusal);
  }
  if ('idempotent' in declared && typeof declared['idempotent'] !== 'boolean')
    return refuse('idempotent is not a boolean');
  return {
    kind: kind as Precondition['kind'],
    ...(version ? { version } : {}),
    header: (declared['header'] as string | undefined) ?? 'If-Match',
    conflictStatus: (declared['conflictStatus'] as number[] | undefined) ?? [
      412,
    ],
    refuseWhen,
    ...(typeof declared['idempotent'] === 'boolean'
      ? { idempotent: declared['idempotent'] }
      : {}),
  };
}

/** The value at a dot-path; an absent field reads as `null` (§4.5). */
export function fieldValue(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, key)) return null;
    current = current[key];
  }
  return current === undefined ? null : current;
}

/**
 * Same JSON value: numbers by value (1 equals 1.0), booleans only with
 * booleans, strings and `null` exactly, arrays and objects member by member
 * (object key order aside); `undefined` is `null`. As the spec says (an
 * absent field equals `null`), `{ a: null }` and `{}` are equal at any
 * depth, also inside nested objects, unlike Python's `==`.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  const x = a === undefined ? null : a;
  const y = b === undefined ? null : b;
  if (x === null || y === null) return x === y;
  if (typeof x !== typeof y) return false;
  if (typeof x !== 'object') return x === y;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length)
      return false;
    return x.every((item, at) => sameJson(item, y[at]));
  }
  const xr = x as Record<string, unknown>;
  const yr = y as Record<string, unknown>;
  const keys = new Set([...Object.keys(xr), ...Object.keys(yr)]);
  for (const key of keys) if (!sameJson(xr[key], yr[key])) return false;
  return true;
}

function header(
  headers: Record<string, string> | undefined,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers ?? {}))
    if (key.toLowerCase() === name.toLowerCase()) return value;
  return null;
}

/** §4.3: the object's version under `ifMatch`, from the read's body or headers. */
export function versionOf(
  declaration: Precondition,
  body: unknown,
  headers?: Record<string, string>,
): unknown {
  const version = declaration.version;
  if (!version) return null;
  return version.in === 'header'
    ? header(headers, version.name)
    : fieldValue(body, version.name);
}

function matches(condition: FieldPredicate, value: unknown): boolean {
  if (condition.present) return value !== null && value !== undefined;
  return (condition.values ?? []).some((v) => sameJson(value, v));
}

/**
 * §4.4: the first matching Refusal Object, as `refused` or, when its source
 * object could not be read, `source-unknown` (fail closed). `current` is the
 * write's object, `body` its request body (for `when`; undefined: no body),
 * `sources` the source objects by resource (`null`: could not be read).
 * With `checkSources: false`, Refusal Objects with a source are skipped, and
 * so is a `when` without a body (the §4.5 resolution read).
 */
export function refusalOf(
  declaration: Precondition,
  current: unknown,
  body?: unknown,
  sources?: Record<string, unknown>,
  checkSources = true,
): { refusal: Refusal; result: 'refused' | 'source-unknown' } | undefined {
  for (const refusal of declaration.refuseWhen) {
    if (refusal.when) {
      if (body === undefined && !checkSources) continue;
      // Without a body the condition cannot be ruled out: fail closed.
      if (
        body !== undefined &&
        !matches(refusal.when, fieldValue(body, refusal.when.field))
      )
        continue;
    }
    if (refusal.source) {
      if (!checkSources) continue;
      const source = sources?.[refusal.source.resource];
      if (source === null || source === undefined)
        return { refusal, result: 'source-unknown' };
      if (matches(refusal, fieldValue(source, refusal.field)))
        return { refusal, result: 'refused' };
    } else if (matches(refusal, fieldValue(current, refusal.field)))
      return { refusal, result: 'refused' };
  }
  return undefined;
}

export type MaySend =
  | { result: 'send'; headers: Record<string, string> }
  | { result: 'refused' | 'source-unknown'; refusal: Refusal }
  | { result: 'conflict'; fields: string[] }
  | { result: 'read-first' }
  | { result: 'unusable-version' };

/**
 * §4.2/§4.4: whether a write may be sent now. `baseline` maps fields to
 * their last read values, `written` lists the fields the write sets,
 * `current` is the object as just read (`readVerify`) or as last read, or
 * undefined (or `null`) when not read, `headers` that read's response headers. `body`
 * and `sources` as for `refusalOf`. `unusable-version`: an `ifMatch`
 * version that is neither a string nor a finite number. A delete (`action`) compares every
 * baseline field.
 */
export function maySend(
  declaration: Precondition,
  baseline: Record<string, unknown>,
  written: string[],
  current: unknown,
  headers?: Record<string, string>,
  body?: unknown,
  sources?: Record<string, unknown>,
  action: 'update' | 'delete' | 'create' = 'update',
): MaySend {
  const own = declaration.refuseWhen.filter((r) => !r.source);
  // Not read (undefined, or `null` from a caller): never compared as an
  // object whose fields are all null.
  if (
    (current === undefined || current === null) &&
    (declaration.kind === 'ifMatch' ||
      declaration.kind === 'readVerify' ||
      own.length)
  )
    return { result: 'read-first' };
  const found = refusalOf(declaration, current, body, sources);
  if (found) return { result: found.result, refusal: found.refusal };
  if (declaration.kind === 'ifMatch') {
    const value = versionOf(declaration, current, headers);
    if (value === null || value === undefined) return { result: 'read-first' };
    // Only a string or a finite number can be sent as a header value; an
    // object, array or boolean is refused, never sent as `[object Object]`.
    if (
      typeof value !== 'string' &&
      !(typeof value === 'number' && Number.isFinite(value))
    )
      return { result: 'unusable-version' };
    return { result: 'send', headers: { [declaration.header]: String(value) } };
  }
  if (declaration.kind === 'readVerify') {
    const compared = action === 'delete' ? Object.keys(baseline) : written;
    const changed = compared
      .filter((f) => !sameJson(fieldValue(current, f), baseline[f]))
      .sort();
    if (changed.length) return { result: 'conflict', fields: changed };
  }
  return { result: 'send', headers: {} };
}

/**
 * §4.5 "The write's own answer": a 404 or 410 to the write itself.
 * `applied` or `gone-unconfirmed` for a delete, `gone` for an update,
 * undefined for any other status. `gone` is the resource's stated
 * Collection Completeness 0.3.0 `gone`, which alone decides a 410.
 */
export function writeAnswer(
  action: 'update' | 'delete',
  status: number,
  deletionConfirmed = false,
  gone?: 'deleted' | 'unavailable',
): 'applied' | 'gone-unconfirmed' | 'gone' | undefined {
  if (status !== 404 && status !== 410) return undefined;
  if (action === 'delete') {
    const confirmed =
      status === 410 && gone !== undefined
        ? gone === 'deleted'
        : deletionConfirmed;
    return confirmed ? 'applied' : 'gone-unconfirmed';
  }
  return 'gone';
}

export type Resolution =
  | 'resend'
  | 'read-first'
  | 'applied'
  | 'not-applied'
  | 'conflict'
  | 'refused'
  | 'gone'
  | 'gone-unconfirmed'
  | 'unknown';

/**
 * §4.5 after an unknown outcome. Only a known update or delete is resolved:
 * by `action` (the operation's `x-crud`), else by a PUT, PATCH or DELETE
 * method; anything else is `unknown`, never resent. `written` maps fields
 * to the values the write set (empty for a delete); `baseline` maps fields
 * to their last read values (for a delete, every field held); `read` is
 * undefined (not read yet) or the read's status, body and headers;
 * `sentVersion` the version an `ifMatch` write sent. `deletionConfirmed`,
 * `tombstone` (the resource's `x-read-tombstone`) and `gone` as in the
 * spec.
 */
export function resolveUnknown(
  declaration: Precondition,
  method: string,
  baseline: Record<string, unknown>,
  written: Record<string, unknown>,
  read?: { status: number; body: unknown; headers?: Record<string, string> },
  sentVersion?: unknown,
  action?: 'update' | 'delete' | 'create',
  deletionConfirmed = false,
  tombstone?: { field: string; values: unknown[] },
  gone?: 'deleted' | 'unavailable',
): Resolution {
  const verb = method.toLowerCase();
  const known =
    action ??
    ({ put: 'update', patch: 'update', delete: 'delete' } as const)[
      verb as 'put' | 'patch' | 'delete'
    ];
  if (known !== 'update' && known !== 'delete') return 'unknown';
  const idempotent =
    declaration.idempotent ?? (verb === 'put' || verb === 'delete');
  if (read === undefined)
    return declaration.kind !== 'readVerify' && idempotent
      ? 'resend'
      : 'read-first';
  const { status, body, headers } = read;
  const answer = writeAnswer(known, status, deletionConfirmed, gone);
  if (answer) return answer; // rule 1
  if (!(status >= 200 && status < 300) || !isRecord(body)) return 'unknown'; // rule 7
  if (
    tombstone &&
    tombstone.values.some((v) => sameJson(fieldValue(body, tombstone.field), v))
  )
    return known === 'delete' ? 'applied' : 'gone'; // rule 2
  if (known !== 'delete') {
    const fields = Object.entries(written);
    if (!fields.length) return 'unknown';
    if (fields.every(([f, v]) => sameJson(fieldValue(body, f), v)))
      return 'applied'; // rule 3
  }
  if (refusalOf(declaration, body, undefined, undefined, false))
    return 'refused'; // rule 4
  if (declaration.kind === 'ifMatch' && sentVersion !== undefined)
    // rule 5
    return sameJson(versionOf(declaration, body, headers), sentVersion)
      ? 'not-applied'
      : 'conflict';
  const compared =
    known === 'delete' ? Object.keys(baseline) : Object.keys(written);
  if (!compared.length || compared.some((f) => !Object.hasOwn(baseline, f)))
    return 'unknown'; // rule 6 needs a baseline for every compared field
  return compared.every((f) => sameJson(fieldValue(body, f), baseline[f]))
    ? 'not-applied'
    : 'conflict';
}
