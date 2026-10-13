#!/usr/bin/env node
/**
 * Refuses a deploy that would change an app module under a version the
 * droplet already serves:
 *
 *   node usertest/check-live.mjs https://catalog.<base-domain>/catalog.json [out]
 *   node usertest/check-live.mjs /srv/catalog/catalog.json [out] [--served /srv/catalog]
 *   ssh <host> '…' | node usertest/check-live.mjs - [out]
 *
 * The live catalog is a URL, a file path, or `-` for standard input (what
 * deploy.sh does, reading the droplet's own copy before it copies anything).
 *
 * It compares the catalog catalog.mjs just built (default out: usertest/out)
 * with the live one. An app whose `app-module` path is the same in both but
 * whose `app-module-integrity` differs was rebuilt into an existing version:
 * the app's code changed without a bump in catalog.mjs's VERSIONS, or the
 * build left out USERTEST_LOG_URL. Deploying it would overwrite that
 * version's ui.js on the droplet, and the host refuses a module whose bytes
 * don't match the hash it installed with. Exits 1 with the app names in
 * that case; bump their versions and rebuild.
 *
 * With `--served <dir>` (the build VPS, where the catalog is a local folder)
 * it also compares each built module with the file already at
 * `<dir>/<app-module>`, which catches a version the live catalog no longer
 * lists but whose ui.js is still served.
 *
 * Absent passes, unreachable fails. Only a definite absence counts as a
 * first deploy: the line `NONE` on standard input (deploy.sh's marker for
 * "no catalog.json on the droplet"), a file that does not exist in a folder
 * that does, or HTTP 404 (not after a redirect: a 3xx fails). A network
 * error or timeout, any other HTTP status, a read error, a missing folder (a
 * mistyped path), empty input or an empty file, and anything that is not a
 * JSON array of catalog entries exit 1; `[]` is a real, empty catalog. A
 * `--served` folder that does not exist exits 1 too. So does a build made with
 * `catalog.mjs --no-log` (its `out/UNLOGGED` marker): it is not for deploying.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const I = 'https://atomicdata.dev/integrations/properties/';
const A = 'https://atomicdata.dev/properties/';

/** What deploy.sh prints when the droplet has no catalog.json yet. */
export const ABSENT = 'NONE';
const here = dirname(fileURLToPath(import.meta.url));

/** app-module path -> { name, integrity }; throws unless a catalog array. */
const modules = catalog => {
  if (!Array.isArray(catalog))
    throw new Error('not a catalog (a JSON array of entries)');

  return new Map(
    catalog
      .filter(entry => entry && entry[I + 'app-module'])
      .map(entry => [
        entry[I + 'app-module'],
        {
          name: entry[A + 'shortname'],
          integrity: entry[I + 'app-module-integrity'],
        },
      ]),
  );
};

/**
 * The live catalog's text, or undefined when it is definitely absent.
 * Throws when it could not be read.
 */
async function liveText(live) {
  if (live === '-') {
    const text = readFileSync(0, 'utf8');

    // Empty input is not absence: deploy.sh says NONE for that, so empty
    // means the droplet's catalog.json is empty or the read went wrong.
    return text.trim() === ABSENT ? undefined : text;
  }

  if (!/^https?:\/\//.test(live)) {
    try {
      return readFileSync(live, 'utf8');
    } catch (error) {
      // No catalog.json yet in an existing folder: a first deploy. A missing
      // folder is more likely a mistyped path, so it fails.
      if (error.code === 'ENOENT' && existsSync(dirname(resolve(live))))
        return undefined;
      throw new Error(`cannot read ${live}: ${error.message}`);
    }
  }

  // A redirect is not followed (it could end in some other page's 404), and
  // a server that does not answer within 30 s counts as unreachable.
  const response = await fetch(live, {
    cache: 'no-store',
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${live}`);

  return response.text();
}

async function main(argv) {
  const servedAt = argv.indexOf('--served');
  const served = servedAt === -1 ? undefined : argv[servedAt + 1];
  const [live, outArg] = argv.filter(
    (a, i) => a !== '--served' && (servedAt === -1 || i !== servedAt + 1),
  );

  if (!live || (servedAt !== -1 && !served)) {
    console.error(
      'usage: check-live.mjs <live catalog URL | file | -> [out] [--served <dir>]',
    );

    return 2;
  }

  const out = resolve(outArg ?? resolve(here, 'out'));

  if (served && !existsSync(served)) {
    console.error(`--served ${served} does not exist. Deploy stopped.`);

    return 1;
  }

  if (existsSync(resolve(out, 'UNLOGGED'))) {
    console.error(
      `${out} was built with catalog.mjs --no-log (no collector prelude): not for deploying. Rebuild with USERTEST_LOG_URL.`,
    );

    return 1;
  }

  const built = modules(
    JSON.parse(readFileSync(resolve(out, 'catalog.json'), 'utf8')),
  );
  let text;

  try {
    text = await liveText(live);
  } catch (error) {
    console.error(
      `Cannot check against the live catalog: ${error.message}. Deploy stopped.`,
    );

    return 1;
  }

  let liveModules = new Map();

  if (text === undefined) console.log('No live catalog yet: a first deploy.');
  else
    try {
      liveModules = modules(JSON.parse(text));
    } catch (error) {
      console.error(
        `The live catalog is not a catalog (${error.message}). Deploy stopped.`,
      );

      return 1;
    }

  const changed = [...built].filter(
    ([path, { integrity }]) =>
      liveModules.has(path) && liveModules.get(path).integrity !== integrity,
  );
  // On the build VPS: a served ui.js the live catalog may no longer list.
  const onDisk = served
    ? [...built].filter(([path, { integrity }]) => {
        if (liveModules.has(path)) return false;
        const file = resolve(served, path);
        if (!existsSync(file)) return false;
        const hash = `sha384-${createHash('sha384').update(readFileSync(file)).digest('base64')}`;

        return hash !== integrity;
      })
    : [];

  for (const [path, { name }] of changed)
    console.error(
      `${name}: ${path} differs from the live one; bump its entry in VERSIONS (usertest/catalog.mjs).`,
    );
  for (const [path, { name }] of onDisk)
    console.error(
      `${name}: ${path} differs from the file already served at ${resolve(served, path)}; bump its entry in VERSIONS (usertest/catalog.mjs).`,
    );
  if (changed.length || onDisk.length) return 1;
  console.log(
    `${built.size} app modules; ${[...built.keys()].filter(p => !liveModules.has(p)).length} new, none changed under an existing version.`,
  );

  return 0;
}

process.exit(await main(process.argv.slice(2)));
