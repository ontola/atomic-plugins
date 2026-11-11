// @wc-ignore-file
/**
 * The three physics mini apps (Lenzen, Magneten, Trillingen) as they now
 * live: drive Apps created by the learning app's "Load starter tree", with
 * their module source stored in the drive and their lessons linked to them.
 * Each test installs the learning app from the catalog (the lane's dev-server
 * serving the committed `apps/learning/<version>/ui.js` in place of GitHub
 * Pages), loads the starter tree, presses Start on the lesson, and drives the
 * app the host then shows in its null-origin iframe: a keypress and a drag.
 *
 * The first test also checks what the host really stored: the App under the
 * learning app, its plugin-script child with the source, and the sidebar
 * listing. Like learning.spec.ts it needs network access to ontola.github.io
 * (the skill, lesson and mastery terms). Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs learning --tier e2e
 */
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';
import { appVersion } from '../../tooling/apps.mjs';

const APP_FRAME = 'iframe[title="App"]';
const VERSION = appVersion('learning');

test.beforeAll(async () => {
  const served = (await import(
    '../../../ontology-kit/served.mjs' as string
  )) as {
    classTermPaths(name: string): string[];
    servedProblems(paths: string[]): Promise<string[]>;
    notServedMessage(problems: string[]): string;
  };
  const problems = await served.servedProblems([
    ...served.classTermPaths('skill-v1'),
    ...served.classTermPaths('lesson-v1'),
    ...served.classTermPaths('mastery-v1'),
  ]);

  if (problems.length) throw new Error(served.notServedMessage(problems));
});

/** Installs Atomic Education, loads the starter tree, and opens `lesson` of `skill` with Start. */
async function startLesson(page: Page, skill: string, lesson: string) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="learning"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Atomic Education' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
  const learning = page.frameLocator(APP_FRAME);
  await learning.getByRole('button', { name: 'Load starter tree' }).click();
  await expect(learning.locator('.lb-node')).toHaveCount(30, {
    timeout: 90_000,
  });
  await expect(learning.locator('.lb-notices')).toContainText('3 mini apps', {
    timeout: 120_000,
  });
  await learning.locator('.lb-node', { hasText: skill }).first().click();
  await learning.getByRole('button', { name: `Start: ${lesson}` }).click();

  // The host navigates to the mini app: a different App in the same frame.
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });
  const frame = page.frameLocator(APP_FRAME);
  await expect(frame.locator('.lb-app')).toHaveCount(0);

  return frame;
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

test.describe('physics mini apps opened from the lesson programme', () => {
  test.beforeEach(before);

  test('Lenzen: renders the rays and the image, reacts to a key and a drag, switches to a concave lens', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const app = await startLesson(page, 'Optica', 'Lenzen (interactief)');
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
    const app = await startLesson(page, 'Magnetisme', 'Magneten (interactief)');
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
    const app = await startLesson(
      page,
      'Trillingen en golven',
      'Trillingen (interactief)',
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
