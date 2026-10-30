// @wc-ignore-file
/**
 * The GitHub issues webhook inbox (inbox/, #369 step 4b) on the pinned host,
 * end to end against the lane's mock proxy (whose inbox routes are
 * integrations/localthought/mock-proxy-inbox.mjs):
 *
 * 1. The bundle, built for the mock proxy's origin, is published as a
 *    release from a Plugin draft and installed through its card under
 *    Integrations, as a person does.
 * 2. On the Installation page, Connections: Connect GitHub Issues, through
 *    the mock proxy's consent page. The page delegates the connection; this
 *    node's agent must then be registered as a runtime of the installation's
 *    app (host gap 1 below).
 * 3. The destination tables are created with `@tomic/lib`'s
 *    `provisionDestination`, run in the page against its own store (host gap
 *    2 below). The host has no "Set up" for a plugin that is not a file
 *    importer, so this is the only way; the plugin's README says so too.
 *    The installation's agent is given read on the schema and write on the
 *    three tables, as a person does under the Installation page's rights: a
 *    run writes with both the approver's and that agent's rights.
 * 4. A reviewed first sync (`/plugin-sync-preview`, `/plugin-sync-apply`)
 *    subscribes; `/plugin-sync-schedule` then runs it every 60 s, unattended.
 * 5. A delivery of about 1 MiB arrives: a scheduled run stores it whole as a
 *    Webhook delivery row, and a later run acknowledges it. The rows are read
 *    from the server by the subjects the run's checkpoint names
 *    (`lastWritten`).
 *
 * Host gaps at candidate22, worked around here and reported for
 * atomic-server:
 * 1. The Installation page does not register the node's runtime with the
 *    proxy: the InstallationRuntime child the node publishes reads back with
 *    no creator (`getCreatedBy()` is undefined), and the page's `asRuntime`
 *    skips such a child. The spec waits 20 s for the page, then sends the
 *    same owner-signed `POST /runtimes`, with a `host-gap` annotation.
 * 2. `provisionDestination` through a Node-side Store timed out against the
 *    lane server, so it runs in the page (bundled from the lib's source with
 *    a stand-in for Loro, and evaluated through Playwright because the
 *    page's CSP refuses an inline script).
 *
 * It needs a few minutes: two or three scheduled runs, 60 s apart.
 */
import { test, expect, type Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  Agent,
  signedRequestInit,
  type provisionDestination,
} from '@tomic/lib';
import {
  before,
  getDevDriveSecret,
  SERVER_URL,
  waitForSynced,
} from '../../../browser/e2e/tests/test-utils';
import {
  openNewPluginDraft,
  waitForOutboxDrained,
} from '../../tooling/e2e/route-install';

const PROXY = process.env.INTEGRATION_PROXY_URL ?? '';
const REPOSITORY = 'atomic-fixture/tracker';

test.describe('GitHub issues webhook inbox', () => {
  test.beforeEach(before);

  test('installs from its card, connects, and keeps a 1 MiB delivery before acknowledging it', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY || !PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(420_000);

    // 1. Build for the mock proxy, and read the manifest from the bundle.
    const { bundle } = (await import('../inbox/build.mjs' as string)) as {
      bundle(options: { proxyOrigin: string }): Promise<string>;
    };
    const code = await bundle({ proxyOrigin: PROXY });
    const { manifest } = (await import(
      `data:text/javascript,${encodeURIComponent(code)}`
    )) as {
      manifest: {
        destination: unknown;
        config: { key: string };
      };
    };

    const { drive, plugin } = await createDraft(page, code);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
    const published = await post(agent, '/plugin-release', { drive, plugin });
    expect(published.status, published.text).toBe(200);
    const releaseId = (published.json as { id: string }).id;
    const installation = await installFromCard(page, releaseId);

    // 2. Connect GitHub Issues on the Installation page.
    const connections = page.getByRole('region', { name: 'Connections' });
    await connections
      .getByRole('button', { name: 'Connect Github Issues' })
      .click();
    const consent = page.getByRole('dialog', { name: /^Connect / });
    await consent.getByRole('button', { name: 'Continue' }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync GitHub Issues with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/, {
      timeout: 30_000,
    });
    await expect(
      page.getByRole('region', { name: 'Connections' }),
    ).toContainText('Connected', { timeout: 30_000 });
    await waitForOutboxDrained(page);
    // The node publishes its agent on an InstallationRuntime child, and the
    // Installation page registers it with the proxy as a runtime of the
    // installation's app (`POST /runtimes`, signed by the owner). At
    // candidate22 the page does not: its `asRuntime` requires the child's
    // `getCreatedBy()` to be the runtime agent, and a child the node signed
    // reads back with no creator here, so it is skipped. Reported to the
    // coordinator as a host gap. The spec waits briefly for the page, then
    // sends the same request the page would, as the same owner.
    const { app, runtime } = await page.evaluate(async (subject: string) => {
      const store = window.store!;
      const resource = await store.fetchResourceFromServer(subject, {
        noWebSocket: true,
      });
      const children = await resource.getChildrenCollection(100);
      let runtimeAgent: unknown;

      for (const member of await children.getAllMembers()) {
        const child = await store.fetchResourceFromServer(member, {
          noWebSocket: true,
        });
        if (
          child.hasClasses('https://atomicdata.dev/classes/InstallationRuntime')
        )
          runtimeAgent = child.get(
            'https://atomicdata.dev/properties/integrationRuntimeAgent',
          );
      }

      return {
        app: resource.get(
          'https://atomicdata.dev/properties/integrationAppAgent',
        ) as string,
        runtime: runtimeAgent as string,
      };
    }, installation);
    expect(runtime, 'the node published its runtime agent').toBeTruthy();
    const proxyState = async () =>
      (await (await fetch(`${PROXY}/__mock/connections`)).json()) as {
        connections: {
          connection_id: string;
          platform: string;
          delegations: { agent: string }[];
        }[];
        runtimes: { app: string; agent: string }[];
      };
    const registered = async () =>
      (await proxyState()).runtimes.some(
        r => r.app === app && r.agent === runtime,
      );
    let byPage = true;

    try {
      await expect.poll(registered, { timeout: 20_000 }).toBe(true);
    } catch {
      byPage = false;
    }

    if (!byPage) {
      test.info().annotations.push({
        type: 'host-gap',
        description:
          'the Installation page did not register the node runtime; the spec did',
      });
      const url = `${PROXY}/runtimes`;
      const body = JSON.stringify({ app, agent: runtime });
      const response = await fetch(
        url,
        await signedRequestInit(url, agent, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }

    expect(await registered()).toBe(true);
    const connection = (await proxyState()).connections.findLast(
      c =>
        c.platform === 'github-issues' &&
        c.delegations.some(d => d.agent === app),
    )!.connection_id;

    // 3. The destination, as the host would set up an importer's. Host gap
    // 2: through a Node-side Store, provisionDestination timed out, so it
    // runs in the page.
    test.info().annotations.push({
      type: 'host-gap',
      description:
        'provisionDestination ran in the page, bundled with a stand-in for Loro: through a Node-side Store it timed out',
    });
    const destination = await provision(
      page,
      drive,
      installation,
      manifest.destination,
      manifest.config.key,
    );
    // A run writes as the person who approved it and as the installation's
    // agent at once (`store_host::check_effective_read`, and the same for
    // writes), so that agent needs read on the schema and write on the three
    // tables, as a person gives it under the Installation page's rights.
    await page.evaluate(
      async ({ subject, tables, property }) => {
        const store = window.store!;
        const installed = await store.getResource(subject);
        const pluginAgent = installed.get(
          'https://atomicdata.dev/properties/pluginAgent',
        ) as string;
        const ontology = (await store.getResource(property)).get(
          'https://atomicdata.dev/properties/parent',
        ) as string;

        for (const target of [ontology, ...tables]) {
          const resource = await store.getResource(target);
          resource.push(
            'https://atomicdata.dev/properties/read',
            [pluginAgent],
            true,
          );
          if (target !== ontology)
            resource.push(
              'https://atomicdata.dev/properties/write',
              [pluginAgent],
              true,
            );
          await resource.save();
        }
      },
      {
        subject: installation,
        tables: [
          destination.table!,
          destination.tables!.work!.table,
          destination.tables!.gaps!.table,
        ],
        property: destination.properties['webhook-delivery-id']!,
      },
    );
    // The page saves locally first; the server must have the schema, the
    // tables and the rights before a run writes into them.
    await waitForOutboxDrained(page);
    const config = { repository: REPOSITORY, ...destination };

    // 4. A reviewed first sync, then the schedule.
    const target = { drive, plugin: installation };
    const preview = await post(agent, '/plugin-sync-preview', {
      ...target,
      release: releaseId,
      config,
    });
    expect(preview.status, preview.text).toBe(200);
    const run = (preview.json as { run: string }).run;
    const applied = await post(agent, '/plugin-sync-apply', { ...target, run });
    expect(applied.status, applied.text).toBe(200);
    expect(
      (applied.json as { status: string }).status,
      (applied.json as { error?: string }).error,
    ).toBe('complete');
    const inbox = async () =>
      (
        (await (await fetch(`${PROXY}/__mock/inbox`)).json()) as {
          subscriptions: {
            id: string;
            connection: string;
            ack: number;
            refs: number;
          }[];
        }
      ).subscriptions.filter(s => s.connection === connection);
    expect(await inbox()).toHaveLength(1);
    const scheduled = await post(agent, '/plugin-sync-schedule', {
      ...target,
      run,
      interval_seconds: 60,
    });
    expect(scheduled.status, scheduled.text).toBe(200);

    // 5. About 1 MiB arrives; a scheduled run stores it whole.
    const body = JSON.stringify({
      action: 'edited',
      issue: { number: 1, body: 'x'.repeat(1_048_000) },
    });
    const routed = await fetch(`${PROXY}/__mock/inbox/deliver`, {
      method: 'POST',
      body: JSON.stringify({
        connection,
        deliveryId: 'e2e-large',
        eventType: 'issues',
        action: 'edited',
        body,
      }),
    });
    expect(await routed.json()).toEqual({ routed: 1 });
    const deliveryId = destination.properties['webhook-delivery-id']!;
    const payload = destination.properties['webhook-payload']!;
    const expected = Buffer.from(body).toString('base64');
    type Session = {
      status?: string;
      error?: string;
      result?: {
        records?: Record<string, { baseline?: { lastWritten?: string[] } }>;
      };
    };
    const syncStatus = async () =>
      (await post(agent, '/plugin-sync-status', { ...target, run: null }))
        .json as Session | null;
    // Each run's checkpoint names the rows it wrote (`lastWritten`). Read
    // them from the server: rows a server-side run writes reach the page's
    // local index only through drive sync.
    const written = new Set<string>();
    await expect
      .poll(
        async () => {
          const session = await syncStatus();
          for (const subject of session?.result?.records?.[
            'webhook-inbox:subscription'
          ]?.baseline?.lastWritten ?? [])
            written.add(subject);

          for (const subject of written) {
            const row = await page.evaluate(
              async (s: string) =>
                (
                  await window.store!.fetchResourceFromServer(s, {
                    noWebSocket: true,
                  })
                ).getPropVals(),
              subject,
            );
            if (row[deliveryId] === 'e2e-large')
              return row[payload] === expected &&
                row['https://atomicdata.dev/properties/parent'] ===
                  destination.table
                ? 'stored whole'
                : 'stored, but not as expected';
          }

          const subscription = (await inbox())[0];

          // Shown when the poll times out: where the scheduled runs stand.
          return `not stored; session ${session?.status} ${session?.error ?? ''}; inbox refs ${subscription?.refs} ack ${subscription?.ack}; rows written ${written.size}`;
        },
        { timeout: 180_000, intervals: [5_000] },
      )
      .toBe('stored whole');
    // Not acknowledged by the run that stored it; a later run does.
    await expect
      .poll(async () => (await inbox())[0]?.refs, { timeout: 180_000 })
      .toBe(0);
  });
});

type Destination = Awaited<ReturnType<typeof provisionDestination>>;

/**
 * `provisionDestination` from `@tomic/lib`'s source, bundled for the page and
 * run with the page's own store, which is connected and signed in.
 *
 * Host gap 2 (see the header): this works around a Node-side Store timing
 * out against the lane server. Loro's WASM is replaced by a stand-in,
 * because provisioning never edits a document.
 */
async function provision(
  page: Page,
  drive: string,
  plugin: string,
  destination: unknown,
  key: string,
): Promise<Destination> {
  // run-lane.mjs runs Playwright from the repository root.
  const browser = resolve(process.cwd(), 'browser');
  const { build } = createRequire(resolve(browser, 'package.json'))(
    'esbuild',
  ) as {
    build(options: object): Promise<{ outputFiles: { text: string }[] }>;
  };
  const bundled = await build({
    stdin: {
      contents: `import { provisionDestination } from ${JSON.stringify(
        resolve(browser, 'lib/src/plugin-destination.ts'),
      )}; globalThis.__inboxProvision = provisionDestination;`,
      resolveDir: browser,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // provisionDestination works on the store it is given (the page's);
    // what it imports from the lib never runs Loro, so a stand-in keeps its
    // WASM out of the bundle.
    plugins: [
      {
        name: 'no-loro',
        setup(b: {
          onResolve(o: object, f: () => object): void;
          onLoad(o: object, f: () => object): void;
        }) {
          b.onResolve({ filter: /^loro-crdt/ }, () => ({
            path: 'loro-crdt',
            namespace: 'no-loro',
          }));
          b.onLoad({ filter: /.*/, namespace: 'no-loro' }, () => ({
            contents: 'export const LoroDoc = class {}; export default {};',
            loader: 'js',
          }));
        },
      },
    ],
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  // As a string expression, evaluated through the DevTools protocol: the
  // page's CSP refuses an inline script tag.
  await page.evaluate(bundled.outputFiles[0]!.text);

  return page.evaluate(
    async args =>
      (
        globalThis as unknown as {
          __inboxProvision: (...a: unknown[]) => Promise<Destination>;
        }
      ).__inboxProvision(
        window.store!,
        args.drive,
        args.plugin,
        args.destination,
        args.key,
      ),
    { drive, plugin, destination, key },
  );
}

/** A Plugin draft in the test's drive whose source is `code`. */
async function createDraft(page: Page, code: string) {
  await openNewPluginDraft(page);

  return page.evaluate(
    async ({ source }) => {
      const store = window.store!;
      const plugin = new URL(location.href).searchParams.get('subject')!;
      const resource = await store.getResource(plugin);
      const sourceProp = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await resource.set(sourceProp, source);
      await resource.set(
        'https://atomicdata.dev/properties/name',
        'GitHub issues inbox',
      );
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content.
    { source: `${code}\n// run ${Date.now()}\n` },
  );
}

/**
 * Installs the release through its card under Integrations. Returns the
 * Installation, whose page it is on.
 */
async function installFromCard(page: Page, releaseId: string) {
  await waitForSynced(page);
  await page.goto(
    new URL('/app/integrations?preview=plugins', SERVER_URL).href,
  );
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  // The store page can take a while to boot on a busy runner.
  await expect(experimental).toBeVisible({ timeout: 45_000 });
  await experimental.check();
  const card = page.locator(`[data-release="${releaseId}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  const dialog = page.locator('dialog[open]');
  await expect(async () => {
    await card
      .getByRole('button', { name: 'Open', exact: true })
      .click({ timeout: 5_000 });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  // The review lists the four declared consumer operations; this release
  // asks for no install config (the sync preview carries the config).
  await expect(dialog).toContainText('inbox-subscribe');
  const reviewUrl = page.url();
  await dialog.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
  await waitForOutboxDrained(page);
  const url = new URL(page.url());

  return url.searchParams.get('subject') ?? `${url.origin}${url.pathname}`;
}

async function post(agent: Agent, path: string, body: unknown) {
  const url = `${SERVER_URL}${path}`;
  const response = await fetch(
    url,
    await signedRequestInit(url, agent, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const text = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return { status: response.status, text, json };
}
