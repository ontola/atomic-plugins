// @wc-ignore-file
/**
 * The consumer side of the OpenAPI Throttling Extension 0.4.0-draft
 * (`openapi-extensions/spec/throttling/README.md`): the root `x-throttling`
 * object's `headers` (header roles), `bodyFields` (the same roles read from
 * the JSON response body, since 0.3.0), `signals` (which responses mean
 * throttling, or, since 0.4.0, a `blocked` refusal not worth retrying) and
 * the earliest retry time, after `classify()` in that
 * folder's `validate.py`. `limits` and `applies` are read only for the
 * bucket a `quotaExhausted` signal names (its window is the fallback when no
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

/**
 * `blocked` (0.4.0): a refusal the API documents as not worth retrying. It
 * is not throttling: no retry time, never resent automatically. A signal
 * whose meaning this consumer does not recognise is read as `blocked`.
 */
export type ThrottlingMeaning = 'throttled' | 'quotaExhausted' | 'blocked';

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
   * Header Role Objects by JSON body dot-path (`bodyFields`, 0.3.0): the
   * path's property names, matched literally and case-sensitively.
   */
  bodyFields: Map<string, HeaderRoleObject>;
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
const MEANINGS = new Set<string>(['throttled', 'quotaExhausted', 'blocked']);

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
  const headers = roleMap(root['headers'], (name) => name.toLowerCase());
  // A dot-path is one or more nonempty property names joined by `.`
  // (`a..b`, `.a` and `a.` are invalid and left out).
  const bodyFields = roleMap(root['bodyFields'], (path) =>
    path.split('.').every((name) => name !== '') ? path : undefined,
  );
  const declaration: ThrottlingDeclaration = {
    windows,
    applies,
    headers,
    bodyFields,
  };
  if (Array.isArray(root['signals']) && root['signals'].length) {
    const signals = root['signals'].map(parseSignal);
    if (signals.every((s) => s !== undefined))
      declaration.signals = signals as SignalObject[];
  }
  return declaration;
}

/**
 * A map of Header Role Objects (`headers` or `bodyFields`) by the key
 * `keyOf` gives. An entry that does not parse (an unknown role, a missing
 * or misplaced unit, a role or a key already taken in this map, a key
 * `keyOf` refuses) is left out.
 */
function roleMap(
  value: unknown,
  keyOf: (name: string) => string | undefined,
): Map<string, HeaderRoleObject> {
  const out = new Map<string, HeaderRoleObject>();
  const rolesSeen = new Set<string>();
  if (!isRecord(value)) return out;
  for (const [name, entry] of Object.entries(value)) {
    const key = keyOf(name);
    if (key === undefined || !isRecord(entry) || out.has(key)) continue;
    const { role, unit, description } = entry;
    if (typeof role !== 'string' || !ROLES.has(role) || rolesSeen.has(role))
      continue;
    if (TIMED_ROLES.has(role)) {
      if (typeof unit !== 'string' || !UNITS.has(unit)) continue;
    } else if (unit !== undefined) continue;
    rolesSeen.add(role);
    out.set(key, {
      role: role as HeaderRole,
      ...(typeof unit === 'string' ? { unit: unit as TimeUnit } : {}),
      ...(typeof description === 'string' ? { description } : {}),
    });
  }
  return out;
}

/**
 * Removes leading and trailing space, tab, CR and LF only: other
 * characters (U+00A0 among them, which `String.prototype.trim` would strip)
 * are kept, so a value carrying them does not parse.
 */
function strip(value: string): string {
  return value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
}

/**
 * A body field's value as text (§"Response body fields"): a string with
 * surrounding space, tab, CR and LF removed; a number with no fractional
 * part, up to 2^53 − 1, as its decimal form (`3.0` reads as `3`; `1e21` and
 * other larger integral numbers do not parse); undefined for any other
 * number, a boolean, `null`, an array, an object, or a path that does not
 * resolve. The path's names are read literally, own properties only.
 */
function bodyText(body: unknown, path: string): string | undefined {
  let node = body;
  for (const name of path.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, name)) return undefined;
    node = node[name];
  }
  if (typeof node === 'string') return strip(node);
  if (typeof node === 'number' && Number.isSafeInteger(node))
    return String(node);
  return undefined;
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
  // 0.4.0: a meaning this consumer does not recognise is read as blocked,
  // so it never resends on a meaning it cannot read.
  if (typeof meaning !== 'string' || meaning === '') return undefined;
  const signal: SignalObject = {
    status: [...(status as number[])],
    meaning: MEANINGS.has(meaning) ? (meaning as ThrottlingMeaning) : 'blocked',
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
  // blocked takes no bucket and no delay: it is not counted.
  if (
    signal.meaning === 'blocked' &&
    (signal.bucket !== undefined || signal.minDelaySeconds !== undefined)
  )
    return undefined;
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

/** The value of one header, by case-insensitive name, with surrounding space, tab, CR and LF removed. */
function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const key = name.toLowerCase();
  for (const [k, v] of Object.entries(headers))
    if (k.toLowerCase() === key)
      return typeof v === 'string' ? strip(v) : undefined;
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

/**
 * A non-negative decimal integer up to 2^53 − 1; else undefined (a longer
 * one, such as a 400-digit `Retry-After`, does not parse).
 */
function integer(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTH = MONTHS.join('|');
const DAY = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const LONG_DAY = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const IMF_FIXDATE = new RegExp(
  `^(?:${DAY}), (\\d{2}) (${MONTH}) (\\d{4}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const RFC850_DATE = new RegExp(
  `^(?:${LONG_DAY}), (\\d{2})-(${MONTH})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) GMT$`,
);
const ASCTIME_DATE = new RegExp(
  `^(?:${DAY}) (${MONTH}) ( \\d|\\d{2}) (\\d{2}):(\\d{2}):(\\d{2}) (\\d{4})$`,
);

/**
 * An HTTP-date (RFC 9110 §5.6.7) in milliseconds since the epoch, in one of
 * its three exact forms: IMF-fixdate (`Sun, 06 Nov 1994 08:49:37 GMT`), the
 * obsolete RFC 850 form (a two-digit year more than 50 years ahead is read
 * as the previous century) or asctime (no zone: GMT). Anything else, a
 * value carrying U+00A0, a byte-order mark or another character the form
 * does not have included, does not parse; no lenient `Date.parse` reading.
 */
export function parseHttpDate(value: string): number | undefined {
  let day: string, month: string, year: number;
  let hour: string, minute: string, second: string;
  let twoDigitYear = false;
  let match = IMF_FIXDATE.exec(value);
  if (match) {
    [, day, month, , hour, minute, second] = match as unknown as string[];
    year = Number(match[3]);
  } else if ((match = RFC850_DATE.exec(value))) {
    [, day, month, , hour, minute, second] = match as unknown as string[];
    year = Number(match[3]);
    twoDigitYear = true;
  } else if ((match = ASCTIME_DATE.exec(value))) {
    [, month, day, hour, minute, second] = match as unknown as string[];
    year = Number(match[6]);
  } else return undefined;
  const m = MONTHS.indexOf(month!);
  const d = Number(day!.trim());
  const [h, min, sec] = [Number(hour!), Number(minute!), Number(second!)];
  if (h > 23 || min > 59 || sec > 60) return undefined;
  const time = ((h * 60 + min) * 60 + sec) * 1000;
  if (twoDigitYear) {
    // RFC 9110 §5.6.7: a date that appears more than 50 years in the
    // future is the most recent past year with the same last two digits;
    // full dates are compared, not only years.
    const now = new Date();
    const century = Math.floor(now.getUTCFullYear() / 100) * 100;
    const limit = new Date(now.getTime());
    limit.setUTCFullYear(now.getUTCFullYear() + 50);
    let start = utcDay(century + year, m, d);
    if (start === undefined) return undefined;
    if (start + time > limit.getTime())
      start = utcDay(century + year - 100, m, d);
    return start === undefined ? undefined : start + time;
  }
  const start = utcDay(year, m, d);
  return start === undefined ? undefined : start + time;
}

/**
 * Midnight UTC of a calendar day, in milliseconds since the epoch; undefined
 * for a day the month does not have (31 Feb). The day is checked before the
 * time is added, so `23:59:60` (a leap second) still names that day, and
 * `setUTCFullYear` keeps a year below 100 as written (`Date.UTC` would add
 * 1900).
 */
function utcDay(year: number, month: number, day: number): number | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day
  )
    return undefined;
  return date.getTime();
}

const httpDate = parseHttpDate;

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

/** One value of a role, as text, from a header or (`body`) a body field. */
interface RoleValue {
  value: string;
  unit: TimeUnit | undefined;
  body: boolean;
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
  // 0.4.0: a blocked refusal is not throttling, even as a 429: no retry
  // time, and the caller must not resend it by itself.
  if (signal?.meaning === 'blocked') return { meaning: 'blocked', signal };
  const meaning: ThrottlingMeaning = signal?.meaning ?? 'throttled';
  // Each role's values: from its header, then from its body field (0.3.0).
  // A role read from both counts once: the later time for retryAfter and
  // reset, exhausted when either remaining is 0.
  const roles = new Map<HeaderRole, RoleValue[]>();
  const add = (role: HeaderRole, entry: RoleValue): void => {
    roles.set(role, [...(roles.get(role) ?? []), entry]);
  };
  const declared = declaration?.headers ?? new Map<string, HeaderRoleObject>();
  for (const [name, header] of declared) {
    const value = headerValue(headers, name);
    if (value === undefined) continue;
    add(header.role, { value, unit: header.unit, body: false });
  }
  if (![...declared.values()].some((h) => h.role === 'retryAfter')) {
    const value = headerValue(headers, 'retry-after');
    if (value !== undefined)
      add('retryAfter', {
        value,
        unit: STANDARD_RETRY_AFTER.unit,
        body: false,
      });
  }
  // Body fields are read only from a throttling response with a JSON body.
  if (declaration?.bodyFields.size) {
    const json = parsedBody();
    for (const [path, field] of declaration.bodyFields) {
      const value = bodyText(json, path);
      if (value === undefined) continue;
      add(field.role, { value, unit: field.unit, body: true });
    }
  }
  const dateHeader = headerValue(headers, 'date');
  /**
   * The times one role's values name. A body field that gives no wait (a
   * delay of 0, or a time not after the response) counts as absent, so the
   * fallbacks below still apply.
   */
  const timed = (role: HeaderRole): number[] =>
    (roles.get(role) ?? []).flatMap(({ value, unit, body }) => {
      if (!unit) return [];
      const t = headerTime(value, unit, receivedAt, dateHeader);
      if (t === undefined || (body && t <= receivedAt)) return [];
      return [t];
    });
  const times = timed('retryAfter');
  const exhausted =
    meaning === 'quotaExhausted' ||
    (roles.get('remaining') ?? []).some(({ value }) => integer(value) === 0);
  if (exhausted) times.push(...timed('reset'));
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
