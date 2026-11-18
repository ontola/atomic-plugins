import type { OpenApiDocument, SchemaObject } from '../openapi/types.js';

/** The native service is consumed by the ordinary OpenAPI collection reader. */
export function macDocument(
  url: string,
  directory: string,
  photos: boolean,
  writable: boolean,
): OpenApiDocument {
  const string: SchemaObject = { type: 'string' };
  const properties = {
    id: { ...string, readOnly: true },
    operationId: string,
    path: string,
    kind: { type: 'string', enum: ['file', 'directory'] },
    sha256: string,
    modifiedTime: string,
    localStatus: { ...string, readOnly: true },
    uploadStatus: { ...string, readOnly: true },
  };
  const document: OpenApiDocument = {
    openapi: '3.1.0',
    info: { title: 'Syncables macOS storage', version: '1' },
    servers: [{ url }],
    'x-syncables-native-scope': {
      version: 1,
      adapter: 'macos',
      directory,
      photos: photos ? 'system-user-library-visible-assets' : false,
    },
    paths: {},
    components: {
      schemas: {
        File: {
          type: 'object',
          properties: {
            id: string,
            name: string,
            path: string,
            kind: string,
            size: string,
            modifiedTime: string,
            uploadStatus: string,
            downloadStatus: string,
          },
        },
        Photo: {
          type: 'object',
          properties: {
            id: string,
            localIdentifier: string,
            cloudIdentifier: string,
            name: string,
            mediaType: string,
            pixelWidth: { type: 'integer' },
            pixelHeight: { type: 'integer' },
            durationSeconds: { type: 'number' },
            livePhoto: { type: 'boolean' },
            resources: { type: 'array', items: { type: 'object' } },
          },
        },
        Transfer: { type: 'object', properties },
      },
      paginationSchemes: {
        pages: {
          type: 'pageToken',
          request: { queryParameters: { cursor: { role: 'cursor' } } },
          response: {
            bodyFields: { nextCursor: { role: 'nextCursor' } },
            envelope: { itemsField: 'items' },
          },
        },
      },
      crudResources: {},
    },
  };
  for (const [name, schema] of [
    ['files', 'File'],
    ...(photos ? [['photos', 'Photo']] : []),
    ['transfers', 'Transfer'],
  ]) {
    const resource = 'macos-' + name;
    document.paths['/' + name] = {
      get: {
        'x-pagination': [{ scheme: 'pages' }],
        parameters: [{ name: 'cursor', in: 'query', schema: string }],
        responses: {
          '200': {
            description: 'One page from a bounded local observation',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/' + schema },
                    },
                    nextCursor: string,
                  },
                },
              },
            },
          },
        },
      },
    };
    document.paths['/' + name + '/{id}'] = {
      get: {
        'x-crud': { resource, action: 'read' },
        responses: {
          '200': {
            description: 'Metadata item',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/' + schema },
              },
            },
          },
        },
      },
    };
    (document.components!.crudResources as Record<string, unknown>)[resource] =
      {
        identity: {
          urlTemplate: '/' + name + '/{id}',
          bindings: { id: { field: 'id' } },
        },
        collections: {
          [name]: {
            urlTemplate: '/' + name,
            envelope: { itemsField: 'items' },
          },
        },
      };
  }
  document.paths['/files/{id}/content'] = {
    get: {
      parameters: [{ name: 'id', in: 'path', required: true, schema: string }],
      responses: {
        '200': {
          description:
            'Explicit content read, which may download a cloud-only file',
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
      },
    },
  };
  if (writable) {
    document.paths['/transfers'].post = {
      'x-crud': {
        resource: 'macos-transfers',
        action: 'create',
        url: { source: 'template' },
        addedFields: { id: { source: 'generated' } },
      },
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Transfer' },
          },
        },
      },
      responses: {
        '201': {
          description: 'Local write receipt',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Transfer' },
            },
          },
        },
      },
    };
  }
  return document;
}
