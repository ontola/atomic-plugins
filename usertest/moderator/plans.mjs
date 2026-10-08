/**
 * The session plans: sessions/<name>.md, one feature to test each (see
 * sessions/README.md). server.mjs loads them once at start; this module is
 * separate so `node --test usertest/moderator/plans.test.mjs` can check the
 * loading without starting the moderator.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A plan that still holds this marker is not finished: its entry steps are
 * unknown (the first such plan, `split-pieces`, waits for a build that has
 * its demo). Every other `.md` in sessions/ becomes a tester-facing plan as
 * soon as it is deployed, so an unfinished one is neither listed nor
 * startable until the marker is edited out.
 */
export const PLACEHOLDER = '[ENTRY PLACEHOLDER';

/**
 * Files a plan has the tester download from the catalog host's `samples/`
 * (#196): the backticked `<app>/<file>` paths on its line that starts with
 * `Sample files`. The page links them.
 */
export function sampleFiles(text) {
  const line = text.match(/^Sample files\b.*$/m)?.[0] ?? '';

  return [...line.matchAll(/`([^`]+)`/g)]
    .map(m => m[1])
    .filter(path => /^[a-z0-9-]+\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path));
}

/**
 * Where the tester's Atomic window opens for this plan: the backticked path on
 * the plan's line that starts with `Start page`, or undefined for the default
 * (`/app/dev-drive`, a fresh drive). Only a same-origin data-browser path is
 * accepted (`/app/…`, letters, digits, `-`, `_`, `/`, and a simple query), so a
 * plan cannot send the window elsewhere.
 */
export function startPage(text) {
  const line = text.match(/^Start page\b.*$/m)?.[0] ?? '';
  const path = line.match(/`([^`]+)`/)?.[1];

  return path && /^\/app\/[A-Za-z0-9/_-]+(\?[A-Za-z0-9=&_-]*)?$/.test(path)
    ? path
    : undefined;
}

/**
 * Reads every `.md` in `dir` except README.md. Returns `plans` (name to
 * text), `list` (what the page's "What do you want to test?" menu shows: each
 * plan's first line, `# Session plan: <title>`, in the order of their titles,
 * with its sample files and start page) and `skipped`: the names of plans left out because
 * they still hold PLACEHOLDER. Throws when a plan has no `# ` heading.
 */
export function loadPlans(dir) {
  const plans = {};
  const skipped = [];

  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md') || file === 'README.md') continue;
    const id = file.slice(0, -3);
    const text = readFileSync(join(dir, file), 'utf8');

    if (text.includes(PLACEHOLDER)) {
      skipped.push(id);
      continue;
    }

    plans[id] = text;
  }

  const list = Object.entries(plans)
    .map(([id, text]) => {
      const title = text.match(/^# (?:Session plan: )?(.+)$/m)?.[1]?.trim();
      if (!title) throw new Error(`sessions/${id}.md has no # heading`);
      const samples = sampleFiles(text);
      const start = startPage(text);

      return {
        id,
        title,
        ...(samples.length ? { samples } : {}),
        ...(start ? { start } : {}),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  return { plans, list, skipped: skipped.sort() };
}
