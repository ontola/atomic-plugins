#!/usr/bin/env node
// The sample-data drive apps (../sample-data/, #196) in the pinned
// atomic-server, headless: builds the user-testing catalog the way a deploy
// does (../catalog.mjs), serves it, opens a fresh drive the way the session
// page does (/app/dev-drive plus the catalog URL in localStorage), installs
// each "<App> (sample data)" entry from Integrations, runs its first import
// on the already-connected sample account, checks that an invented record
// shows, and that it still does after a reload of the page (a new frame).
//
//   node integrations/tooling/link-atomic-server.mjs   # once, as in AGENTS.md
//   npm ci --prefix usertest/e2e
//   node usertest/e2e/samples.mjs [calendar issue-tracker timesheets notion]
//
// Needs the atomic-server binary that serve.mjs uses
// ($ATOMIC_SERVER_CHECKOUT/target/e2e/atomic-server), or ATOMIC_SERVER_IMAGE.
// Ports 19290-19292 (lane index 19 in lanes.json's port formula, which no
// lane uses). No mock proxy runs: nothing here needs one.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { bringUp, serverCheckout } from '../../integrations/tooling/serve.mjs';

// atomic-server's request log is long; serve.mjs passes this through.
process.env.RUST_LOG ??= 'warn';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const LABEL = 'usertest-samples';
const ports = { atomicServer: 19290, devServer: 19291, mockProxy: 19292 };
const SERVER = `http://localhost:${ports.atomicServer}`;
const APP_FRAME = 'iframe[title="App"]';

/**
 * Each sample app: `start` takes it from its first screen (the sample account
 * is already connected) through its import; `shows` finds one invented record.
 */
const APPS = {
  calendar: {
    title: 'Google Calendar (sample data)',
    async start(app) {
      const choose = app.getByRole('form', { name: 'Choose a calendar' });
      await choose
        .getByRole('radio', { name: /Acme Studio/ })
        .waitFor({ timeout: 30_000 });
      await choose
        .getByRole('button', { name: 'Import this calendar' })
        .click();
      await app
        .locator('.pill')
        .filter({ hasText: 'Synced' })
        .waitFor({ timeout: 30_000 });
    },
    async shows(app) {
      await app.getByRole('button', { name: 'Agenda', exact: true }).click();
      await app
        .getByRole('button', {
          name: /^Design review: Bakkerij Zonnig packaging/,
        })
        .waitFor({ timeout: 15_000 });
    },
  },
  'issue-tracker': {
    title: 'GitHub issues (sample data)',
    async start(app) {
      await app
        .getByRole('radio', { name: /acme-studio\/website/ })
        .check({ timeout: 30_000 });
      await app
        .getByRole('button', { name: 'Import acme-studio/website' })
        .click();
    },
    async shows(app) {
      await app
        .getByText('Contact form accepts an empty email address')
        .first()
        .waitFor({ timeout: 30_000 });
    },
  },
  timesheets: {
    title: 'Clockify timesheets (sample data)',
    async start(app) {
      await app
        .getByText('Connected as Alex Sample')
        .waitFor({ timeout: 30_000 });
      await app.getByRole('button', { name: 'Import entries' }).click();
    },
    async shows(app) {
      await app
        .getByText('Webshop phase 2')
        .first()
        .waitFor({ timeout: 30_000 });
    },
  },
  notion: {
    title: 'Notion (sample data)',
    // Syncs by itself on first open.
    async start() {},
    async shows(app) {
      await app.getByText('Launch plan').first().waitFor({ timeout: 30_000 });
    },
  },
};

const wanted = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(APPS);
for (const id of wanted)
  if (!APPS[id])
    throw new Error(`no sample app ${id}; known: ${Object.keys(APPS)}`);

// The catalog, built as a deploy builds it.
const out = mkdtempSync(join(tmpdir(), 'usertest-samples-'));
const built = spawnSync(
  process.execPath,
  [resolve(repo, 'usertest/catalog.mjs'), out],
  {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
  },
);
if (built.status !== 0) throw new Error('catalog.mjs failed');

// Served like Caddy serves catalog.<base-domain>: any origin may read it.
const TYPES = { '.json': 'application/json', '.js': 'text/javascript' };
const catalog = createServer((req, res) => {
  const path = normalize(
    decodeURIComponent(new URL(req.url, 'http://x').pathname),
  );
  try {
    const body = readFileSync(join(out, path));
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
const CATALOG_URL = `http://127.0.0.1:${catalog.address().port}/catalog.json`;

// A fresh store each run, so every app installs into an empty drive.
rmSync(resolve(serverCheckout(), `.lane-store/${LABEL}`), {
  recursive: true,
  force: true,
});
const stop = await bringUp({ ports, platforms: [], label: LABEL });

const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
});
let failed = 0;

try {
  for (const id of wanted) {
    const spec = APPS[id];
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => {
      if (m.type() === 'error' || m.type() === 'warning')
        errors.push(`${m.type()}: ${m.text()}`);
    });
    try {
      await page.goto(`${SERVER}/app/dev-drive`);
      await page.waitForURL(url => !url.pathname.startsWith('/app/dev-drive'), {
        timeout: 60_000,
      });
      await page.evaluate(
        url => localStorage.setItem('plugin-catalog-url', url),
        CATALOG_URL,
      );
      await page.goto(`${SERVER}/app/integrations`);
      const entry = page
        .getByRole('region', { name: 'Drive apps' })
        .locator(`[data-catalog-app="${id}-sample"]`);
      await entry.waitFor({ timeout: 30_000 });
      await entry
        .getByRole('button', { name: `Install ${spec.title}` })
        .click();
      const frame = page.getByRole('main').locator(APP_FRAME);
      await frame.waitFor({ timeout: 45_000 });
      const app = page.frameLocator(APP_FRAME);
      await app.getByRole('note').filter({ hasText: 'Sample data' }).waitFor();
      await spec.start(app);
      await spec.shows(app);

      // Leave the app and come back: a new frame, the same sample account.
      const at = page.url();
      await page.reload();
      await page.waitForURL(at);
      await page
        .getByRole('main')
        .locator(APP_FRAME)
        .waitFor({ timeout: 45_000 });
      await spec.shows(page.frameLocator(APP_FRAME));
      console.log(
        `ok    ${spec.title}: imports sample records, keeps them after a reload`,
      );
    } catch (error) {
      failed++;
      console.log(`FAIL  ${spec.title}: ${error.message.split('\n')[0]}`);
      if (errors.length)
        console.log(`      page errors: ${errors.join(' | ')}`);
      await page.screenshot({ path: join(out, `${id}.png`) }).catch(() => {});
      console.log(`      screenshot: ${join(out, `${id}.png`)}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  catalog.close();
  await stop();
}

console.log(`\n${wanted.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
