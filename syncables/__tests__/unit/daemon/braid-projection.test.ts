import { describe, it, expect } from 'vitest';
import { startBraidServer } from '../../../src/daemon/braid.js';
import type { HistoryRevision } from '../../../src/daemon/history-store.js';

describe('Braid representation namespaces', () => {
  it('separates raw, recursive, and revised schema projections without rewriting source revisions', async () => {
    const revision = {
      id: 'a'.repeat(64),
      scope: 'invented-scope',
      parents: [],
      resources: { 'urn:test': 'hash' },
    } as unknown as HistoryRevision;
    const store = {
      head: async () => revision.id,
      revision: async () => revision,
      render: async () => '{"@id":"urn:test"}',
    };
    const token = 'invented-local-projection-reader-token';
    const versions: string[] = [];
    for (const key of [undefined, 'schema-one', 'schema-two']) {
      const server = await startBraidServer({
        store,
        token,
        port: 0,
        collections: [
          {
            alias: 'example/work/notes',
            scope: revision.scope,
            ...(key
              ? {
                  format: 'syncd-braid-atomic-v1',
                  projectionKey: key,
                  project: () => ({ 'urn:linked': '{"@id":"urn:linked"}' }),
                }
              : {}),
          },
        ],
      });
      try {
        const url = server.url + '/collections/example%2Fwork%2Fnotes';
        expect((await fetch(url)).status).toBe(401);
        const response = await fetch(url, {
          headers: { authorization: 'Bearer ' + token },
        });
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.revision).toBe(revision.id);
        expect(body.resources).toHaveProperty(key ? 'urn:linked' : 'urn:test');
        if (versions.length)
          expect(
            (
              await fetch(url, {
                headers: {
                  authorization: 'Bearer ' + token,
                  version: versions[0],
                },
              })
            ).status,
          ).toBe(409);
        versions.push(response.headers.get('version')!);
      } finally {
        await server.close();
      }
    }
    expect(new Set(versions).size).toBe(3);
  });
});
