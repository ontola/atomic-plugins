// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  readCollections,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import { fixedReads } from '../../fixtures/fixed-reads.js';

const reply = (body: unknown) => ({
  status: 200,
  headers: {},
  body: JSON.stringify(body),
});

describe('selected Syncables collections', () => {
  const transport = () =>
    vi.fn<Transport>(async (request: TransportRequest) =>
      reply(
        request.method === 'POST'
          ? { results: [{ id: 'page-1' }], next_cursor: null }
          : { items: [{ id: 'task-1' }], nextPageToken: null },
      ),
    );

  it('reads just one root collection and does not require unrelated parameters', async () => {
    const fetch = transport();
    const result = await readCollections(fixedReads, {
      transport: fetch,
      collectionNames: ['searchedPages'],
    });
    expect(result.errors).toEqual([]);
    expect(
      result.collections.map((snapshot) => snapshot.collection.name),
    ).toEqual(['searchedPages']);
    expect(
      fetch.mock.calls.every(([request]) => request.method === 'POST'),
    ).toBe(true);
  });

  it('uses bound path parameters and never fetches other collections', async () => {
    const fetch = transport();
    const result = await readCollections(fixedReads, {
      transport: fetch,
      collectionNames: ['allTasks'],
      constants: { listId: 'selected-list' },
    });
    expect(result.errors).toEqual([]);
    expect(
      result.collections.map((snapshot) => snapshot.collection.name),
    ).toEqual(['allTasks']);
    expect(
      fetch.mock.calls.every(([request]) => request.method === 'GET'),
    ).toBe(true);
    expect(fetch.mock.calls[0]?.[0].url.pathname).toBe(
      '/lists/selected-list/tasks',
    );
  });

  it('refuses unknown names without sending provider requests', async () => {
    const fetch = transport();
    await expect(
      readCollections(fixedReads, {
        transport: fetch,
        collectionNames: ['not-a-collection'],
      }),
    ).rejects.toThrow('Unknown collection not-a-collection');
    expect(fetch).not.toHaveBeenCalled();
  });
});
