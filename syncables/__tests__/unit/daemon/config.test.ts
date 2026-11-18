import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  collectionScope,
  loadDaemonConfig,
  selectedCollections,
} from '../../../src/daemon/config.js';

describe('configured daemon scope', () => {
  it.each([
    [undefined, 'https://integrations.atomic.place'],
    ['https://proxy.example', 'https://proxy.example'],
    ['http://127.0.0.1:11872', 'http://127.0.0.1:11872'],
    ['https://localthought.io', 'https://localthought.io'],
  ])(
    'uses issuer %s without retargeting explicit configurations',
    async (issuer, expected) => {
      const dir = await mkdtemp(join(tmpdir(), 'syncables-issuer-'));
      try {
        const file = join(dir, 'config.json');
        await writeFile(
          file,
          JSON.stringify({
            version: 1,
            owner: 'invented-owner',
            ...(issuer === undefined ? {} : { issuer }),
            collections: [
              {
                platform: 'example',
                account: 'work',
                name: 'entries',
                connection: 'existing-connection',
                document: 'source.json',
                collection: 'entries',
              },
            ],
          }),
        );
        const config = await loadDaemonConfig(file);
        expect(config.issuer).toBe(expected);
        expect(config.collections[0].connection).toBe('existing-connection');
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it('resolves local files relative to config and scopes checkpoints to definition/query, not polling', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'syncables-config-'));
    try {
      const file = join(dir, 'config.json');
      const value = {
        version: 1,
        owner: 'invented-owner',
        collections: [
          {
            platform: 'example',
            account: 'work',
            name: 'entries',
            connection: 'test',
            document: 'source.json',
            collection: 'entries',
            pollSeconds: 0,
            readLimits: { maxRecords: 10_000, maxRequests: 2500 },
            query: { b: '2', a: '1' },
          },
        ],
      };
      await writeFile(file, JSON.stringify(value));
      const config = await loadDaemonConfig(file);
      const source = config.collections[0];
      expect(source.document).toBe(join(dir, 'source.json'));
      expect(config.checkoutDirectory).toBeUndefined();
      await writeFile(
        file,
        JSON.stringify({ ...value, checkoutDirectory: 'my-data' }),
      );
      expect((await loadDaemonConfig(file)).checkoutDirectory).toBe(
        join(dir, 'my-data'),
      );
      expect(source.pollSeconds).toBe(0);
      expect(source.readLimits).toEqual({
        maxRecords: 10_000,
        maxRequests: 2500,
      });
      expect(selectedCollections(config, ['example/work/entries'])).toEqual([
        source,
      ]);
      expect(() =>
        selectedCollections(config, ['example/work/missing']),
      ).toThrow('Unknown');
      const scope = collectionScope(config.owner, source, 'definition');
      expect(
        collectionScope(
          config.owner,
          {
            ...source,
            readLimits: { timeoutMs: 2000 },
            pollSeconds: 300,
            query: { a: '1', b: '2' },
          },
          'definition',
        ),
      ).toBe(scope);
      expect(
        collectionScope(
          config.owner,
          { ...source, query: { a: '3' } },
          'definition',
        ),
      ).not.toBe(scope);
      expect(collectionScope(config.owner, source, 'changed')).not.toBe(scope);
      await writeFile(
        file,
        JSON.stringify({
          ...value,
          collections: [value.collections[0], value.collections[0]],
        }),
      );
      await expect(loadDaemonConfig(file)).rejects.toThrow('Duplicate');
      for (const readLimits of [
        { maxRecords: 0 },
        { maxRequests: '5' },
        { timeoutMs: 1.5 },
        { maxRetries: 3 },
      ]) {
        await writeFile(
          file,
          JSON.stringify({
            ...value,
            collections: [{ ...value.collections[0], readLimits }],
          }),
        );
        await expect(loadDaemonConfig(file)).rejects.toThrow(
          'Invalid collection readLimits',
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
