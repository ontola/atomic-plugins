#!/usr/bin/env node
/**
 * Builds the user-testing catalog into a folder that deploy.sh copies to the
 * droplet's /srv/catalog:
 *
 *   node usertest/catalog.mjs [out]      # default out: usertest/out
 *
 * With USERTEST_LOG_URL set (deploy it with
 * USERTEST_LOG_URL=https://logs.<base-domain>/log), the modules of apps
 * marked `report: true` start with a prelude that defines `globalThis.__USERTEST_REPORT__`, which
 * posts what an app hands it to the collector. Apps call it through their
 * own `report.ts` (calendar so far). The apps themselves make no network
 * request of their own (their build tests check for `fetch(`); only this
 * prelude does, and only in these test builds.
 *
 * It starts from this checkout's integrations/catalog.json and makes every
 * drive app installable and visible without the "Show experimental plugins"
 * toggle, including the ones the published catalog keeps disabled until
 * launch. Apps not yet published to apps/ are built from this checkout with
 * their own app/build.mjs and served next to the catalog, at
 * apps/<id>/<version>/ui.js, with the SRI hash the host checks on install.
 * Pets keeps its published module.
 *
 * VERSIONS below is the only thing to edit. Bump an app's version whenever
 * its build changes: the host offers "Update to <version>" only for a new
 * version string, and a changed file under an old version fails the
 * integrity check for anyone who installs it afterwards.
 *
 * Needs the layout AGENTS.md describes (browser/ from the pinned
 * atomic-server) and each app's dependencies installed (see README.md).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const out = resolve(process.argv[2] ?? resolve(here, 'out'));

const A = 'https://atomicdata.dev/properties/';
const I = 'https://atomicdata.dev/integrations/properties/';

/** Drive apps built here. `base` is the catalog entry whose copy they reuse. */
const VERSIONS = {
  calendar: 'usertest-5',
  'issue-tracker': 'usertest',
  money: 'usertest',
  notion: 'usertest',
  timesheets: 'usertest',
};
const APPS = {
  calendar: {
    base: 'calendar',
    name: 'Google Calendar',
    emoji: '📅',
    row: ['Event', 'Events'],
    // Has app/report.ts; gets the collector prelude.
    report: true,
  },
  'issue-tracker': {
    base: 'issue-tracker',
    name: 'GitHub issues',
    emoji: '🐙',
    description: 'Import the issues of a GitHub repository into a table.',
    row: ['Issue', 'Issues'],
  },
  money: { base: 'money', row: ['Transaction', 'Transactions'] },
  notion: { base: 'notion', row: ['Page', 'Pages'] },
  timesheets: { base: 'timesheets', row: ['Time entry', 'Time entries'] },
};

const LOG_URL = process.env.USERTEST_LOG_URL;
if (LOG_URL && !/^https:\/\/[^/]+\/log$/.test(LOG_URL))
  throw new Error('USERTEST_LOG_URL must look like https://<host>/log');
/** text/plain keeps the post a simple request: no CORS preflight from the
 * frame's null origin. A failing collector never affects the app. */
const PRELUDE = LOG_URL
  ? `globalThis.__USERTEST_REPORT__=e=>{try{fetch(${JSON.stringify(LOG_URL)},{method:"POST",keepalive:!0,headers:{"content-type":"text/plain"},body:JSON.stringify(e)}).catch(()=>{})}catch{}};\n`
  : '';

const catalog = JSON.parse(
  readFileSync(resolve(repo, 'integrations/catalog.json'), 'utf8'),
);
const byShortname = name => catalog.find(r => r[A + 'shortname'] === name);

for (const [id, app] of Object.entries(APPS)) {
  const version = VERSIONS[id];
  const { build } = await import(
    pathToFileURL(resolve(repo, 'integrations', id, 'app/build.mjs')).href
  );
  const file = resolve(out, 'apps', id, version, 'ui.js');
  mkdirSync(dirname(file), { recursive: true });
  await build({ outfile: file });
  if (PRELUDE && app.report)
    writeFileSync(file, PRELUDE + readFileSync(file, 'utf8'));
  const bytes = readFileSync(file);

  const source = byShortname(app.base);
  if (!source) throw new Error(`catalog.json has no entry ${app.base}`);
  const entry = { ...source };
  entry[A + 'localId'] = id;
  entry[A + 'shortname'] = id;
  if (app.name) entry[A + 'name'] = app.name;
  if (app.emoji) entry[A + 'emoji'] = app.emoji;
  if (app.description) entry[A + 'description'] = app.description;
  // A drive app, not a sandbox plugin: it needs no API-plugins host.
  delete entry[I + 'requires-api-plugins'];
  entry[I + 'version'] = version;
  entry[I + 'app-module'] = `apps/${id}/${version}/ui.js`;
  entry[I + 'app-module-integrity'] =
    'sha384-' + createHash('sha384').update(bytes).digest('base64');
  entry[I + 'app-row-name'] = app.row[0];
  entry[I + 'app-row-name-plural'] = app.row[1];

  const at = catalog.indexOf(source);
  if (app.base === id) catalog[at] = entry;
  else catalog.splice(at + 1, 0, entry);
}

// Every drive app, Pets included: enabled, and shown without the toggle.
for (const entry of catalog) {
  if (!entry[I + 'app-module']) continue;
  entry[I + 'enabled'] = true;
  entry[I + 'experimental'] = false;
}

mkdirSync(out, { recursive: true });
writeFileSync(
  resolve(out, 'catalog.json'),
  JSON.stringify(catalog, null, 2) + '\n',
);
for (const entry of catalog)
  if (entry[I + 'app-module'])
    console.log(`${entry[A + 'shortname']} ${entry[I + 'version']}`);
