// @wc-ignore-file
/**
 * Opt-in: the Fediverse plugin federating with a real Mastodon server, on
 * atomic-server built with the `plugin-routes` feature at
 * `--plugin-routes read-write`.
 *
 * It starts the official Mastodon image with PostgreSQL and Redis
 * (./mastodon.mjs: host network, every listener on 127.0.0.1, certificates
 * from a throwaway test CA, invented accounts, everything removed
 * afterwards) behind a TLS proxy in this process on 127.0.0.1:19943, which
 * also fronts the lane's atomic-server: the plugin's actor is
 * `https://fedi-<run>.localhost:19943/ap/actor`, and Mastodon is
 * `https://mastodon.localhost:19943`. An invented Mastodon user, through
 * Mastodon's own client API:
 *
 * 1. looks the actor up by its URL: Mastodon fetches the actor and checks
 *    its handle (`news@fedi-<run>.localhost:19943`) with WebFinger;
 * 2. follows it: Mastodon sends a signed Follow, the host verifies it, the
 *    plugin stores the follower and queues an Accept, and Mastodon records
 *    the follow as accepted;
 * 3. receives a Note the drive publishes through `/ap/outbox`: the host
 *    delivers a signed Create to Mastodon's shared inbox;
 * 4. replies to it: Mastodon delivers the reply to the actor's inbox and
 *    the plugin stores it in the drive;
 * 5. unfollows: Mastodon sends Undo(Follow) and the follower is removed.
 *
 * Every request between the two passes through the proxy, which logs it;
 * the test checks the parts that matter (signature scheme, content types)
 * and attaches the whole log as `mastodon-traffic.json`.
 *
 * Skipped unless FEDIVERSE_MASTODON_E2E=1. Needs Docker; pulls
 * `ghcr.io/mastodon/mastodon:v4.7.3` (FEDIVERSE_MASTODON_IMAGE to try
 * another), `postgres:17-alpine` and `redis:7-alpine`, uses ports 19930,
 * 19932, 19939 and 19943 on 127.0.0.1 (FEDIVERSE_MASTODON_PORT moves the
 * last; the others follow it), and names its containers
 * `fediverse-e2e-mastodon-*` (FEDIVERSE_MASTODON_NAME):
 *
 *   FEDIVERSE_MASTODON_E2E=1 node integrations/tooling/run-lane.mjs fediverse --tier e2e
 *
 * Both specs of this lane write their test CA to the one path the server
 * trusts, so they need the lane's one Playwright worker (the default).
 * FEDIVERSE_MASTODON_KEEP=1 leaves the stack running after the test, to
 * look at a failure; the next run removes it. What passed against which
 * Mastodon is in the README ("Against a real Mastodon").
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
import {
  bindHost,
  childNamed,
  createFolders,
  installPlugin,
  P,
  PORT,
  signedPost,
} from './helpers';
import { atomicRequest, PEER_CA_PATH, waitFor } from './peer';

type MastodonModule = typeof import('./mastodon.mjs');

const ENABLED = process.env.FEDIVERSE_MASTODON_E2E === '1';
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const MASTODON_PORT = Number(process.env.FEDIVERSE_MASTODON_PORT || 19943);
// A host of its own per run, as in fediverse.spec.ts. Mastodon reaches it
// through the TLS proxy's port; the drive is bound to the name, so any port
// reaches it.
const NAME = `fedi-${Date.now().toString(36)}.localhost`;
const HANDLE = `news@${NAME}:${MASTODON_PORT}`;
const ORIGIN = `https://${NAME}:${MASTODON_PORT}`;
const ACTOR = `${ORIGIN}/ap/actor`;
// The same host on atomic-server's own port, for the drive's owner: the
// binding and the publish route are reached directly, over http.
const DIRECT = `http://${NAME}:${PORT}`;
const NOTE = 'Hello Mastodon, from an Atomic drive';

test.describe('fediverse with a real Mastodon', () => {
  test.skip(
    LEVEL !== 'read-write',
    'run through run-lane.mjs, which starts the server at --plugin-routes read-write',
  );
  test.skip(!ENABLED, 'opt-in: set FEDIVERSE_MASTODON_E2E=1 (needs Docker)');
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('a Mastodon user follows the drive actor, gets its post and replies', async ({
    page,
  }, testInfo) => {
    test.setTimeout(900_000);
    const { startMastodon } =
      (await import('./mastodon.mjs')) as MastodonModule;
    const mastodon = await startMastodon({
      atomicHost: NAME,
      atomicPort: PORT,
      caPath: resolve(__dirname, '../../..', PEER_CA_PATH),
      port: MASTODON_PORT,
    });

    const dump = (error: unknown) => {
      throw new Error(
        `${error}\n--- proxy\n${mastodon
          .traffic()
          .map(
            t =>
              `${t.to} ${t.method} ${t.path} ${t.status} ${t.response ?? t.error ?? ''}`,
          )
          .join('\n')}\n${mastodon.logs()}`,
      );
    };

    try {
      testInfo.annotations.push({
        type: 'mastodon',
        description: `${mastodon.image} (/api/v2/instance version ${mastodon.version})`,
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
      const token = mastodon.addUser('alice');

      const api = async (method: string, path: string, body?: unknown) => {
        const r = await mastodon.call(method, path, { token, body });
        expect(r.status, `${method} ${path}: ${r.body}`).toBe(200);

        return JSON.parse(r.body);
      };

      const followerCount = async () =>
        JSON.parse(
          (
            await atomicRequest(`${DIRECT}/ap/followers`, {
              headers: { accept: 'application/activity+json' },
            })
          ).body,
        ).totalItems as number;

      let accountId = '';

      await test.step('Mastodon resolves the actor', async () => {
        // By its URL: Mastodon's search takes no port in a handle
        // (Account::MENTION_RE), so `@news@<host>:<port>` finds nothing.
        const found = await waitFor(
          async () => {
            const r = await mastodon.call(
              'GET',
              `/api/v2/search?type=accounts&resolve=true&q=${encodeURIComponent(ACTOR)}`,
              { token },
            );

            return r.status === 200 && JSON.parse(r.body).accounts.length
              ? JSON.parse(r.body).accounts[0]
              : undefined;
          },
          `Mastodon to resolve ${ACTOR}`,
          60_000,
        ).catch(dump);
        expect(found).toMatchObject({
          acct: HANDLE,
          username: 'news',
          display_name: 'Atomic news',
          bot: true,
          locked: false,
        });
        accountId = found.id;
      });

      await test.step('alice follows; Mastodon gets the Accept', async () => {
        await api('POST', `/api/v1/accounts/${accountId}/follow`);
        const relationship = await waitFor(
          async () => {
            const [r] = await api(
              'GET',
              `/api/v1/accounts/relationships?id[]=${accountId}`,
            );

            return r.following ? r : undefined;
          },
          'Mastodon to record the follow as accepted',
          120_000,
        ).catch(dump);
        expect(relationship).toMatchObject({
          following: true,
          requested: false,
        });
        expect(await followerCount()).toBe(1);
      });

      let statusId = '';

      await test.step('the drive posts; the Note reaches Mastodon', async () => {
        const posted = await signedPost(agent, `${DIRECT}/ap/outbox`, {
          type: 'Note',
          content: NOTE,
        });
        expect(posted.status, posted.body).toBe(201);
        const out = JSON.parse(posted.body);
        expect(out.queued).toBe(1);
        const status = await waitFor(
          async () => {
            const list = await api(
              'GET',
              `/api/v1/accounts/${accountId}/statuses`,
            );

            return list.find((s: { uri: string }) => s.uri === out.object);
          },
          'the post in Mastodon',
          120_000,
        ).catch(dump);
        expect(status.content).toBe(`<p>${NOTE}</p>`);
        expect(status.visibility).toBe('public');
        const home = await waitFor(async () => {
          const list = await api('GET', '/api/v1/timelines/home');

          return list.find((s: { id: string }) => s.id === status.id);
        }, "the post in alice's home timeline").catch(dump);
        expect(home.account.acct).toBe(HANDLE);
        statusId = status.id;
      });

      await test.step('alice replies; the reply is stored in the drive', async () => {
        const reply = await api('POST', '/api/v1/statuses', {
          status: 'Welcome to the fediverse, drive!',
          in_reply_to_id: statusId,
          visibility: 'public',
        });
        const stored = await waitFor(
          () => childNamed(page, folders.replies, 'Welcome to the fediverse'),
          'the stored reply',
          120_000,
        ).catch(dump);
        expect(stored[P.description]).toContain(
          'Welcome to the fediverse, drive!',
        );
        expect(stored[P.url]).toBe(reply.uri);
        expect(stored[P.replyTo]).toBeTruthy();
      });

      await test.step('alice unfollows; the follower is removed', async () => {
        await api('POST', `/api/v1/accounts/${accountId}/unfollow`);
        await waitFor(
          async () => ((await followerCount()) === 0 ? true : undefined),
          'the follower to be removed',
          120_000,
        ).catch(dump);
      });

      await test.step('the wire, as the proxy saw it', async () => {
        const traffic = mastodon.traffic();
        const file = testInfo.outputPath('mastodon-traffic.json');
        writeFileSync(file, JSON.stringify(traffic, null, 2));
        await testInfo.attach('mastodon-traffic.json', {
          path: file,
          contentType: 'application/json',
        });
        const toAtomic = traffic.filter(t => t.to === 'atomic');
        const toMastodon = traffic.filter(t => t.to === 'mastodon');
        // Mastodon's lookups of the actor.
        expect(
          toAtomic.some(t => t.path.startsWith('/.well-known/webfinger?')),
        ).toBe(true);
        const actorFetch = toAtomic.find(
          t => t.method === 'GET' && t.path === '/ap/actor',
        );
        expect(actorFetch?.status).toBe(200);
        // Mastodon's inbox deliveries, all accepted.
        const inbox = toAtomic.filter(
          t => t.method === 'POST' && t.path === '/ap/inbox',
        );
        expect(inbox.map(t => JSON.parse(t.body ?? '{}').type)).toEqual(
          expect.arrayContaining(['Create', 'Follow', 'Undo']),
        );

        for (const t of inbox) {
          expect(t.status, t.response).toBe(202);
          expect(t.headers.signature).toMatch(/algorithm="rsa-sha256"/);
        }

        // The host's deliveries to Mastodon: Accept and Create, signed.
        const delivered = toMastodon.filter(
          t => t.method === 'POST' && t.path === '/inbox',
        );
        expect(
          delivered.map(t => JSON.parse(t.body ?? '{}').type).sort(),
        ).toEqual(['Accept', 'Create']);

        for (const t of delivered) {
          expect(t.status, t.response).toBe(202);
          expect(t.headers.signature).toContain(`keyId="${ACTOR}#main-key"`);
        }
      });
    } finally {
      if (process.env.FEDIVERSE_MASTODON_KEEP !== '1') mastodon.stop();
    }
  });
});
