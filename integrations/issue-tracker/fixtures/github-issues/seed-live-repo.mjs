// @wc-ignore-file
/**
 * Fills a disposable GitHub repository with the synthetic `acme-studio/website`
 * issues from user-testing.mjs, for user testing the GitHub issues drive app
 * against live GitHub. Synthetic, for user testing: every issue is invented.
 *
 *   node integrations/issue-tracker/fixtures/github-issues/seed-live-repo.mjs \
 *     --repo <owner>/<name> [--yes]
 *
 * It runs `gh api` as whichever account the GitHub CLI is signed in as, and
 * never reads or prints a token. Use a dedicated test account, never a
 * personal one (integrations/LIVE_TESTING.md), for example in its own config
 * directory:
 *
 *   GH_CONFIG_DIR=~/.config/gh-atomic-test gh auth login
 *   GH_CONFIG_DIR=~/.config/gh-atomic-test node …/seed-live-repo.mjs --repo …
 *
 * Without `--yes` it only prints what it would do. It refuses a repository
 * that already has issues or pull requests, so it cannot run twice on the
 * same one. What differs from the mock scenario:
 *
 * - Every issue and comment is authored by the signed-in account; the
 *   invented people (priya-dev, tomas-k, …) and assignees do not exist.
 * - Dates are when the script ran.
 * - It creates the labels, including `atomic:doing`, which the app's Doing
 *   column needs. Existing labels with the same name are left as they are.
 *
 * About 40 API calls, one second apart, to stay clear of GitHub's secondary
 * rate limit for content creation.
 */
import { execFileSync } from 'node:child_process';
import { USER_TESTING_REPOSITORIES } from './user-testing.mjs';

const DOING = { name: 'atomic:doing', color: '5319e7' };
const COLORS = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  design: 'f9d0c4',
  docs: '0075ca',
  maintenance: 'fbca04',
  'good first issue': '7057ff',
  planning: 'c5def5',
};

const args = process.argv.slice(2);
const repo = args[args.indexOf('--repo') + 1];
const write = args.includes('--yes');

if (!args.includes('--repo') || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) {
  console.error('Usage: seed-live-repo.mjs --repo <owner>/<name> [--yes]');
  process.exit(2);
}

/** `gh api`, with a JSON body on stdin; returns the parsed answer. */
function gh(method, path, body) {
  const out = execFileSync(
    'gh',
    ['api', '--method', method, path, ...(body ? ['--input', '-'] : [])],
    {
      input: body ? JSON.stringify(body) : undefined,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );

  return out.trim() ? JSON.parse(out) : undefined;
}

const pause = () => new Promise(resolve => setTimeout(resolve, 1000));

const login = gh('GET', '/user').login;
const existing = gh('GET', `/repos/${repo}/issues?state=all&per_page=1`);
console.log(`Signed in to GitHub as ${login}; repository ${repo}.`);

if (existing.length) {
  console.error(
    `${repo} already has issues or pull requests; use an empty repository.`,
  );
  process.exit(1);
}

const issues = USER_TESTING_REPOSITORIES['acme-studio/website'];
const labels = [
  ...Object.entries(COLORS).map(([name, color]) => ({ name, color })),
  DOING,
];
console.log(
  `${write ? 'Creating' : 'Would create'} ${labels.length} labels, ` +
    `${issues.length} issues and ` +
    `${issues.reduce((n, i) => n + (i.comments?.length ?? 0), 0)} comments.`,
);

if (!write) {
  console.log('Nothing written. Add --yes to write.');
  process.exit(0);
}

const known = new Set(
  gh('GET', `/repos/${repo}/labels?per_page=100`).map(l => l.name),
);

for (const label of labels) {
  if (known.has(label.name)) continue;
  gh('POST', `/repos/${repo}/labels`, label);
}

for (const [index, input] of issues.entries()) {
  const created = gh('POST', `/repos/${repo}/issues`, {
    title: input.title,
    ...(input.body === null ? {} : { body: input.body }),
    labels: input.labels,
  });
  await pause();

  for (const comment of input.comments ?? []) {
    gh('POST', `/repos/${repo}/issues/${created.number}/comments`, {
      body: comment.body,
    });
    await pause();
  }

  if (input.state === 'closed') {
    gh('PATCH', `/repos/${repo}/issues/${created.number}`, {
      state: 'closed',
      state_reason: 'completed',
    });
    await pause();
  }

  console.log(
    `${index + 1}/${issues.length} #${created.number} ${input.title.slice(0, 60)}`,
  );
}

console.log(`Done: https://github.com/${repo}/issues`);
