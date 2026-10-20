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
            query: { b: '2', a: '1' },
          },
        ],
      };
      await writeFile(file, JSON.stringify(value));
      const config = await loadDaemonConfig(file);
      const source = config.collections[0];
      expect(source.document).toBe(join(dir, 'source.json'));
      expect(source.pollSeconds).toBe(0);
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
          { ...source, pollSeconds: 300, query: { a: '1', b: '2' } },
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
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
