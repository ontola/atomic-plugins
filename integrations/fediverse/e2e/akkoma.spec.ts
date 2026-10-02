// @wc-ignore-file
/**
 * Opt-in: the Fediverse plugin federating with a real Akkoma server, on
 * atomic-server built with the `plugin-routes` feature at
 * `--plugin-routes read-write`.
 *
 * It starts Akkoma's official OTP release on `alpine:3.22` with
 * `postgres:17-alpine` (./akkoma.mjs: host network, every listener on
 * 127.0.0.1, certificates from a throwaway test CA, invented accounts,
 * everything removed afterwards) behind the TLS proxy of ./stack.mjs on
 * 127.0.0.1:19953, which also fronts the lane's atomic-server: the plugin's
 * actor is `https://fedi-<run>.localhost:19953/ap/actor`, and Akkoma is
 * `https://akkoma.localhost:19953`. An invented Akkoma user runs the round
 * trip of ./client-api.ts through Akkoma's Mastodon client API: resolve the
 * actor, follow (the Accept arrives), see a published Note in the home
 * timeline, reply (stored in the drive), unfollow.
 *
 * Every request between the two passes through the proxy, which logs it;
 * the test checks the parts that matter (signature scheme, content types)
 * and attaches the whole log as `akkoma-traffic.json`.
 *
 * Skipped unless FEDIVERSE_AKKOMA_E2E=1. Needs Docker and network access
 * to download the release (about 25 MB; FEDIVERSE_AKKOMA_RELEASE names
 * another URL or a local zip) and Alpine packages; pulls `alpine:3.22` and
 * `postgres:17-alpine`; uses ports 19950, 19951 and 19953 on 127.0.0.1
 * (FEDIVERSE_AKKOMA_PORT moves the last; the others follow it), and names
 * its containers `fediverse-e2e-akkoma-*` (FEDIVERSE_AKKOMA_NAME):
 *
 *   FEDIVERSE_AKKOMA_E2E=1 node integrations/tooling/run-lane.mjs fediverse --tier e2e
 *
 * The lane's specs write their test CA to the one path the server trusts,
 * so they need the lane's one Playwright worker (the default).
 * FEDIVERSE_AKKOMA_KEEP=1 leaves the stack running after the test, to look
 * at a failure; the next run removes it. What passed against which Akkoma
 * is in the README ("Against a real Akkoma").
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';
import { Agent } from '@tomic/lib';
import {
  before,
  getDevDriveSecret,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { roundTrip } from './client-api';
import { bindHost, createFolders, installPlugin, PORT } from './helpers';
import { PEER_CA_PATH } from './peer';

type AkkomaModule = typeof import('./akkoma.mjs');

const ENABLED = process.env.FEDIVERSE_AKKOMA_E2E === '1';
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const AKKOMA_PORT = Number(process.env.FEDIVERSE_AKKOMA_PORT || 19953);
const NAME = `fedi-${Date.now().toString(36)}.localhost`;
const HANDLE = `news@${NAME}:${AKKOMA_PORT}`;
const ORIGIN = `https://${NAME}:${AKKOMA_PORT}`;
const ACTOR = `${ORIGIN}/ap/actor`;
const DIRECT = `http://${NAME}:${PORT}`;
const NOTE = 'Hello Akkoma, from an Atomic drive';

test.describe('fediverse with a real Akkoma', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which starts the server at --plugin-routes read-write',
  );
  test.skip(!ENABLED, 'opt-in: set FEDIVERSE_AKKOMA_E2E=1 (needs Docker)');
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('an Akkoma user follows the drive actor, gets its post and replies', async ({
    page,
  }, testInfo) => {
    test.setTimeout(900_000);
    const { startAkkoma } = (await import('./akkoma.mjs')) as AkkomaModule;
    const akkoma = await startAkkoma({
      atomicHost: NAME,
      atomicPort: PORT,
      caPath: resolve(__dirname, '../../..', PEER_CA_PATH),
      port: AKKOMA_PORT,
    });

    try {
      testInfo.annotations.push({
        type: 'akkoma',
        description: `${akkoma.release} (sha256 ${akkoma.sha256}) on ${akkoma.image}; /api/v1/instance version ${akkoma.version}`,
      });
      const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');
      const folders = await createFolders(page);
      await bindHost(agent, DIRECT, folders.drive);
      await installPlugin(page, agent, {
        origin: ORIGIN,
        username: 'news',
        profile: folders.profile,
        posts: folders.posts,
        followers: folders.followers,
        replies: folders.replies,
        publishers: [agent.subject],
      });
      const token = await akkoma.addUser('alice');

      const trip = await roundTrip({
        name: 'Akkoma',
        server: akkoma,
        token,
        page,
        agent,
        actor: ACTOR,
        direct: DIRECT,
        replies: folders.replies,
        note: NOTE,
        replyText: 'Welcome to the fediverse, drive!',
      });

      await test.step('the wire, as the proxy saw it', async () => {
        const traffic = akkoma.traffic();
        const file = testInfo.outputPath('akkoma-traffic.json');
        writeFileSync(file, JSON.stringify(traffic, null, 2));
        await testInfo.attach('akkoma-traffic.json', {
          path: file,
          contentType: 'application/json',
        });
        const toAtomic = traffic.filter(t => t.to === 'atomic');
        const toAkkoma = traffic.filter(t => t.to === 'akkoma');
        // Discovery: the actor (GET signed by Akkoma's instance fetch
        // actor), then host-meta, whose LRDD template Akkoma follows to
        // WebFinger by the actor's URL. The host routes WebFinger to this
        // plugin only for `acct:` resources, so that is 404 (a host gap;
        // README, "Known host gaps").
        const actorFetch = toAtomic.find(
          t => t.method === 'GET' && t.path === '/ap/actor',
        );
        expect(actorFetch?.status).toBe(200);
        expect(actorFetch?.headers.signature).toContain(
          `keyId="${akkoma.origin}/internal/fetch#main-key"`,
        );
        expect(
          toAtomic.find(t => t.path === '/.well-known/host-meta')?.status,
        ).toBe(200);
        expect(
          toAtomic.find(
            t => t.path === `/.well-known/webfinger?resource=${ACTOR}`,
          )?.status,
        ).toBe(404);
        // No handshake failed at the proxy.
        expect(traffic.filter(t => t.to === 'tls')).toEqual([]);
        // Akkoma's inbox deliveries, all accepted.
        const inbox = toAtomic.filter(
          t => t.method === 'POST' && t.path === '/ap/inbox',
        );
        expect(inbox.map(t => JSON.parse(t.body ?? '{}').type)).toEqual(
          expect.arrayContaining(['Create', 'Follow', 'Undo']),
        );

        for (const t of inbox) {
          expect(t.status, t.response).toBe(202);
          // draft-cavage, like Mastodon, but content-length is signed too
          // and the key is the user's #main-key.
          expect(t.headers.signature).toMatch(/algorithm="rsa-sha256"/);
          expect(t.headers.signature).toContain(
            'headers="(request-target) content-length date digest host"',
          );
          expect(t.headers.signature).toMatch(
            new RegExp(`keyId="${akkoma.origin}/users/by-id/[^"#]+#main-key"`),
          );
          expect(t.headers['content-type']).toBe('application/activity+json');
          expect(t.headers.digest).toMatch(/^SHA-256=/);
        }

        // The host's deliveries to Akkoma: Accept and Create, signed.
        const delivered = toAkkoma.filter(
          t => t.method === 'POST' && t.path === '/inbox',
        );
        expect(
          delivered.map(t => JSON.parse(t.body ?? '{}').type).sort(),
        ).toEqual(['Accept', 'Create']);

        // Akkoma answers its inbox with 200, not Mastodon's 202.
        for (const t of delivered) {
          expect(t.status, t.response).toBe(200);
          expect(t.headers.signature).toContain(`keyId="${ACTOR}#main-key"`);
        }
      });

      await test.step("Akkoma's view of the actor and the post", async () => {
        // Without a WebFinger answer for the actor's URL Akkoma falls back
        // to preferredUsername@<host of the actor id>, which has no port:
        // on port 443 that is the right handle, here it is not.
        expect(trip.account).toMatchObject({
          acct: `news@${NAME}`,
          username: 'news',
          display_name: 'Atomic news',
          bot: true,
          locked: false,
        });
        expect(trip.status.content).toBe(`<p>${NOTE}</p>`);
        expect(trip.home.account.acct).toBe(`news@${NAME}`);
      });

      await test.step('a handle with a port matches nothing', async () => {
        // As in Mastodon: Akkoma's search refuses a domain with a `:`
        // (User.Search.verify_and_normalise_nick), so it never asks.
        const r = await akkoma.call(
          'GET',
          `/api/v2/search?type=accounts&resolve=true&q=${encodeURIComponent(`@${HANDLE}`)}`,
          { token },
        );
        expect(r.status, r.body).toBe(200);
        expect(JSON.parse(r.body).accounts).toEqual([]);
        expect(
          akkoma
            .traffic()
            .filter(t =>
              t.path.startsWith('/.well-known/webfinger?resource=acct:'),
            ),
        ).toEqual([]);
      });
    } finally {
      if (process.env.FEDIVERSE_AKKOMA_KEEP !== '1') akkoma.stop();
    }
  });
});
