import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The entry documentation (#259): every relative link in README.md and
 * docs/*.md points at a file in this package, and no link points at the
 * historical tubsproject/devonian repository. Network-free; absolute
 * http(s) links are not fetched.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docs = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** Markdown link targets: `[text](target)`, without a title. */
function links(text: string): string[] {
  return [...text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
}

describe('entry documentation links', () => {
  it.each(docs)('%s links only to files that exist', (doc) => {
    const text = readFileSync(join(root, doc), 'utf8');
    const missing = links(text)
      .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target))
      .filter((target) => !target.startsWith('#'))
      .map((target) => target.split('#')[0])
      // Links out of the package (for example to the repository's
      // workflows) are checked against the repository checkout.
      .filter((target) => !existsSync(resolve(root, dirname(doc), target)));
    expect(missing).toEqual([]);
  });

  it.each(docs)('%s does not link to the old tubsproject repository', (doc) => {
    expect(readFileSync(join(root, doc), 'utf8')).not.toMatch(
      /tubsproject\/devonian|tubsproject\.github\.io\/devonian/,
    );
  });

  it('README states that the legacy lens copies additions only', () => {
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    expect(text).toMatch(/## Which API to use/);
    expect(text).toMatch(/\*\*Additions only\.\*\*/);
    expect(text).not.toMatch(/updates and deletions coming soon/i);
    expect(text).not.toMatch(/Short answer: DON'T/);
  });
});
