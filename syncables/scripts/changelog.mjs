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
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
    else if (text.startsWith('- ') || text.startsWith('* '))
      problems.push(`${file}: starts with a list marker; write the text only`);
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
export function insertEntry(readme, entry) {
  const heading = '## Changelog\n\n';
  const at = readme.indexOf(heading);
  if (at === -1) throw new Error('README.md has no "## Changelog" section');
  if (/^- \*\*Unreleased\*\*/m.test(readme.slice(at)))
    throw new Error(
      'README.md still has **Unreleased** bullets; fold them into fragments or the entry first',
    );
  const start = at + heading.length;
  return readme.slice(0, start) + entry + readme.slice(start);
}

function main(args) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const dir = join(root, 'changes');
  const { fragments, problems } = readFragments(dir);
  if (problems.length) {
    for (const problem of problems) console.error(`changes/${problem}`);
    process.exit(1);
  }
  if (args.includes('--check')) {
    console.log(`${fragments.length} changelog fragment(s), all valid`);
    return;
  }
  const at = args.indexOf('--release');
  const version = at === -1 ? undefined : args[at + 1];
  const summaryAt = args.indexOf('--summary');
  const summary = summaryAt === -1 ? undefined : args[summaryAt + 1];
  if (at !== -1 && !/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('--release takes a version such as 0.25.0');
    process.exit(1);
  }
  const entry = renderEntry(version ?? 'Unreleased', fragments, summary);
  if (version === undefined) {
    process.stdout.write(entry);
    return;
  }
  if (!fragments.length) {
    console.error('no changelog fragments to release');
    process.exit(1);
  }
  const readmePath = join(root, 'README.md');
  let readme;
  try {
    readme = insertEntry(readFileSync(readmePath, 'utf8'), entry);
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  }
  writeFileSync(readmePath, readme);
  for (const fragment of fragments) unlinkSync(join(dir, fragment.file));
  console.log(
    `README.md: ${version} entry from ${fragments.length} fragment(s); fragments deleted`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
