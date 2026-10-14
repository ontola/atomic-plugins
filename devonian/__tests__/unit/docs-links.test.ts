import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The entry documentation (#259): every relative link in README.md and
 * docs/*.md points at a file in this package, every `#fragment` at a
 * heading of its target, and no link points at the historical
 * tubsproject/devonian repository. Network-free; absolute http(s) links
 * are not fetched. Fenced code blocks are ignored.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const docs = [
  'README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** The text outside fenced code blocks. */
const prose = (text: string): string =>
  text.replace(/^```[\s\S]*?^```/gm, '').replace(/^~~~[\s\S]*?^~~~/gm, '');

/** Markdown link targets: `[text](target)`, without a title. */
function links(text: string): string[] {
  return [...prose(text).matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map(
    (m) => m[1],
  );
}

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to dashes. */
function anchors(markdown: string): Set<string> {
  const out = new Set<string>();
  for (const [, heading] of prose(markdown).matchAll(/^#{1,6}\s+(.+?)\s*$/gm))
    out.add(
      heading
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, '')
        .replace(/\s/g, '-'),
    );
  return out;
}

const relative = (target: string): boolean =>
  !/^[a-z][a-z0-9+.-]*:/i.test(target);

describe('entry documentation links', () => {
  it.each(docs)('%s links only to files that exist', (doc) => {
    const text = readFileSync(join(root, doc), 'utf8');
    const missing = links(text)
      .filter(relative)
      .filter((target) => !target.startsWith('#'))
      .map((target) => target.split('#')[0])
      .filter((target) => !existsSync(resolve(root, dirname(doc), target)));
    expect(missing).toEqual([]);
  });

  it.each(docs)('%s links only to headings that exist', (doc) => {
    const text = readFileSync(join(root, doc), 'utf8');
    const broken = links(text)
      .filter(relative)
      .filter((target) => target.includes('#'))
      .filter((target) => {
        const [path, fragment] = target.split('#');
        const file = path ? resolve(root, dirname(doc), path) : join(root, doc);
        if (!file.endsWith('.md') || !existsSync(file)) return false;
        return !anchors(readFileSync(file, 'utf8')).has(fragment);
      });
    expect(broken).toEqual([]);
  });

  it.each(docs)('%s does not link to the old tubsproject repository', (doc) => {
    expect(readFileSync(join(root, doc), 'utf8')).not.toMatch(
      /tubsproject\/devonian|tubsproject\.github\.io\/devonian/,
    );
  });

  it('README keeps the support matrix and the additions-only statement', () => {
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    expect(text).toMatch(/## Which API to use/);
    expect(text).toMatch(/\*\*Additions only\.\*\*/);
    expect(text).not.toMatch(/updates and deletions coming soon/i);
  });
});
