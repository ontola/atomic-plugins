// @wc-ignore-file
/**
 * The AT Protocol handle plugin (`integrations/atproto/`) on a real
 * atomic-server built with `--features plugin-routes` and started with
 * `--plugin-routes read-only`. Run it the way CI would:
 *
 *   node integrations/tooling/run-lane.mjs atproto --tier e2e
 *
 * What it does, all test-side, with invented identities only (no Bluesky,
 * PLC directory or PDS is contacted; nothing leaves this machine):
 *
 * 1. publishes plugin.mjs (the bundle is that file, verbatim) to this node's
 *    marketplace and creates an active Installation of it in the test's
 *    drive, signed by the drive owner, which approves the exclusive
 *    `atproto-did` and `did.json` claims on the drive's hosts;
 * 2. binds two fresh host names to the drive (`/bind-drive`): the handle,
 *    and a second name the handle is not;
 * 3. resolves the handle the way the AT Protocol handle spec says, over
 *    plain HTTP with a `Host` header (no TLS, no DNS): the HTTPS method's
 *    `/.well-known/atproto-did`, then the did:web document at
 *    `/.well-known/did.json`, and checks both directions agree (the
 *    document's `alsoKnownAs` names the handle);
 * 4. on a host that hands handlers `request.host` (`hostFeatures.pluginRoutes
 *    .requestHost`, atomic-server `claude/plugin-atproto-host`), checks the
 *    second host name answers 404 even with forwarding headers naming the
 *    handle. On an older host it documents the limitation instead: every
 *    host name of the drive answers with the same DID;
 * 5. reconfigures the Installation to a did:plc identity and checks the
 *    did:web document is gone while the handle resolves to the new DID.
 *
 * Not covered: an independent atproto resolver library, a TLS host, and
 * the install review UI (the Installation is committed directly, as
 * `@tomic/lib`'s installRelease would).
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';

// Playwright loads this spec as CommonJS, so __dirname rather than
// import.meta.
const RUN = Date.now().toString(36);
/**
 * The plugin plus a comment naming this run. Release ids are
 * content-addressed, and on the lane's persisted store an earlier run's
 * Release sits in a drive this run's agent can't read.
 */
const bundle = `${readFileSync(resolve(__dirname, '../plugin.mjs'), 'utf8')}// e2e run ${RUN}\n`;
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const server = new URL(SERVER_URL);
const PORT = Number(server.port);
/**
 * Invented names under a domain the project controls, new for every run: a
 * host bound to an earlier run's drive can only be rebound by a writer of
 * that drive. The plugin refuses reserved suffixes such as `.localhost`
 * (production handle rules), and nothing resolves these names: every
 * request goes to the server's port with the name in `Host`.
 */
const HANDLE = `alice-${RUN}.e2e.atomicdata.dev`;
const OTHER = `bob-${RUN}.e2e.atomicdata.dev`;
const WEB_DID = `did:web:${HANDLE}`;
const PLC_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
/** Invented; never contacted. */
const PDS = 'https://pds.e2e.atomicdata.dev';
/** The AT Protocol cryptography spec's example secp256k1 public key. */
const SIGNING_KEY = 'zQ3shqwJEJyMBsBXCWyCBpUBMqxcon9oHB7mCvx4sSpMdLJwc';

test.describe('atproto', () => {
  test.skip(
    LEVEL !== 'read-only',
    'run through run-lane.mjs, which starts the plugin-routes build at read-only',
  );
  test.beforeEach(before);

  test('a drive host serves as a Bluesky handle, with a did:web document', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const target = await createDraft(page);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');

    const published = await signedPost(
      agent,
      SERVER_URL,
      '/plugin-release',
      target,
    );
    expect(published.status, published.body).toBe(200);
    const { id: releaseId, subject: release } = JSON.parse(published.body) as {
      id: string;
      subject: string;
    };
    const catalog = await (await fetch(`${SERVER_URL}/plugin-catalog`)).json();
    const entry = catalog.entries.find(
      (e: { releaseId?: string }) => e.releaseId === releaseId,
    );
    expect(entry, JSON.stringify(catalog.entries)).toBeTruthy();
    expect(entry.requires).toEqual([
      'persistent-host',
      'plugin-routes:read-only',
      'public-origin',
      'wasm-sandbox',
    ]);
    const strict = catalog.hostFeatures?.pluginRoutes?.requestHost === true;

    for (const host of [HANDLE, OTHER]) {
      const bound = await signedPost(
        agent,
        `http://${host}:${PORT}`,
        '/bind-drive',
        { 'https://atomicdata.dev/properties/initialDrive': target.drive },
      );
      expect(bound.status, `${host}: ${bound.body}`).toBe(200);
    }

    const installation = await install(page, target.drive, {
      release,
      releaseId,
      config: {
        handle: HANDLE,
        did: WEB_DID,
        pds: PDS,
        signingKey: SIGNING_KEY,
      },
    });

    // Handle -> DID: the HTTPS resolution method's well-known file.
    const did = await get(HANDLE, '/.well-known/atproto-did');
    expect(did.status, did.body).toBe(200);
    expect(did.headers['content-type']).toBe('text/plain');
    expect(did.headers['cache-control']).toBe('no-store');
    expect(did.body).toBe(WEB_DID);
    const head = await send(
      'HEAD',
      '/.well-known/atproto-did',
      `${HANDLE}:${PORT}`,
      {},
    );
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    // DID -> document: did:web resolves at the DID's host's did.json.
    const docHost = WEB_DID.slice('did:web:'.length);
    const doc = await get(docHost, '/.well-known/did.json', {
      origin: 'https://resolver.e2e.atomicdata.dev',
    });
    expect(doc.status, doc.body).toBe(200);
    expect(doc.headers['content-type']).toBe('application/json');
    // Declared `any-origin-no-credentials`, through the real CORS layer.
    expect(doc.headers['access-control-allow-origin']).toBe('*');
    expect(doc.headers['access-control-allow-credentials']).toBeUndefined();
    const document = JSON.parse(doc.body);
    expect(document.id).toBe(WEB_DID);
    // The reverse direction a client must check before trusting the handle.
    expect(document.alsoKnownAs).toContain(`at://${HANDLE}`);
    expect(document.verificationMethod).toEqual([
      {
        id: `${WEB_DID}#atproto`,
        type: 'Multikey',
        controller: WEB_DID,
        publicKeyMultibase: SIGNING_KEY,
      },
    ]);
    expect(document.service).toEqual([
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: PDS,
      },
    ]);

    // The routes also answer on their own paths on the drive host.
    expect((await get(HANDLE, '/atproto-did')).body).toBe(WEB_DID);
    expect(JSON.parse((await get(HANDLE, '/did.json')).body).id).toBe(WEB_DID);

    // The second host name bound to the same drive.
    for (const path of ['/.well-known/atproto-did', '/.well-known/did.json']) {
      const other = await get(OTHER, path, {
        'x-forwarded-host': HANDLE,
        forwarded: `host=${HANDLE};proto=https`,
      });

      if (strict) {
        expect(other.status, `${path}: ${other.body}`).toBe(404);
        expect(other.body).not.toContain(WEB_DID);
      } else {
        // Hosts without `request.host`: the plugin can't tell the drive's
        // names apart, so all of them answer (README, "Current host
        // limitation").
        expect(other.status, `${path}: ${other.body}`).toBe(200);
        expect(other.body).toContain(WEB_DID);
      }
    }

    // The API origin is the operator's: no claims without their grant.
    for (const path of ['/.well-known/atproto-did', '/.well-known/did.json']) {
      const api = await get(`localhost`, path);
      expect(api.body, path).not.toContain(WEB_DID);
    }

    // Reconfigured to did:plc: the handle follows, the did:web document goes.
    await reconfigure(page, installation, { handle: HANDLE, did: PLC_DID });
    await expect
      .poll(async () => (await get(HANDLE, '/.well-known/atproto-did')).body)
      .toBe(PLC_DID);
    const gone = await get(HANDLE, '/.well-known/did.json');
    expect(gone.status, gone.body).toBe(404);
    expect(gone.body).not.toContain(WEB_DID);
  });
});

/** A Plugin draft in the test's drive whose source is the bundle. */
async function createDraft(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(async code => {
    const store = window.store!;
    const plugin = new URL(location.href).searchParams.get('subject')!;
    const resource = await store.getResource(plugin);
    const sourceProp = Object.entries(resource.getPropVals()).find(
      ([, value]) =>
        typeof value === 'string' && value.includes('export function run'),
    )?.[0];
    if (!sourceProp) throw new Error('plugin has no source property');
    await resource.set(sourceProp, code);
    await resource.set('https://atomicdata.dev/properties/name', 'atproto');
    await resource.set(
      'https://atomicdata.dev/properties/description',
      'AT Protocol handle and did:web document for this drive.',
    );
    await resource.save();
    const drive = store.getDrive();
    if (!drive) throw new Error('no drive');

    return { drive, plugin };
  }, bundle);
}

/**
 * An active Installation of the release, signed by the drive owner in the
 * browser: the same propVals as @tomic/lib's installRelease, which
 * `window.atomicE2E` does not expose. It leaves out the integration app id,
 * which only proxy connections use.
 */
async function install(
  page: Page,
  drive: string,
  options: { release: string; releaseId: string; config: unknown },
) {
  return page.evaluate(
    async ({ drive: parent, release, releaseId, config }) => {
      const p = 'https://atomicdata.dev/properties/';
      const d = 'https://atomicdata.dev/datatypes/';
      const installation = await window.store.newResource({
        isA: 'https://atomicdata.dev/classes/Installation',
        parent,
        propVals: {
          [`${p}name`]: 'atproto',
          [`${p}namespace`]: 'atomic-plugins',
          [`${p}release`]: release,
          [`${p}releaseId`]: releaseId,
          [`${p}installationStatus`]: 'active',
          // Every declared capability must be granted.
          [`${p}grants`]: ['storage'],
          [`${p}config`]: config as never,
        },
        propDatatypes: {
          [`${p}name`]: `${d}string`,
          [`${p}namespace`]: `${d}string`,
          [`${p}release`]: `${d}atomicURL`,
          [`${p}releaseId`]: `${d}string`,
          [`${p}installationStatus`]: `${d}string`,
          [`${p}grants`]: `${d}json`,
          [`${p}config`]: `${d}json`,
        } as never,
      });
      await installation.save();

      return installation.subject;
    },
    { drive, ...options },
  );
}

/** Replaces the Installation's config, as the Installation page's form does. */
async function reconfigure(page: Page, installation: string, config: unknown) {
  await page.evaluate(
    async ({ subject, config: next }) => {
      const resource = await window.store.getResource(subject);
      await resource.set(
        'https://atomicdata.dev/properties/config',
        next as never,
      );
      await resource.save();
    },
    { subject: installation, config },
  );
}

/**
 * A POST to atomic-server with a version 2 request signature over the
 * method, `origin` + `path` and the body (version 1 where the endpoint
 * refuses version 2). `origin` may be a host bound to a
 * drive: the request still goes to the server's port, with that host in the
 * `Host` header, and the server checks the signature against the URL on that
 * host. `/bind-drive` binds that URL's host name without the port.
 */
async function signedPost(
  agent: Agent,
  origin: string,
  path: string,
  body: unknown,
) {
  const text = JSON.stringify(body);
  const url = `${origin}${path}`;
  const post = (headers: Record<string, string>) =>
    send(
      'POST',
      path,
      new URL(origin).host,
      { ...headers, 'content-type': 'application/json' },
      text,
    );
  const v2 = await post(
    await signRequest(url, agent, {}, { method: 'POST', body: text }),
  );

  // Endpoints that don't check version 2 yet (`/plugin-release` at the pin)
  // say so; sign those with version 1. Built by hand rather than with
  // `signRequest`, which sends no headers when an agent on `localhost` signs
  // a URL on another host.
  if (v2.status !== 401 || !v2.body.includes('version 2')) return v2;
  const timestamp = Date.now();

  return post({
    'x-atomic-public-key': await agent.getPublicKey(),
    'x-atomic-signature': await agent.createSignature(url, timestamp),
    'x-atomic-timestamp': String(timestamp),
    'x-atomic-agent': agent.subject!,
  });
}

/** A GET on `host` (a name without port) at the server's port. */
function get(host: string, path: string, headers: Record<string, string> = {}) {
  return send('GET', path, `${host}:${PORT}`, headers);
}

function send(
  method: string,
  path: string,
  host: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((done, fail) => {
    const req = httpRequest(
      {
        host: server.hostname,
        port: PORT,
        method,
        path,
        headers: { ...headers, host },
      },
      res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (text += chunk));
        res.on('end', () =>
          done({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: text,
          }),
        );
      },
    );
    req.on('error', fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
