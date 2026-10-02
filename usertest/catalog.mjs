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
 * With sample data (#196): each app in SAMPLES also gets a second entry,
 * "<App> (sample data)", whose module wraps the same built app with
 * `sample-data/proxy.mjs` and one of the mock proxy's provider fixtures, so
 * it runs on invented data without a provider account (sample-data/README.md).
 * Its version is the app's plus SAMPLE_VERSION, so it changes with either.
 * The sample bank statements for the Money app
 * (integrations/money/fixtures/usertest/) are copied to samples/money/.
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
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const out = resolve(process.argv[2] ?? resolve(here, 'out'));

const A = 'https://atomicdata.dev/properties/';
const I = 'https://atomicdata.dev/integrations/properties/';

/** Drive apps built here. `base` is the catalog entry whose copy they reuse. */
const VERSIONS = {
  calendar: 'usertest-9',
  'issue-tracker': 'usertest-6',
  money: 'usertest-2',
  notion: 'usertest-4',
  timesheets: 'usertest-5',
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

/**
 * Apps that also get a sample-data entry, by their id in APPS, with the
 * provider fixture under sample-data/. Bump SAMPLE_VERSION whenever
 * sample-data/ or a fixture it imports changes.
 */
const SAMPLE_VERSION = 'sample-1';
const SAMPLES = {
  calendar: { provider: 'Google Calendar', name: 'Google Calendar' },
  'issue-tracker': { provider: 'GitHub', name: 'GitHub issues' },
  timesheets: { provider: 'Clockify', name: 'Clockify timesheets' },
  notion: { provider: 'Notion', name: 'Notion' },
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

const require = createRequire(resolve(repo, 'browser/package.json'));
const esbuild = require('esbuild');

/**
 * The app's built module, wrapped so that its `store.proxy` is the sample
 * account of sample-data/<id>.mjs. It bundles the app's built module (before
 * the collector prelude), so the sample entry runs the same app build as the
 * real entry, minified once more together with the wrapper.
 */
async function buildSample(id, appFile, file, prelude) {
  const at = path => JSON.stringify(path);
  const result = await esbuild.build({
    stdin: {
      contents: [
        `import { view as appView } from ${at(appFile)};`,
        `import provider from ${at(resolve(here, 'sample-data', `${id}.mjs`))};`,
        `import { sampleView } from ${at(resolve(here, 'sample-data/proxy.mjs'))};`,
        'export const view = sampleView(appView, provider);',
      ].join('\n'),
      resolveDir: repo,
      loader: 'js',
    },
    absWorkingDir: repo,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    legalComments: 'none',
    minify: true,
    write: false,
    logLevel: 'silent',
    plugins: [
      {
        // The notion fixture reads its OpenAPI document with node:fs, only
        // when the mock proxy asks for `document`; the frame never does.
        name: 'no-node-fs',
        setup(builder) {
          builder.onResolve({ filter: /^node:fs$/ }, () => ({
            path: 'node:fs',
            namespace: 'no-node-fs',
          }));
          builder.onLoad({ filter: /.*/, namespace: 'no-node-fs' }, () => ({
            contents:
              'export function readFileSync() { throw new Error("no file system in the frame"); }',
            loader: 'js',
          }));
        },
      },
    ],
  });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, prelude + result.outputFiles[0].text);
}

/** One catalog entry for a built module. */
function entryFor(source, id, version, bytes, fields) {
  const entry = { ...source };
  entry[A + 'localId'] = id;
  entry[A + 'shortname'] = id;
  for (const [key, value] of Object.entries(fields))
    if (value) entry[A + key] = value;
  // A drive app, not a sandbox plugin: it needs no API-plugins host.
  delete entry[I + 'requires-api-plugins'];
  entry[I + 'version'] = version;
  entry[I + 'app-module'] = `apps/${id}/${version}/ui.js`;
  entry[I + 'app-module-integrity'] =
    'sha384-' + createHash('sha384').update(bytes).digest('base64');

  return entry;
}

for (const [id, app] of Object.entries(APPS)) {
  const version = VERSIONS[id];
  const { build } = await import(
    pathToFileURL(resolve(repo, 'integrations', id, 'app/build.mjs')).href
  );
  const file = resolve(out, 'apps', id, version, 'ui.js');
  mkdirSync(dirname(file), { recursive: true });
  // The app alone, before the prelude: what a sample entry wraps.
  await build({ outfile: file });
  const plain = readFileSync(file, 'utf8');
  const prelude = app.report ? PRELUDE : '';
  if (prelude) writeFileSync(file, prelude + plain);
  const bytes = readFileSync(file);

  const source = byShortname(app.base);
  if (!source) throw new Error(`catalog.json has no entry ${app.base}`);
  const entry = entryFor(source, id, version, bytes, {
    name: app.name,
    emoji: app.emoji,
    description: app.description,
  });
  entry[I + 'app-row-name'] = app.row[0];
  entry[I + 'app-row-name-plural'] = app.row[1];

  const at = catalog.indexOf(source);
  if (app.base === id) catalog[at] = entry;
  else catalog.splice(at + 1, 0, entry);

  const sample = SAMPLES[id];
  if (!sample) continue;
  const sampleId = `${id}-sample`;
  const sampleVersion = `${version}-${SAMPLE_VERSION}`;
  const sampleFile = resolve(out, 'apps', sampleId, sampleVersion, 'ui.js');
  const appFile = resolve(out, 'apps', id, version, 'plain.js');
  writeFileSync(appFile, plain);
  await buildSample(id, appFile, sampleFile, prelude);
  rmSync(appFile);
  const sampleEntry = entryFor(
    entry,
    sampleId,
    sampleVersion,
    readFileSync(sampleFile),
    {
      name: `${sample.name} (sample data)`,
      description: `Try ${sample.name} on invented sample data, without a ${sample.provider} account. For user testing: nothing reaches ${sample.provider}, and its changes stay in this app.`,
    },
  );
  catalog.splice(catalog.indexOf(entry) + 1, 0, sampleEntry);
}

// Sample files testers download during a session (moderator/sessions/*.md
// name them; the page links them): catalog.<base-domain>/samples/<app>/.
const SAMPLE_FILES = {
  money: resolve(repo, 'integrations/money/fixtures/usertest'),
};
for (const [app, dir] of Object.entries(SAMPLE_FILES)) {
  mkdirSync(resolve(out, 'samples', app), { recursive: true });
  for (const name of readdirSync(dir))
    if (/\.(mt940|xml)$/.test(name))
      copyFileSync(resolve(dir, name), resolve(out, 'samples', app, name));
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
