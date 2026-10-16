// @wc-ignore-file
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  insertEntry,
  readFragments,
  release,
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
    ['x.added.md', '- a bullet\n', 'a line starts with a list marker'],
    ['x.added.md', 'text\n- a bullet\n', 'a line starts with a list marker'],
    ['x.added.md', 'text\n* a bullet\n', 'a line starts with a list marker'],
    ['x.added.md', 'text\n1. a step\n', 'a line starts with a list marker'],
    ['x.added.md', 'text\n## Heading\n', 'or heading'],
  ])('refuses %s with %j', (file, text, problem) => {
    const { fragments, problems } = readFragments(withFiles({ [file]: text }));
    expect(fragments).toEqual([]);
    expect(problems.join('\n')).toContain(problem);
  });

  it('accepts a wrapped line that starts with a PR reference', () => {
    const { problems } = readFragments(
      withFiles({ 'x.fixed.md': 'Fixed, after the review of\n#630.\n' }),
    );
    expect(problems).toEqual([]);
  });

  it('reports a directory named like a fragment, with the other problems', () => {
    const changes = withFiles({ 'bad.kind.md': 'x' });
    mkdirSync(join(changes, 'folder.added.md'));
    const { problems } = readFragments(changes);
    expect(problems).toEqual([
      'bad.kind.md: kind kind is not one of behaviour, added, fixed, other',
      'folder.added.md: not a file',
    ]);
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

  it('anchors the heading at the start of a line', () => {
    expect(() =>
      insertEntry('Not a ## Changelog\n\nheading.\n', '- **0.25.0**:\n'),
    ).toThrow(/no "## Changelog" section/);
  });

  it('refuses a version the README already has', () => {
    expect(() =>
      insertEntry(
        '## Changelog\n\n- **0.25.0**: released.\n',
        '- **0.25.0**:\n',
        '0.25.0',
      ),
    ).toThrow(/already has a 0\.25\.0 entry/);
    // 0.25.0 does not match 0.25.01 or 0x25x0.
    expect(
      insertEntry(
        '## Changelog\n\n- **0x25x0**: other.\n',
        '- **0.25.0**:\n',
        '0.25.0',
      ),
    ).toContain('- **0.25.0**:\n- **0x25x0**');
  });

  describe('release', () => {
    const setUp = (
      readme: string,
    ): { changesDir: string; readmePath: string } => {
      const changesDir = withFiles({ 'one.added.md': 'One.\n' });
      const readmePath = join(
        changesDir,
        '..',
        `${changesDir.split('/').pop()}.md`,
      );
      writeFileSync(readmePath, readme);
      return { changesDir, readmePath };
    };

    it('writes the README, then deletes the fragments', () => {
      const paths = setUp('# X\n\n## Changelog\n\n- **0.24.0**: before.\n');
      expect(release({ ...paths, version: '0.25.0', summary: 'Now.' })).toBe(1);
      expect(readFileSync(paths.readmePath, 'utf8')).toBe(
        '# X\n\n## Changelog\n\n- **0.25.0**: Now.\n  - **Added:** One.\n- **0.24.0**: before.\n',
      );
      expect(existsSync(join(paths.changesDir, 'one.added.md'))).toBe(false);
      rmSync(paths.readmePath);
    });

    it('leaves the README and the fragments alone when it refuses', () => {
      const readme = '## Changelog\n\n- **0.25.0**: released.\n';
      const paths = setUp(readme);
      expect(() => release({ ...paths, version: '0.25.0' })).toThrow(
        /already has a 0\.25\.0 entry/,
      );
      expect(() => release({ ...paths, version: 'next' })).toThrow(
        /takes a version/,
      );
      expect(readFileSync(paths.readmePath, 'utf8')).toBe(readme);
      expect(existsSync(join(paths.changesDir, 'one.added.md'))).toBe(true);
      rmSync(paths.readmePath);
    });
  });

  it("accepts this package's own changes/ directory", () => {
    const { problems } = readFragments(
      fileURLToPath(new URL('../../changes/', import.meta.url)),
    );
    expect(problems).toEqual([]);
  });
});
