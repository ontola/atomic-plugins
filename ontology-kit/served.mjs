/**
 * Whether the shared ontology's terms are served at their subjects, with
 * exactly the committed bytes: the precondition of a plugin e2e that uses
 * them (ontola/atomic-plugins#177).
 *
 * A plugin bundles the published subjects (`terms.mjs`), so in an e2e the
 * pinned atomic-server and the browser fetch those terms from GitHub Pages
 * themselves, the same way they do in production: the server once, on first
 * use, and the browser through its local-database worker (spike S1). Nothing
 * is rewritten. A term that is not on Pages yet (a new class version in the
 * same pull request, or Pages lagging behind `main`) would make that e2e fail
 * somewhere deep in Set up; `servedProblems` says so up front instead.
 * README.md, "Plugin e2e tests and the published subjects", has the reasons.
 *
 *   node ontology-kit/served.mjs classes/bank-transaction-v1   # a class and its properties
 *   node ontology-kit/served.mjs                               # every term file
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBase, root, TERMS_DIR } from './ontology.mjs';

const REQUIRES = 'https://atomicdata.dev/properties/requires';
const RECOMMENDS = 'https://atomicdata.dev/properties/recommends';

/** Every committed term file, as a path under `ontology/`. */
export function termPaths(base = root) {
  const dir = resolve(base, TERMS_DIR);

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/**
 * A class's term file plus those of the properties it requires and
 * recommends that this ontology defines (not reused ones such as Atomic's
 * `name`), as paths under `ontology/`.
 */
export function classTermPaths(name, base = root) {
  const ontologyBase = readBase(base);
  const path = `classes/${name}`;
  const klass = JSON.parse(
    readFileSync(resolve(base, TERMS_DIR, path), 'utf8'),
  );
  const properties = [...(klass[REQUIRES] ?? []), ...(klass[RECOMMENDS] ?? [])]
    .filter(subject => subject.startsWith(`${ontologyBase}/`))
    .map(subject => subject.slice(ontologyBase.length + 1));

  return [path, ...properties];
}

/**
 * The term files of `paths` that are not served at their subject with the
 * committed bytes, one line each; empty when all are. One request per file,
 * no retries; a cache-busting query avoids Pages' CDN copy.
 */
export async function servedProblems(
  paths = termPaths(),
  { base = root, fetch: get = fetch, timeoutMs = 15_000 } = {},
) {
  const ontologyBase = readBase(base);
  const problems = [];

  await Promise.all(
    paths.map(async path => {
      const url = `${ontologyBase}/${path}`;
      const committed = readFileSync(resolve(base, TERMS_DIR, path));

      try {
        const res = await get(`${url}?v=${Date.now()}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const served = Buffer.from(await res.arrayBuffer());
        if (!served.equals(committed))
          problems.push(`${url}: served bytes differ from ontology/${path}`);
      } catch (error) {
        problems.push(`${url}: ${error.message}`);
      }
    }),
  );

  return problems.sort();
}

/** The message an e2e fails with when `servedProblems` found any. */
export const notServedMessage = problems =>
  `These shared ontology terms are not served at their subjects yet, so the ` +
  `server and browser cannot read them:\n  ${problems.join('\n  ')}\n` +
  `A new term is only usable in an e2e once it is on main and GitHub Pages ` +
  `serves it (.github/workflows/ontology-published.yml checks that). Land ` +
  `the ontology change first, or check this machine can reach the base URL.`;

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const names = process.argv.slice(2);
  const paths = names.length
    ? names.flatMap(name =>
        name.startsWith('classes/')
          ? classTermPaths(name.slice('classes/'.length))
          : [name],
      )
    : termPaths();
  const problems = await servedProblems([...new Set(paths)]);

  if (problems.length) {
    console.error(notServedMessage(problems));
    process.exit(1);
  }

  console.info(`${paths.length} term file(s) served as committed`);
}
