// @wc-ignore-file
/**
 * The Fediverse plugin federating with an ActivityPub peer, on a real
 * atomic-server built with `--features plugin-routes` and started with
 * `--plugin-routes read-write`:
 *
 *   node integrations/tooling/run-lane.mjs fediverse --tier e2e
 *
 * The peer (./peer.ts) is an HTTPS server on this machine with one actor,
 * standing in for a Mastodon instance. No real fediverse server is involved.
 *
 * 1. The plugin (../plugin.js) is published, pinned and installed through the
 *    store's review dialog with its config and route-write approval, on the
 *    `drive-host` mount of a `fedi-<run>.localhost` host bound to the test's
 *    drive.
 * 2. Discovery: WebFinger and NodeInfo through `/.well-known/`, and the
 *    actor document with the host-held public key.
 * 3. The peer follows: a draft-cavage signed Follow is verified by the host
 *    (the key fetched from the peer), the follower is stored, and a signed
 *    Accept arrives at the peer's shared inbox from the host's delivery
 *    queue. The peer verifies that signature against the actor document.
 *    Unsigned, forged and tampered requests are refused with 401.
 * 4. The drive's agent posts a Note to `/ap/outbox` with a version 2 Atomic
 *    request signature (`auth: atomic`). It is stored under the posts
 *    folder, served at its object URL and in the outbox, and a signed
 *    Create(Note) reaches the peer.
 * 5. The peer replies; the reply is stored under the replies folder as a
 *    Message pointing at the post (`replyTo`).
 * 6. The peer undoes its follow; the next post is queued for nobody.
 *
 * Needs an atomic-server with auth: atomic on routes, the verified actor's
 * inbox in `request.caller.actor`, shared WebFinger claims by rel, and the
 * debug-build peer seams (atomic-server branch
 * claude/plugin-fediverse-host). The lane starts the server with
 * ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS=true and ATOMIC_PLUGIN_E2E_PEER_CA
 * pointing at the peer's test CA (lanes.json `serverEnv`).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { atomicRequest, startPeer, waitFor, type Peer } from './peer';

// Playwright loads this spec as CommonJS, so __dirname, not import.meta.
const source = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const PORT = new URL(SERVER_URL).port;
// A host of its own per run: a host stays bound to the drive of the run that
// bound it, and a local rerun reuses the lane's store (CI's is always fresh).
const HOST = `fedi-${Date.now().toString(36)}.localhost:${PORT}`;
const ORIGIN = `http://${HOST}`;
const ACTOR = `${ORIGIN}/ap/actor`;
const ACCOUNT = `acct:news@${HOST}`;
const INBOX = `${ORIGIN}/ap/inbox`;
const AS = 'https://www.w3.org/ns/activitystreams';
const P = {
  name: 'https://atomicdata.dev/properties/name',
  description: 'https://atomicdata.dev/properties/description',
  read: 'https://atomicdata.dev/properties/read',
  replyTo: 'https://atomicdata.dev/properties/replyTo',
  url: 'https://atomicdata.dev/property/url',
};
const FOLDER = 'https://atomicdata.dev/classes/Folder';
const PLAIN_TEXT = 'https://atomicdata.dev/classes/PlainText';
const PUBLIC_AGENT = 'https://atomicdata.dev/agents/publicAgent';

test.describe('fediverse', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which starts the server at --plugin-routes read-write',
  );
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  let peer: Peer;
  test.beforeAll(async () => {
    peer = await startPeer(resolve(__dirname, '../../..'));
  });
  test.afterAll(async () => {
    await peer?.close();
  });

  test('a drive actor is discovered, followed, posts and receives a reply', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
    const folders = await createFolders(page);
    await bindHost(agent, folders.drive);

    await test.step('publish, pin and install the plugin', async () => {
      const draft = await createPluginDraft(page);
      const published = await signedPost(
        agent,
        `${SERVER_URL}/plugin-release`,
        draft,
      );
      expect(published.status, published.body).toBe(200);
      const releaseId = JSON.parse(published.body).id as string;
      const pinned = await signedPost(
        agent,
        `${SERVER_URL}/plugin-release-pin`,
        draft,
      );
      expect(pinned.status, pinned.body).toBe(200);

      const dialog = await openReview(page, releaseId);
      await dialog.getByLabel('Config').fill(
        JSON.stringify({
          origin: ORIGIN,
          username: 'news',
          profile: folders.profile,
          posts: folders.posts,
          followers: folders.followers,
          replies: folders.replies,
          publishers: [agent.subject],
        }),
      );
      await dialog.getByTestId('route-write-approval').check();
      const reviewUrl = page.url();
      await dialog
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await expect(page).not.toHaveURL(reviewUrl, { timeout: 60_000 });
    });

    await test.step('discovery: WebFinger, NodeInfo, actor', async () => {
      const finger = await waitFor(async () => {
        const r = await atomicRequest(
          `${ORIGIN}/.well-known/webfinger?resource=${encodeURIComponent(ACCOUNT)}`,
        );

        return r.status === 200 ? r : undefined;
      }, 'WebFinger to answer');
      expect(finger.headers['content-type']).toContain('application/jrd+json');
      expect(finger.headers['access-control-allow-origin']).toBe('*');
      expect(JSON.parse(finger.body)).toEqual({
        subject: ACCOUNT,
        aliases: [ACTOR],
        links: [
          { rel: 'self', type: 'application/activity+json', href: ACTOR },
        ],
      });
      expect(
        (
          await atomicRequest(
            `${ORIGIN}/.well-known/webfinger?resource=${encodeURIComponent(`acct:someone@${HOST}`)}`,
          )
        ).status,
      ).toBe(404);

      const links = JSON.parse(
        (await atomicRequest(`${ORIGIN}/.well-known/nodeinfo`)).body,
      );
      expect(links.links[0].href).toBe(`${ORIGIN}/nodeinfo/2.1`);
      const info = JSON.parse(
        (await atomicRequest(`${ORIGIN}/nodeinfo/2.1`)).body,
      );
      expect(info.protocols).toEqual(['activitypub']);

      const actor = await atomicRequest(ACTOR, {
        headers: { accept: 'application/activity+json' },
      });
      expect(actor.status, actor.body).toBe(200);
      const doc = JSON.parse(actor.body);
      expect(doc).toMatchObject({
        id: ACTOR,
        type: 'Service',
        preferredUsername: 'news',
        name: 'Atomic news',
        inbox: INBOX,
        publicKey: { id: `${ACTOR}#main-key`, owner: ACTOR },
      });
      expect(doc.publicKey.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    });

    const follow = {
      '@context': AS,
      id: `${peer.actor}/follows/1`,
      type: 'Follow',
      actor: peer.actor,
      object: ACTOR,
    };

    await test.step('unverifiable requests are refused before the plugin runs', async () => {
      const unsigned = await atomicRequest(INBOX, {
        method: 'POST',
        headers: { 'content-type': 'application/activity+json' },
        body: JSON.stringify(follow),
      });
      expect(unsigned.status).toBe(401);
      const tampered = await peer.send(INBOX, follow, { tamper: true });
      expect(tampered.status).toBe(401);
      // Signed by bob, claiming to be someone else: the plugin refuses.
      const impersonating = await peer.send(INBOX, {
        ...follow,
        actor: `${peer.origin}/users/mallory`,
      });
      expect(impersonating.status).toBe(401);
      expect(peer.deliveries).toHaveLength(0);
    });

    await test.step('the peer follows; the host delivers a signed Accept', async () => {
      const sent = await peer.send(INBOX, follow);
      expect(sent.status, sent.body).toBe(202);
      const accept = await waitFor(
        () => peer.deliveries.find(d => d.activity.type === 'Accept'),
        'the Accept delivery',
        90_000,
      );
      expect(accept.path).toBe('/inbox');
      expect(accept.verified, accept.problem).toBe(true);
      expect(accept.keyId).toBe(`${ACTOR}#main-key`);
      expect(accept.activity).toMatchObject({
        actor: ACTOR,
        object: { id: follow.id, type: 'Follow', actor: peer.actor },
      });
      const followers = JSON.parse(
        (
          await atomicRequest(`${ORIGIN}/ap/followers`, {
            headers: { accept: 'application/activity+json' },
          })
        ).body,
      );
      expect(followers.totalItems).toBe(1);
    });

    let objectId = '';

    await test.step('the drive posts; a signed Create reaches the follower', async () => {
      const note = {
        '@context': AS,
        type: 'Create',
        object: { type: 'Note', content: 'Hello from an Atomic drive' },
      };
      expect(
        (await signedPost(undefined, `${ORIGIN}/ap/outbox`, note)).status,
      ).toBe(401);
      const posted = await signedPost(agent, `${ORIGIN}/ap/outbox`, note);
      expect(posted.status, posted.body).toBe(201);
      const out = JSON.parse(posted.body);
      expect(out.queued).toBe(1);
      objectId = out.object;
      expect(objectId.startsWith(`${ORIGIN}/ap/objects/`)).toBe(true);

      const create = await waitFor(
        () => peer.deliveries.find(d => d.activity.type === 'Create'),
        'the Create delivery',
        90_000,
      );
      expect(create.verified, create.problem).toBe(true);
      expect(create.activity).toMatchObject({
        actor: ACTOR,
        to: [`${AS}#Public`],
        object: {
          id: objectId,
          type: 'Note',
          content: '<p>Hello from an Atomic drive</p>',
          attributedTo: ACTOR,
        },
      });

      const object = await atomicRequest(objectId, {
        headers: { accept: 'application/activity+json' },
      });
      expect(object.status, object.body).toBe(200);
      expect(JSON.parse(object.body)).toMatchObject({
        id: objectId,
        content: '<p>Hello from an Atomic drive</p>',
        published: (create.activity.object as { published: string }).published,
      });
      const page1 = JSON.parse(
        (
          await atomicRequest(`${ORIGIN}/ap/outbox?page=1`, {
            headers: { accept: 'application/activity+json' },
          })
        ).body,
      );
      expect(
        page1.orderedItems.map((a: { object: { id: string } }) => a.object.id),
      ).toEqual([objectId]);
    });

    await test.step('the peer replies; the reply is stored in the drive', async () => {
      const reply = {
        '@context': AS,
        id: `${peer.actor}/activities/2`,
        type: 'Create',
        actor: peer.actor,
        object: {
          id: `${peer.actor}/notes/2`,
          type: 'Note',
          attributedTo: peer.actor,
          inReplyTo: objectId,
          content: '<p>Welcome, <b>drive</b>!</p>',
        },
      };
      const sent = await peer.send(INBOX, reply);
      expect(sent.status, sent.body).toBe(202);
      const stored = await waitFor(
        () => childNamed(page, folders.replies, 'Welcome'),
        'the stored reply',
      );
      expect(stored[P.description]).toBe('Welcome, drive!');
      expect(stored[P.name]).toBe(peer.actor);
      expect(stored[P.url]).toBe(`${peer.actor}/notes/2`);
      expect(stored[P.replyTo]).toBeTruthy();
      // Delivered twice, stored once.
      expect((await peer.send(INBOX, reply)).status).toBe(202);
    });

    await test.step('the peer unfollows; the next post goes nowhere', async () => {
      const undo = {
        '@context': AS,
        id: `${peer.actor}/undo/1`,
        type: 'Undo',
        actor: peer.actor,
        object: follow,
      };
      expect((await peer.send(INBOX, undo)).status).toBe(202);
      const followers = await waitFor(async () => {
        const doc = JSON.parse(
          (
            await atomicRequest(`${ORIGIN}/ap/followers`, {
              headers: { accept: 'application/activity+json' },
            })
          ).body,
        );

        return doc.totalItems === 0 ? doc : undefined;
      }, 'the follower to be removed');
      expect(followers.totalItems).toBe(0);
      const posted = await signedPost(agent, `${ORIGIN}/ap/outbox`, {
        type: 'Note',
        content: 'Nobody hears this one',
      });
      expect(posted.status, posted.body).toBe(201);
      expect(JSON.parse(posted.body).queued).toBe(0);
    });
  });
});

/** The profile and the three folders, under the test's drive. */
async function createFolders(page: Page) {
  return page.evaluate(
    async ({ p, folderClass, plainTextClass, publicAgent }) => {
      const store = window.store!;
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      const make = async (
        isA: string,
        propVals: Record<string, unknown>,
      ): Promise<string> => {
        const resource = await store.newResource({
          isA,
          parent: drive,
          propVals: propVals as never,
        });
        await resource.save();

        return resource.subject;
      };

      return {
        drive,
        profile: await make(plainTextClass, {
          [p.name]: 'Atomic news',
          [p.description]: 'Posts from an Atomic drive',
          [p.read]: [publicAgent],
        }),
        posts: await make(folderClass, {
          [p.name]: 'Fediverse posts',
          [p.read]: [publicAgent],
        }),
        followers: await make(folderClass, { [p.name]: 'Fediverse followers' }),
        replies: await make(folderClass, { [p.name]: 'Fediverse replies' }),
      };
    },
    {
      p: P,
      folderClass: FOLDER,
      plainTextClass: PLAIN_TEXT,
      publicAgent: PUBLIC_AGENT,
    },
  );
}

/** Maps the run's host to the drive (`/bind-drive`), as its owner. */
async function bindHost(agent: Agent, drive: string) {
  const bound = await signedPost(agent, `${ORIGIN}/bind-drive`, {
    'https://atomicdata.dev/properties/initialDrive': drive,
  });
  expect(bound.status, bound.body).toBe(200);
}

/** A Plugin draft whose source is the bundle, as plugin-routes.spec.ts makes one. */
async function createPluginDraft(page: Page) {
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
      await resource.set('https://atomicdata.dev/properties/name', 'Fediverse');
      await resource.set(
        'https://atomicdata.dev/properties/description',
        'One ActivityPub actor for this drive.',
      );
      await resource.save();
      const drive = store.getDrive();
      if (!drive) throw new Error('no drive');

      return { drive, plugin };
    },
    // Unique per run: a release id is a hash of its content.
    { code: `${source}\n// run ${Date.now()}\n` },
  );
}

async function openReview(page: Page, releaseId: string) {
  await page.goto(new URL('/app/integrations', SERVER_URL).href);
  const card = page.locator(`[data-release="${releaseId}"]`);
  await expect(card).toBeVisible({ timeout: 45_000 });
  await card.getByRole('button', { name: 'Open', exact: true }).click();
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  return dialog;
}

/**
 * A JSON POST with a version 2 Atomic request signature over the method,
 * the full URL and the body; unsigned without an agent. Drive-host URLs go
 * through {@link atomicRequest}.
 */
async function signedPost(
  agent: Agent | undefined,
  url: string,
  value: unknown,
) {
  const body = JSON.stringify(value);
  const headers = {
    'content-type': 'application/json',
    ...(agent
      ? await signRequest(url, agent, {}, { method: 'POST', body })
      : {}),
  } as Record<string, string>;

  return atomicRequest(url, { method: 'POST', headers, body });
}

/** A child of `parent` whose description contains `text`, as its propvals. */
async function childNamed(page: Page, parent: string, text: string) {
  const found = await page.evaluate(
    async ({ under, needle }) => {
      const store = window.store!;

      for (const hit of await store.search(needle, { parents: under })) {
        const row = await store.fetchResourceFromServer(hit);
        const values = row.getPropVals() as Record<string, unknown>;
        const description =
          values['https://atomicdata.dev/properties/description'];
        if (String(description ?? '').includes(needle))
          return JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
      }

      return undefined;
    },
    { under: parent, needle: text },
  );

  return (found ?? undefined) as Record<string, unknown> | undefined;
}
