// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';

// #384 items 7 and 10b in the client: the deletion feed's envelope with
// `itemsField: null`, and the Collection Object's envelope in
// `ApiClient.paginate`. Invented document and responses.

const reply = (body: unknown): ReturnType<Transport> =>
  Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });

const doc: OpenApiDocument = {
  openapi: '3.1.0',
  info: { title: 'Envelopes', version: '1.0.0' },
  servers: [{ url: 'https://ledger.example/v1' }],
  paths: {
    '/entries': {
      get: {
        operationId: 'listEntries',
        responses: { '200': { description: 'Entries' } },
      },
    },
    '/entries/{entryId}': {
      get: { responses: { '200': { description: 'An entry' } } },
      put: { responses: { '200': { description: 'Updated' } } },
    },
    '/entry-changes': {
      get: {
        operationId: 'listEntryChanges',
        parameters: [
          { name: 'since', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'Changes' } },
      },
    },
  },
  components: {
    crudResources: {
      entry: {
        identity: {
          urlTemplate: '/entries/{entryId}',
          bindings: { entryId: { field: 'id' } },
        },
        collections: {
          entries: {
            urlTemplate: '/entries',
            envelope: { itemsField: 'data.entries' },
            'x-deletion-feed': {
              operationId: 'listEntryChanges',
              // null: the feed body is the array itself.
              envelope: { itemsField: null },
              cursor: { parameter: 'since', responseField: 'next' },
              tombstone: { field: 'gone', values: [true] },
            },
          },
        },
      },
    },
  },
};

describe('ApiClient.paginate applies the Collection Object envelope (item 10b)', () => {
  it('reads the list operation through the collection envelope', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply({ data: { entries: [{ id: 'e1' }, { id: 'e2' }] } }),
    );
    const client = createApiClient(doc, { transport });
    expect(await client.paginate('/entries')).toEqual([
      { id: 'e1' },
      { id: 'e2' },
    ]);
  });
});

describe('a deletion feed whose envelope is itemsField: null (item 7)', () => {
  it('parses the declaration and reads the feed body as the array', async () => {
    const feedReads: string[] = [];
    const transport = vi.fn<Transport>(async ({ url }) => {
      if (url.pathname.endsWith('/entry-changes')) {
        feedReads.push(url.search);
        // A feed read whose cursor the body does not carry is incomplete,
        // so the body must be an array for the read to count at all.
        return reply([{ id: 'e9', gone: true }]);
      }
      return reply({ data: { entries: [{ id: 'e1' }] } });
    });
    const client = createApiClient(doc, { transport });
    await client.sync();
    // The feed was read (the declaration parsed), once, without a cursor.
    expect(feedReads).toEqual(['']);
  });
});
