import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addConnection,
  defineConnection,
  listReplication,
} from '../../../src/cli/replication.js';

describe('replication connection scaffold', () => {
  it('persists all three definitions without activating replication or overwriting names', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'syncables-replication-'));
    try {
      const definitions = [
        defineConnection({
          name: 'ontola',
          backend: 'atomic',
          collections: 'issues,comments',
          url: 'http://localhost:11870',
          drive: 'atomic:demo',
        }),
        defineConnection({
          name: 'nextgraph',
          backend: 'nextgraph',
          collections: 'issues',
          graph: 'did:ng:o:demo',
        }),
        defineConnection({
          name: 'storage',
          backend: 'remotestorage',
          collections: 'issues',
          address: 'demo@example.com',
          module: 'syncables',
        }),
      ];
      await Promise.all(
        definitions.map((entry) => addConnection(directory, entry)),
      );
      expect(await listReplication(directory)).toEqual([
        definitions[1],
        definitions[0],
        definitions[2],
      ]);
      expect((await stat(join(directory, 'ontola.json'))).mode & 0o777).toBe(
        0o600,
      );
      await expect(addConnection(directory, definitions[0])).rejects.toThrow(
        'already exists',
      );
      expect(await listReplication(directory)).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('requires explicit collection scope and rejects path traversal', () => {
    expect(() =>
      defineConnection({
        name: '../escape',
        backend: 'nextgraph',
        collections: 'issues',
        graph: 'did:ng:o:demo',
      }),
    ).toThrow('Connection name');
    expect(() =>
      defineConnection({
        name: 'demo',
        backend: 'nextgraph',
        graph: 'did:ng:o:demo',
      }),
    ).toThrow('--collections');
    expect(() =>
      defineConnection({
        name: 'demo',
        backend: 'unknown',
        collections: 'issues',
      }),
    ).toThrow('Backend');
  });
});
