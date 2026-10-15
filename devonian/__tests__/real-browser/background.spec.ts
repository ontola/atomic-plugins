import { expect, test, type Page } from '@playwright/test';
import { bundle, root } from '../browser/bundling.js';
import { html, js, serve } from './server.js';

/**
 * `devonian/background` in headless Chromium (#259 item 5), where the unit
 * tests use fakes: the default leases are the browser's Web Locks, shared
 * by every tab of an origin and released when a tab closes; the state lives
 * in IndexedDB, shared by the tabs and the service worker; and a service
 * worker's `sync` event runs a tick (fixtures/tab.mjs, fixtures/sw.mjs).
 *
 * Not covered: Periodic Background Sync firing (the browser decides when,
 * and only for an installed app with the permission), Firefox and Safari.
 */
interface Harness {
  hasWebLocks(): boolean;
  startHeld(name: string, intervalMs: number): Promise<void>;
  releaseHeld(): Promise<string>;
  tick(name: string, intervalMs: number): Promise<string>;
  count(key: string): Promise<number>;
  registerWorker(): Promise<{
    periodic: boolean;
    oneShot: boolean;
    errors: string[];
  }>;
}

declare global {
  interface Window {
    devonian: Harness;
  }
}

let server: Awaited<ReturnType<typeof serve>>;

async function script(fixture: string): Promise<string> {
  const { text, nodeImports } = await bundle(
    `${root}__tests__/real-browser/fixtures/${fixture}.mjs`,
    'iife',
  );
  if (nodeImports.length)
    throw new Error(`${fixture}: ${nodeImports.join(', ')}`);
  return text;
}

test.beforeAll(async () => {
  server = await serve({
    '/': html('/tab.js'),
    '/tab.js': js(await script('tab')),
    '/sw.js': js(await script('sw')),
  });
});

test.afterAll(async () => {
  await server?.close();
});

async function tab(page: Page): Promise<Page> {
  await page.goto(`${server.origin}/`);
  await page.waitForFunction(() => 'devonian' in window);
  return page;
}

test('two tabs share one lease and one schedule', async ({ context }) => {
  const a = await tab(await context.newPage());
  const b = await tab(await context.newPage());
  expect(await a.evaluate(() => window.devonian.hasWebLocks())).toBe(true);

  // A holds the lease mid-pass: B's tick finds it taken and does not run.
  await a.evaluate(() => window.devonian.startHeld('shared', 60_000));
  expect(await b.evaluate(() => window.devonian.tick('shared', 60_000))).toBe(
    'busy',
  );
  expect(await a.evaluate(() => window.devonian.releaseHeld())).toBe('ran');

  // A's pass wrote the next due time to IndexedDB: B is not due.
  expect(await b.evaluate(() => window.devonian.tick('shared', 60_000))).toBe(
    'not-due',
  );
  expect(await b.evaluate(() => window.devonian.count('runs-shared'))).toBe(1);
});

test('a tab closed mid-pass leaves no stale lease', async ({ context }) => {
  const a = await tab(await context.newPage());
  const b = await tab(await context.newPage());

  await a.evaluate(() => window.devonian.startHeld('closed', 60_000));
  expect(await b.evaluate(() => window.devonian.tick('closed', 60_000))).toBe(
    'busy',
  );
  // The pass never finished, so nothing was written and the work is still
  // due; the browser releases the closed tab's lock.
  await a.close();
  await expect
    .poll(() => b.evaluate(() => window.devonian.tick('closed', 60_000)))
    .toBe('ran');
  expect(await b.evaluate(() => window.devonian.count('runs-closed'))).toBe(2);
});

test('a service worker sync event runs a tick on the shared store', async ({
  context,
}) => {
  const page = await tab(await context.newPage());
  const registered = await page.evaluate(() =>
    window.devonian.registerWorker(),
  );
  // One-shot sync registers. Periodic sync is refused, as for any site that
  // is not an installed app with the permission: the result says so, and
  // nothing throws.
  expect(registered).toEqual({
    oneShot: true,
    periodic: false,
    errors: ['periodic: Permission denied.'],
  });

  // The browser fires the one-shot sync at once while online; the worker's
  // pass counts itself in the IndexedDB the tabs read.
  await expect
    .poll(() => page.evaluate(() => window.devonian.count('runs-worker')), {
      timeout: 15_000,
    })
    .toBe(1);
});
