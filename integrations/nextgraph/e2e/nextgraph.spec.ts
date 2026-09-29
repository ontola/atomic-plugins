// @wc-ignore-file
/**
 * NextGraph (`integrations/nextgraph/`), end to end against a real host and a
 * real NextGraph wallet:
 *
 * - atomic-server built with `plugin-routes`, started at `--plugin-routes
 *   read-write --plugin-sidecars nextgraph=<PLUGIN_SIDECAR_URL>` by
 *   run-lane.mjs (lanes.json `sidecars`);
 * - the operator sidecar in ../sidecar/, run here in Docker: a NextGraph
 *   wallet and local verifier (nextgraph-rs, pinned in its Cargo.toml) that
 *   saves to disk. `init` creates the wallet and two documents and seeds the
 *   first one with invented triples.
 *
 * What runs where: the committed plugin.mjs runs in the server's QuickJS
 * sandbox (`/plugin-run`); its `pull` reads a document through the declared
 * `atomic-sidecar:` read operation; the snapshot is stored as an ordinary
 * Atomic PlainText resource (the create the review would apply, committed
 * here with @tomic/lib); `export` turns it into INSERT DATA; the push is an
 * external write intent approved through `/plugin-external-apply`, which
 * journals the sidecar's acknowledgement. Then: a retried approval returns
 * the journaled receipt, the sidecar replays its stored acknowledgement, the
 * data and the acknowledgements survive a sidecar restart, and a revoked
 * grant is refused.
 *
 * Not covered: a NextGraph broker (ngd). The wallet is created without one,
 * so nothing here syncs between NextGraph peers.
 *
 * Needs a host with `atomic-sidecar:` operations (atomic-server branch
 * claude/plugin-nextgraph-host). On a host without them publishing the
 * release is refused on the operation URL, and the test is skipped saying so.
 * Needs Docker. Run it the way CI would:
 *   node integrations/tooling/run-lane.mjs nextgraph --tier e2e
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signedRequestInit } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';

// Playwright may load this spec as CommonJS: __dirname, and a native
// dynamic import for the ES module under test.
const here = __dirname;
const pluginPath = resolve(here, '../plugin.mjs');
const source = readFileSync(pluginPath, 'utf8');
const importNative = new Function('url', 'return import(url)') as (
  url: string,
) => Promise<{
  pushIntent: (input: { document: string; id: string; update: string }) => {
    id: string;
    operation: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body: string;
  };
}>;

const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const SIDECAR_URL = process.env.PLUGIN_SIDECAR_URL ?? '';
const IMAGE = process.env.NG_SIDECAR_IMAGE ?? 'ng-atomic-sidecar:e2e';
const CONTAINER = `ng-atomic-sidecar-e2e-${process.pid}`;
const P = {
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  media: 'https://atomicdata.dev/properties/mimetype',
};

/** Invented data; the decimal is past 2^53 to prove it stays a string. */
const SEED = `INSERT DATA {
<http://example.org/alice> <http://xmlns.com/foaf/0.1/name> "Alice"@en .
<http://example.org/alice> <http://example.org/balance> "9007199254740993.123456789"^^<http://www.w3.org/2001/XMLSchema#decimal> .
}
`;

type Binding = Record<string, { type: string; value: string } & Record<string, string>>;

function docker(args: string[], timeout = 120_000) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout });
  if (result.status !== 0)
    throw new Error(
      `docker ${args[0]} failed (${result.status}): ${result.stderr || result.stdout}`,
    );

  return result.stdout;
}

const user = () =>
  `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;

function startSidecar(dir: string) {
  const port = new URL(SIDECAR_URL).port;
  docker([
    'run',
    '-d',
    '--name',
    CONTAINER,
    '--user',
    user(),
    '-e',
    'HOME=/data',
    '-v',
    `${dir}:/data`,
    '-p',
    `127.0.0.1:${port}:14480`,
    IMAGE,
    'serve',
    '--base',
    '/data',
    '--listen',
    '0.0.0.0:14480',
  ]);
}

async function waitForSidecar() {
  for (let i = 0; i < 120; i++) {
    try {
      const health = await fetch(`${SIDECAR_URL}/v1/health`);
      if (health.ok) return health.json();
    } catch {
      // not up yet
    }
    await new Promise(done => setTimeout(done, 1000));
  }
  throw new Error(
    `sidecar did not answer at ${SIDECAR_URL}: ${spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' }).stderr}`,
  );
}

function grant(
  dir: string,
  installation: string,
  grants: [string, 'read' | 'read-write'][],
) {
  writeFileSync(
    resolve(dir, 'scopes.json'),
    JSON.stringify({
      grants: grants.map(([document, access]) => ({
        installation,
        document,
        access,
      })),
    }),
  );
}

test.describe('nextgraph integration', () => {
  test.skip(
    LEVEL !== 'read-write' || !SIDECAR_URL,
    'run through run-lane.mjs, which starts the server with the nextgraph sidecar',
  );
  test.beforeEach(before);

  let dir: string | undefined;
  test.afterEach(() => {
    spawnSync('docker', ['rm', '--force', CONTAINER], { stdio: 'ignore' });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('pull a NextGraph document into Atomic, export it and push it back, durably', async ({
    page,
  }) => {
    test.setTimeout(3_600_000);
    const { drive, plugin } = await createPlugin(page);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
    const target = { drive, plugin };

    // Maintainer: publish the release; a host without `atomic-sidecar:`
    // operations refuses the manifest here.
    const published = await post(agent, '/plugin-release', target);
    test.skip(
      published.status !== 200 &&
        published.text.includes('operation URLs must be HTTP endpoints'),
      'this atomic-server has no atomic-sidecar: operations (needs atomic-server claude/plugin-nextgraph-host)',
    );
    expect(published.status, published.text).toBe(200);
    const release = (published.json as { id: string }).id;

    // Operator: build the sidecar, create a wallet and two documents, and
    // grant this plugin read on the first and read-write on the second.
    if (!process.env.NG_SIDECAR_IMAGE)
      docker(
        [
          'build',
          '-t',
          IMAGE,
          resolve(here, '../sidecar'),
        ],
        3_000_000,
      );
    dir = mkdtempSync(resolve(tmpdir(), 'ng-sidecar-'));
    writeFileSync(resolve(dir, 'seed.sparql'), SEED);
    const init = JSON.parse(
      docker(
        [
          'run',
          '--rm',
          '--user',
          user(),
          '-e',
          'HOME=/data',
          '-v',
          `${dir}:/data`,
          IMAGE,
          'init',
          '--base',
          '/data',
          '--documents',
          '2',
          '--seed',
          '/data/seed.sparql',
        ],
        600_000,
      )
        // NextGraph logs INFO lines to stdout; the result is the last line.
        .trim()
        .split('\n')
        .pop()!,
    ) as { documents: string[] };
    const [source, destination] = init.documents;
    // The wallet secret stays with the operator, never on stdout.
    expect(Object.keys(init)).toEqual(['documents']);
    grant(dir, plugin, [
      [source, 'read'],
      [destination, 'read-write'],
    ]);
    startSidecar(dir);
    await waitForSidecar();

    // 1. Pull: the plugin reads the source document through the sidecar.
    const pulled = await runPlugin(agent, target, {
      mode: 'pull',
      parent: drive,
      id: `pull-${Date.now()}`,
      name: 'NextGraph source',
      document: source,
    });
    const snapshot = pulled.intents[0];
    expect(snapshot.op).toBe('create');
    expect(snapshot.set[P.media]).toBe('application/sparql-results+json');
    const rows = bindings(snapshot.set[P.description]);
    expect(rows).toContainEqual({
      s: { type: 'uri', value: 'http://example.org/alice' },
      p: { type: 'uri', value: 'http://xmlns.com/foaf/0.1/name' },
      o: { type: 'literal', value: 'Alice', 'xml:lang': 'en' },
    });
    expect(rows).toContainEqual({
      s: { type: 'uri', value: 'http://example.org/alice' },
      p: { type: 'uri', value: 'http://example.org/balance' },
      o: {
        type: 'literal',
        value: '9007199254740993.123456789',
        datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
      },
    });

    // 2. The snapshot becomes an ordinary Atomic resource (what approving
    // the reviewed create does), then 3. export reads it back with ctx.read.
    const stored = await applyCreate(page, snapshot);
    const exportId = `export-${Date.now()}`;
    const exported = await runPlugin(agent, target, {
      mode: 'export',
      parent: drive,
      id: exportId,
      name: 'NextGraph push',
      sourceSubject: stored,
    });
    const update = exported.intents[0].set[P.description] as string;
    expect(exported.intents[0].set[P.media]).toBe('application/sparql-update');
    expect(update).toContain(
      '"9007199254740993.123456789"^^<http://www.w3.org/2001/XMLSchema#decimal>',
    );

    // 4. Push: a person approves the declared write; the host journals the
    // sidecar's acknowledgement as the receipt.
    const { pushIntent } = await importNative(pathToFileURL(pluginPath).href);
    const intent = pushIntent({ document: destination, id: exportId, update });
    const approval = { ...target, release, run: exportId, intent };
    const applied = await post(agent, '/plugin-external-apply', approval);
    expect(applied.status, applied.text).toBe(200);
    const receipt = applied.json as { status: number; body: string };
    expect(receipt.status).toBe(200);
    const ack = JSON.parse(receipt.body);
    expect(ack.replayed).toBe(false);
    expect(ack.ack.document).toBe(destination);
    expect(ack.ack.key).toBe(`atomic-export-${exportId}`);

    // A retried approval is the journaled receipt, not a second write.
    const again = await post(agent, '/plugin-external-apply', approval);
    expect(again.status, again.text).toBe(200);
    expect(again.json).toEqual(receipt);

    // 5. The destination now holds the triples, read back through the plugin.
    const readBack = await pullRows(agent, target, drive, destination);
    expect(readBack).toEqual(expect.arrayContaining(rows));

    // 6. Restart the sidecar: the NextGraph store and the acknowledgements
    // are on disk. The same key is replayed, not applied twice.
    spawnSync('docker', ['rm', '--force', CONTAINER], { stdio: 'ignore' });
    startSidecar(dir);
    await waitForSidecar();
    expect(await pullRows(agent, target, drive, destination)).toEqual(
      expect.arrayContaining(rows),
    );
    const replay = await fetch(`${SIDECAR_URL}/v1/update`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-atomic-installation': plugin,
      },
      body: intent.body,
    });
    const replayed = await replay.json();
    expect(replayed.replayed).toBe(true);
    expect(replayed.ack).toEqual(ack.ack);

    // 7. Revoke write on the destination: a new push is refused by the
    // sidecar, and the host keeps that refusal as the receipt.
    grant(dir, plugin, [
      [source, 'read'],
      [destination, 'read'],
    ]);
    const refused = await post(agent, '/plugin-external-apply', {
      ...target,
      release,
      run: `${exportId}-revoked`,
      intent: pushIntent({
        document: destination,
        id: `${exportId}-revoked`,
        update,
      }),
    });
    expect(refused.status, refused.text).not.toBe(200);
    expect(refused.text).toContain('403');
  });
});

function bindings(text: string): Binding[] {
  return (JSON.parse(text) as { results: { bindings: Binding[] } }).results
    .bindings;
}

async function pullRows(
  agent: Agent,
  target: { drive: string; plugin: string },
  drive: string,
  document: string,
) {
  const verdict = await runPlugin(agent, target, {
    mode: 'pull',
    parent: drive,
    id: `read-${Date.now()}`,
    name: 'NextGraph read-back',
    document,
  });

  return bindings(verdict.intents[0].set[P.description]);
}

type Intent = {
  op: string;
  parent: string;
  isA: string[];
  set: Record<string, string>;
};

/** `/plugin-run`: the committed source in the server's QuickJS sandbox. */
async function runPlugin(
  agent: Agent,
  target: { drive: string; plugin: string },
  config: Record<string, string>,
): Promise<{ intents: Intent[] }> {
  const response = await post(agent, '/plugin-run', {
    ...target,
    source,
    input: JSON.stringify({ trigger: { kind: 'manual', at: Date.now() }, config }),
  });
  expect(response.status, response.text).toBe(200);
  const { verdict, error } = response.json as {
    verdict?: string;
    error?: string;
  };
  expect(error, error).toBeFalsy();

  return JSON.parse(verdict!);
}

/** Commits a reviewed create intent the way the browser applies one. */
async function applyCreate(page: Page, intent: Intent) {
  return page.evaluate(async ({ parent, isA, set }) => {
    const store = window.store!;
    const resource = await store.newResource({ parent, isA, propVals: set });
    await resource.save();

    return resource.subject;
  }, intent);
}

/** A Plugin draft in the test's drive whose source is plugin.mjs. */
async function createPlugin(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(
    async ({ code }) => {
      const store = window.store!;
      const plugin = new URL(location.href).searchParams.get('subject')!;
      const resource = await store.getResource(plugin);
      const sourceProp = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProp) throw new Error('plugin has no source property');
      await resource.set(sourceProp, code);
      await resource.set('https://atomicdata.dev/properties/name', 'NextGraph');
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run, as in plugin-routes.spec.ts: a release id hashes the
    // content, and a rerun on an old store would find it listed already.
    { code: `${source}\n// run ${Date.now()}\n` },
  );
}

/** A POST signed (v2, over method and body) as the test's agent. */
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
  const answer = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(answer);
  } catch {
    json = undefined;
  }

  return { status: response.status, text: answer, json };
}
