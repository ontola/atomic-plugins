import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { runAtomicTablesPeer } from '../../../src/daemon/atomic-peer.js';
import type { PreparedCollection } from '../../../src/daemon/sync.js';
import type { PostgresHistoryStore } from '../../../src/daemon/history-store.js';
import { nodeHash } from '../../../src/postgres/json-graph.js';

it.each(['wrong source', 'request change'])(
  'rejects a %s projection contract before native allocation',
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), 'syncables-contract-startup-'));
    const owner = 'atomic:agent:invented';
    const prepared: PreparedCollection = {
      source: {
        platform: 'invented',
        account: 'work',
        name: 'items',
        collection: 'items',
        connection: 'invented',
        document: 'invented.json',
        bindings: {},
        query: {},
        pollSeconds: 300,
      },
      scope: 'invented-scope',
      documentHash: '',
      document: {
        openapi: '3.0.3',
        info: { title: 'Invented API', version: '1' },
        servers: [{ url: 'https://api.example.test' }],
        components: {
          crudResources: {
            item: {
              schema: {
                type: 'object',
                properties: { id: { type: 'string' } },
              },
              identity: {
                urlTemplate: '/items/{id}',
                bindings: { id: { field: 'id' } },
              },
              collections: { items: { urlTemplate: '/items' } },
            },
          },
        },
        paths: {
          '/items': {
            get: {
              responses: {
                '200': {
                  content: {
                    'application/json': {
                      schema: { type: 'array', items: { type: 'object' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    prepared.documentHash = nodeHash(JSON.stringify(prepared.document));
    const store = {
      owner,
      head: async () => 'revision',
      revision: async () => ({
        id: 'revision',
        scope: prepared.scope,
        context_text: JSON.stringify({
          context: { documentHash: prepared.documentHash },
        }),
        resources: {},
      }),
    } as unknown as PostgresHistoryStore;
    try {
      await expect(
        runAtomicTablesPeer(
          store,
          {
            binary: join(root, 'missing-peer'),
            directory: join(root, 'native'),
            signerFile: join(root, 'unused-signer'),
            owner,
            readers: [owner],
            port: 9901,
            collections: [prepared],
            projectionContracts: [
              {
                sourceDocumentHash:
                  kind === 'wrong source'
                    ? 'b'.repeat(64)
                    : prepared.documentHash,
                overlay: {
                  overlay: '1.0.0',
                  info: { title: 'Invented projection', version: '1' },
                  actions: [
                    {
                      target:
                        kind === 'wrong source'
                          ? '$.components.crudResources'
                          : '$.servers',
                      update:
                        kind === 'wrong source'
                          ? {}
                          : [{ url: 'https://changed.example.test' }],
                    },
                  ],
                },
              },
            ],
          },
          new AbortController().signal,
          () => {
            throw new Error('Invalid contract reached native publication');
          },
        ),
      ).rejects.toThrow(/projection|contract|overlay/i);
      expect(existsSync(join(root, 'native'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
