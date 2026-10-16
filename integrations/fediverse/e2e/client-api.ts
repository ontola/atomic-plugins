// @wc-ignore-file
/**
 * The round trip both opt-in real-server specs run (`mastodon.spec.ts`,
 * `akkoma.spec.ts`), through the Mastodon client API that both servers
 * implement: an invented local user resolves the plugin's actor, follows
 * it, sees a Note the drive publishes in the home timeline, replies, and
 * unfollows. Each step checks what both servers must agree on and returns
 * what the server answered, so a spec can check its own server's details.
 */
import { test, expect, type Page } from '@playwright/test';
import type { Agent } from '@tomic/lib';
import { childNamed, P, signedPost } from './helpers';
import { atomicRequest, waitFor } from './peer';
import type { Response, Traffic } from './stack.mjs';

/** What a spec's server module gives the round trip. */
export interface ClientApiServer {
  call(
    method: string,
    path: string,
    options?: { token?: string; body?: unknown },
  ): Promise<Response>;
  traffic(): Traffic[];
  logs(lines?: number): string;
}

/** The fields of Mastodon API entities the round trip reads. */
export interface Account {
  id: string;
  acct: string;
  [field: string]: unknown;
}
export interface Status {
  id: string;
  uri: string;
  content: string;
  visibility: string;
  account: Account;
  [field: string]: unknown;
}
export interface Relationship {
  following: boolean;
  requested: boolean;
  [field: string]: unknown;
}

export interface RoundTrip {
  /** The actor's account as the server's search returned it. */
  account: Account;
  /** The relationship once the follow is accepted. */
  relationship: Relationship;
  /** The published Note as a status in the actor's statuses. */
  status: Status;
  /** The same status in the user's home timeline. */
  home: Status;
  /** The user's reply, as posted. */
  reply: Status;
  /** The reply as the plugin stored it in the drive. */
  stored: Record<string, unknown>;
}

export async function roundTrip({
  name,
  server,
  token,
  page,
  agent,
  actor,
  direct,
  replies,
  note,
  replyText,
}: {
  /** The server's name, for step titles: `Mastodon`, `Akkoma`. */
  name: string;
  server: ClientApiServer;
  /** The local user's OAuth token (read, write, follow). */
  token: string;
  page: Page;
  /** The drive's publisher. */
  agent: Agent;
  /** The plugin's actor URL, as the server reaches it. */
  actor: string;
  /** The drive host on atomic-server's own port, over http. */
  direct: string;
  /** The replies folder. */
  replies: string;
  note: string;
  replyText: string;
}): Promise<RoundTrip> {
  const dump = (error: unknown): never => {
    throw new Error(
      `${error}\n--- proxy\n${server
        .traffic()
        .map(
          t =>
            `${t.to} ${t.method} ${t.path} ${t.status} ${t.response ?? t.error ?? ''}`,
        )
        .join('\n')}\n${server.logs()}`,
    );
  };

  const api = async (method: string, path: string, body?: unknown) => {
    const r = await server.call(method, path, { token, body });
    expect(r.status, `${method} ${path}: ${r.body}`).toBe(200);

    return JSON.parse(r.body);
  };

  const followerCount = async () =>
    JSON.parse(
      (
        await atomicRequest(`${direct}/ap/followers`, {
          headers: { accept: 'application/activity+json' },
        })
      ).body,
    ).totalItems as number;

  const account: Account = await test.step(`${name} resolves the actor`, () =>
    // By its URL: Mastodon's search takes no port in a handle
    // (Account::MENTION_RE), so `@news@<host>:<port>` finds nothing there.
    waitFor(
      async () => {
        const r = await server.call(
          'GET',
          `/api/v2/search?type=accounts&resolve=true&q=${encodeURIComponent(actor)}`,
          { token },
        );

        return r.status === 200 && JSON.parse(r.body).accounts.length
          ? JSON.parse(r.body).accounts[0]
          : undefined;
      },
      `${name} to resolve ${actor}`,
      60_000,
    ).catch(dump));

  const relationship: Relationship =
    await test.step('the user follows; the Accept arrives', async () => {
      await api('POST', `/api/v1/accounts/${account.id}/follow`);
      const accepted = await waitFor(
        async () => {
          const [r] = await api(
            'GET',
            `/api/v1/accounts/relationships?id[]=${account.id}`,
          );

          return r.following ? r : undefined;
        },
        `${name} to record the follow as accepted`,
        120_000,
      ).catch(dump);
      expect(accepted).toMatchObject({ following: true, requested: false });
      expect(await followerCount()).toBe(1);

      return accepted;
    });

  const { status, home } =
    await test.step('the drive posts; the Note reaches the home timeline', async () => {
      const posted = await signedPost(agent, `${direct}/ap/outbox`, {
        type: 'Note',
        content: note,
      });
      expect(posted.status, posted.body).toBe(201);
      const out = JSON.parse(posted.body);
      expect(out.queued).toBe(1);
      const found: Status = await waitFor(
        async () => {
          const list = await api(
            'GET',
            `/api/v1/accounts/${account.id}/statuses`,
          );

          return list.find((s: { uri: string }) => s.uri === out.object);
        },
        `the post in ${name}`,
        120_000,
      ).catch(dump);
      expect(found.visibility).toBe('public');
      const inHome: Status = await waitFor(async () => {
        const list = await api('GET', '/api/v1/timelines/home');

        return list.find((s: { id: string }) => s.id === found.id);
      }, "the post in the user's home timeline").catch(dump);
      expect(inHome.account.id).toBe(account.id);

      return { status: found, home: inHome };
    });

  const { reply, stored } =
    await test.step('the user replies; the reply is stored in the drive', async () => {
      const posted = await api('POST', '/api/v1/statuses', {
        status: replyText,
        in_reply_to_id: status.id,
        visibility: 'public',
      });
      const found = await waitFor(
        () => childNamed(page, replies, replyText.slice(0, 20)),
        'the stored reply',
        120_000,
      ).catch(dump);
      expect(found[P.description]).toContain(replyText);
      expect(found[P.url]).toBe(posted.uri);
      expect(found[P.replyTo]).toBeTruthy();

      return { reply: posted, stored: found };
    });

  await test.step('the user unfollows; the follower is removed', async () => {
    await api('POST', `/api/v1/accounts/${account.id}/unfollow`);
    await waitFor(
      async () => ((await followerCount()) === 0 ? true : undefined),
      'the follower to be removed',
      120_000,
    ).catch(dump);
  });

  return { account, relationship, status, home, reply, stored };
}
