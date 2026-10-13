/**
 * Per-folder npm dependencies, installed on demand for local runs.
 *
 * A plugin that bundles published npm packages pins them in its own
 * package.json and pnpm-lock.yaml (integrations/notion/, integrations/pets/,
 * integrations/issue-tracker/app/, …), and a lane that declares shared
 * `paths` in lanes.json imports that package from source (devonian/). CI
 * installs every one of those lockfiles before certify.mjs and run-lane.mjs
 * run ("Install plugin npm dependencies" in .github/workflows/ci.yml). A
 * local checkout usually has not, and the resulting failure — a vitest or
 * tsc "Cannot find module" — does not say what is missing.
 *
 * installMissing() runs `pnpm install --frozen-lockfile` in each given folder
 * that has a pnpm-lock.yaml and either no node_modules or a stale one,
 * printing one line per install. Stale means pnpm's own copy of the lockfile
 * it installed from (`node_modules/.pnpm/lock.yaml`) differs from the
 * folder's pnpm-lock.yaml: the lockfile changed since (a dependency bump
 * merged from main, say), and a build would bundle the old versions. A
 * node_modules without that copy (another installer, an old pnpm) is left
 * alone. On CI, where the install step ran first, every copy matches and
 * this does nothing: CI behaviour is unchanged. It never updates a lockfile
 * (`--frozen-lockfile`).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { root } from './lanes.mjs';

/**
 * The folders, relative to `base`, that hold one plugin's own lockfiles: the
 * plugin folder itself, its drive app, its e2e specs' test-only
 * dependencies (an independent protocol client, for instance), and its
 * Devonian lens folder's (`integrations/<id>/devonian/`, the npm `devonian`
 * its lens prototypes test against, for a plugin with no drive app to hold
 * it): the same four globs CI installs (`integrations/*\/pnpm-lock.yaml`,
 * `integrations/*\/app/pnpm-lock.yaml`, `integrations/*\/e2e/pnpm-lock.yaml`,
 * `integrations/*\/devonian/pnpm-lock.yaml`).
 */
export const pluginDependencyDirs = id => [
  `integrations/${id}`,
  `integrations/${id}/app`,
  `integrations/${id}/e2e`,
  `integrations/${id}/devonian`,
];

/**
 * The shared packages (devonian/, syncables/, reflector/) a lane's `paths`
 * point into, e.g. `devonian/src/**` → `devonian`.
 */
export const sharedDependencyDirs = (paths = []) => [
  ...new Set(paths.map(path => path.split('/')[0])),
];

/**
 * Why `dir` needs an install, or undefined: `missing` (a lockfile and no
 * node_modules) or `stale` (node_modules installed from another lockfile).
 */
export function installReason(dir, base = root) {
  const lock = resolve(base, dir, 'pnpm-lock.yaml');
  if (!existsSync(lock)) return undefined;
  if (!existsSync(resolve(base, dir, 'node_modules'))) return 'missing';
  const installed = resolve(base, dir, 'node_modules/.pnpm/lock.yaml');
  if (!existsSync(installed)) return undefined;

  return readFileSync(installed).equals(readFileSync(lock))
    ? undefined
    : 'stale';
}

/** Those of `dirs` that have a pnpm-lock.yaml and need an install. */
export function missingInstalls(dirs, base = root) {
  return [...new Set(dirs)].filter(dir => installReason(dir, base));
}

function pnpmInstall(cwd) {
  return spawnSync('pnpm', ['install', '--frozen-lockfile'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Install each of `dirs` that needs it. Returns the folders it installed.
 * Throws on the first failed install, with pnpm's output in the message.
 */
export function installMissing(
  dirs,
  { base = root, install = pnpmInstall, log = console.log } = {},
) {
  const installed = [];

  for (const dir of missingInstalls(dirs, base)) {
    log(
      installReason(dir, base) === 'stale'
        ? `Installing ${dir} dependencies again: node_modules was installed from an older pnpm-lock.yaml (pnpm install --frozen-lockfile)`
        : `Installing ${dir} dependencies (pnpm install --frozen-lockfile)`,
    );
    const result = install(resolve(base, dir));

    if (result.error || result.status !== 0) {
      const output = [result.error?.message, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      throw new Error(
        `pnpm install --frozen-lockfile failed in ${dir}${output ? `:\n${output}` : ''}`,
      );
    }

    installed.push(dir);
  }

  return installed;
}
