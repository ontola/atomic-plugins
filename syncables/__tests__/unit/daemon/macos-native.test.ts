import { describe, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildMacApp, macNative } from '../../../src/macos/native.js';

describe.skipIf(process.platform !== 'darwin')(
  'native macOS filesystem adapter',
  () => {
    it('scans metadata, streams explicit content, and refuses overwrite, traversal and symlink escape', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'syncables-native-'));
      try {
        const root = join(directory, 'root');
        await mkdir(root);
        const native = macNative(await buildMacApp(directory), directory);
        const bytes = 'Invented native storage content\n';
        const blob = join(directory, 'blob');
        await writeFile(blob, bytes, { mode: 0o600 });
        const write = {
          operation: 'write',
          directory: root,
          path: 'nested/test.txt',
          kind: 'file',
          modifiedTime: '2025-01-02T03:04:05.123Z',
          blob,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
        expect(await native(write)).toEqual({ localStatus: 'written' });
        expect(await readFile(join(root, 'nested/test.txt'), 'utf8')).toBe(
          bytes,
        );
        expect(
          Math.abs(
            (await stat(join(root, 'nested/test.txt'))).mtimeMs -
              Date.parse('2025-01-02T03:04:05.123Z'),
          ),
        ).toBeLessThan(1);
        const scan = await native({ operation: 'drive', directory: root });
        expect(scan.complete).toBe(true);
        expect(scan.items).toHaveLength(2);
        const exported = join(directory, 'exported');
        expect(
          await native({
            operation: 'content',
            directory: root,
            path: 'nested/test.txt',
            export: exported,
          }),
        ).toEqual({ exported: true });
        expect(await readFile(exported, 'utf8')).toBe(bytes);
        await expect(native(write)).rejects.toThrow('Filesystem');
        await expect(
          native({ ...write, path: '../escaped.txt' }),
        ).rejects.toThrow('Filesystem');
        await symlink(directory, join(root, 'escape'));
        await expect(
          native({ ...write, path: 'escape/escaped.txt' }),
        ).rejects.toThrow('Filesystem');
        await expect(
          native({ ...write, path: 'corrupt.txt', sha256: '0'.repeat(64) }),
        ).rejects.toThrow('Filesystem');
        expect(await readFile(join(root, 'nested/test.txt'), 'utf8')).toBe(
          bytes,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
