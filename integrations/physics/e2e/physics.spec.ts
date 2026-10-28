// @wc-ignore-file
/**
 * The three physics drive apps (Lenzen, Magneten, Trillingen) in a real host:
 * each is installed from the catalog's Drive apps section under "Show
 * experimental plugins" (the lane's dev-server serving the committed
 * `apps/physics-<id>/<version>/ui.js` in place of GitHub Pages), runs in its
 * null-origin iframe, and reacts to a keypress and to a pointer drag.
 *
 * The apps read and write nothing and use no ontology, so unlike the
 * learning lane this needs no network access to ontola.github.io. Run it
 * the way CI does:
 *   node integrations/tooling/run-lane.mjs physics --tier e2e
 */
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const APP_FRAME = 'iframe[title="App"]';

async function installFromCatalog(
  page: Page,
  id: string,
  name: string,
  version: string,
) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator(`[data-catalog-app="${id}"]`);
  await expect(entry).toContainText(`Version ${version}`);
  await entry.getByRole('button', { name: `Install ${name}` }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return page.frameLocator(APP_FRAME);
}

/** Drags from the middle of `from` by (dx, dy) screen pixels, in page coordinates. */
async function dragBy(
  page: Page,
  from: ReturnType<FrameLocator['locator']>,
  dx: number,
  dy: number,
) {
  await from.scrollIntoViewIfNeeded();
  const box = (await from.boundingBox())!;
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
  await page.mouse.move(x + dx, y + dy, { steps: 4 });
  await page.mouse.up();
}

const values = (app: FrameLocator) => app.locator('.ph-values dd');

test.describe('physics drive apps', () => {
  test.beforeEach(before);

  test('Lenzen: renders the rays and the image, reacts to a key and a drag, switches to a concave lens', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const app = await installFromCatalog(
      page,
      'physics-lens',
      'Lenzen',
      appVersion('physics-lens'),
    );
    await expect(app.getByRole('heading', { level: 1 })).toHaveText(
      /Lenses|Lenzen/,
      { timeout: 45_000 },
    );
    // Three rays, incoming and outgoing each (Playwright counts a horizontal line as not visible).
    await expect(
      app.locator('[data-rays] line:not([style*="none"])'),
    ).toHaveCount(6);
    // v = 14, f = 6 -> b = 10.5.
    await expect(values(app).nth(1)).toHaveText(/^10[.,]5 cm$/);

    const object = app.locator('[data-handle="object"]');
    await object.focus();
    await page.keyboard.press('ArrowRight');
    await expect(values(app).nth(0)).toHaveText(/^13[.,]5 cm$/);

    const distance = await values(app).nth(0).textContent();
    await dragBy(page, object, 60, 0);
    await expect(values(app).nth(0)).not.toHaveText(distance!);

    await app.getByRole('radio', { name: /Concave|Hol/ }).check();
    await expect(values(app).nth(2)).toHaveText(/^-\d+[.,]\d cm$/);
    await expect(values(app).nth(1)).toHaveText(/^-\d+[.,]\d cm$/);
  });

  test('Magneten: draws field lines, moves the compass and shows attraction for two magnets', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const app = await installFromCatalog(
      page,
      'physics-magnet',
      'Magneten',
      appVersion('physics-magnet'),
    );
    await expect(app.getByRole('heading', { level: 1 })).toHaveText(
      /Magnets|Magneten/,
      { timeout: 45_000 },
    );
    await expect(app.locator('[data-layer="lines"]')).toHaveAttribute(
      'd',
      /M.*L/,
    );

    const compass = app.locator('[data-handle="compass"]');
    const field = await app.locator('[data-field]').textContent();
    await compass.focus();
    for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowLeft');
    await expect(app.locator('[data-field]')).not.toHaveText(field!);

    await app.getByRole('radio', { name: '2', exact: true }).check();
    await expect(app.locator('[data-verdict]')).toHaveText(
      /Attraction|Aantrekking/,
    );
    await app
      .getByRole('button', { name: /Flip magnet 2|Keer magneet 2 om/ })
      .click();
    await expect(app.locator('[data-verdict]')).toHaveText(
      /Repulsion|Afstoting/,
    );

    const label = await app
      .locator('[data-handle="magnet-1"]')
      .getAttribute('aria-label');
    await dragBy(
      page,
      app.locator('[data-handle="magnet-1"] rect').nth(2),
      0,
      50,
    );
    await expect(app.locator('[data-handle="magnet-1"]')).not.toHaveAttribute(
      'aria-label',
      label!,
    );
  });

  test('Trillingen: animates, measures the period, and reacts to a key and a drag', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const app = await installFromCatalog(
      page,
      'physics-spring',
      'Trillingen',
      appVersion('physics-spring'),
    );
    await expect(app.getByRole('heading', { level: 1 })).toHaveText(
      /Oscillations|Trillingen/,
      { timeout: 45_000 },
    );
    // T = 2 pi sqrt(0.5 / 20) = 0.99 s, from the formula and measured from the motion.
    await expect(values(app).nth(0)).toHaveText(/^0[.,]99 s$/);
    await expect(values(app).nth(1)).toHaveText(/^0[.,]99 s$/, {
      timeout: 30_000,
    });
    await expect(app.locator('[data-curve]')).toHaveAttribute('d', /M.*L/);

    const mass = app.locator('[data-handle="mass"]');
    await mass.focus();
    await page.keyboard.press('ArrowUp');
    const amplitude = app.locator('input[type=range]').nth(2);
    await expect(amplitude).toHaveValue('8.5');

    // Pause first: a moving mass cannot be scrolled to or grabbed reliably.
    await page.keyboard.press('Space');
    await expect(app.locator('[data-toggle]')).toHaveText(/Start/);
    await dragBy(page, mass.locator('rect').nth(1), 0, -30);
    await expect(amplitude).not.toHaveValue('8.5');
    const t = await values(app).nth(3).textContent();
    await page.waitForTimeout(400);
    await expect(values(app).nth(3)).toHaveText(t!);
  });
});
