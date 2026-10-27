/**
 * Set up the layout every package under integrations/ needs to build and
 * test: an ontola/atomic-server checkout at the commit pinned in
 * `.atomic-server-ref`, with its `browser/` symlinked into this repo so the
 * packages' relative `../../browser/lib/src/...` imports resolve.
 *
 * This is the exact wiring CI uses — ci.yml runs this script (with
 * --no-fetch, after actions/checkout has fetched the pinned commit) instead
 * of restating the `ln -s` itself, so local and CI setups cannot drift.
 *
 *   node integrations/tooling/link-atomic-server.mjs            # set up / update
 *   node integrations/tooling/link-atomic-server.mjs --check    # verify only
 *
 * The checkout lives at ATOMIC_SERVER_CHECKOUT (default: this pin's
 * ~/.cache/atomic-plugins/atomic-server/<sha> when that directory exists,
 * else /tmp/atomic-server; serve.mjs's serverCheckout(), which run-lane.mjs
 * uses too), outside this repo, so one checkout — and its pnpm store and
 * cargo cache — is shared by every worktree on that pin.
 *
 * Steps, each idempotent:
 *   1. Clone (shallow, just the pinned commit) if the checkout is missing;
 *      otherwise fetch and check out the pinned commit if HEAD differs.
 *      Refuses to move a checkout that has uncommitted changes (apart from
 *      server-build.mjs's BUILD_OUTPUT_PATHS, which the atomic-server build
 *      regenerates: those alone are restored, then it moves), or one named
 *      after another commit (`…/atomic-server/<sha>`, the per-SHA layout of
 *      AGENTS.md and docs/agents/build-vps.md): that one belongs to the
 *      branches pinned there, and the error names this pin's own path.
 *      --no-fetch skips this and only verifies HEAD (CI's mode).
 *   2. Symlink `browser` -> <checkout>/browser (replacing a stale symlink,
 *      never a real directory).
 *   3. Symlink `integrations/node_modules` -> ../browser/e2e/node_modules,
 *      which lane e2e specs need for bare `@playwright/test` imports
 *      (run-lane.mjs also creates it on demand).
 *   4. `pnpm install --frozen-lockfile` in <checkout>/browser, unless
 *      --no-install.
 *
 * Not covered, on purpose: the atomic-server binary (`cargo build`, only the
 * live/e2e tiers need it — serve.mjs prints the command), and
 * `integrations/localthought`'s `../../wasm/pkg/atomic_wasm.js` (a
 * `wasm-pack` build of atomic-server's Rust `wasm` crate, used only by
 * localthought's wasm-smoke.mjs, which CI does not run either).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './lanes.mjs';
import { serverCheckout } from './serve.mjs';
import { BUILD_OUTPUT_PATHS, restoreBuildOutputs } from './server-build.mjs';

export const REPO_URL = 'https://github.com/ontola/atomic-server.git';

export const pinnedRef = (base = root) =>
  readFileSync(resolve(base, '.atomic-server-ref'), 'utf8').trim();

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/**
 * HEAD of the repository rooted exactly at `checkout`, or undefined — not the
 * HEAD of an enclosing repository git would otherwise walk up to.
 */
function headOf(checkout) {
  try {
    const top = git(checkout, 'rev-parse', '--show-toplevel');
    if (realpathSync(top) !== realpathSync(checkout)) return undefined;

    return git(checkout, 'rev-parse', 'HEAD');
  } catch {
    return undefined;
  }
}

/**
 * What is wrong with the current layout, as human-readable lines; empty when
 * `browser/` resolves into an atomic-server checkout at the pinned commit
 * with dependencies installed. Checks what `browser/` actually points at, not
 * ATOMIC_SERVER_CHECKOUT, so it is right however the link was made.
 */
export function layoutProblems(base = root) {
  const link = resolve(base, 'browser');
  const ref = pinnedRef(base);

  if (!existsSync(link))
    return [
      `${link} does not exist (or is a dangling symlink) — run node integrations/tooling/link-atomic-server.mjs`,
    ];

  const checkout = dirname(realpathSync(link));
  const head = headOf(checkout);
  const problems = [];

  if (head === undefined)
    problems.push(`${checkout} (browser/'s parent) is not a git checkout`);
  else if (head !== ref)
    problems.push(
      `${checkout} is at ${head.slice(0, 12)}, but .atomic-server-ref pins ${ref.slice(0, 12)} — you would be testing against the wrong atomic-server. Re-run node integrations/tooling/link-atomic-server.mjs`,
    );

  if (!existsSync(resolve(link, 'node_modules/.bin/tsc')))
    problems.push(
      `${link}/node_modules is not installed — run pnpm install --frozen-lockfile in ${checkout}/browser`,
    );

  return problems;
}

/**
 * Why `checkout` must not be moved to `ref`, or undefined. A directory named
 * after a commit (`<sha>`, or `<sha>-<variant>` such as `-plugin-routes`) is
 * the checkout for that commit, shared by every branch pinned there: moving
 * it to another pin pulls `browser/` out from under their lanes and leaves
 * its binary built for the old commit (seen on the build VPS, 2026-10-09).
 */
export function movePinProblem(checkout, ref) {
  const name = basename(checkout);
  const named = /^([0-9a-f]{40})(-.*)?$/.exec(name);
  if (!named || named[1] === ref) return undefined;

  return (
    `${checkout} is the checkout for ${named[1].slice(0, 12)}, not this branch's pin ${ref.slice(0, 12)}; other branches pinned there may be using it, so it is not moved. ` +
    `Use this pin's own: ATOMIC_SERVER_CHECKOUT=${join(dirname(checkout), ref + (named[2] ?? ''))} (one checkout per SHA; docs/agents/build-vps.md).`
  );
}

/**
 * Tracked paths with uncommitted changes in `checkout` (staged or not), both
 * sides of a rename or copy included, each path once (a copy's source can
 * also be modified, say).
 */
export function changedPaths(checkout) {
  // Not git(): its trim() would eat the leading space of " M path".
  const fields = execFileSync(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=no'],
    { cwd: checkout, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  const paths = [];

  for (let i = 0; i < fields.length; i++) {
    const [x, y] = fields[i];
    paths.push(fields[i].slice(3));
    // A rename or copy, in the index (X) or in the working tree (Y, as an
    // intent-to-add rename shows), is followed by its source path as its
    // own field.
    if ('RC'.includes(x) || 'RC'.includes(y)) paths.push(fields[++i]);
  }

  return [...new Set(paths)];
}

/**
 * Why `checkout`'s uncommitted changes stop it moving to `ref`, or undefined.
 * Changes only to BUILD_OUTPUT_PATHS (server-build.mjs: the atomic-server
 * build regenerates them, and the binary has its own copy) are tolerated:
 * they are restored to HEAD here, so the checkout can move. Any other change
 * refuses, and then nothing is restored.
 */
export function dirtyProblem(checkout, ref) {
  const changed = changedPaths(checkout);
  if (!changed.length) return undefined;

  let other = changed.filter(p => !BUILD_OUTPUT_PATHS.includes(p));

  if (!other.length) {
    restoreBuildOutputs(checkout);
    // Whatever restoring couldn't undo (a path HEAD doesn't track) remains.
    other = changedPaths(checkout);

    if (!other.length) {
      console.info(
        `Restored ${changed.join(', ')} in ${checkout} (regenerated by the atomic-server build)`,
      );

      return undefined;
    }
  }

  return `${checkout} has uncommitted changes (${other.join(', ')}) and is at ${git(checkout, 'rev-parse', 'HEAD').slice(0, 12)}, not the pinned ${ref.slice(0, 12)}. Commit or discard them, or point ATOMIC_SERVER_CHECKOUT elsewhere.`;
}

function ensureCheckout(checkout, ref) {
  if (!existsSync(checkout)) {
    console.log(`Cloning ${REPO_URL} @ ${ref.slice(0, 12)} into ${checkout}`);
    // init + fetch-by-SHA rather than `git clone`: only the pinned commit is
    // downloaded, not atomic-server's full history.
    execFileSync('git', ['init', '--quiet', checkout], { stdio: 'inherit' });
    git(checkout, 'remote', 'add', 'origin', REPO_URL);
  } else {
    const head = headOf(checkout);
    if (head === undefined)
      throw new Error(`${checkout} exists but is not a git checkout`);
    if (head === ref) return;
    const named = movePinProblem(checkout, ref);
    if (named) throw new Error(named);

    const dirty = dirtyProblem(checkout, ref);
    if (dirty) throw new Error(dirty);
  }

  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      cwd: checkout,
      stdio: 'ignore',
    });
  } catch {
    console.log(`Fetching ${ref.slice(0, 12)}`);
    execFileSync('git', ['fetch', '--depth=1', 'origin', ref], {
      cwd: checkout,
      stdio: 'inherit',
    });
  }

  execFileSync('git', ['checkout', '--quiet', '--detach', ref], {
    cwd: checkout,
    stdio: 'inherit',
  });
  console.log(`${checkout} is now at ${ref.slice(0, 12)}`);
}

/** Point `path` at `target`, replacing a stale symlink but never real files. */
function ensureSymlink(path, target) {
  let stat;

  try {
    stat = lstatSync(path);
  } catch {
    stat = undefined;
  }

  if (stat) {
    if (!stat.isSymbolicLink())
      throw new Error(
        `${path} exists and is not a symlink; move it aside first`,
      );
    if (readlinkSync(path) === target) return;
    unlinkSync(path);
  }

  symlinkSync(target, path, 'dir');
  console.log(`Linked ${path} -> ${target}`);
}

function main(args) {
  const checkOnly = args.includes('--check');
  const noFetch = args.includes('--no-fetch');
  const noInstall = args.includes('--no-install');
  const unknown = args.filter(
    a => !['--check', '--no-fetch', '--no-install'].includes(a),
  );

  if (unknown.length) {
    console.error(
      `Unknown argument(s): ${unknown.join(' ')}\nUsage: link-atomic-server.mjs [--check | [--no-fetch] [--no-install]]`,
    );

    return 2;
  }

  if (!checkOnly) {
    const checkout = resolve(serverCheckout());
    const ref = pinnedRef();

    if (!noFetch) ensureCheckout(checkout, ref);
    ensureSymlink(resolve(root, 'browser'), resolve(checkout, 'browser'));
    ensureSymlink(
      resolve(root, 'integrations/node_modules'),
      '../browser/e2e/node_modules',
    );

    if (!noInstall) {
      const result = spawnSync('pnpm', ['install', '--frozen-lockfile'], {
        cwd: resolve(checkout, 'browser'),
        stdio: 'inherit',
      });
      if (result.status !== 0) return result.status ?? 1;
    }
  }

  const problems = layoutProblems().filter(
    // With --no-install, missing node_modules is expected, not a failure.
    p => !(noInstall && p.includes('node_modules is not installed')),
  );

  for (const p of problems) console.error(p);
  if (problems.length) return 1;

  console.log(
    `browser/ -> atomic-server @ ${pinnedRef().slice(0, 12)}: layout OK`,
  );

  return 0;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
