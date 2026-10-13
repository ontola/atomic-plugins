#!/usr/bin/env node
/**
 * Refuses a deploy that would change an app module under a version the
 * droplet already serves:
 *
 *   node usertest/check-live.mjs https://catalog.<base-domain>/catalog.json [out]
 *   ssh <host> cat /srv/catalog/catalog.json | node usertest/check-live.mjs - [out]
 *
 * The live catalog is a URL, a file path, or `-` for standard input (what
 * deploy.sh does, reading the droplet's own copy before it copies anything).
 *
 * It compares the catalog catalog.mjs just built (default out: usertest/out)
 * with the live one. An app whose `app-module` path is the same in both but
 * whose `app-module-integrity` differs was rebuilt into an existing version:
 * the app's code changed without a bump in catalog.mjs's VERSIONS. Deploying
 * it would overwrite that version's ui.js on the droplet, and the host
 * refuses a module whose bytes don't match the hash it installed with.
 * Exits 1 with the app names in that case; bump their versions and rebuild.
 *
 * A live catalog that can't be fetched (a first deploy, the droplet down) is
 * reported and passes: there is nothing to compare with.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const I = 'https://atomicdata.dev/integrations/properties/';
const A = 'https://atomicdata.dev/properties/';
const here = dirname(fileURLToPath(import.meta.url));
const [liveUrl, outArg] = process.argv.slice(2);
if (!liveUrl) {
  console.error('usage: check-live.mjs <live catalog URL | file | -> [out]');
  process.exit(2);
}
const out = resolve(outArg ?? resolve(here, 'out'));

/** app-module path -> { name, integrity } */
const modules = catalog =>
  new Map(
    catalog
      .filter(entry => entry[I + 'app-module'])
      .map(entry => [
        entry[I + 'app-module'],
        {
          name: entry[A + 'shortname'],
          integrity: entry[I + 'app-module-integrity'],
        },
      ]),
  );

const built = modules(
  JSON.parse(readFileSync(resolve(out, 'catalog.json'), 'utf8')),
);
let live;

/** The live catalog's text: from standard input, a file, or over HTTP. */
async function liveText() {
  if (liveUrl === '-') return readFileSync(0, 'utf8');

  if (!/^https?:\/\//.test(liveUrl)) {
    if (!existsSync(liveUrl)) throw new Error(`no file ${liveUrl}`);

    return readFileSync(liveUrl, 'utf8');
  }

  const response = await fetch(liveUrl, { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return response.text();
}

try {
  const text = await liveText();
  // An empty answer (no catalog on the droplet yet) is a first deploy.
  if (!text.trim()) throw new Error('empty');
  live = modules(JSON.parse(text));
} catch (error) {
  console.log(`No live catalog to compare with (${error.message}).`);
  process.exit(0);
}

const changed = [...built].filter(
  ([path, { integrity }]) =>
    live.has(path) && live.get(path).integrity !== integrity,
);

for (const [path, { name }] of changed)
  console.error(
    `${name}: ${path} differs from the live one; bump its entry in VERSIONS (usertest/catalog.mjs).`,
  );
if (changed.length) process.exit(1);
console.log(
  `${built.size} app modules; ${[...built.keys()].filter(p => !live.has(p)).length} new, none changed under an existing version.`,
);
