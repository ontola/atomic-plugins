// @wc-ignore-file
/**
 * The two steps every plugin-routes e2e lane repeats around installing a
 * bundle on the pinned host: open a new Plugin draft, and wait until the
 * install has reached the server. Used by the remoteStorage, Open Cloud Mesh,
 * Fediverse, Solid, Willow, AT Protocol and Willow drop specs.
 *
 * Why this is under integrations/tooling/ and not in a plugin folder: a lane
 * may not import a sibling plugin's folder, and a copy per lane had already
 * drifted once (#248, #289). Bare `@playwright/test` and `@tomic/lib` imports
 * resolve here exactly as in a lane's e2e/ folder: node's upward lookup from
 * integrations/tooling/e2e/ reaches the same `integrations/node_modules`
 * symlink to `browser/e2e/node_modules` (the other specs in this folder rely
 * on it), and `../../../browser/e2e/tests/test-utils` is the same relative
 * path as from `integrations/<lane>/e2e/`. The file is not a `*.spec.ts`, so
 * Playwright does not run it as a test; tsc reaches it through the specs'
 * imports (`integrations/tsconfig.e2e.json`). A lane that imports it lists it
 * as a build dependency in `integrations/tooling/lanes.mjs`, so a change here
 * reruns those lanes. A plugin's own e2e/ code can still skip it and stay
 * self-contained; plugin-routes.spec.ts and signed-post.ts do.
 */
import { expect, type Page } from '@playwright/test';
import {
  createFromCatalog,
  waitForSynced,
} from '../../../browser/e2e/tests/test-utils';

/**
 * Opens a new Plugin draft from the catalog and waits for its editor
 * (`New plugin` heading, 45 s). Returns when the page is on the draft, so the
 * caller can fill in its source.
 *
 * `warm` (default true) first waits for the store to sync, loads /app/new and
 * waits up to 60 s for the template search box. `createFromCatalog` reloads
 * the SPA at /app/new and fills that search with Playwright's default 10 s
 * action timeout, which a CI runner can miss while the page is still on the
 * boot splash (run 36891774224: the page snapshot was only the "Atomic Place"
 * logo). With the page warm, the helper's own reload finds a running app. A
 * spec that is already on a loaded page and has not needed it passes
 * `warm: false`; the Willow route spec does today (its behaviour is
 * unchanged by this module, so it is not a claim that it cannot flake).
 */
export async function openNewPluginDraft(
  page: Page,
  { warm = true }: { warm?: boolean } = {},
) {
  if (warm) {
    await waitForSynced(page);
    await page.goto(new URL('/app/new', page.url()).href);
    await expect(
      page.getByRole('searchbox', {
        name: 'Search templates and resource types',
      }),
    ).toBeVisible({ timeout: 60_000 });
  }
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
}

/**
 * Waits up to 60 s for the page's outbox to drain. An install (or a rights
 * edit made in the page) navigates as soon as the Installation and the
 * folder's write grant are saved locally, before the server has them; a route
 * write in that window is refused as `500 route-write-failed` (the
 * remoteStorage lane's race, #248; open-cloud-mesh on PR #280, run
 * 37033430608). Call it before any route request.
 */
export async function waitForOutboxDrained(page: Page) {
  await waitForSynced(page, 60_000);
}
