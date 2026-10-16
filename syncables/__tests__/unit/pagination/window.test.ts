// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  formatBound,
  halves,
  parseBound,
  windowRequest,
} from '../../../src/pagination/window.js';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';
import {
  PaginationSchemeError,
  resolveEffectiveScheme,
} from '../../../src/pagination/autodetect.js';
import type {
  OpenApiDocument,
  OperationObject,
} from '../../../src/openapi/types.js';
import type {
  PaginationSchemeObject,
  RangeWindowObject,
} from '../../../src/pagination/types.js';

// Pagination Schemes 0.5.0 §4.6 (rangeWindow), the consumer side. The
// expected values are those of the spec folder's validate.py (`halves`,
// `_to_number`) and its examples/range-window.yaml.

const days: RangeWindowObject = {
  unit: 'day',
  format: 'basicDate',
  bounds: 'closed',
  cap: 100,
};

const periodWindows = (): PaginationSchemeObject => ({
  type: 'rangeWindow',
  autoDetect: false,
  window: { ...days },
  request: {
    queryParameters: {
      filter: { role: 'windowRange', template: 'period:{start}..{end}' },
    },
  },
});

describe('bounds (§4.6.2)', () => {
  it('reads and writes each format as exact strings', () => {
    const cases: [
      RangeWindowObject['format'],
      RangeWindowObject['unit'],
      string,
    ][] = [
      ['date', 'day', '2026-01-31'],
      ['basicDate', 'day', '20260131'],
      ['dateTime', 'second', '2026-01-31T23:59:59Z'],
      ['unixSeconds', 'second', '1769903999'],
      ['integer', 'integer', '-4711'],
    ];
    for (const [format, unit, bound] of cases) {
      const window = { ...days, unit, format };
      expect(formatBound(parseBound(bound, window), window)).toBe(bound);
    }
  });

  it('refuses a bound that is not in the format', () => {
    for (const [format, bound] of [
      ['basicDate', '2026-01-31'],
      ['basicDate', '20261301'],
      ['date', '2026-02-30'],
      ['dateTime', '2026-01-31T23:59:59+01:00'],
      ['integer', '007'],
      ['integer', '-0'],
      ['integer', '1.5'],
    ] as const) {
      expect(() => parseBound(bound, { ...days, format })).toThrow();
    }
    expect(() => parseBound(20260131, days)).toThrow();
  });
});

describe('halving (§4.6.3 step 3)', () => {
  it('gives the first window ceil(w/2) units, as read.ts and validate.py do', () => {
    expect(halves('20260101', '20261231', days)).toEqual([
      ['20260101', '20260702'],
      ['20260703', '20261231'],
    ]);
    expect(halves('20260703', '20261231', days)).toEqual([
      ['20260703', '20261001'],
      ['20261002', '20261231'],
    ]);
  });

  it('crosses months and leap days', () => {
    expect(
      halves('2028-02-28', '2028-03-01', { ...days, format: 'date' }),
    ).toEqual([
      ['2028-02-28', '2028-02-29'],
      ['2028-03-01', '2028-03-01'],
    ]);
  });

  it('splits half-open windows at the same unit for both halves', () => {
    const seconds: RangeWindowObject = {
      unit: 'second',
      format: 'dateTime',
      bounds: 'halfOpen',
      cap: 500,
    };
    expect(
      halves('2026-01-01T00:00:00Z', '2026-01-01T00:00:10Z', seconds),
    ).toEqual([
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:05Z'],
      ['2026-01-01T00:00:05Z', '2026-01-01T00:00:10Z'],
    ]);
    expect(
      halves('2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', seconds),
    ).toBeUndefined();
  });

  it('does not split below 2 × minimumWidth', () => {
    const weeks = { ...days, minimumWidth: 7 };
    expect(halves('20260101', '20260113', weeks)).toBeUndefined();
    expect(halves('20260101', '20260114', weeks)).toEqual([
      ['20260101', '20260107'],
      ['20260108', '20260114'],
    ]);
    expect(halves('20260415', '20260415', days)).toBeUndefined();
  });
});

describe('window requests (§4.6.1)', () => {
  it('fills a template, or a start and an end field', () => {
    expect(
      windowRequest(periodWindows(), '20260101', '20260131').queryParameters,
    ).toEqual({ filter: 'period:20260101..20260131' });
    const pair: PaginationSchemeObject = {
      type: 'rangeWindow',
      window: { ...days, bounds: 'halfOpen' },
      request: {
        queryParameters: {
          from: { role: 'windowStart' },
          before: { role: 'windowEnd' },
        },
      },
    };
    expect(windowRequest(pair, 'a', 'b').queryParameters).toEqual({
      from: 'a',
      before: 'b',
    });
  });
});

describe('validation (§9 rules 12–16)', () => {
  const errors = (scheme: unknown): string[] =>
    validatePaginationScheme('s', scheme as PaginationSchemeObject);

  it('accepts the spec example', () => {
    expect(errors(periodWindows())).toEqual([]);
  });

  it('needs a window on a rangeWindow scheme and refuses one elsewhere (rule 12)', () => {
    const scheme = periodWindows();
    delete scheme.window;
    expect(errors(scheme).join()).toMatch(/window is required/);
    expect(
      errors({
        type: 'pageNumber',
        window: days,
        request: { queryParameters: { page: { role: 'page' } } },
      }).join(),
    ).toMatch(/window is allowed only/);
  });

  it('checks the Range Window Object (rules 12, 13)', () => {
    for (const change of [
      { cap: 0 },
      { cap: '100' },
      { minimumWidth: 0 },
      { bounds: 'open' },
      { unit: 'month' },
      { format: 'dateTime' },
      { field: 'date' },
      { split: 'halve' },
    ]) {
      const scheme = periodWindows();
      Object.assign(scheme.window as object, change);
      expect(errors(scheme)).not.toEqual([]);
    }
    const scheme = periodWindows();
    Object.assign(scheme.window as object, {
      unit: 'second',
      format: 'dateTime',
      timeZone: 'UTC',
    });
    expect(errors(scheme).join()).toMatch(/timeZone is allowed only/);
  });

  it('needs one way of carrying the window (rule 14)', () => {
    const scheme = periodWindows();
    scheme.request!.queryParameters!['from'] = { role: 'windowStart' };
    expect(errors(scheme).join()).toMatch(/one windowRange field/);
    expect(
      errors({
        type: 'pageNumber',
        request: { queryParameters: { from: { role: 'windowStart' } } },
      }).join(),
    ).toMatch(/allowed only in a rangeWindow scheme/);
  });

  it('checks templates (rule 15)', () => {
    for (const template of [
      'period:{start}',
      '{start}..{start}',
      '{start}..{end}}',
      '',
    ]) {
      const scheme = periodWindows();
      scheme.request!.queryParameters!['filter']!.template = template;
      expect(errors(scheme)).not.toEqual([]);
    }
    const scheme = periodWindows();
    delete scheme.request!.queryParameters!['filter']!.template;
    expect(errors(scheme).join()).toMatch(/needs a template/);
  });

  it('refuses auto-detection (rule 16)', () => {
    expect(errors({ ...periodWindows(), autoDetect: true }).join()).toMatch(
      /never auto-detected/,
    );
    const without = periodWindows();
    delete without.autoDetect;
    expect(errors(without)).toEqual([]);
  });
});

describe('applying a rangeWindow scheme', () => {
  const document = (
    extra: Record<string, PaginationSchemeObject> = {},
  ): OpenApiDocument => ({
    openapi: '3.0.3',
    info: { title: 't', version: '1' },
    paths: {},
    components: {
      paginationSchemes: { periodWindows: periodWindows(), ...extra },
    },
  });
  const operation = (applications: unknown[]): OperationObject => ({
    parameters: [{ name: 'filter', in: 'query' }],
    responses: {},
    'x-pagination': applications,
  });

  it('applies it explicitly, alone', () => {
    const apps = [{ scheme: 'periodWindows' }];
    expect(
      resolveEffectiveScheme(document(), operation(apps))?.scheme.type,
    ).toBe('rangeWindow');
  });

  it('never auto-detects it, even when the operation has its field', () => {
    expect(resolveEffectiveScheme(document(), operation([]))).toBeUndefined();
  });

  it('refuses it together with another scheme, also after overrides (rule 17)', () => {
    const pages: PaginationSchemeObject = {
      type: 'pageNumber',
      request: { queryParameters: { page: { role: 'page' } } },
    };
    for (const apps of [
      [{ scheme: 'periodWindows' }, { scheme: 'pages' }],
      [
        { scheme: 'pages' },
        { scheme: 'pages', overrides: { type: 'rangeWindow' } },
      ],
    ]) {
      expect(() =>
        resolveEffectiveScheme(document({ pages }), operation(apps)),
      ).toThrow(PaginationSchemeError);
    }
  });
});
