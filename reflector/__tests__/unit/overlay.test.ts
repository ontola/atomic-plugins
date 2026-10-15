import { describe, expect, it } from 'vitest';
import {
  adaptSchemesForSyncables,
  applicationProblem,
  applyOverlay,
  parseTarget,
  pinItemsFields,
  type OverlayDocument,
} from '../../src/sync/overlay.js';

describe('parseTarget', () => {
  it('parses the document root', () => {
    expect(parseTarget('$')).toEqual([]);
  });

  it('parses dot paths', () => {
    expect(parseTarget('$.components.paginationSchemes')).toEqual([
      'components',
      'paginationSchemes',
    ]);
  });

  it('parses quoted bracket paths containing slashes and braces', () => {
    expect(parseTarget("$.paths['/calendars/{calendarId}/events'].get")).toEqual([
      'paths',
      '/calendars/{calendarId}/events',
      'get',
    ]);
  });
});

describe('applyOverlay', () => {
  it('deep-merges update actions and creates missing parents', () => {
    const doc = { paths: { "/calendars/{calendarId}/events": { get: {} } } };
    const overlay: OverlayDocument = {
      overlay: '1.0.0',
      info: { title: 't', version: '1' },
      actions: [
        {
          target: "$.paths['/calendars/{calendarId}/events'].get",
          update: { 'x-pagination': [{ scheme: 'eventSync' }] },
        },
      ],
    };
    const result = applyOverlay(doc, overlay);
    expect(result.paths['/calendars/{calendarId}/events'].get).toEqual({
      'x-pagination': [{ scheme: 'eventSync' }],
    });
  });

  it('does not mutate the input document', () => {
    const doc = { components: {} as Record<string, unknown> };
    applyOverlay(doc, {
      overlay: '1.0.0',
      info: { title: 't', version: '1' },
      actions: [{ target: '$.components', update: { added: true } }],
    });
    expect(doc.components).toEqual({});
  });
});

describe('adaptSchemesForSyncables', () => {
  it('rewrites incrementalSync to pageToken and drops sync-token roles', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {},
      components: {
        paginationSchemes: {
          eventSync: {
            type: 'incrementalSync',
            request: {
              queryParameters: {
                maxResults: { role: 'pageSize' },
                pageToken: { role: 'pageToken' },
                syncToken: { role: 'syncToken' },
              },
            },
            response: {
              envelope: { itemsField: 'items' },
              bodyFields: {
                nextPageToken: { role: 'nextPageToken' },
                nextSyncToken: { role: 'nextSyncToken' },
              },
            },
          },
        },
      },
    };
    const adapted = adaptSchemesForSyncables(doc as never) as unknown as typeof doc;
    const scheme = adapted.components.paginationSchemes.eventSync;
    expect(scheme.type).toBe('pageToken');
    expect(Object.keys(scheme.request.queryParameters)).toEqual(['maxResults', 'pageToken']);
    expect(Object.keys(scheme.response.bodyFields)).toEqual(['nextPageToken']);
    // The envelope hint is preserved and harmless.
    expect(scheme.response.envelope).toEqual({ itemsField: 'items' });
  });
});

interface ListDocument {
  [key: string]: unknown;
  paths: Record<
    string,
    {
      get: {
        [key: string]: unknown;
        responses: Record<
          string,
          {
            content: Record<
              string,
              {
                schema: {
                  [key: string]: unknown;
                  properties: Record<string, unknown>;
                };
              }
            >;
          }
        >;
      };
    }
  >;
}

describe('pinItemsFields', () => {
  function documentWith(application: unknown): ListDocument {
    return {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {
        '/events': {
          get: {
            'x-pagination': application,
            responses: {
              '200': {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        defaultReminders: { type: 'array' },
                        items: { type: 'array' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        paginationSchemes: {
          pages: {
            type: 'pageToken',
            response: { envelope: { itemsField: 'items' } },
          },
        },
      },
    };
  }

  function properties(doc: ListDocument): string[] {
    return Object.keys(
      doc.paths['/events'].get.responses['200'].content['application/json']
        .schema.properties,
    );
  }

  it('keeps only the declared items array of a well-formed application', () => {
    const doc = documentWith([
      { scheme: 'pages', description: 'd', 'x-note': 1, overrides: {} },
    ]);
    pinItemsFields(doc as never);
    expect(properties(doc)).toEqual(['items']);
  });

  it.each([
    [
      [{ scheme: 'pages', overide: {} }],
      'has a field the spec does not define: overide',
    ],
    [
      [{ scheme: '' }],
      'must be a Pagination Application Object with a "scheme" name',
    ],
    [['pages'], 'must be a Pagination Application Object with a "scheme" name'],
    [[{ scheme: 'pages', overrides: [] }], 'overrides must be an object'],
    [[{ scheme: 'pages', description: 1 }], 'description must be a string'],
    [
      [{ scheme: 'pages' }, { scheme: 'pages', extra: true }],
      'has a field the spec does not define: extra',
    ],
  ])('refuses %j, as syncables does', (application, problem) => {
    const doc = documentWith(application);
    const index = (application as unknown[]).findIndex(
      (entry) => applicationProblem(entry) !== undefined,
    );
    expect(() => pinItemsFields(doc as never)).toThrow(
      `paths['/events'].get.x-pagination[${index}] ${problem}`,
    );
    // Nothing is pinned from a refused application.
    expect(properties(doc)).toEqual(['defaultReminders', 'items']);
  });
});
