// @wc-ignore-file
/**
 * The pinned host offers an integration through a lens of the shared lens
 * catalog (`ontology/lenses/`, ontology-kit/LENSES.md), served by the lane's
 * dev-server with its subjects on the dev-server's origin
 * (integrations/tooling/dev-server.mjs `ontologyFile`, `serveTerm`):
 *
 *   node integrations/tooling/run-lane.mjs ontology --tier e2e
 *
 * Needs atomic-server candidate21 (`e922179`, atomic-server 28da8f0d2) or
 * later: behind the split-pieces flag (localStorage
 * `atomic.experimental.split-pieces`), it loads the catalog release named by
 * localStorage `lens-catalog-url` (by default the published
 * https://ontola.github.io/atomic-plugins/ontology/lenses/v1), and trusts its
 * lenses on every drive. The spec seeds that key before the first script
 * runs, the way the host's playwright config seeds `plugin-catalog-url`.
 *
 * - The tester entry of the split-pieces demo (`/app/pieces-demo?tester`)
 *   mints the pieces vocabulary (`piece-kind`) on a fresh drive.
 * - A probe integration is added to the drive: an App with `piece-kind`
 *   "integration" that renders only the provider-shaped endpoint of the
 *   catalog's Todoist lens (`record:APIs/todoist.com/1#task`), so nothing
 *   but that lens can bring it to an `issue-v1` table. Its module writes
 *   what the host's `getData()` hands it into the frame.
 * - On a hand-made table of the dev-server's `issue-v1`, Connect offers the
 *   probe "via lens", through "Todoist task ↔ Issue".
 * - Connecting it opens its tab, and the frame receives that lens in
 *   `lensPath`: the catalog subject, walked backward (issue-v1 to the
 *   Todoist record), with the mapping as the catalog file has it.
 *
 * Found on the way, at candidate21: a drive App cannot declare a `record:`
 * endpoint in `renders` through the client's validation (a ResourceArray
 * entry must be a subject or a slug-like relative subject; "Not a valid
 * Relative Subject: record:APIs/todoist.com/1#task"). The probe sets it
 * unvalidated, which atomic-server accepts. Until an App can declare it,
 * every lens in release 1 (each has a `record:` or `rdf:` endpoint) offers
 * only integrations made that way.
 *
 * Not checked here: the real Todoist drive app (it renders `issue-v1`
 * natively, so it needs no lens), syncing through the lens, a lens the host
 * skips (an unknown mapping version, a file not at its own subject), and the
 * published github.io release. The catalog is fetched by the browser only,
 * so unlike ontology.spec.ts this spec uses `localhost` with
 * ATOMIC_SERVER_IMAGE set too: the host accepts a lens catalog URL only on
 * HTTPS or loopback, and `host.docker.internal` is neither.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import {
  before,
  FRONTEND_URL,
  openSubject,
} from '../../../browser/e2e/tests/test-utils';

// Playwright loads this spec as CommonJS, so __dirname, not import.meta.
const repo = resolve(__dirname, '../../..');
const PUBLISHED: string = JSON.parse(
  readFileSync(resolve(repo, 'ontology-kit/base.json'), 'utf8'),
).base;
const DEV_PORT = new URL(
  process.env.PLUGIN_CATALOG_URL ?? 'http://localhost:19271/x',
).port;
const BASE = `http://localhost:${DEV_PORT}/ontology`;
const RELEASE = `${BASE}/lenses/v1`;

/** A committed ontology file, as the dev-server serves it. */
const served = (path: string) =>
  JSON.parse(
    readFileSync(resolve(repo, 'ontology', path), 'utf8').replaceAll(
      PUBLISHED,
      BASE,
    ),
  ) as Record<string, unknown>;

const LENS = served('lenses/todoist-task-issue-v1') as {
  '@id': string;
  name: string;
  mapping: unknown;
};
const ISSUE = `${BASE}/classes/issue-v1`;
/** The lens's provider-shaped endpoint, as the host keys it (`endpointKey`). */
const TODOIST_TASK = 'record:APIs/todoist.com/1#task';
const PROBE = 'Lens catalog probe';

const P = {
  name: 'https://atomicdata.dev/properties/name',
  shortname: 'https://atomicdata.dev/properties/shortname',
  isA: 'https://atomicdata.dev/properties/isA',
  classtype: 'https://atomicdata.dev/properties/classtype',
  table: 'https://atomicdata.dev/classes/Table',
};

/**
 * The probe's module: it shows nothing but what `getData()` returned, so the
 * spec reads the host's hand-over off the frame.
 */
const PROBE_SOURCE = `export async function view({ root, store }) {
  const data = await store.getData();
  const out = document.createElement('pre');
  out.id = 'lens-probe';
  out.textContent = JSON.stringify({
    rowClass: data?.rowClass ?? null,
    lensPath: data?.lensPath ?? null,
    pendingReview: data?.pendingReview ?? null,
  });
  root.replaceChildren(out);
}
`;

test.describe('shared lens catalog', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    await page.addInitScript(
      ([url]) => {
        localStorage.setItem('atomic.experimental.split-pieces', 'true');
        localStorage.setItem('lens-catalog-url', url);
      },
      [RELEASE],
    );
    await before({ page }, testInfo);
  });

  test('Connect offers an integration through a catalog lens, and its frame gets the lens', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    expect(LENS['@id']).toBe(`${BASE}/lenses/todoist-task-issue-v1`);

    // The catalog the host will load is the dev-server's, served as Pages
    // serves it, and lists the Todoist lens at its own subject.
    const release = await page.evaluate(async url => {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });

      return { status: res.status, body: JSON.parse(await res.text()) };
    }, RELEASE);
    expect(release.status).toBe(200);
    expect(release.body.lenses).toContain(LENS['@id']);

    // The tester entry seeds the demo, which mints `piece-kind`, and lands
    // on its Hours table.
    await page.goto(`${FRONTEND_URL}/app/pieces-demo?tester`);
    await expect(
      page.getByRole('button', { name: 'Connect', exact: true }),
    ).toBeVisible({ timeout: 60_000 });

    const made = await page.evaluate(
      async ({ p, issue, task, source, probe }) => {
        const store = window.store!;
        const drive = store.getDrive()!;
        const seeded = JSON.parse(
          localStorage.getItem(
            `atomic.experimental.split-pieces.seeded:${drive}`,
          ) ?? 'null',
        ) as { clockify: string } | null;
        if (!seeded) throw new Error('the demo did not record what it seeded');

        // The property subjects by shortname, read off the demo's Clockify
        // integration and its entry point, so this spec names no drive-local
        // subject.
        const byShortname = async (subject: string) => {
          const resource = await store.getResource(subject);
          const out: Record<string, string> = {};

          const propVals = resource.getPropVals() as unknown;
          const keys =
            propVals instanceof Map
              ? [...propVals.keys()]
              : Object.keys(propVals as object);

          for (const prop of keys) {
            const short = (await store.getResource(prop)).get(p.shortname);
            if (typeof short === 'string') out[short] = prop;
          }

          return { resource, props: out };
        };

        const app = await byShortname(seeded.clockify);
        const entry = app.resource.get(app.props.entrypoint) as string;
        const script = await byShortname(entry);

        const probeApp = await store.newResource({
          parent: drive,
          isA: app.resource.get(p.isA) as string[],
          propVals: {
            [p.name]: probe,
            [app.props['piece-kind']]: 'integration',
          },
        });
        // `renders` is a ResourceArray, and the client refuses a `record:`
        // key as a subject (it takes relative subjects for slugs), so the
        // value is set unvalidated. No drive App can declare it otherwise
        // at candidate21; see the spec's header.
        await probeApp.set(app.props.renders, [task], false);
        await probeApp.save();
        const probeEntry = await store.newResource({
          parent: probeApp.subject,
          isA: script.resource.get(p.isA) as string[],
          propVals: {
            [p.name]: `${probe} view`,
            [script.props['plugin-source']]: source,
          },
        });
        await probeEntry.save();
        await probeApp.set(app.props.entrypoint, probeEntry.subject);
        await probeApp.save();

        const table = await store.newResource({
          parent: drive,
          isA: [p.table],
          propVals: { [p.name]: 'Catalog lens issues', [p.classtype]: issue },
        });
        await table.save();

        return { app: probeApp.subject, table: table.subject };
      },
      {
        p: P,
        issue: ISSUE,
        task: TODOIST_TASK,
        source: PROBE_SOURCE,
        probe: PROBE,
      },
    );

    await openSubject(page, made.table);
    const connect = page.getByRole('button', { name: 'Connect', exact: true });
    await expect(connect).toBeVisible({ timeout: 30_000 });
    await connect.click();
    const item = page.getByRole('menuitem', { name: new RegExp(PROBE) });
    await expect(item).toBeVisible();
    await expect(item).toContainText('via lens');
    await expect(item).toHaveAttribute('title', `Through ${LENS.name}`);
    await expect(item).toBeEnabled();
    await item.click();

    const frame = page.frameLocator('iframe[title="App"]');
    const probe = frame.locator('#lens-probe');
    await expect(probe).toHaveText(/lensPath/, { timeout: 30_000 });
    const got = JSON.parse((await probe.textContent()) ?? 'null');
    expect(got.rowClass).toBe(ISSUE);
    expect(got.pendingReview).toEqual([]);
    expect(got.lensPath).toEqual([
      {
        subject: LENS['@id'],
        name: LENS.name,
        direction: 'backward',
        mapping: LENS.mapping,
      },
    ]);
  });
});
