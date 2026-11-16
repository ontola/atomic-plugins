// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  paginate,
  type OpenApiDocument,
  type Transport,
  type WalkOutcome,
} from '../../../src/browser.js';

const document = (): OpenApiDocument => ({
  openapi: '3.0.3',
  info: { title: 'Folder listing', version: '1' },
  servers: [{ url: 'https://storage.example/2' }],
  paths: {
    '/list_folder': {
      post: { 'x-pagination': [{ scheme: 'listing' }], responses: {} },
    },
    '/list_folder/continue': {
      post: { operationId: 'continueListing', responses: {} },
    },
  },
  components: {
    paginationSchemes: {
      listing: {
        type: 'pageToken',
        autoDetect: false,
        response: {
          envelope: { itemsField: 'entries' },
          bodyFields: { cursor: { role: 'nextCursor' } },
        },
        continuation: {
          operationId: 'continueListing',
          request: { bodyFields: { cursor: { role: 'cursor' } } },
          hasMoreField: 'has_more',
        },
      },
    },
  },
});

function provider(...pages: unknown[]): {
  requests: Parameters<Transport>[0][];
  transport: Transport;
} {
  const requests: Parameters<Transport>[0][] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: JSON.stringify(pages.shift()) };
  };
  return { transport, requests };
}

const options = {
  path: '/list_folder',
  method: 'POST' as const,
  body: { path: '', recursive: true },
};

describe('pagination across operations', () => {
  it('switches operations, advances across empty pages and resumes from the terminal cursor', async () => {
    const fake = provider(
      { entries: [{ id: 'one' }], cursor: 'a', has_more: true },
      { entries: [], cursor: 'b', has_more: true },
      { entries: [{ id: 'two' }], cursor: 'c', has_more: false },
      { entries: [], cursor: 'c', has_more: false },
    );
    const outcome: WalkOutcome = { complete: false };
    const doc = document();
    expect(
      await paginate(doc, { ...options, transport: fake.transport, outcome }),
    ).toEqual([{ id: 'one' }, { id: 'two' }]);
    expect(outcome).toEqual({ complete: true, checkpoint: 'c' });
    expect(
      await paginate(doc, {
        ...options,
        transport: fake.transport,
        outcome,
        checkpoint: outcome.checkpoint!,
      }),
    ).toEqual([]);
    expect(
      fake.requests.map((request) => [
        request.method,
        request.url.pathname,
        JSON.parse(request.body!),
      ]),
    ).toEqual([
      ['POST', '/2/list_folder', options.body],
      ['POST', '/2/list_folder/continue', { cursor: 'a' }],
      ['POST', '/2/list_folder/continue', { cursor: 'b' }],
      ['POST', '/2/list_folder/continue', { cursor: 'c' }],
    ]);
  });

  it.each([
    { entries: [], has_more: true },
    { entries: [], cursor: 'next', has_more: 'false' },
    { entries: [], cursor: 12, has_more: false },
    { entries: [], cursor: 'saved', has_more: true },
  ])(
    'rejects malformed or looping responses without issuing a checkpoint',
    async (page) => {
      const fake = provider(page);
      const outcome: WalkOutcome = { complete: true, checkpoint: 'old' };
      await expect(
        paginate(document(), {
          ...options,
          checkpoint: 'saved',
          transport: fake.transport,
          outcome,
        }),
      ).rejects.toThrow();
      expect(outcome).toEqual({ complete: false });
      expect(fake.requests).toHaveLength(1);
    },
  );

  it('shares the request budget across both operations', async () => {
    const fake = provider({ entries: [], cursor: 'next', has_more: true });
    const outcome: WalkOutcome = { complete: false };
    await expect(
      paginate(document(), {
        ...options,
        transport: fake.transport,
        outcome,
        limits: { maxRequests: 1 },
      }),
    ).rejects.toThrow('exceeds 1 requests');
    expect(outcome).toEqual({ complete: false });
    expect(fake.requests).toHaveLength(1);
  });

  it('rejects unknown continuation operations before sending the first request', async () => {
    const doc = document();
    delete doc.paths['/list_folder/continue'];
    const fake = provider();
    await expect(
      paginate(doc, { ...options, transport: fake.transport }),
    ).rejects.toThrow('unique GET or POST');
    expect(fake.requests).toHaveLength(0);
  });
});
