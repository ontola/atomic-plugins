// @wc-ignore-file
/* global process, console, URL */
/**
 * Changelog fragments, after towncrier: each change adds its own file under
 * `changes/` instead of an Unreleased bullet in README.md, so parallel PRs
 * never edit the same lines. The release step folds every fragment into
 * one README entry and deletes the fragments.
 *
 *   npm run changelog                       print the entry the fragments make
 *   npm run changelog -- --check            validate the fragments (exit 1 on a problem)
 *   npm run changelog -- --release 0.25.0 [--summary "…"]
 *                                           write the entry into README.md and
 *                                           delete the fragments
 *
 * A fragment is `changes/<name>.<kind>.md`: <name> is the branch or PR
 * (lowercase letters, digits and hyphens), <kind> one of KINDS. Its text is
 * one Markdown paragraph, wrapped as the README is, without a leading `- `.
 */
import {
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The kinds in the order a release entry lists them, behaviour changes first. */
export const KINDS = {
  behaviour: 'Behaviour change',
  added: 'Added',
  fixed: 'Fixed',
  other: 'Other',
};

const NAME = /^([a-z0-9][a-z0-9-]*)\.([a-z]+)\.md$/;

/**
 * A line that would not stay inside one sub-bullet: a list item or a
 * heading. A line starting `#630` (a wrapped PR reference) is not a
 * heading; `# ` is.
 */
const MARKUP = /^\s*(?:[-*+] |\d+[.)] |#{1,6}(?:\s|$))/;

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads `dir`: the fragments, sorted by kind and then name, and what is
 * wrong with any file there. `README.md` and dotfiles are not fragments.
 */
export function readFragments(dir) {
  const fragments = [];
  const problems = [];
  for (const file of readdirSync(dir).sort()) {
    if (file === 'README.md' || file.startsWith('.')) continue;
    const match = NAME.exec(file);
    if (!match) {
      problems.push(`${file}: not <name>.<kind>.md`);
      continue;
    }
    const [, name, kind] = match;
    if (!statSync(join(dir, file)).isFile()) {
      problems.push(`${file}: not a file`);
      continue;
    }
    if (!Object.hasOwn(KINDS, kind)) {
      problems.push(
        `${file}: kind ${kind} is not one of ${Object.keys(KINDS).join(', ')}`,
      );
      continue;
    }
    const text = readFileSync(join(dir, file), 'utf8').trim();
    if (text === '') problems.push(`${file}: empty`);
    else if (/\n\s*\n/.test(text))
      problems.push(`${file}: more than one paragraph`);
    else if (text.split('\n').some((line) => MARKUP.test(line)))
      problems.push(
        `${file}: a line starts with a list marker or heading; write one paragraph of text`,
      );
    else fragments.push({ file, name, kind, text });
  }
  const order = Object.keys(KINDS);
  fragments.sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      a.name.localeCompare(b.name),
  );
  return { fragments, problems };
}

/** One sub-bullet: `  - **Kind:** text`, continuation lines indented. */
function bullet(fragment) {
  const [first, ...rest] = fragment.text.split('\n').map((l) => l.trim());
  return [
    `  - **${KINDS[fragment.kind]}:** ${first}`,
    ...rest.map((line) => `    ${line}`),
  ].join('\n');
}

/** The README entry for `version`: an optional summary, then one sub-bullet per fragment. */
export function renderEntry(version, fragments, summary) {
  const lead = summary
    ? `- **${version}**: ${summary.trim()}`
    : `- **${version}**:`;
  return [lead, ...fragments.map(bullet)].join('\n') + '\n';
}

/**
 * `readme` with `entry` first under `## Changelog`. Refuses while the
 * README still holds `**Unreleased**` bullets written before fragments:
 * those are folded by hand (or moved into fragments) first.
 */
export function insertEntry(readme, entry, version) {
  const heading = /^## Changelog\n\n/m.exec(readme);
  if (!heading) throw new Error('README.md has no "## Changelog" section');
  const changelog = readme.slice(heading.index);
  if (/^- \*\*Unreleased\*\*/m.test(changelog))
    throw new Error(
      'README.md still has **Unreleased** bullets; fold them into fragments or the entry first',
    );
  if (
    version !== undefined &&
    new RegExp(`^- \\*\\*${escape(version)}\\*\\*`, 'm').test(changelog)
  )
    throw new Error(`README.md already has a ${version} entry`);
  const start = heading.index + heading[0].length;
  return readme.slice(0, start) + entry + readme.slice(start);
}

/**
 * Writes the `version` entry the fragments in `changesDir` make into
 * `readmePath`, then deletes them. Every check runs before anything is
 * written; the README is replaced in one rename, and the fragments are
 * deleted only after it. Returns how many fragments were released.
 */
export function release({ changesDir, readmePath, version, summary }) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ''))
    throw new Error('--release takes a version such as 0.25.0');
  const { fragments, problems } = readFragments(changesDir);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!fragments.length) throw new Error('no changelog fragments to release');
  const readme = insertEntry(
    readFileSync(readmePath, 'utf8'),
    renderEntry(version, fragments, summary),
    version,
  );
  const temporary = `${readmePath}.changelog-${process.pid}.tmp`;
  writeFileSync(temporary, readme);
  renameSync(temporary, readmePath);
  for (const fragment of fragments) unlinkSync(join(changesDir, fragment.file));
  return fragments.length;
}

function main(args) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const changesDir = join(root, 'changes');
  const at = args.indexOf('--release');
  if (at !== -1) {
    const summaryAt = args.indexOf('--summary');
    try {
      const count = release({
        changesDir,
        readmePath: join(root, 'README.md'),
        version: args[at + 1],
        summary: summaryAt === -1 ? undefined : args[summaryAt + 1],
      });
      console.log(
        `README.md: ${args[at + 1]} entry from ${count} fragment(s); fragments deleted`,
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    return;
  }
  const { fragments, problems } = readFragments(changesDir);
  if (problems.length) {
    for (const problem of problems) console.error(`changes/${problem}`);
    process.exit(1);
  }
  if (args.includes('--check')) {
    console.log(`${fragments.length} changelog fragment(s), all valid`);
    return;
  }
  process.stdout.write(renderEntry('Unreleased', fragments));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
