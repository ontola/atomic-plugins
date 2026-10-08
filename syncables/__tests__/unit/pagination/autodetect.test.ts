import { describe, expect, it } from 'vitest';
import {
  PaginationSchemeError,
  resolveEffectiveScheme,
} from '../../../src/pagination/autodetect.js';
import type {
  OpenApiDocument,
  OperationObject,
} from '../../../src/openapi/types.js';
import type { PaginationSchemesMap } from '../../../src/pagination/types.js';

function documentWith(
  paginationSchemes: PaginationSchemesMap,
): OpenApiDocument {
  return {
    openapi: '3.0.0',
    info: { title: 'Test', version: '1.0.0' },
    paths: {},
    components: { paginationSchemes },
  };
}

const pageNumberScheme = {
  type: 'pageNumber' as const,
  request: {
    queryParameters: {
      page: { role: 'page' as const },
      limit: { role: 'pageSize' as const },
    },
  },
};

describe('resolveEffectiveScheme', () => {
  it('auto-detects a scheme whose query parameters are all present on the operation', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.schemeName).toBe('pageNumber');
  });

  it('does not match when a required query parameter is missing', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      parameters: [{ name: 'page', in: 'query' }],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  it('never auto-detects a scheme with autoDetect: false', () => {
    const document = documentWith({
      pageNumber: { ...pageNumberScheme, autoDetect: false },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  it('excludes invalid schemes from auto-detection entirely', () => {
    const document = documentWith({
      broken: {
        // @ts-expect-error deliberately invalid type for the test
        type: 'offset',
        request: { queryParameters: { page: { role: 'page' } } },
      },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [{ name: 'page', in: 'query' }],
    };

    expect(resolveEffectiveScheme(document, operation)).toBeUndefined();
  });

  // #384 item 1: an explicit application is never dropped silently, since a
  // read that ignored it would return one page as the whole collection.
  it('fails an explicit x-pagination that names an invalid scheme, with the validation error', () => {
    const document = documentWith({
      links: {
        type: 'nextLink',
        response: {
          bodyFields: {
            // @ts-expect-error deliberately invalid base for the test
            next: { role: 'nextLink', linkResolution: { base: 'servr' } },
          },
        },
      },
    });
    const operation: OperationObject = {
      responses: {},
      'x-pagination': [{ scheme: 'links' }],
    };
    expect(() => resolveEffectiveScheme(document, operation)).toThrow(
      PaginationSchemeError,
    );
    expect(() => resolveEffectiveScheme(document, operation)).toThrow(
      /names the pagination scheme "links", which is invalid: .*linkResolution\.base must be one of request, server, or declared \(got "servr"\)/,
    );
  });

  it('fails an explicit x-pagination that names an undeclared scheme, or is malformed', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    expect(() =>
      resolveEffectiveScheme(document, {
        responses: {},
        'x-pagination': [{ scheme: 'cursor' }],
      }),
    ).toThrow(
      /names the pagination scheme "cursor", which the document does not declare/,
    );
    expect(() =>
      resolveEffectiveScheme(document, {
        responses: {},
        'x-pagination': { scheme: 'pageNumber' },
      }),
    ).toThrow(/x-pagination must be an array/);
    expect(() =>
      resolveEffectiveScheme(document, {
        responses: {},
        'x-pagination': [{ overrides: {} }],
      }),
    ).toThrow(/must be a Pagination Application Object with a "scheme" name/);
  });

  it('fails an explicit x-pagination whose overrides make the scheme invalid (checked after the merge)', () => {
    const document = documentWith({
      links: {
        type: 'nextLink',
        response: { bodyFields: { next: { role: 'nextLink' } } },
      },
    });
    expect(() =>
      resolveEffectiveScheme(document, {
        responses: {},
        'x-pagination': [
          {
            scheme: 'links',
            overrides: {
              response: {
                bodyFields: {
                  next: { linkResolution: { base: 'declared', url: 'v2/' } },
                },
              },
            },
          },
        ],
      }),
    ).toThrow(
      /overrides make the pagination scheme "links" invalid: .*linkResolution\.url/,
    );
  });

  it('falls through to auto-detection for an empty x-pagination array, as before', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
      'x-pagination': [],
    };
    expect(resolveEffectiveScheme(document, operation)?.schemeName).toBe(
      'pageNumber',
    );
  });

  it('prefers an explicit x-pagination application over auto-detection', () => {
    const document = documentWith({
      pageNumber: pageNumberScheme,
      cursor: {
        type: 'pageToken',
        request: { queryParameters: { cursor: { role: 'cursor' } } },
      },
    });
    const operation: OperationObject = {
      responses: {},
      parameters: [
        { name: 'page', in: 'query' },
        { name: 'limit', in: 'query' },
      ],
      'x-pagination': [{ scheme: 'cursor' }],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.schemeName).toBe('cursor');
  });

  it('deep-merges overrides from an explicit x-pagination application', () => {
    const document = documentWith({ pageNumber: pageNumberScheme });
    const operation: OperationObject = {
      responses: {},
      'x-pagination': [
        {
          scheme: 'pageNumber',
          overrides: {
            request: {
              queryParameters: { limit: { role: 'pageSize', required: true } },
            },
          },
        },
      ],
    };

    const effective = resolveEffectiveScheme(document, operation);
    expect(effective?.scheme.request?.queryParameters?.['limit']).toEqual({
      role: 'pageSize',
      required: true,
    });
    // Untouched sibling field from the base scheme survives the merge.
    expect(effective?.scheme.request?.queryParameters?.['page']).toEqual({
      role: 'page',
    });
  });
});
