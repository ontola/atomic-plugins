// @wc-ignore-file
/**
 * Pagination Schemes 0.4.0's two link-resolution examples, as the spec
 * gives them (`openapi-extensions/spec/pagination-schemes/README.md` §8.10
 * and §8.11, and its `examples/relative-next-link.yaml` and
 * `examples/declared-base.yaml`), transcribed to TypeScript for the read
 * tests. Both are synthetic: the first is shaped like classic Twilio list
 * responses, the second like a `Link` header meant relative to a declared
 * base. Neither is a declaration for a real API.
 */
import type { OpenApiDocument } from '../../src/browser.js';
import type { ResponseObject } from '../../src/openapi/types.js';

/** §8.10, `examples/relative-next-link.yaml`: `next_page_uri` is an absolute-path reference against the server. */
export const twilioShaped: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Illustrative relative next links', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com' }],
  components: {
    paginationSchemes: {
      linkedCollections: {
        type: 'nextLink',
        autoDetect: false,
        request: { queryParameters: { PageSize: { role: 'pageSize' } } },
        response: {
          bodyFields: {
            next_page_uri: {
              role: 'nextLink',
              linkResolution: {
                base: 'server',
                description:
                  'An absolute-path reference such as /2010-04-01/Accounts/AC0/Calls.json?Page=1.',
              },
            },
            previous_page_uri: {
              role: 'previousLink',
              linkResolution: { base: 'server' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/2010-04-01/Accounts/{AccountSid}/Calls.json': {
      get: {
        parameters: [
          {
            name: 'AccountSid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'PageSize',
            in: 'query',
            schema: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        ],
        'x-pagination': [
          {
            scheme: 'linkedCollections',
            overrides: { response: { envelope: { itemsField: 'calls' } } },
          },
        ],
        responses: {
          '200': {
            description: 'One page of calls.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    calls: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: { sid: { type: 'string' } },
                      },
                    },
                    next_page_uri: { type: 'string', nullable: true },
                    previous_page_uri: { type: 'string', nullable: true },
                    page: { type: 'integer' },
                    page_size: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

/** The path of `twilioShaped`'s one operation, bound to account `AC0`. */
export const callsPath = '/2010-04-01/Accounts/{AccountSid}/Calls.json';
export const callsUrl =
  'https://api.example.com/2010-04-01/Accounts/AC0/Calls.json';

/** §8.11, `examples/declared-base.yaml`: a relative `Link` header resolved against a declared base. */
export const declaredBase: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Illustrative declared link base', version: '1.0.0' },
  servers: [{ url: 'https://api.example.com/v2' }],
  components: {
    paginationSchemes: {
      linkHeader: {
        type: 'nextLink',
        autoDetect: false,
        request: { queryParameters: { limit: { role: 'pageSize' } } },
        response: {
          headers: {
            Link: {
              role: 'nextLink',
              linkResolution: {
                base: 'declared',
                url: 'https://api.example.com/v2/',
              },
            },
          },
        },
      },
    },
  },
  paths: {
    '/projects/{projectId}/items': {
      get: {
        parameters: [
          {
            name: 'projectId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
        ],
        'x-pagination': [{ scheme: 'linkHeader' }],
        responses: {
          // The example documents the Link header on the response; the
          // package's minimal ResponseObject type has no `headers`, so this
          // object is typed loosely.
          '200': {
            description: 'One page of items; the body is the array.',
            headers: {
              Link: {
                description:
                  'RFC 8288 links; rel="next" is a relative reference such as <items?cursor=abc>.',
                schema: { type: 'string' },
              },
            },
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { id: { type: 'string' } },
                  },
                },
              },
            },
          } as unknown as ResponseObject,
        },
      },
    },
  },
};

export const itemsPath = '/projects/{projectId}/items';
