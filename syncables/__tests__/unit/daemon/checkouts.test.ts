import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitAtomicStore } from '../../../src/daemon/git-store.js';
import { nodeHash } from '../../../src/postgres/json-graph.js';

const exec = promisify(execFile);
const dirs: string[] = [];
const subject = 'urn:example:item';
const resource = (value: number): Map<string, string> =>
  new Map([
    [subject, JSON.stringify({ '@id': subject, 'urn:example:value': value })],
  ]);
async function setup(): Promise<GitAtomicStore> {
  const dir = await mkdtemp(join(tmpdir(), 'syncables checkouts '));
  dirs.push(dir);
  const store = new GitAtomicStore(join(dir, 'data.git'));
  await store.initialize();
  return store;
}
async function git(folder: string, ...args: string[]): Promise<string> {
  return (await exec('git', ['-C', folder, ...args])).stdout.trim();
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe('automatic normal Git working folders', () => {
  it('materializes existing multi-collection histories and updates without cloning', async () => {
    const store = await setup();
    const first = await store.commit({
      scope: 'keep',
      context: {},
      resources: resource(1),
    });
    const second = await store.commit(
      { scope: 'keep', context: {}, resources: resource(2) },
      first,
    );
    const issues = await store.commit({
      scope: 'issues',
      context: {},
      resources: resource(3),
    });
    const a = await store.checkout('keep', 'google-keep/example/notes');
    const b = await store.checkout('issues', 'github-issues/example/issues');
    expect(a?.revision).toBe(second);
    expect(b?.revision).toBe(issues);
    expect(await git(a!.directory, 'log', '--format=%H')).toBe(
      second + '\n' + first,
    );
    expect(await git(a!.directory, 'status', '--porcelain')).toBe('');
    expect(
      await readFile(
        join(a!.directory, 'r-' + nodeHash(subject) + '.json'),
        'utf8',
      ),
    ).toContain(':2}');
    const third = await store.commit(
      { scope: 'keep', context: {}, resources: resource(4) },
      second,
    );
    expect(
      (await store.checkout('keep', 'google-keep/example/notes'))?.revision,
    ).toBe(third);
    expect(await git(a!.directory, 'rev-parse', 'HEAD')).toBe(third);
    expect(await git(b!.directory, 'rev-parse', 'HEAD')).toBe(issues);
    expect(await store.history('keep')).toEqual([third, second, first]);
  });
  it('preserves tracked edits, untracked files and locally committed work', async () => {
    const store = await setup();
    const first = await store.commit({
      scope: 'keep',
      context: {},
      resources: resource(1),
    });
    const folder = (await store.checkout('keep', 'google-keep/example/notes'))!
      .directory;
    const file = join(folder, 'r-' + nodeHash(subject) + '.json');
    const original = await readFile(file, 'utf8');
    await writeFile(file, 'local edit');
    await store.commit(
      { scope: 'keep', context: {}, resources: resource(2) },
      first,
    );
    await expect(
      store.checkout('keep', 'google-keep/example/notes'),
    ).rejects.toThrow('local edits');
    expect(await readFile(file, 'utf8')).toBe('local edit');
    expect(await git(folder, 'rev-parse', 'HEAD')).toBe(first);
    await writeFile(file, original);
    await writeFile(join(folder, 'private.txt'), 'local file');
    await expect(
      store.checkout('keep', 'google-keep/example/notes'),
    ).rejects.toThrow('untracked');
    await git(folder, 'add', 'private.txt');
    await git(
      folder,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'Local work',
    );
    await expect(
      store.checkout('keep', 'google-keep/example/notes'),
    ).rejects.toThrow('HEAD does not belong');
    expect(await readFile(join(folder, 'private.txt'), 'utf8')).toBe(
      'local file',
    );
  });
  it('refuses unrelated folders, symlinks, another archive and changed definitions', async () => {
    const store = await setup();
    await store.commit({ scope: 'one', context: {}, resources: resource(1) });
    const folder = join(store.checkoutDirectory, 'example', 'work', 'items');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'existing'), 'preserve');
    await expect(store.checkout('one', 'example/work/items')).rejects.toThrow(
      'not a managed',
    );
    expect(await readFile(join(folder, 'existing'), 'utf8')).toBe('preserve');
    await rm(folder, { recursive: true });
    await symlink(store.directory, folder);
    await expect(store.checkout('one', 'example/work/items')).rejects.toThrow(
      'symlink',
    );
    await rm(folder);
    await symlink(store.directory, join(store.checkoutDirectory, 'linked'));
    await expect(store.checkout('one', 'linked/work/items')).rejects.toThrow(
      'symlink',
    );
    await store.checkout('one', 'example/work/items');
    await store.commit({ scope: 'two', context: {}, resources: resource(2) });
    await expect(store.checkout('two', 'example/work/items')).rejects.toThrow(
      'HEAD does not belong',
    );
    const other = new GitAtomicStore(join(dirs.at(-1)!, 'other.git'));
    await other.initialize();
    await other.commit({ scope: 'one', context: {}, resources: resource(3) });
    await expect(other.checkout('one', 'example/work/items')).rejects.toThrow(
      'different repository',
    );
  });
  it('rejects traversal and a checkout root inside the archive; missing snapshots create no worktree', async () => {
    const store = await setup();
    await expect(store.checkout('one', '../work/items')).rejects.toThrow(
      'Invalid checkout',
    );
    expect(
      () => new GitAtomicStore(store.directory, join(store.directory, 'data')),
    ).toThrow('outside');
    expect(
      await store.checkout('missing', 'example/work/items'),
    ).toBeUndefined();
    expect(
      await readdir(join(store.checkoutDirectory, 'example', 'work')),
    ).toEqual([]);
  });
});
