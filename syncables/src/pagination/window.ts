// @wc-ignore-file
/**
 * Range windows (Pagination Schemes 0.5.0 §4.6): the bounds of a window in
 * the declared format, its width, the default split of a full window, and
 * the request fields that carry a window. After `_to_number`, `_to_bound`,
 * `halves` and `window_request` in the spec folder's `validate.py`. The
 * traversal itself is in `read/pages.ts` (`walkPages`).
 */
import type {
  PaginationSchemeObject,
  RangeWindowObject,
  RequestFieldObject,
} from './types.js';

/** A windowed read that is not complete (§4.6.4 rule 4). */
export class WindowReadError extends Error {}

const DAY_MS = 86_400_000;

const isLeap = (y: number): boolean =>
  (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days since 1970-01-01 of a civil date, or undefined for one that does not exist. */
function dayNumber(y: number, m: number, d: number): number | undefined {
  if (m < 1 || m > 12 || d < 1) return undefined;
  const days = m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1]!;
  if (d > days) return undefined;
  return Date.UTC(y, m - 1, d) / DAY_MS;
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/**
 * A bound in the window's `format` as a number of its `unit`s (§4.6.2):
 * days since 1970-01-01 for `day`, seconds since the epoch for `second`,
 * the integer itself for `integer`. Throws for a value that is not in the
 * format; bounds are exact strings, never floats.
 */
export function parseBound(bound: unknown, window: RangeWindowObject): number {
  const refuse = (): never => {
    throw new WindowReadError(
      `bound ${JSON.stringify(bound)} is not in the window format ${window.format}`,
    );
  };
  if (typeof bound !== 'string') return refuse();
  const { format } = window;
  if (format === 'date' || format === 'basicDate') {
    const m =
      format === 'date'
        ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(bound)
        : /^(\d{4})(\d{2})(\d{2})$/.exec(bound);
    if (!m) return refuse();
    const day = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    return day === undefined ? refuse() : day;
  }
  if (format === 'dateTime') {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(bound);
    if (!m) return refuse();
    const day = dayNumber(Number(m[1]), Number(m[2]), Number(m[3]));
    const [h, min, s] = [Number(m[4]), Number(m[5]), Number(m[6])];
    if (day === undefined || h > 23 || min > 59 || s > 59) return refuse();
    return day * 86_400 + h * 3600 + min * 60 + s;
  }
  // unixSeconds and integer: a decimal integer, no leading zeros, no -0.
  if (!INTEGER.test(bound) || bound === '-0') return refuse();
  const n = Number(bound);
  return Number.isSafeInteger(n) ? n : refuse();
}

const pad = (n: number, width: number): string =>
  String(n).padStart(width, '0');

/** The inverse of `parseBound`. */
export function formatBound(number: number, window: RangeWindowObject): string {
  const { format } = window;
  if (format === 'integer' || format === 'unixSeconds') return String(number);
  const date = new Date(
    format === 'dateTime' ? number * 1000 : number * DAY_MS,
  );
  const y = pad(date.getUTCFullYear(), 4);
  const mo = pad(date.getUTCMonth() + 1, 2);
  const d = pad(date.getUTCDate(), 2);
  if (format === 'basicDate') return `${y}${mo}${d}`;
  if (format === 'date') return `${y}-${mo}-${d}`;
  return `${y}-${mo}-${d}T${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}Z`;
}

/** The number of units in `[first, last]` or `[first, last)`, as `bounds` says (§4.6.3). */
export function windowWidth(
  first: number,
  last: number,
  window: RangeWindowObject,
): number {
  return window.bounds === 'closed' ? last - first + 1 : last - first;
}

/**
 * The default split of §4.6.3 step 3: two adjacent windows, the first
 * holding the first `ceil(w / 2)` units. Undefined when the window is
 * narrower than `2 × minimumWidth`, so it cannot be split.
 */
export function halves(
  start: string,
  end: string,
  window: RangeWindowObject,
): [[string, string], [string, string]] | undefined {
  const first = parseBound(start, window);
  const last = parseBound(end, window);
  const width = windowWidth(first, last, window);
  if (width < 2 * (window.minimumWidth ?? 1)) return undefined;
  // The first unit of the second window.
  const middle = first + Math.ceil(width / 2);
  const headEnd = window.bounds === 'closed' ? middle - 1 : middle;
  return [
    [start, formatBound(headEnd, window)],
    [formatBound(middle, window), end],
  ];
}

export type WindowLocation = 'queryParameters' | 'bodyFields' | 'headerFields';

export interface WindowField {
  location: WindowLocation;
  name: string;
  role: 'windowStart' | 'windowEnd' | 'windowRange';
  template?: string;
}

/** The request fields that carry the window, in declaration order. */
export function windowFields(scheme: PaginationSchemeObject): WindowField[] {
  const fields: WindowField[] = [];
  for (const location of [
    'queryParameters',
    'bodyFields',
    'headerFields',
  ] as const) {
    const declared = (scheme.request?.[location] ?? {}) as Record<
      string,
      RequestFieldObject
    >;
    for (const [name, field] of Object.entries(declared)) {
      if (
        field.role === 'windowStart' ||
        field.role === 'windowEnd' ||
        field.role === 'windowRange'
      )
        fields.push({
          location,
          name,
          role: field.role,
          ...(typeof field.template === 'string'
            ? { template: field.template }
            : {}),
        });
    }
  }
  return fields;
}

/** The values one window's request carries, per location, `start` and `end` in the window's format. */
export function windowRequest(
  scheme: PaginationSchemeObject,
  start: string,
  end: string,
): {
  queryParameters: Record<string, string>;
  bodyFields: Record<string, string>;
  headerFields: Record<string, string>;
} {
  const values = {
    queryParameters: {} as Record<string, string>,
    bodyFields: {} as Record<string, string>,
    headerFields: {} as Record<string, string>,
  };
  for (const field of windowFields(scheme)) {
    values[field.location][field.name] =
      field.role === 'windowStart'
        ? start
        : field.role === 'windowEnd'
          ? end
          : (field.template ?? '{start}..{end}')
              .replace('{start}', start)
              .replace('{end}', end);
  }
  return values;
}
