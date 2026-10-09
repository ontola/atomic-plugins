// @wc-ignore-file
import type {
  OpenApiDocument,
  OperationObject,
  ParameterObject,
} from '../openapi/types.js';
import { isRecord } from './model.js';

/**
 * Filtering 0.2.0-draft `x-time-zone` (Parameter time zones): a date-time
 * query parameter the API reads as wall-clock time in a zone the request
 * does not carry. These helpers mirror `wall_clock_param`, `instants_of`
 * and `covered_span` in the spec folder's `validate.py`, with `Intl` for
 * the zone data (no dependency): its accuracy is the runtime's time zone
 * database.
 */

export type Ambiguous = 'unspecified' | 'earlier' | 'later';

export interface TimeZoneDeclaration {
  /** The zone: a fixed IANA name, or the operation and pointer that answer it. */
  zone: { name: string } | { operationId: string; pointer: string };
  /** Appended to the wall-clock digits; `''` when the declaration has none. */
  suffix: string;
  ambiguous: Ambiguous;
}

/** A parameter that declares `x-time-zone`, with its `x-filter` bound role. */
export interface TimeZoneParameter {
  name: string;
  declaration: TimeZoneDeclaration;
  /**
   * From the parameter's `x-filter` operator: `lower` for `gte`/`gt`,
   * `upper` for `lte`/`lt`, else undefined (no range predicate declared).
   */
  bound?: 'lower' | 'upper';
  /** `gte`/`lte`: the bound itself is included. */
  inclusive?: boolean;
  /** The `x-filter` field (a JSON Pointer into an item) the bound compares. */
  field?: string;
}

/** A UTC span a read is known to cover; an absent end is open. */
export interface CoveredSpan {
  /** ISO 8601 UTC instant (`...Z`), from the lower-bound parameters. */
  from?: string;
  /** ISO 8601 UTC instant (`...Z`), from the upper-bound parameters. */
  to?: string;
}

/**
 * The UTC span one item field is bounded to by a read's `x-time-zone`
 * parameters: their `x-filter` field, the ends, and whether each end is
 * included (`gte`/`lte`) or not (`gt`/`lt`). An absent end is open.
 */
export interface FieldSpan {
  field: string;
  from?: string;
  fromInclusive?: boolean;
  to?: string;
  toInclusive?: boolean;
}

/**
 * What one request with `x-time-zone` query parameters asked for: the
 * provider was asked for the items whose fields are in every span of
 * `spans` at once (one per `x-filter` field). This describes the query, not
 * the local copy: an item in a span is local only if the read returned it
 * and the caller kept it. `spans` is null when the request covers nothing
 * known; `reason` then says why.
 */
export interface ReadCoverage {
  /**
   * The `x-time-zone` query parameters and the values sent for them: the
   * wall-clock digits plus `suffix`, not instants.
   */
  parameters: Record<string, string>;
  /** The instants those values were written from, as given (ISO 8601 UTC). */
  instants: Record<string, string>;
  /**
   * Per parameter, the zone its value was written in; null when the zone
   * could not be read, so the UTC digits were sent and the bound narrowed
   * by 14 hours.
   */
  zones: Record<string, string | null>;
  spans: FieldSpan[] | null;
  /**
   * `empty`: the lower end is not before the upper end (with an unknown
   * zone, any window of 28 hours or less). `zoneChanged`: a zone read again
   * after the read differs from the one a value was written in, or could
   * not be read again; read again for a known span. `noRangePredicate`: a
   * parameter declares no `x-filter` with `gte`, `gt`, `lte` or `lt`, so
   * its value bounds nothing known. `otherFilters`: another query
   * parameter with a value narrows the read in a way no span describes (an
   * equality or other `x-filter`, an undeclared predicate, a range bound
   * that is not an instant); paging parameters and the collection's own
   * fixed `listQuery` values do not count. `incomplete`: the read did not
   * finish.
   */
  reason?:
    | 'empty'
    | 'zoneChanged'
    | 'noRangePredicate'
    | 'otherFilters'
    | 'incomplete';
}

/** Current offsets run from UTC−12 to UTC+14; the fallback narrows by 14 hours. */
export const MAX_OFFSET_MS = 14 * 60 * 60 * 1000;

const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let found = formatters.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      era: 'short',
    });
    formatters.set(zone, found);
  }
  return found;
}

/**
 * Whether `zone` is an IANA time zone name this runtime knows. Offsets
 * (`+01:00`), which some runtimes accept as a `timeZone`, are not names.
 */
export function isTimeZoneName(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !ZONE_NAME.test(zone)) return false;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock fields of `ms` (whole seconds) in `zone`, as UTC milliseconds. */
function wallOf(ms: number, zone: string): number {
  const parts: Record<string, string> = {};
  for (const part of formatter(zone).formatToParts(new Date(ms)))
    parts[part.type] = part.value;
  const year =
    parts['era'] === 'BC' || parts['era'] === 'B'
      ? 1 - Number(parts['year'])
      : Number(parts['year']);
  const wall = new Date(0);
  wall.setUTCFullYear(year, Number(parts['month']) - 1, Number(parts['day']));
  wall.setUTCHours(
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
    0,
  );
  return wall.getTime();
}

function digits(wallMs: number): string {
  return new Date(wallMs).toISOString().slice(0, 19);
}

/** Parses `yyyy-MM-ddTHH:mm:ss` wall-clock digits as UTC milliseconds. */
function wallMs(wall: string): number {
  const ms = Date.parse(`${wall.slice(0, 19)}Z`);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(wall) || Number.isNaN(ms))
    throw new Error(`Not wall-clock digits: ${wall}`);
  return ms;
}

/**
 * Step 2: the wall-clock digits (`yyyy-MM-ddTHH:mm:ss`, whole seconds,
 * truncated) of `instant` in `zone`, with `suffix` appended. `zone` null
 * writes the UTC digits.
 */
export function wallClockParam(
  instant: Date | number | string,
  zone: string | null,
  suffix = 'Z',
): string {
  const ms = Math.floor(toMs(instant) / 1000) * 1000;
  return digits(zone === null ? ms : wallOf(ms, zone)) + suffix;
}

function toMs(instant: Date | number | string): number {
  if (typeof instant === 'number') return instant;
  if (instant instanceof Date) return instant.getTime();
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(instant))
    throw new Error(`${instant} is not an instant: give it a Z or an offset`);
  const ms = Date.parse(instant);
  if (Number.isNaN(ms)) throw new Error(`${instant} is not an instant`);
  return ms;
}

/**
 * The UTC instants wall-clock digits can mean in `zone`, by offset:
 * `earlier` under the offset in effect before a change (Python's
 * `fold=0`), `later` under the one after it (`fold=1`). Outside a repeated
 * or skipped hour both are the same. In a skipped hour `earlier` is the
 * later instant (Amsterdam 2026-03-29 02:30 at +01:00 is 01:30Z). The
 * offsets before and after are taken a day either side, so two changes
 * within two days are not told apart.
 */
export function instantsOf(
  wall: string,
  zone: string,
): { earlier: Date; later: Date } {
  const w = wallMs(wall);
  const day = 24 * 60 * 60 * 1000;
  const before = wallOf(w - day, zone) - (w - day);
  const after = wallOf(w + day, zone) - (w + day);
  const first = w - before;
  const second = w - after;
  const firstFits = wallOf(first, zone) === w;
  const secondFits = wallOf(second, zone) === w;
  if (firstFits !== secondFits) {
    const only = new Date(firstFits ? first : second);
    return { earlier: only, later: only };
  }
  // Both fit (a repeated hour, or no change), or neither (a skipped hour).
  return { earlier: new Date(first), later: new Date(second) };
}

/**
 * Step 3: the UTC span bounds written as these wall-clock digits are known
 * to cover, or null when it is empty or inverted. `zone` null: the zone
 * could not be read and the digits are UTC; each bound covers 14 hours
 * less. `ambiguous` `earlier`/`later` takes that offset's instant;
 * `unspecified` the reading that covers least (the later instant for a
 * lower bound, the earlier for an upper one).
 */
export function coveredSpan(
  lower: string | undefined,
  upper: string | undefined,
  zone: string | null,
  ambiguous: Ambiguous = 'unspecified',
): CoveredSpan | null {
  const at = (wall: string, role: 'lower' | 'upper'): number => {
    if (zone === null)
      return wallMs(wall) + (role === 'lower' ? MAX_OFFSET_MS : -MAX_OFFSET_MS);
    const { earlier, later } = instantsOf(wall, zone);
    if (ambiguous !== 'unspecified')
      return (ambiguous === 'earlier' ? earlier : later).getTime();
    return role === 'lower'
      ? Math.max(earlier.getTime(), later.getTime())
      : Math.min(earlier.getTime(), later.getTime());
  };
  const from = lower === undefined ? undefined : at(lower, 'lower');
  const to = upper === undefined ? undefined : at(upper, 'upper');
  if (from !== undefined && to !== undefined && from >= to) return null;
  return {
    ...(from === undefined ? {} : { from: new Date(from).toISOString() }),
    ...(to === undefined ? {} : { to: new Date(to).toISOString() }),
  };
}

/** The parameter's `x-time-zone`, or undefined when absent or not usable. */
export function timeZoneDeclaration(
  parameter: ParameterObject,
): TimeZoneDeclaration | undefined {
  const raw = parameter['x-time-zone'];
  if (!isRecord(raw) || raw['interpretation'] !== 'wallClock') return undefined;
  const zone = raw['zone'];
  if (!isRecord(zone)) return undefined;
  const ambiguous = raw['ambiguous'] ?? 'unspecified';
  if (
    ambiguous !== 'unspecified' &&
    ambiguous !== 'earlier' &&
    ambiguous !== 'later'
  )
    return undefined;
  const suffix = typeof raw['suffix'] === 'string' ? raw['suffix'] : '';
  if (typeof zone['name'] === 'string' && zone['operationId'] === undefined)
    return { zone: { name: zone['name'] }, suffix, ambiguous };
  if (
    typeof zone['operationId'] === 'string' &&
    typeof zone['pointer'] === 'string' &&
    zone['name'] === undefined
  )
    return {
      zone: { operationId: zone['operationId'], pointer: zone['pointer'] },
      suffix,
      ambiguous,
    };
  return undefined;
}

/**
 * The query parameters of a list operation (its path item's and its own,
 * its own winning by name) that declare a usable `x-time-zone`.
 */
export function timeZoneParameters(
  pathItemParameters: unknown,
  operation: OperationObject,
): TimeZoneParameter[] {
  const byName = new Map<string, ParameterObject>();
  for (const list of [pathItemParameters, operation.parameters])
    for (const parameter of Array.isArray(list) ? list : [])
      if (isRecord(parameter) && parameter['in'] === 'query')
        byName.set(String(parameter['name']), parameter as ParameterObject);
  const found: TimeZoneParameter[] = [];
  for (const [name, parameter] of byName) {
    const declaration = timeZoneDeclaration(parameter);
    if (!declaration) continue;
    const filter = parameter['x-filter'];
    const operator = isRecord(filter) ? filter['operator'] : undefined;
    const bound =
      operator === 'gte' || operator === 'gt'
        ? 'lower'
        : operator === 'lte' || operator === 'lt'
          ? 'upper'
          : undefined;
    const field = isRecord(filter) ? filter['field'] : undefined;
    found.push({
      name,
      declaration,
      ...(bound && typeof field === 'string'
        ? { bound, inclusive: operator === 'gte' || operator === 'lte', field }
        : {}),
    });
  }
  return found;
}

/** A query parameter's `x-filter` range role, when it declares one. */
export interface RangeParameter {
  bound: 'lower' | 'upper';
  inclusive: boolean;
  field: string;
}

/**
 * Every query parameter of a list operation (its path item's and its own,
 * its own winning by name) that declares an `x-filter` with `gte`, `gt`,
 * `lte` or `lt`, by name, with its range role.
 */
export function rangeParameters(
  pathItemParameters: unknown,
  operation: OperationObject,
): Map<string, RangeParameter> {
  const found = new Map<string, RangeParameter>();
  for (const list of [pathItemParameters, operation.parameters])
    for (const parameter of Array.isArray(list) ? list : []) {
      if (!isRecord(parameter) || parameter['in'] !== 'query') continue;
      const name = String(parameter['name']);
      found.delete(name);
      const filter = parameter['x-filter'];
      const operator = isRecord(filter) ? filter['operator'] : undefined;
      const field = isRecord(filter) ? filter['field'] : undefined;
      if (typeof field !== 'string') continue;
      if (operator === 'gte' || operator === 'gt')
        found.set(name, {
          bound: 'lower',
          inclusive: operator === 'gte',
          field,
        });
      else if (operator === 'lte' || operator === 'lt')
        found.set(name, {
          bound: 'upper',
          inclusive: operator === 'lte',
          field,
        });
    }
  return found;
}

/** The value at a JSON Pointer, or undefined. */
export function atPointer(value: unknown, pointer: string): unknown {
  if (pointer === '') return value;
  if (!pointer.startsWith('/')) return undefined;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(key))
      current = current[Number(key)];
    else if (isRecord(current) && Object.hasOwn(current, key))
      current = current[key];
    else return undefined;
  }
  return current;
}

/**
 * The `get` operation with this `operationId` under `paths`, with its path
 * template and every parameter it requires, or undefined.
 */
export function zoneOperation(
  document: OpenApiDocument,
  operationId: string,
): { path: string; required: ParameterObject[] } | undefined {
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const operation = item?.get;
    if (!isRecord(operation) || operation.operationId !== operationId) continue;
    const byKey = new Map<string, ParameterObject>();
    for (const list of [item['parameters'], operation.parameters])
      for (const parameter of Array.isArray(list) ? list : [])
        if (isRecord(parameter))
          byKey.set(
            `${String(parameter['in'])}:${String(parameter['name'])}`,
            parameter as ParameterObject,
          );
    return {
      path,
      required: [...byKey.values()].filter(
        (p) => p.required || p.in === 'path',
      ),
    };
  }
  return undefined;
}

/** The zone read by a source, or null when it cannot be read. */
export type ZoneRead = (
  zone: TimeZoneDeclaration['zone'],
  path: Record<string, string>,
) => Promise<string | null>;

/**
 * Step 1 and 4: reads zones for one read. `read` answers each source once
 * (a fixed name, or the operation's GET with the request's path values),
 * cached for the read; `recheck` reads every operation source again and
 * returns the keys whose zone changed or could not be read again.
 * `send` is the read's budgeted transport; budget errors are thrown, any
 * other failure makes the zone unreadable (null).
 */
export function zoneReader(
  document: OpenApiDocument,
  upstream: URL,
  send: (request: {
    url: URL;
    method: 'GET';
    headers: Record<string, string>;
  }) => Promise<{ status: number; body: string }>,
  isBudgetError: (error: unknown) => boolean,
): {
  read: (
    zone: TimeZoneDeclaration['zone'],
    path: Record<string, string>,
  ) => Promise<{ zone: string | null; key: string }>;
  recheck: () => Promise<Set<string>>;
} {
  const cache = new Map<string, Promise<string | null>>();
  const sources = new Map<
    string,
    { operationId: string; pointer: string; url: URL | undefined }
  >();

  function urlFor(
    operationId: string,
    path: Record<string, string>,
  ): URL | undefined {
    const operation = zoneOperation(document, operationId);
    if (!operation) return undefined;
    const values: Record<string, string> = {};
    for (const parameter of operation.required) {
      const value = path[parameter.name];
      if (parameter.in !== 'path' || value === undefined || value === '')
        return undefined;
      values[parameter.name] = value;
    }
    const url = new URL(upstream.href);
    url.pathname =
      upstream.pathname.replace(/\/$/, '') +
      operation.path.replace(/\{([^}]+)\}/g, (_, name: string) =>
        encodeURIComponent(values[name] ?? ''),
      );
    url.search = '';
    return url;
  }

  async function fetchZone(
    url: URL | undefined,
    pointer: string,
  ): Promise<string | null> {
    if (!url) return null;
    try {
      const response = await send({
        url: new URL(url.href),
        method: 'GET',
        headers: { accept: 'application/json' },
      });
      if (response.status < 200 || response.status >= 300) return null;
      const zone = atPointer(JSON.parse(response.body), pointer);
      return isTimeZoneName(zone) ? zone : null;
    } catch (error) {
      if (isBudgetError(error)) throw error;
      return null;
    }
  }

  return {
    async read(
      zone: TimeZoneDeclaration['zone'],
      path: Record<string, string>,
    ): Promise<{ zone: string | null; key: string }> {
      if ('name' in zone)
        return {
          zone: isTimeZoneName(zone.name) ? zone.name : null,
          key: `name ${zone.name}`,
        };
      const url = urlFor(zone.operationId, path);
      const key = `operation ${zone.operationId} ${zone.pointer} ${url?.href ?? ''}`;
      let found = cache.get(key);
      if (!found) {
        found = fetchZone(url, zone.pointer);
        cache.set(key, found);
        sources.set(key, { ...zone, url });
      }
      return { zone: await found, key };
    },
    async recheck(): Promise<Set<string>> {
      const changed = new Set<string>();
      for (const [key, source] of sources) {
        const before = await cache.get(key);
        if (before === null || before === undefined) continue;
        const after = await fetchZone(source.url, source.pointer);
        if (after !== before) changed.add(key);
      }
      return changed;
    },
  };
}

/**
 * The rest of a request's query, for its coverage: the range parameters
 * without `x-time-zone` (`ranges`), the paging parameters (`paging`) and
 * the collection's own fixed `listQuery` values (`fixed`), which define the
 * collection rather than narrow it.
 */
export interface OtherQuery {
  ranges: Map<string, RangeParameter>;
  paging: Set<string>;
  fixed: Record<string, string>;
}

/**
 * Steps 2 and 3 for one request: the query with each `x-time-zone`
 * parameter's instant written as wall-clock digits plus `suffix`, and what
 * the request covers, or no coverage when none of them has a value. Range
 * parameters without `x-time-zone` add their instants to the spans of their
 * fields; any other narrowing value (`others`) makes the coverage unknown.
 * The keys are the zone sources the coverage depends on.
 */
export async function wallClockQuery(
  parameters: TimeZoneParameter[],
  query: Record<string, string>,
  path: Record<string, string>,
  read: ReturnType<typeof zoneReader>['read'],
  others: OtherQuery = {
    ranges: new Map(),
    paging: new Set(),
    fixed: {},
  },
): Promise<{
  query: Record<string, string>;
  coverage?: ReadCoverage;
  keys: Set<string>;
}> {
  const sent = { ...query };
  const keys = new Set<string>();
  const values: Record<string, string> = {};
  const instants: Record<string, string> = {};
  const zones: Record<string, string | null> = {};
  // Per x-filter field: the tightest lower and upper end, in milliseconds.
  const ends = new Map<
    string,
    {
      from?: number;
      fromInclusive?: boolean;
      to?: number;
      toInclusive?: boolean;
    }
  >();
  let noRange = false;
  /** The tighter end wins; at the same instant, an excluded one. */
  const addEnd = (
    field: string,
    bound: 'lower' | 'upper',
    at: number,
    inclusive: boolean,
  ): void => {
    const end = ends.get(field) ?? {};
    ends.set(field, end);
    if (bound === 'lower') {
      if (
        end.from === undefined ||
        at > end.from ||
        (at === end.from && !inclusive)
      ) {
        end.from = at;
        end.fromInclusive = inclusive;
      }
    } else if (
      end.to === undefined ||
      at < end.to ||
      (at === end.to && !inclusive)
    ) {
      end.to = at;
      end.toInclusive = inclusive;
    }
  };
  for (const parameter of parameters) {
    const value = query[parameter.name];
    if (value === undefined || value === '') continue;
    const { zone, key } = await read(parameter.declaration.zone, path);
    if (zone !== null) keys.add(key);
    const written = wallClockParam(value, zone, parameter.declaration.suffix);
    sent[parameter.name] = written;
    values[parameter.name] = written;
    instants[parameter.name] = new Date(Date.parse(value)).toISOString();
    zones[parameter.name] = zone;
    if (!parameter.bound || parameter.field === undefined) {
      noRange = true;
      continue;
    }
    const wall = written.slice(0, 19);
    const one = coveredSpan(
      parameter.bound === 'lower' ? wall : undefined,
      parameter.bound === 'upper' ? wall : undefined,
      zone,
      parameter.declaration.ambiguous,
    );
    const inclusive = parameter.inclusive === true;
    if (one?.from !== undefined)
      addEnd(parameter.field, 'lower', Date.parse(one.from), inclusive);
    if (one?.to !== undefined)
      addEnd(parameter.field, 'upper', Date.parse(one.to), inclusive);
  }
  // The rest of the query: range bounds without a zone are instants as
  // given; any other narrowing value leaves the coverage unknown.
  const zonedNames = new Set(parameters.map((p) => p.name));
  let otherFilters = false;
  for (const [name, value] of Object.entries(query)) {
    if (zonedNames.has(name) || value === undefined || value === '') continue;
    if (others.paging.has(name) || others.fixed[name] === value) continue;
    const range = others.ranges.get(name);
    const at = /(Z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
    if (!range || Number.isNaN(at)) {
      otherFilters = true;
      continue;
    }
    instants[name] = new Date(at).toISOString();
    addEnd(range.field, range.bound, at, range.inclusive);
  }
  if (!Object.keys(values).length) return { query: sent, keys };
  const base = { parameters: values, instants, zones };
  const empty = [...ends.values()].some(
    (end) =>
      end.from !== undefined && end.to !== undefined && end.from >= end.to,
  );
  const coverage: ReadCoverage = noRange
    ? { ...base, spans: null, reason: 'noRangePredicate' }
    : otherFilters
      ? { ...base, spans: null, reason: 'otherFilters' }
      : empty
        ? { ...base, spans: null, reason: 'empty' }
        : {
            ...base,
            spans: [...ends].map(([field, end]) => ({
              field,
              ...(end.from === undefined
                ? {}
                : {
                    from: new Date(end.from).toISOString(),
                    fromInclusive: end.fromInclusive === true,
                  }),
              ...(end.to === undefined
                ? {}
                : {
                    to: new Date(end.to).toISOString(),
                    toInclusive: end.toInclusive === true,
                  }),
            })),
          };
  return { query: sent, coverage, keys };
}
