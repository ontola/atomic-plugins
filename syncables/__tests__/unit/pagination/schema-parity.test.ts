// @wc-ignore-file
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';
import { resolveEffectiveScheme } from '../../../src/pagination/autodetect.js';
import type { OpenApiDocument } from '../../../src/openapi/types.js';
import type { PaginationSchemeObject } from '../../../src/pagination/types.js';

// validatePaginationScheme refuses what the spec's schema.json refuses
// (openapi-extensions/spec/pagination-schemes/), beyond the numbered rules:
// fields the spec does not define (other than `x-`) and the types it
// states. The cases below were checked against schema.json with Python's
// jsonschema on 2026-10-14, as were all 491 schemes in the repository's
// overlays: the verdicts agree, apart from `incrementalSync`, which the
// spec allows and this client does not implement (refused, as before).

type Scheme = Record<string, unknown>;

const base = (): Scheme => ({
  type: 'pageToken',
  request: { queryParameters: { cursor: { role: 'cursor' } } },
  response: { bodyFields: { next: { role: 'nextCursor' } } },
});

const variant = (change: (scheme: Scheme) => void): Scheme => {
  const scheme = base();
  change(scheme);
  return scheme;
};

const at = (scheme: Scheme, ...path: string[]): Scheme =>
  path.reduce((value, key) => value[key] as Scheme, scheme);

const errors = (scheme: unknown): string[] =>
  validatePaginationScheme('s', scheme as unknown as PaginationSchemeObject);

describe('the structure schema.json gives a scheme', () => {
  it.each([
    ['the base scheme', base()],
    ['an x- field on the scheme', variant((s) => (s['x-note'] = 1))],
    [
      'an Auto-Detect Object with a boolean',
      variant((s) => (s['autoDetect'] = { requireAll: false })),
    ],
  ])('accepts %s', (_label, scheme) => {
    expect(errors(scheme)).toEqual([]);
  });

  it.each([
    [
      'a field the spec does not define (a typo of response)',
      variant((s) => (s['respnse'] = {})),
      /paginationSchemes\.s\.respnse is not a Pagination Scheme Object field/,
    ],
    [
      'a description that is not a string',
      variant((s) => (s['description'] = 1)),
      /description must be a string/,
    ],
    [
      'an unknown Auto-Detect Object field',
      variant((s) => (s['autoDetect'] = { matchQuery: true })),
      /autoDetect\.matchQuery is not an? Auto-Detect Object field/,
    ],
    [
      'an Auto-Detect Object member that is not a boolean',
      variant((s) => (s['autoDetect'] = { requireAll: 'yes' })),
      /autoDetect\.requireAll must be a boolean/,
    ],
    [
      'a request that is not an object',
      variant((s) => (s['request'] = 'x')),
      /request must be an object/,
    ],
    [
      'an unknown request location',
      variant((s) => (at(s, 'request')['query'] = {})),
      /request\.query is not a Request Pagination Fields Object field/,
    ],
    [
      'queryParameters that are not an object',
      variant((s) => (at(s, 'request')['queryParameters'] = [])),
      /request\.queryParameters must be an object/,
    ],
    [
      'a field that is null',
      variant((s) => (at(s, 'request', 'queryParameters')['cursor'] = null)),
      /queryParameters\.cursor must be an object/,
    ],
    [
      'an unknown request field member',
      variant(
        (s) => (at(s, 'request', 'queryParameters', 'cursor')['name'] = 'c'),
      ),
      /cursor\.name is not a Request Field Object field/,
    ],
    [
      'a role that is not a string',
      variant(
        (s) => (at(s, 'request', 'queryParameters', 'cursor')['role'] = 3),
      ),
      /cursor\.role must be a string/,
    ],
    [
      'required that is not a boolean',
      variant(
        (s) =>
          (at(s, 'request', 'queryParameters', 'cursor')['required'] = 'yes'),
      ),
      /cursor\.required must be a boolean/,
    ],
    [
      'a schema that is not an object',
      variant(
        (s) =>
          (at(s, 'request', 'queryParameters', 'cursor')['schema'] = 'string'),
      ),
      /cursor\.schema must be an object/,
    ],
    [
      'an unknown role on a header field',
      variant(
        (s) => (at(s, 'request')['headerFields'] = { h: { role: 'bogus' } }),
      ),
      /headerFields\.h\.role is not a valid request role/,
    ],
    [
      'a response that is an array',
      variant((s) => (s['response'] = [])),
      /response must be an object/,
    ],
    [
      'an unknown response member',
      variant((s) => (at(s, 'response')['body'] = {})),
      /response\.body is not a Response Pagination Fields Object field/,
    ],
    [
      'an unknown response field member',
      variant((s) => (at(s, 'response', 'bodyFields', 'next')['path'] = 'a')),
      /next\.path is not a Response Field Object field/,
    ],
    [
      'an envelope that is an array',
      variant((s) => (at(s, 'response')['envelope'] = [])),
      /envelope must be an object/,
    ],
    [
      'an unknown Envelope Object field',
      variant((s) => (at(s, 'response')['envelope'] = { items: 'data' })),
      /envelope\.items is not an? Envelope Object field/,
    ],
    [
      'an unknown Link Resolution Object field',
      variant(
        (s) =>
          (at(s, 'response')['bodyFields'] = {
            n: {
              role: 'nextLink',
              linkResolution: { base: 'request', why: 1 },
            },
          }),
      ),
      /linkResolution\.why is not a Link Resolution Object field/,
    ],
  ])('refuses %s', (_label, scheme, message) => {
    expect(errors(scheme)).toContainEqual(expect.stringMatching(message));
  });

  it('refuses a scheme that is not an object, without throwing', () => {
    expect(errors(null)).toEqual(['paginationSchemes.s must be an object']);
  });
});

// The repository's overlays and catalogs (`../overlays/`).
const overlays = join(import.meta.dirname, '../../../../overlays');
const PAGES = 'https://ontola.github.io/atomic-plugins/overlays/';

interface Found {
  schemes: Map<string, Scheme>;
  applied: Set<string>;
}

/** Every Pagination Scheme and every scheme an x-pagination names. */
function collect(value: unknown, found: Found): void {
  if (Array.isArray(value)) {
    for (const item of value) collect(item, found);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, member] of Object.entries(value)) {
    if (
      key === 'paginationSchemes' &&
      typeof member === 'object' &&
      member !== null
    )
      for (const [name, scheme] of Object.entries(member))
        found.schemes.set(name, scheme as Scheme);
    else if (key === 'x-pagination' && Array.isArray(member)) {
      for (const entry of member)
        if (typeof entry?.scheme === 'string') found.applied.add(entry.scheme);
    } else collect(member, found);
  }
}

describe('the repository’s catalogs under the stricter validation', () => {
  const catalogs = readdirSync(join(overlays, 'catalog')).filter((f) =>
    f.endsWith('.json'),
  );
  const platforms = catalogs.flatMap((file) => {
    const catalog = JSON.parse(
      readFileSync(join(overlays, 'catalog', file), 'utf8'),
    ) as { platforms: { name: string; overlays?: string[] }[] };
    return catalog.platforms.map((platform) => {
      const found: Found = { schemes: new Map(), applied: new Set() };
      for (const url of platform.overlays ?? [])
        if (url.startsWith(PAGES))
          collect(
            yaml.load(
              readFileSync(join(overlays, url.slice(PAGES.length)), 'utf8'),
            ),
            found,
          );
      return { catalog: file, platform: platform.name, ...found };
    });
  });

  it('reads every catalog', () => {
    expect(catalogs.length).toBeGreaterThan(0);
    expect(platforms.some((p) => p.schemes.size > 0)).toBe(true);
  });

  it('makes no explicit selection fail: every scheme an x-pagination names is valid', () => {
    const failing = platforms.flatMap(
      ({ catalog, platform, schemes, applied }) =>
        [...applied]
          .filter((name) => schemes.has(name))
          .filter(
            (name) =>
              validatePaginationScheme(
                name,
                schemes.get(name) as unknown as PaginationSchemeObject,
              ).length > 0,
          )
          .map((name) => `${catalog} ${platform} ${name}`),
    );
    expect(failing).toEqual([]);
  });

  it('leaves only Box’s first overlay with invalid schemes auto-detection may apply', () => {
    const detectable = new Set(
      platforms.flatMap(({ platform, schemes }) =>
        [...schemes]
          .filter(
            ([name, scheme]) =>
              scheme['autoDetect'] !== false &&
              validatePaginationScheme(
                name,
                scheme as unknown as PaginationSchemeObject,
              ).length > 0,
          )
          .map(([name]) => `${platform} ${name}`),
      ),
    );
    expect([...detectable].sort()).toEqual(['box marker', 'box offset']);
  });
});

describe('the repository’s other overlays', () => {
  it('refuses Shutterstock’s pageNumber for its response.properties (bodyFields meant), the one verdict that changed', () => {
    const file = join(
      overlays,
      'APIs/shutterstock.com/1.1.32/pagination-dec74da7a6785d5d5b83bc6a4cebc07336d67ec9-overlay.yaml',
    );
    const found: Found = { schemes: new Map(), applied: new Set() };
    collect(yaml.load(readFileSync(file, 'utf8')), found);
    expect(
      validatePaginationScheme(
        'pageNumber',
        found.schemes.get('pageNumber') as unknown as PaginationSchemeObject,
      ),
    ).toEqual([
      'paginationSchemes.pageNumber.response.properties is not a Response Pagination Fields Object field',
    ]);
  });
});

describe('auto-detection on a malformed operation', () => {
  const doc = {
    openapi: '3.0.3',
    info: { title: 'Broken', version: '1' },
    paths: {},
    components: { paginationSchemes: { cursor: base() } },
  } as unknown as OpenApiDocument;

  it.each([
    ['parameters that are not an array', { cursor: { in: 'query' } }],
    ['a parameter that is null', [null, { name: 'cursor', in: 'query' }]],
    ['a parameter that is a string', ['cursor']],
  ])('does not throw on %s', (_label, parameters) => {
    const operation = { parameters, responses: {} } as never;
    expect(() => resolveEffectiveScheme(doc, operation)).not.toThrow();
  });

  it('still matches the well-formed parameters beside a malformed one', () => {
    const operation = {
      parameters: [null, { name: 'cursor', in: 'query' }],
      responses: {},
    } as never;
    expect(resolveEffectiveScheme(doc, operation)?.schemeName).toBe('cursor');
  });
});
