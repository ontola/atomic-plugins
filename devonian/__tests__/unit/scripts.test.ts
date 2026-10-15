import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The post-build scripts select test files by vitest filters. A filter that
 * stops matching (a renamed folder) would let the script pass on the
 * others alone, so every filter must match at least one test file.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scripts = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;

const testFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? testFiles(join(dir, e.name))
      : /\.test\.ts$/.test(e.name)
        ? [relative(root, join(dir, e.name))]
        : [],
  );
const files = testFiles(join(root, '__tests__'));

/** The filters after `vitest run`, up to the first option. */
const filters = (script: string): string[] => {
  const words = script.split(/\s+/);
  const start = words.indexOf('run') + 1;
  const end = words.findIndex((w, i) => i >= start && w.startsWith('-'));

  return words.slice(start, end < 0 ? undefined : end);
};

describe('post-build test scripts', () => {
  it.each(['test:browser-build', 'test:packaged'])(
    '%s: every filter matches a test file',
    (name) => {
      const wanted = filters(scripts[name]);
      expect(wanted.length).toBeGreaterThan(0);
      const unmatched = wanted.filter(
        (filter) => !files.some((f) => f.includes(filter)),
      );
      expect(unmatched).toEqual([]);
    },
  );

  it('test:browser-build runs the packaged consumer', () => {
    expect(filters(scripts['test:browser-build'])).toContain('packaged');
  });
});
