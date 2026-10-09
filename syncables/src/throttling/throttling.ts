// @wc-ignore-file
/**
 * The consumer side of the OpenAPI Throttling Extension 0.2.0-draft
 * (`openapi-extensions/spec/throttling/README.md`): the root `x-throttling`
 * object's `headers` (header roles), `signals` (which responses mean
 * throttling) and the earliest retry time, after `classify()` in that
 * folder's `validate.py`. `limits` and `applies` are read only for the
 * bucket a `quotaExhausted` signal names (its window is the floor when no
 * time is given) and for which buckets an operation selects. Pacing against
 * the announced quotas is not implemented.
 */
import type { OpenApiDocument, OperationObject } from '../openapi/types.js';
import { isRecord } from '../read/model.js';

export type HeaderRole =
  | 'limit'
  | 'remaining'
  | 'used'
  | 'reset'
  | 'retryAfter';
export type TimeUnit =
  | 'epochSeconds'
  | 'deltaSeconds'
  | 'httpDate'
  | 'deltaSecondsOrHttpDate';

/** Header Role Object: what a response header reports. */
export interface HeaderRoleObject {
  role: HeaderRole;
  /** Required for `reset` and `retryAfter`, absent otherwise. */
  unit?: TimeUnit;
  description?: string;
}

export type JsonScalar = string | number | boolean | null;

/** Header Predicate: a condition on one response header (name case-insensitive). */
export type HeaderPredicate = { name: string } & (
  | { equals: string }
  | { in: string[] }
  | { present: true }
);

/** Body Predicate: a condition on the JSON body at a JSON Pointer (RFC 6901). */
export type BodyPredicate = { pointer: string } & (
  | { equals: JsonScalar }
  | { in: JsonScalar[] }
  | { contains: string }
  | { present: true }
  | { item: BodyPredicate }
);

export type ThrottlingMeaning = 'throttled' | 'quotaExhausted';

/** Signal Object: a response the API documents as a rate-limit refusal. */
export interface SignalObject {
  status: number[];
  header?: HeaderPredicate;
  body?: BodyPredicate;
  meaning: ThrottlingMeaning;
  /** The `limits` bucket the response reports exhausted. */
  bucket?: string;
  /** The delay the API asks for when the response carries no time. */
  minDelaySeconds?: number;
  description?: string;
}

/** The parsed root `x-throttling` object, as this consumer reads it. */
export interface ThrottlingDeclaration {
  /** `limits[<bucket>].window.seconds`, per bucket identifier. */
  windows: Map<string, number>;
  /** The default bucket selection (`applies`). */
  applies: string[];
  /** Header Role Objects by lower-cased header name. */
  headers: Map<string, HeaderRoleObject>;
  /**
   * The Signal Objects, in order. Absent when the document declares none:
   * only a 429 is then throttling, and this extension says nothing about
   * other responses.
   */
  signals?: SignalObject[];
}

/** What a response means under the declaration. */
export interface ThrottlingVerdict {
  meaning: ThrottlingMeaning;
  /** The exhausted bucket, when the matching signal names one. */
  bucket?: string;
  /**
   * The earliest time to send the request again (or any request counted
   * against the exhausted bucket), in milliseconds since the epoch. Absent
   * when no header or declared delay gives one: the consumer's own backoff
   * applies.
   */
  retryAt?: number;
  /** The Signal Object that matched; absent for a 429 no signal matched. */
  signal?: SignalObject;
}

/** A response, as `classifyThrottling` sees it. */
export interface ThrottlingResponse {
  status: number;
  /** Header names in any case; a repeated header's values joined as the transport gives them. */
  headers: Record<string, string>;
  /** The response body text; a body that is not JSON matches no Body Predicate. */
  body?: string;
  /** When the response was received, in milliseconds since the epoch. Default: now. */
  receivedAt?: number;
}

const ROLES = new Set<string>([
  'limit',
  'remaining',
  'used',
  'reset',
  'retryAfter',
]);
const TIMED_ROLES = new Set<string>(['reset', 'retryAfter']);
const UNITS = new Set<string>([
  'epochSeconds',
  'deltaSeconds',
  'httpDate',
  'deltaSecondsOrHttpDate',
]);
const MEANINGS = new Set<string>(['throttled', 'quotaExhausted']);

const isScalar = (value: unknown): value is JsonScalar =>
  value === null ||
  typeof value === 'string' ||
  typeof value === 'number' ||
  typeof value === 'boolean';

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Reads the document's root `x-throttling`. Undefined when absent or not an
 * object. A `headers` entry that does not parse (an unknown role, a missing
 * or misplaced unit, a role or a name already taken) is left out. The
 * `signals` array is left out as a whole when any Signal Object does not
 * parse, since the objects are tested in order and a gap would change the
 * meaning of the rest; a 429 then stays throttling and nothing else does.
 */
export function declaredThrottling(
  document: OpenApiDocument,
): ThrottlingDeclaration | undefined {
  const root = (document as Record<string, unknown>)['x-throttling'];
  if (!isRecord(root)) return undefined;
  const windows = new Map<string, number>();
  if (isRecord(root['limits']))
    for (const [name, limit] of Object.entries(root['limits'])) {
      const window = isRecord(limit) ? limit['window'] : undefined;
      const seconds = isRecord(window) ? window['seconds'] : undefined;
      if (isPositiveInteger(seconds)) windows.set(name, seconds);
    }
  const applies = Array.isArray(root['applies'])
    ? root['applies'].filter((b): b is string => typeof b === 'string')
    : [];
  const headers = new Map<string, HeaderRoleObject>();
  const rolesSeen = new Set<string>();
  if (isRecord(root['headers']))
    for (const [name, value] of Object.entries(root['headers'])) {
      const key = name.toLowerCase();
      if (!isRecord(value) || headers.has(key)) continue;
      const { role, unit, description } = value;
      if (typeof role !== 'string' || !ROLES.has(role) || rolesSeen.has(role))
        continue;
      if (TIMED_ROLES.has(role)) {
        if (typeof unit !== 'string' || !UNITS.has(unit)) continue;
      } else if (unit !== undefined) continue;
      rolesSeen.add(role);
      headers.set(key, {
        role: role as HeaderRole,
        ...(typeof unit === 'string' ? { unit: unit as TimeUnit } : {}),
        ...(typeof description === 'string' ? { description } : {}),
      });
    }
  const declaration: ThrottlingDeclaration = { windows, applies, headers };
  if (Array.isArray(root['signals']) && root['signals'].length) {
    const signals = root['signals'].map(parseSignal);
    if (signals.every((s) => s !== undefined))
      declaration.signals = signals as SignalObject[];
  }
  return declaration;
}

function parseSignal(value: unknown): SignalObject | undefined {
  if (!isRecord(value)) return undefined;
  const {
    status,
    header,
    body,
    meaning,
    bucket,
    minDelaySeconds,
    description,
  } = value;
  if (
    !Array.isArray(status) ||
    !status.length ||
    !status.every(
      (s) =>
        Number.isInteger(s) && (s as number) >= 100 && (s as number) <= 599,
    )
  )
    return undefined;
  if (typeof meaning !== 'string' || !MEANINGS.has(meaning)) return undefined;
  const signal: SignalObject = {
    status: [...(status as number[])],
    meaning: meaning as ThrottlingMeaning,
  };
  if (header !== undefined) {
    const parsed = parseHeaderPredicate(header);
    if (!parsed) return undefined;
    signal.header = parsed;
  }
  if (body !== undefined) {
    const parsed = parseBodyPredicate(body);
    if (!parsed) return undefined;
    signal.body = parsed;
  }
  if (bucket !== undefined) {
    if (typeof bucket !== 'string') return undefined;
    signal.bucket = bucket;
  }
  if (minDelaySeconds !== undefined) {
    if (!isPositiveInteger(minDelaySeconds)) return undefined;
    signal.minDelaySeconds = minDelaySeconds;
  }
  if (typeof description === 'string') signal.description = description;
  return signal;
}

/** Exactly one of the operator keys, as the spec requires. */
function oneOperator(
  value: Record<string, unknown>,
  operators: string[],
): string | undefined {
  const present = operators.filter((op) => value[op] !== undefined);
  return present.length === 1 ? present[0] : undefined;
}

function parseHeaderPredicate(value: unknown): HeaderPredicate | undefined {
  if (!isRecord(value) || typeof value['name'] !== 'string') return undefined;
  const name = value['name'];
  switch (oneOperator(value, ['equals', 'in', 'present'])) {
    case 'equals':
      return typeof value['equals'] === 'string'
        ? { name, equals: value['equals'] }
        : undefined;
    case 'in': {
      const list = value['in'];
      return Array.isArray(list) &&
        list.length &&
        list.every((v) => typeof v === 'string')
        ? { name, in: [...(list as string[])] }
        : undefined;
    }
    case 'present':
      return value['present'] === true ? { name, present: true } : undefined;
    default:
      return undefined;
  }
}

/** A JSON Pointer: empty, or `/`-separated tokens with only `~0` and `~1` escapes. */
const POINTER = /^(\/([^~/]|~[01])*)*$/;

function parseBodyPredicate(value: unknown): BodyPredicate | undefined {
  if (!isRecord(value) || typeof value['pointer'] !== 'string')
    return undefined;
  const pointer = value['pointer'];
  if (!POINTER.test(pointer)) return undefined;
  switch (oneOperator(value, ['equals', 'in', 'contains', 'present', 'item'])) {
    case 'equals':
      return isScalar(value['equals'])
        ? { pointer, equals: value['equals'] }
        : undefined;
    case 'in': {
      const list = value['in'];
      return Array.isArray(list) && list.length && list.every(isScalar)
        ? { pointer, in: [...(list as JsonScalar[])] }
        : undefined;
    }
    case 'contains':
      return typeof value['contains'] === 'string'
        ? { pointer, contains: value['contains'] }
        : undefined;
    case 'present':
      return value['present'] === true ? { pointer, present: true } : undefined;
    case 'item': {
      const item = parseBodyPredicate(value['item']);
      return item ? { pointer, item } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The buckets an operation's requests count against: its own `x-throttling`
 * array when present (it replaces the default list in full), else the
 * root's `applies`.
 */
export function operationBuckets(
  declaration: ThrottlingDeclaration,
  operation: OperationObject | undefined,
): string[] {
  const own = operation?.['x-throttling'];
  if (Array.isArray(own))
    return own.filter((b): b is string => typeof b === 'string');
  return declaration.applies;
}

const MISSING = Symbol('missing');

/** The value at a JSON Pointer (RFC 6901), or MISSING. */
function resolvePointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  let node: unknown = value;
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (isRecord(node) && Object.prototype.hasOwnProperty.call(node, token)) {
      node = node[token];
    } else if (
      Array.isArray(node) &&
      /^(0|[1-9][0-9]*)$/.test(token) &&
      Number(token) < node.length
    ) {
      node = node[Number(token)];
    } else {
      return MISSING;
    }
  }
  return node;
}

/** JSON equality of scalars: `"0"` is not `0`, and `true` is not `1`. */
const jsonEqual = (a: unknown, b: JsonScalar): boolean =>
  a === b || (typeof a === 'number' && typeof b === 'number' && a === b);

function bodyMatches(predicate: BodyPredicate, body: unknown): boolean {
  const value = resolvePointer(body, predicate.pointer);
  if (value === MISSING) return false;
  if ('present' in predicate) return true;
  if ('equals' in predicate) return jsonEqual(value, predicate.equals);
  if ('in' in predicate) return predicate.in.some((v) => jsonEqual(value, v));
  if ('contains' in predicate)
    return (
      typeof value === 'string' &&
      value.toLowerCase().includes(predicate.contains.toLowerCase())
    );
  return (
    Array.isArray(value) &&
    value.some((element) => bodyMatches(predicate.item, element))
  );
}

/** The stripped value of one header, by case-insensitive name. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === key)
      return typeof v === 'string' ? v.trim() : undefined;
  return undefined;
}

function headerMatches(
  predicate: HeaderPredicate,
  headers: Record<string, string>,
): boolean {
  const value = headerValue(headers, predicate.name);
  if (value === undefined) return false;
  if ('present' in predicate) return true;
  if ('equals' in predicate) return value === predicate.equals;
  return predicate.in.includes(value);
}

/** A non-negative decimal integer the consumer can represent exactly; else undefined. */
function integer(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * An HTTP-date (RFC 9110 §5.6.7) in milliseconds since the epoch. The
 * obsolete asctime form has no zone and is read as GMT. A value without a
 * letter is not a date (`Date.parse('120')` would be a year).
 */
function httpDate(value: string): number | undefined {
  if (!/[a-zA-Z]/.test(value)) return undefined;
  const zoned = /(GMT|UTC|UT|[+-][0-9]{2}:?[0-9]{2})\s*$/i.test(value);
  const ms = Date.parse(zoned ? value : `${value} GMT`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * The time a header's value names, in milliseconds since the epoch, under
 * its declared unit; undefined when the value does not parse in that
 * encoding (no other unit is guessed). An absolute time is measured twice,
 * against the consumer's clock and as the same offset from the response's
 * `Date` header applied to `receivedAt`; the later of the two counts, so
 * neither a wrong local clock nor a wrong `Date` can make it earlier.
 */
export function headerTime(
  value: string,
  unit: TimeUnit,
  receivedAt: number,
  dateHeader?: string,
): number | undefined {
  if (unit === 'deltaSeconds' || unit === 'deltaSecondsOrHttpDate') {
    const delta = integer(value);
    if (delta !== undefined) return receivedAt + delta * 1000;
    if (unit === 'deltaSeconds') return undefined;
  }
  let absolute: number | undefined;
  if (unit === 'epochSeconds') {
    const seconds = integer(value);
    absolute = seconds === undefined ? undefined : seconds * 1000;
  } else {
    absolute = httpDate(value);
  }
  if (absolute === undefined) return undefined;
  const serverNow = dateHeader === undefined ? undefined : httpDate(dateHeader);
  return serverNow === undefined
    ? absolute
    : Math.max(absolute, receivedAt + (absolute - serverNow));
}

/**
 * The standard `Retry-After` header as RFC 9110 §10.2.3 defines it, used
 * when the document declares no `retryAfter` role: this extension does not
 * replace the ordinary header, and the client honoured it before the
 * extension existed.
 */
const STANDARD_RETRY_AFTER: HeaderRoleObject = {
  role: 'retryAfter',
  unit: 'deltaSecondsOrHttpDate',
};

/**
 * Classifies one response under the declaration (§"Throttling signals").
 * The first Signal Object whose status list holds the response's status and
 * whose predicates match decides; without one, a 429 is `throttled` (with
 * or without a declaration, with or without `signals`) and any other
 * response is not throttling. The verdict's `retryAt` is the earliest retry
 * time: the later of the `retryAfter` time and, for `quotaExhausted` or a
 * `remaining` of `0`, the `reset` time; else the response time plus the
 * signal's `minDelaySeconds`; else, for `quotaExhausted` with a bucket
 * whose window is declared, plus that window; else absent (the consumer's
 * backoff). A declared header whose value does not parse is ignored.
 */
export function classifyThrottling(
  declaration: ThrottlingDeclaration | undefined,
  response: ThrottlingResponse,
): ThrottlingVerdict | undefined {
  const receivedAt = response.receivedAt ?? Date.now();
  const headers = response.headers;
  let body: unknown = MISSING;
  const parsedBody = (): unknown => {
    if (body === MISSING) {
      try {
        body =
          response.body === undefined ? undefined : JSON.parse(response.body);
      } catch {
        body = undefined;
      }
    }
    return body;
  };
  let signal: SignalObject | undefined;
  for (const candidate of declaration?.signals ?? []) {
    if (!candidate.status.includes(response.status)) continue;
    if (candidate.header && !headerMatches(candidate.header, headers)) continue;
    if (candidate.body) {
      const json = parsedBody();
      if (json === undefined || !bodyMatches(candidate.body, json)) continue;
    }
    signal = candidate;
    break;
  }
  if (!signal && response.status !== 429) return undefined;
  const meaning: ThrottlingMeaning = signal?.meaning ?? 'throttled';
  const roles = new Map<HeaderRole, { value: string; unit?: TimeUnit }>();
  const declared = declaration?.headers ?? new Map<string, HeaderRoleObject>();
  for (const [name, header] of declared) {
    const value = headerValue(headers, name);
    if (value === undefined) continue;
    const entry: { value: string; unit?: TimeUnit } = { value };
    if (header.unit) entry.unit = header.unit;
    roles.set(header.role, entry);
  }
  if (![...declared.values()].some((h) => h.role === 'retryAfter')) {
    const value = headerValue(headers, 'retry-after');
    if (value !== undefined)
      roles.set('retryAfter', {
        value,
        unit: STANDARD_RETRY_AFTER.unit as TimeUnit,
      });
  }
  const dateHeader = headerValue(headers, 'date');
  const times: number[] = [];
  const retryAfter = roles.get('retryAfter');
  if (retryAfter?.unit) {
    const t = headerTime(
      retryAfter.value,
      retryAfter.unit,
      receivedAt,
      dateHeader,
    );
    if (t !== undefined) times.push(t);
  }
  const remaining = roles.get('remaining');
  const exhausted =
    meaning === 'quotaExhausted' ||
    (remaining !== undefined && integer(remaining.value) === 0);
  const reset = roles.get('reset');
  if (exhausted && reset?.unit) {
    const t = headerTime(reset.value, reset.unit, receivedAt, dateHeader);
    if (t !== undefined) times.push(t);
  }
  const verdict: ThrottlingVerdict = { meaning };
  if (signal) verdict.signal = signal;
  if (signal?.bucket !== undefined) verdict.bucket = signal.bucket;
  if (times.length) verdict.retryAt = Math.max(...times);
  else if (signal?.minDelaySeconds !== undefined)
    verdict.retryAt = receivedAt + signal.minDelaySeconds * 1000;
  else if (meaning === 'quotaExhausted' && signal?.bucket !== undefined) {
    const window = declaration?.windows.get(signal.bucket);
    if (window !== undefined) verdict.retryAt = receivedAt + window * 1000;
  }
  return verdict;
}
