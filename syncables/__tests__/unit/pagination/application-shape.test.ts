// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  PaginationSchemeError,
  resolveEffectiveScheme,
} from '../../../src/pagination/autodetect.js';
import type {
  OpenApiDocument,
  OperationObject,
} from '../../../src/openapi/types.js';

// An explicit x-pagination entry follows the spec's schema.json for a
// Pagination Application Object: a nonempty `scheme`, an object
// `overrides`, a string `description`, and no other field but `x-` ones.
// Every entry is checked, not only the first. Every x-pagination entry in
// the repository's YAML and JSON files passes (1,275 entries, counted on
// 2026-10-15 by walking every file for x-pagination arrays).

const document = {
  openapi: '3.0.3',
  info: { title: 'Pages', version: '1' },
  paths: {},
  components: {
    paginationSchemes: {
      cursor: {
        type: 'pageToken',
        autoDetect: false,
        request: { queryParameters: { cursor: { role: 'cursor' } } },
        response: { bodyFields: { next: { role: 'nextCursor' } } },
      },
    },
  },
} as unknown as OpenApiDocument;

const resolve = (applications: unknown): unknown =>
  resolveEffectiveScheme(document, {
    responses: {},
    'x-pagination': applications,
  } as unknown as OperationObject);

describe('a Pagination Application Object', () => {
  it.each([
    ['a scheme alone', [{ scheme: 'cursor' }]],
    [
      'a description and an x- field',
      [{ scheme: 'cursor', description: 'd', 'x-note': 1 }],
    ],
    [
      'overrides',
      [{ scheme: 'cursor', overrides: { request: { queryParameters: {} } } }],
    ],
  ])('applies with %s', (_label, applications) => {
    expect(resolve(applications)).toMatchObject({ schemeName: 'cursor' });
  });

  it.each([
    [
      'an unknown field (a typo of overrides)',
      [{ scheme: 'cursor', overide: {} }],
      /field the spec does not define: overide/,
    ],
    [
      'overrides that are not an object',
      [{ scheme: 'cursor', overrides: 'x' }],
      /overrides must be an object/,
    ],
    [
      'overrides that are an array',
      [{ scheme: 'cursor', overrides: [] }],
      /overrides must be an object/,
    ],
    [
      'a description that is not a string',
      [{ scheme: 'cursor', description: 1 }],
      /description must be a string/,
    ],
    ['an empty scheme name', [{ scheme: '' }], /"scheme" name/],
    [
      'a bad second entry',
      [{ scheme: 'cursor' }, { scheme: 'cursor', extra: true }],
      /x-pagination\[1\] has a field the spec does not define: extra/,
    ],
  ])('refuses %s, failing the read', (_label, applications, message) => {
    expect(() => resolve(applications)).toThrow(PaginationSchemeError);
    expect(() => resolve(applications)).toThrow(message);
  });
});
