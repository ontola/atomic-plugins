import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import type * as Browser from '../../../src/browser.js';
import { FakeInbox } from './fake-inbox.js';

// atomic-server runs sandbox plugins in QuickJS (rquickjs): ECMAScript
// intrinsics and the host's `ctx`, but no `URL`, `URLSearchParams`,
// `Buffer`, `TextDecoder` or `fetch`. A fresh `vm` context has the same
// intrinsics and none of those, so the inbox consumer bundled from
// `syncables/browser` must run in it as it is.

const browserEntry = fileURLToPath(
  new URL('../../../src/browser.ts', import.meta.url),
);
const examples = new URL(
  '../../../../openapi-extensions/spec/webhook-deliveries/examples/',
  import.meta.url,
);

type Inbox = Pick<
  typeof Browser,
  'InboxClient' | 'InboxConsumer' | 'InMemoryInboxJournal' | 'scopedReads'
>;

async function sandboxed(): Promise<{
  inbox: Inbox;
  globals: Record<string, string>;
}> {
  const result = await build({
    stdin: {
      contents: `
        import { InboxClient, InboxConsumer, InMemoryInboxJournal, scopedReads }
          from ${JSON.stringify(browserEntry)};
        globalThis.inbox = { InboxClient, InboxConsumer, InMemoryInboxJournal, scopedReads };
        globalThis.globals = Object.fromEntries(
          ['URL', 'URLSearchParams', 'Buffer', 'TextDecoder', 'atob', 'fetch']
            .map((name) => [name, typeof globalThis[name]]));
      `,
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      loader: 'ts',
    },
    bundle: true,
    platform: 'neutral',
    format: 'iife',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  const context: Record<string, unknown> = {};
  runInNewContext(result.outputFiles[0]!.text, context);
  return {
    inbox: context.inbox as Inbox,
    globals: context.globals as Record<string, string>,
  };
}

describe('the inbox consumer in a sandbox without web globals', () => {
  it('subscribes, journals, acknowledges and names reads without URL, Buffer or TextDecoder', async () => {
    const { inbox: Sandboxed, globals } = await sandboxed();
    expect(globals).toEqual({
      URL: 'undefined',
      URLSearchParams: 'undefined',
      Buffer: 'undefined',
      TextDecoder: 'undefined',
      atob: 'undefined',
      fetch: 'undefined',
    });
    const fake = new FakeInbox();
    const hrefs: string[] = [];
    const journal = new Sandboxed.InMemoryInboxJournal();
    const consumer = new Sandboxed.InboxConsumer({
      client: new Sandboxed.InboxClient(
        'https://proxy.example/',
        async (request) => {
          hrefs.push(request.url.href);
          return fake.transport(request);
        },
      ),
      journal,
      subscription: {
        connection: 'c 1',
        source: 'project',
        parameters: { projectId: 'p-1' },
        events: ['task'],
      },
      reconcile: async (): Promise<void> => {},
      now: (): number => fake.now,
    });
    expect(await consumer.step()).toMatchObject({ kind: 'subscribed' });
    const github = readFileSync(
      new URL('github-deliveries/issues-edited.json', examples),
      'utf8',
    );
    fake.deliver('d-1', JSON.parse(JSON.parse(github).body));
    expect(await consumer.step()).toMatchObject({ kind: 'events', stored: 1 });
    expect(fake.subs.get('sub-1')!.refs).toHaveLength(0);
    // The exact strings a v2 signature would cover.
    expect(hrefs).toEqual([
      'https://proxy.example/connections/c%201/subscriptions',
      'https://proxy.example/subscriptions/sub-1/reconciled',
      'https://proxy.example/subscriptions/sub-1/events?wait=25',
      'https://proxy.example/subscriptions/sub-1/ack',
    ]);

    const document = yaml.load(
      readFileSync(new URL('github-fixture.yaml', examples), 'utf8'),
    );
    expect(
      Sandboxed.scopedReads(document, {
        ...journal.events[0]!,
        eventType: 'issues',
      }).map((read) => read.path),
    ).toEqual([
      '/repos/fixture-owner/fixture-repo/issues/7',
      '/repos/fixture-owner/fixture-repo/issues',
    ]);
  });
});
