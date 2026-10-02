#!/usr/bin/env node
/**
 * Takes the README's drive app screenshots (#49) into docs/screenshots/:
 *
 *   node integrations/tooling/link-atomic-server.mjs   # once, as in AGENTS.md
 *   node integrations/tooling/screenshots.mjs [pets calendar issue-tracker money notion timesheets]
 *
 * Starts atomic-server, the dev-server and the mock proxy (`pets` fixture) the
 * way run-lane.mjs does, on a fresh store, plus a static server for the
 * user-testing catalog that `usertest/catalog.mjs` builds (its "(sample data)"
 * entries). Then runs `e2e/screenshots.spec.ts`, which installs each app and
 * imports invented data; see that file for where each app's data comes from.
 * Each shot is 1280×800 in the light theme.
 *
 * Needs the pinned atomic-server binary that serve.mjs uses
 * ($ATOMIC_SERVER_CHECKOUT/target/e2e/atomic-server) or ATOMIC_SERVER_IMAGE,
 * Installs the drive apps' own dependencies first where they are missing,
 * as run-lane.mjs does: catalog.mjs builds every drive app. Ports 19280-19283: lane index 18 in lanes.json's
 * port formula, which no lane uses (usertest/e2e/samples.mjs takes 19).
 *
 * The PNGs are written as Playwright takes them. Shrink them afterwards if a
 * tool is at hand, e.g. `pngquant --skip-if-larger --ext .png --force`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { installMissing, pluginDependencyDirs } from './deps.mjs';
import { root } from './lanes.mjs';
import { bringUp, mockProxyOrigin, serverCheckout } from './serve.mjs';

process.env.RUST_LOG ??= 'warn';

const SHOTS = [
  'pets',
  'calendar',
  'issue-tracker',
  'money',
  'notion',
  'timesheets',
];
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : SHOTS;
for (const id of wanted)
  if (!SHOTS.includes(id))
    throw new Error(`no screenshot ${id}; known: ${SHOTS.join(', ')}`);

const LABEL = 'screenshots';
const ports = {
  atomicServer: 19280,
  devServer: 19281,
  mockProxy: 19282,
  sidecar: 19283,
};
const out = resolve(root, 'docs/screenshots');
mkdirSync(out, { recursive: true });

// usertest/catalog.mjs builds each of these apps from this checkout.
installMissing(
  [
    'calendar',
    'issue-tracker',
    'money',
    'notion',
    'pets',
    'timesheets',
  ].flatMap(pluginDependencyDirs),
);

// The user-testing catalog, built as a deploy builds it.
const catalogDir = mkdtempSync(join(tmpdir(), 'screenshots-catalog-'));
const built = spawnSync(
  process.execPath,
  [resolve(root, 'usertest/catalog.mjs'), catalogDir],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);
if (built.status !== 0) throw new Error('usertest/catalog.mjs failed');

const TYPES = { '.json': 'application/json', '.js': 'text/javascript' };
const catalog = createServer((req, res) => {
  const path = normalize(
    decodeURIComponent(new URL(req.url, 'http://x').pathname),
  );

  try {
    const body = readFileSync(join(catalogDir, path));
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'access-control-allow-origin': '*',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'access-control-allow-origin': '*' });
    res.end();
  }
});
await new Promise(done => catalog.listen(0, '127.0.0.1', done));

// A fresh store, so every app installs into an empty drive.
rmSync(resolve(serverCheckout(), `.lane-store/${LABEL}`), {
  recursive: true,
  force: true,
});
const stop = await bringUp({ ports, platforms: ['pets'], label: LABEL });

let status = 1;

try {
  // Not spawnSync: the catalog server above answers from this process's
  // event loop, which must keep running while Playwright does.
  const playwright = spawn(
    resolve(root, 'browser/e2e/node_modules/.bin/playwright'),
    [
      'test',
      '--config=integrations/tooling/playwright.config.ts',
      '--project=chromium',
      '--workers=1',
      '--retries=0',
      'integrations/tooling/e2e/screenshots.spec.ts',
      '--grep',
      `README screenshots (${wanted.join('|')})$`,
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        SERVER_URL: `http://localhost:${ports.atomicServer}`,
        FRONTEND_URL: `http://localhost:${ports.atomicServer}`,
        PLUGIN_CATALOG_URL: `http://localhost:${ports.devServer}/integrations/catalog.json`,
        INTEGRATION_PROXY_URL: mockProxyOrigin(ports),
        ATOMIC_MOCK_INTEGRATION_PROXY: '1',
        SAMPLE_CATALOG_URL: `http://127.0.0.1:${catalog.address().port}/catalog.json`,
        SCREENSHOTS_DIR: out,
      },
    },
  );
  status = await new Promise(done =>
    playwright.on('exit', code => done(code ?? 1)),
  );
} finally {
  catalog.close();
  rmSync(catalogDir, { recursive: true, force: true });
  await stop();
}

if (status === 0) console.log(`\nWrote ${wanted.join(', ')} to ${out}`);
process.exit(status);
