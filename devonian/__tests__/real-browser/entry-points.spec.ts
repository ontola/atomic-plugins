import { expect, test } from '@playwright/test';
import { bundle, drivers, expected, root } from '../browser/bundling.js';
import { html, js, serve } from './server.js';

/**
 * Every public entry point in headless Chromium (#259 item 5): the drivers
 * of ../browser/fixtures/, bundled from build/ for the browser (the
 * `browser` export condition, no Node built-ins), each run as a page's
 * script. The results must equal what ../browser/bundle.test.ts expects
 * from its node:vm context, so the two runs check the same behaviour in a
 * simulated and a real browser.
 */
let server: Awaited<ReturnType<typeof serve>>;

test.beforeAll(async () => {
  const routes: Parameters<typeof serve>[0] = {};
  for (const driver of Object.values(drivers)) {
    const { text, nodeImports } = await bundle(
      `${root}__tests__/browser/fixtures/${driver}.mjs`,
      'iife',
    );
    if (nodeImports.length)
      throw new Error(`${driver}: ${nodeImports.join(', ')}`);
    routes[`/${driver}.html`] = html(`/${driver}.js`);
    routes[`/${driver}.js`] = js(text);
  }
  server = await serve(routes);
});

test.afterAll(async () => {
  await server?.close();
});

for (const [subpath, driver] of Object.entries(drivers))
  test(`${subpath} runs in Chromium`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${server.origin}/${driver}.html`);
    const result = await page.evaluate(async () =>
      JSON.parse(
        JSON.stringify(await (globalThis as { __result?: unknown }).__result),
      ),
    );
    expect(result).toEqual(expected[subpath]);
    expect(errors).toEqual([]);
  });
