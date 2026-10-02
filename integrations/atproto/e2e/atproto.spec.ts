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
 * 6. throughout, resolves the same identity with Bluesky's reference code
 *    (`@atproto/identity`, `@atproto/did`, `@atproto/crypto`,
 *    `@atproto/syntax`, pinned in `e2e/package.json`) over real TLS on the
 *    loopback, the way a PDS or AppView does (`reference.ts`): handle to
 *    DID, DID to document, the document's own handle back to the same DID,
 *    the strict DID document schema, the `#atproto` key as a `did:key`
 *    that verifies a signature made with the matching private key, and
 *    the `#atproto_pds` service. It does this for a secp256k1 and a P-256
 *    key, and checks that the second host name never verifies as a handle.
 *
 * Not covered: DNS TXT handle resolution (the plugin publishes no TXT
 * records; on these invented names the method would ask public DNS), TLS
 * on port 443 of a real host, and the install review UI (the Installation
 * is committed directly, as `@tomic/lib`'s installRelease would).
 */
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import {
  P256Keypair,
  parseDidKey,
  Secp256k1Keypair,
  type Keypair,
} from '@atproto/crypto';
import {
  assertAtprotoDid,
  type AtprotoDidDocument,
  didDocumentValidator,
  extractAtprotoData,
  isAtprotoDidWeb,
} from '@atproto/did';
import { ensureValidDid, ensureValidHandle } from '@atproto/syntax';
import { PDS_HOSTNAME, serviceJwt, startPds } from './pds';
import { startReference, type Reference } from './reference';
import {
  before,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import { openNewPluginDraft } from '../../tooling/e2e/route-install';

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
/** Opt-in: Bluesky's reference PDS in Docker (`pds.ts`). */
const WITH_PDS = process.env.ATPROTO_PDS_E2E === '1';
const server = new URL(SERVER_URL);
const PORT = Number(server.port);
/**
 * Invented names under a domain the project controls, new for every run: a
 * host bound to an earlier run's drive can only be rebound by a writer of
 * that drive. The plugin refuses reserved suffixes such as `.localhost`
 * (production handle rules), and nothing resolves these names: every
 * request goes to the server's port with the name in `Host`.
 */
const DOMAIN = 'e2e.atomicdata.dev';
const HANDLE = `alice-${RUN}.${DOMAIN}`;
const OTHER = `bob-${RUN}.${DOMAIN}`;
const WEB_DID = `did:web:${HANDLE}`;
const PLC_DID = 'did:plc:ewvi7nxzyoun6zhxrhs64oiz';
/**
 * Invented; contacted only by the opt-in PDS part, where it is the
 * reference PDS container's own public URL.
 */
const PDS = `https://${PDS_HOSTNAME}`;
/** Bytes the test signs with each fresh key; the resolved key must verify them. */
const SIGNED = new TextEncoder().encode(`atproto e2e ${RUN}`);

test.describe('atproto', () => {
  test.skip(
    LEVEL !== 'read-only',
    'run through run-lane.mjs, which starts the plugin-routes build at read-only',
  );
  test.beforeEach(before);
  /** The current test's TLS terminator and resolvers. */
  let open: Reference | undefined;
  test.afterEach(async () => {
    await open?.close();
    open = undefined;
  });

  test('a drive host serves as a Bluesky handle, with a did:web document', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const reference = (open = await startReference(DOMAIN, PORT));
    // A fresh repository key, given in the `did:key` form the reference PDS
    // returns from getRecommendedDidCredentials.
    const k256 = await Secp256k1Keypair.create();
    const signingKey = k256.did().slice('did:key:'.length);
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
        signingKey: k256.did(),
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
        publicKeyMultibase: signingKey,
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

    // Bluesky's reference resolver, over TLS, as a PDS or AppView would.
    await expectReferenceIdentity(reference, k256, 'ES256K');
    expect(reference.seen).toEqual(
      expect.arrayContaining([
        { method: 'GET', host: HANDLE, path: '/.well-known/atproto-did' },
        { method: 'GET', host: HANDLE, path: '/.well-known/did.json' },
      ]),
    );
    // The second name never verifies as a handle. On a strict host it
    // resolves to nothing; on an older one it answers with the handle's
    // DID, whose document names the handle, not it, so the bidirectional
    // check fails, and did:web:<other> gets a document for another id.
    const otherDid = await reference.handles.resolve(OTHER);

    if (strict) {
      expect(otherDid).toBeUndefined();
      expect(await reference.dids.resolve(`did:web:${OTHER}`)).toBeNull();
    } else {
      expect(otherDid).toBe(WEB_DID);
      expect(
        (await reference.dids.resolveAtprotoData(WEB_DID)).handle,
      ).not.toBe(OTHER);
      await expect(reference.dids.resolve(`did:web:${OTHER}`)).rejects.toThrow(
        /Poorly formatted DID Document/i,
      );
    }

    if (WITH_PDS) await migrateToReferencePds(page, installation, k256, strict);

    // The API origin is the operator's: no claims without their grant.
    for (const path of ['/.well-known/atproto-did', '/.well-known/did.json']) {
      const api = await get(`localhost`, path);
      expect(api.body, path).not.toContain(WEB_DID);
    }

    // Key rotation to P-256, given as the bare Multikey this time. (After the
    // opt-in PDS part, this takes the identity away from that PDS again.)
    const p256 = await P256Keypair.create();
    await reconfigure(page, installation, {
      handle: HANDLE,
      did: WEB_DID,
      pds: PDS,
      signingKey: p256.did().slice('did:key:'.length),
    });
    await expect
      .poll(
        async () =>
          (await reference.dids.resolveAtprotoData(WEB_DID)).signingKey,
      )
      .toBe(p256.did());
    await expectReferenceIdentity(reference, p256, 'ES256');
    // The old key no longer verifies for this DID.
    expect(
      await reference.dids.verifySignature(
        WEB_DID,
        SIGNED,
        await k256.sign(SIGNED),
      ),
    ).toBe(false);

    // Reconfigured to did:plc: the handle follows, the did:web document goes.
    await reconfigure(page, installation, { handle: HANDLE, did: PLC_DID });
    await expect
      .poll(async () => (await get(HANDLE, '/.well-known/atproto-did')).body)
      .toBe(PLC_DID);
    const gone = await get(HANDLE, '/.well-known/did.json');
    expect(gone.status, gone.body).toBe(404);
    expect(gone.body).not.toContain(WEB_DID);
    // The reference resolver agrees. The did:plc document lives in the PLC
    // directory, which this spec does not contact.
    expect(await reference.handles.resolve(HANDLE)).toBe(PLC_DID);
    expect(await reference.dids.resolve(WEB_DID)).toBeNull();
  });

  test('the reference resolver refuses did:web ports outside localhost', async () => {
    // AT Protocol allows a `%3A`-encoded port in did:web for localhost
    // testing only; the plugin allows none (its handle is the hostname).
    const reference = (open = await startReference(DOMAIN, PORT));
    const ported = `did:web:${HANDLE}%3A8443`;
    const local = `did:web:localhost%3A${PORT}`;
    // Generic DID syntax accepts both.
    expect(() => ensureValidDid(ported)).not.toThrow();
    expect(() => ensureValidDid(local)).not.toThrow();
    // AT Protocol's did:web rules accept the port on localhost only.
    expect(isAtprotoDidWeb(ported)).toBe(false);
    expect(isAtprotoDidWeb(local)).toBe(true);
    // The resolvers' default fetch policy refuses both before connecting:
    // a custom https port, and plain http (localhost resolves over http).
    await expect(reference.dids.resolve(ported)).rejects.toThrow(
      /Custom https: ports not allowed/,
    );
    await expect(reference.dids.resolve(local)).rejects.toThrow(
      /http: .*not allowed|Forbidden protocol/i,
    );
    expect(reference.seen).toEqual([]);
  });
});

/**
 * Bluesky's reference PDS takes the plugin's did:web identity, the way an
 * account migrates to a PDS: the PDS resolves the handle (HTTPS method),
 * the did:web document and its `#atproto` key to verify a service-auth
 * token for createAccount, and checks the handle resolves back to the
 * DID. The drive owner then publishes the PDS's recommended credentials
 * through the plugin (README, "Configure and deploy"), and the PDS reports
 * the DID document valid for it and activates the account.
 */
async function migrateToReferencePds(
  page: Page,
  installation: string,
  key: Keypair,
  strict: boolean,
) {
  const pds = await startPds({
    run: RUN,
    domain: DOMAIN,
    names: [HANDLE, OTHER],
    serverPort: PORT,
  });

  try {
    const resolved = await pds.xrpc('com.atproto.identity.resolveHandle', {
      params: { handle: HANDLE },
    });
    expect(resolved, pds.logs()).toEqual({
      status: 200,
      body: { did: WEB_DID },
    });

    if (strict) {
      const other = await pds.xrpc('com.atproto.identity.resolveHandle', {
        params: { handle: OTHER },
      });
      expect(other.status, JSON.stringify(other.body)).toBe(400);
    }

    const created = await pds.xrpc('com.atproto.server.createAccount', {
      body: {
        handle: HANDLE,
        did: WEB_DID,
        email: `alice-${RUN}@${DOMAIN}`,
        password: `invented-${RUN}`,
      },
      token: await serviceJwt(key, {
        iss: WEB_DID,
        aud: `did:web:${PDS_HOSTNAME}`,
        lxm: 'com.atproto.server.createAccount',
      }),
    });
    expect(
      created.status,
      `${JSON.stringify(created.body)}\n${pds.logs()}`,
    ).toBe(200);
    expect(created.body.did).toBe(WEB_DID);
    expect(created.body.handle).toBe(HANDLE);
    const token = created.body.accessJwt as string;

    // Still the account's own key: not yet valid for this PDS.
    const unmigrated = await pds.xrpc('com.atproto.server.checkAccountStatus', {
      token,
    });
    expect(unmigrated.body.activated).toBe(false);
    expect(unmigrated.body.validDid).toBe(false);

    const recommended = await pds.xrpc(
      'com.atproto.identity.getRecommendedDidCredentials',
      { token },
    );
    expect(recommended.status, JSON.stringify(recommended.body)).toBe(200);
    expect(recommended.body.alsoKnownAs).toEqual([`at://${HANDLE}`]);
    expect(recommended.body.services.atproto_pds).toEqual({
      type: 'AtprotoPersonalDataServer',
      endpoint: PDS,
    });
    const pdsKey = recommended.body.verificationMethods.atproto as string;
    expect(pdsKey).toMatch(/^did:key:z/);

    // The README's instructions, verbatim: endpoint and did:key as given.
    await reconfigure(page, installation, {
      handle: HANDLE,
      did: WEB_DID,
      pds: recommended.body.services.atproto_pds.endpoint,
      signingKey: pdsKey,
    });
    await expect
      .poll(
        async () =>
          (await pds.xrpc('com.atproto.server.checkAccountStatus', { token }))
            .body.validDid,
      )
      .toBe(true);

    const activated = await pds.xrpc('com.atproto.server.activateAccount', {
      post: true,
      token,
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    const after = await pds.xrpc('com.atproto.server.checkAccountStatus', {
      token,
    });
    expect(after.body).toMatchObject({ activated: true, validDid: true });
    const session = await pds.xrpc('com.atproto.server.getSession', { token });
    expect(session.body).toMatchObject({ did: WEB_DID, handle: HANDLE });

    // What the PDS fetched from the drive, through the terminator.
    const fetched = pds.fetched();
    console.log(`reference PDS fetched:\n  ${fetched.join('\n  ')}`);
    expect(fetched).toEqual(
      expect.arrayContaining([
        `GET ${HANDLE}/.well-known/atproto-did`,
        `GET ${HANDLE}/.well-known/did.json`,
      ]),
    );
  } finally {
    pds.close();
  }
}

/**
 * The identity as Bluesky's reference code sees it: handle to DID, the
 * strict DID document schema, `ensureAtpDocument`'s fields, the handle in
 * the document back to the same DID, and the `#atproto` key verifying a
 * signature by `key`.
 */
async function expectReferenceIdentity(
  reference: Reference,
  key: Keypair,
  jwtAlg: string,
) {
  ensureValidHandle(HANDLE);
  const did = await reference.handles.resolve(HANDLE);
  expect(did).toBe(WEB_DID);
  assertAtprotoDid(did);

  // `resolve` checks the document against the package's schema and its id
  // against the DID; the stricter `@atproto/did` validator on top.
  const raw = await reference.dids.resolve(WEB_DID);
  expect(raw).not.toBeNull();
  const strictDocument = didDocumentValidator.parse(raw);
  const extracted = extractAtprotoData(strictDocument as AtprotoDidDocument);
  expect(extracted.did).toBe(WEB_DID);
  expect(extracted.aka).toBe(HANDLE);
  expect(extracted.key?.publicKeyMultibase).toBe(
    key.did().slice('did:key:'.length),
  );
  expect(extracted.pds?.serviceEndpoint).toBe(PDS);

  const data = await reference.dids.resolveAtprotoData(WEB_DID);
  expect(data).toEqual({
    did: WEB_DID,
    handle: HANDLE,
    pds: PDS,
    signingKey: key.did(),
  });
  // Bidirectional: the handle the document names resolves to this DID.
  expect(await reference.handles.resolve(data.handle)).toBe(data.did);

  expect(parseDidKey(data.signingKey).jwtAlg).toBe(jwtAlg);
  const signature = await key.sign(SIGNED);
  expect(await reference.dids.verifySignature(WEB_DID, SIGNED, signature)).toBe(
    true,
  );
}

/** A Plugin draft in the test's drive whose source is the bundle. */
async function createDraft(page: Page) {
  await openNewPluginDraft(page);

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
        // A fresh connection each time: Node 22's global agent keeps
        // connections alive, and reusing one the server has just closed
        // after an idle pause fails with "socket hang up".
        agent: false,
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
