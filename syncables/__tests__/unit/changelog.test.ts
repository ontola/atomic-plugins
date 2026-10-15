// @wc-ignore-file
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  insertEntry,
  readFragments,
  renderEntry,
} from '../../scripts/changelog.mjs';

// Changelog fragments (changes/<name>.<kind>.md), folded into the README's
// changelog by `npm run changelog -- --release <version>`, so parallel PRs
// do not all edit the same Unreleased lines.

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const withFiles = (files: Record<string, string>): string => {
  dir = mkdtempSync(join(tmpdir(), 'syncables-changes-'));
  for (const [name, text] of Object.entries(files))
    writeFileSync(join(dir, name), text);
  return dir;
};

describe('changelog fragments', () => {
  it('folds them into one entry, behaviour changes first', () => {
    const { fragments, problems } = readFragments(
      withFiles({
        'README.md': 'not a fragment',
        'b-feature.added.md': 'A new `thing`, which\ndoes this.\n',
        'a-fix.fixed.md': 'A fix.\n',
        '609.behaviour.md': 'Explicit entries must have\nthe shape.\n',
        'a-feature.added.md': 'Another addition.\n',
      }),
    );
    expect(problems).toEqual([]);
    expect(renderEntry('0.25.0', fragments, 'Two things.')).toBe(
      [
        '- **0.25.0**: Two things.',
        '  - **Behaviour change:** Explicit entries must have',
        '    the shape.',
        '  - **Added:** Another addition.',
        '  - **Added:** A new `thing`, which',
        '    does this.',
        '  - **Fixed:** A fix.',
        '',
      ].join('\n'),
    );
  });

  it.each([
    ['NoKind.md', 'x', 'not <name>.<kind>.md'],
    ['x.breaking.md', 'x', 'kind breaking is not one of'],
    ['x.added.md', '  \n', 'empty'],
    ['x.added.md', 'one\n\ntwo\n', 'more than one paragraph'],
    ['x.added.md', '- a bullet\n', 'starts with a list marker'],
  ])('refuses %s with %j', (file, text, problem) => {
    const { fragments, problems } = readFragments(withFiles({ [file]: text }));
    expect(fragments).toEqual([]);
    expect(problems.join('\n')).toContain(problem);
  });

  it('puts the entry first under ## Changelog', () => {
    const readme = '# X\n\n## Changelog\n\n- **0.24.0**: before.\n';
    expect(insertEntry(readme, '- **0.25.0**: now.\n')).toBe(
      '# X\n\n## Changelog\n\n- **0.25.0**: now.\n- **0.24.0**: before.\n',
    );
  });

  it('refuses while the README still has Unreleased bullets', () => {
    expect(() =>
      insertEntry(
        '## Changelog\n\n- **Unreleased**: old style.\n- **0.24.0**: x.\n',
        '- **0.25.0**:\n',
      ),
    ).toThrow(/still has \*\*Unreleased\*\* bullets/);
  });

  it("accepts this package's own changes/ directory", () => {
    const { problems } = readFragments(
      new URL('../../changes/', import.meta.url).pathname,
    );
    expect(problems).toEqual([]);
  });
});
