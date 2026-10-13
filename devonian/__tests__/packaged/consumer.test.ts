import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The packed package, consumed the way an npm user consumes it (#259):
 * `pnpm pack`, the tarball extracted into a consumer's node_modules, its
 * runtime dependencies linked from this package's own install (no
 * network), and examples/packaged-consumer/consumer.mjs run there with
 * plain `node`. Needs `pnpm build` first, so it runs only with
 * DEVONIAN_TEST_BUILD=1 (`pnpm run test:browser-build`, which CI runs
 * after the build, or `pnpm run test:packaged`).
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
};
const enabled = process.env.DEVONIAN_TEST_BUILD === '1';

describe.runIf(enabled)('the packed devonian, as an npm consumer', () => {
  let work = '';
  let unpacked = '';
  let consumer = '';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'devonian-packed-'));
    execFileSync('pnpm', ['pack', '--pack-destination', work], {
      cwd: root,
      stdio: 'pipe',
    });
    const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
    if (!tarball) throw new Error('pnpm pack wrote no tarball');
    execFileSync('tar', ['-xzf', join(work, tarball), '-C', work]);
    unpacked = join(work, 'package');

    consumer = join(work, 'consumer');
    const modules = join(consumer, 'node_modules');
    mkdirSync(modules, { recursive: true });
    cpSync(unpacked, join(modules, 'devonian'), { recursive: true });
    // Runtime dependencies from this package's own install: what `npm
    // install` would add. Plus @tomic/lib, an optional peer the native API
    // needs, which npm does not install: a consumer installs it themselves,
    // as the README's Usage says.
    for (const name of [...Object.keys(pkg.dependencies), '@tomic/lib']) {
      const target = join(modules, name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(realpathSync(join(root, 'node_modules', name)), target);
    }
    cpSync(
      join(root, 'examples/packaged-consumer/consumer.mjs'),
      join(consumer, 'consumer.mjs'),
    );
  }, 120_000);

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('holds every exports entry point and no test sources', () => {
    const unpackedPkg = JSON.parse(
      readFileSync(join(unpacked, 'package.json'), 'utf8'),
    );
    expect(unpackedPkg.version).toBe(pkg.version);

    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const files =
        typeof target === 'string'
          ? [target]
          : Object.values(target as Record<string, string>);
      for (const file of files)
        expect(existsSync(join(unpacked, file)), `${subpath}: ${file}`).toBe(
          true,
        );
    }

    // `tsc` compiles __tests__ and examples into build/ too; `files` ships
    // only build/src.
    const shipped = ['__tests__', 'examples', 'build/__tests__', 'build/examples'];
    expect(shipped.filter((dir) => existsSync(join(unpacked, dir)))).toEqual([]);
    expect(readdirSync(join(unpacked, 'build'))).toEqual(['src']);
    const tests = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? tests(join(dir, e.name))
          : /\.(test|spec)\.[cm]?[jt]s$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    expect(tests(unpacked)).toEqual([]);
  });

  it('runs ingest, edit, publish, failure, checkpoint and restart', () => {
    const state = join(work, 'state');
    mkdirSync(state);
    const out = execFileSync('node', ['consumer.mjs', state], {
      cwd: consumer,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const summary = JSON.parse(out.trim().split('\n').pop() ?? '{}');
    expect(summary).toEqual({
      ingested: 'Write docs',
      afterEdit: { id: 't0', title: 'Write docs', done: true, labels: ['x'] },
      failure: 'platform unavailable',
      afterRetry: 'Write the docs',
      createdId: 't1',
      afterRestartId: 't1',
      platformRecords: 2,
      creates: 1,
    });
    expect(existsSync(join(state, 'state.json'))).toBe(true);
  });
});
