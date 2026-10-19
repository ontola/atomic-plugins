// @wc-ignore-file
/**
 * The controller as the #89 views use it: the timesheet it hands them,
 * progress while syncing, typed problems, and the settings, window,
 * reconnect and disconnect actions.
 */
import { describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../fixtures/clockify/scenario.mjs';
import {
  createController,
  type SyncProgressState,
  type ViewState,
} from './controller.js';
import { APP, fakeStore } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import { classify } from './problem.js';
import { ensureSchema } from './schema.js';
import type { PluginStore } from './store.js';
import { ProxyError, proxyRefusal } from './transport.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');

async function configured(lookbackDays = 30) {
  const proxy = fixtureProxy(NOW);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const app = await store.getResource(APP);
  app.set(schema.settings.workspaceId, WORKSPACE.id);
  app.set(schema.settings.userId, USER.id);
  app.set(schema.settings.lookbackDays, lookbackDays);
  await app.save();

  return { proxy, store, schema };
}

async function ready(store: PluginStore, seen: ViewState[] = []) {
  const controller = createController(
    store,
    s => seen.push(s),
    () => NOW,
  );
  const { syncing } = await controller.load();
  await syncing;

  return controller;
}

describe('classify', () => {
  const err = (status: number, retryAfter?: string) =>
    new ProxyError('/api/v1/x', status, { message: 'm' }, retryAfter);

  it('maps statuses and relay failures to the banner kinds', () => {
    expect(classify(err(401))).toMatchObject({
      kind: 'reauth',
      detail: 'HTTP 401 on GET /api/v1/x "m"',
    });
    expect(classify(err(403)).kind).toBe('forbidden');
    expect(classify(err(500)).kind).toBe('other');
    expect(classify(new TypeError('Failed to fetch')).kind).toBe('network');
    expect(
      classify(new Error('Clockify /x returned more than 200 pages')).kind,
    ).toBe('too-many');
    expect(
      classify(
        new Error(
          'The integration proxy refused this connection (unknown_connection). Connect again.',
        ),
      ).kind,
    ).toBe('reauth');
    expect(classify(new Error('Simulated write failure')).kind).toBe('other');
    expect(
      classify(
        new Error(
          'The integration proxy refused the request (capability_expired).',
        ),
      ).kind,
    ).toBe('reauth');
    // The proxy's access check (0.8.2): not "choose another workspace".
    expect(
      classify(Object.assign(new Error('refused'), { code: 'forbidden' })).kind,
    ).toBe('proxy-access');
    expect(
      classify(
        new Error(
          'The integration proxy refused the request (access_denied: this agent may not use the proxy: not on the list).',
        ),
      ).kind,
    ).toBe('proxy-access');
    // Someone else's connection: connect again.
    expect(
      classify(
        new Error(
          'The integration proxy refused this connection (not_owner). Connect again.',
        ),
      ).kind,
    ).toBe('reauth');
    // A retired agent id is not a reconnect: the proxy refuses it at
    // /connect/redeem too, so "Reconnect" would loop.
    expect(
      classify(
        new Error(
          'The integration proxy refused the request (agent_retired: this agent id was transferred to another one and can no longer own connections).',
        ),
      ).kind,
    ).toBe('agent-retired');
    expect(
      classify(Object.assign(new Error('refused'), { code: 'agent_retired' }))
        .kind,
    ).toBe('agent-retired');
    // The proxy's own wording, as the host relays a failed connect (0.8.4).
    expect(
      classify(
        new Error(
          'The integration proxy refused POST /connect/redeem: this agent id was transferred to another one and can no longer own connections',
        ),
      ).kind,
    ).toBe('agent-retired');
    expect(
      classify(
        new Error(
          'The integration proxy refused POST /connections/c-1/agents: this agent may not use the proxy: blocked',
        ),
      ).kind,
    ).toBe('proxy-access');
    // Clockify's own 403 on a workspace stays "choose another workspace".
    expect(classify(err(403)).kind).toBe('forbidden');
    expect(
      classify(
        new Error('The integration proxy refused the request (bad_signature).'),
      ).kind,
    ).toBe('other');
  });

  it('reads not_owner as the proxy refusing this connection, and agent_retired as a replaced key (0.8.3)', () => {
    const notOwner = proxyRefusal({
      status: 403,
      body: { error: 'not_owner', message: 'm' },
    });
    expect(notOwner?.message).toMatch(
      /refused this connection .* Connect again\./,
    );
    expect(classify(notOwner).kind).toBe('reauth');

    // Not "Connect again": after a key transfer the proxy refuses the
    // retired id at /connect/redeem too.
    const retired = proxyRefusal({
      status: 403,
      body: { error: 'agent_retired', message: 'm' },
    });
    expect(retired?.message).not.toMatch(/Connect again/);
    expect(classify(retired).kind).toBe('agent-retired');

    const denied = proxyRefusal({
      status: 403,
      body: { error: 'access_denied', message: 'not on the list' },
    });
    expect(classify(denied).kind).toBe('proxy-access');
  });

  it('reads retry-after as seconds or a date, else 60', () => {
    expect(classify(err(429, '30')).retryAfterSeconds).toBe(30);
    expect(
      classify(err(429, new Date(NOW + 90_000).toUTCString()), NOW)
        .retryAfterSeconds,
    ).toBe(90);
    expect(classify(err(429)).retryAfterSeconds).toBe(60);
  });
});

describe('controller for the timesheet views', () => {
  it('reads the mirror before the first sync, then reports fetch and save progress', async () => {
    const { store } = await configured();
    const seen: ViewState[] = [];
    const controller = await ready(store, seen);

    const progress = seen
      .filter(s => s.kind === 'syncing' && s.progress)
      .map(s => (s as { progress: SyncProgressState }).progress);
    expect(progress[0]).toEqual({ phase: 'fetch', page: 1 });
    expect(progress.at(-1)).toEqual({ phase: 'save', done: 2, total: 3 });

    const sheet = controller.sheet()!;
    expect(sheet.entries).toHaveLength(3);
    expect(sheet.entries[0].project?.color).toBe('#0B8A8A');
    expect(sheet.running).toBe(1);
    expect(sheet.window).toEqual({ from: NOW - 30 * 86_400_000, to: NOW });
  });

  it('keeps showing imported entries when the host has no relay (frame K)', async () => {
    const { store } = await configured();
    await ready(store);
    const offline = createController({ ...store, proxy: undefined }, () => {});

    await offline.load();

    expect(offline.state().kind).toBe('no-proxy');
    // No settings are known without a connection: every entry shows.
    expect(offline.sheet()!.entries).toHaveLength(3);
  });

  it('types a 401 as reauth and a 429 with its retry-after', async () => {
    const { store, proxy } = await configured();
    const controller = await ready(store);

    proxy.fixture.state.failures = { count: 1, status: 401 };
    const failed = await controller.sync();
    expect(failed).toMatchObject({
      kind: 'ready',
      last: { ok: false, problem: { kind: 'reauth' } },
    });
    // The last good copy stays on screen.
    expect(controller.sheet()!.entries).toHaveLength(3);

    proxy.fixture.state.failures = {
      count: 1,
      status: 429,
      retryAfter: '30',
    } as typeof proxy.fixture.state.failures;
    expect(await controller.sync()).toMatchObject({
      last: {
        ok: false,
        problem: { kind: 'rate-limited', retryAfterSeconds: 30 },
      },
    });
  });

  it('keeps a failed sync while the settings sheet is open, and gives it back on cancel', async () => {
    const { store, proxy } = await configured();
    const controller = await ready(store);
    proxy.fixture.state.failures = { count: 1, status: 401 };
    await controller.sync();

    const setup = await controller.openSettings();
    expect(setup).toMatchObject({
      kind: 'setup',
      last: { ok: false, problem: { kind: 'reauth' } },
    });
    expect(controller.cancelSettings()).toMatchObject({
      kind: 'ready',
      last: { ok: false, problem: { kind: 'reauth' } },
    });
  });

  it('cancels the settings form back to ready without saving', async () => {
    const { store } = await configured();
    const controller = await ready(store);
    const writes = store.writes.length;

    expect((await controller.openSettings()).kind).toBe('setup');
    expect(controller.cancelSettings()).toMatchObject({
      kind: 'ready',
      settings: { lookbackDays: 30 },
    });
    expect(store.writes.length).toBe(writes);
  });

  it('switches the window and imports again (frames I and J)', async () => {
    const { store, schema } = await configured(7);
    const controller = await ready(store);
    expect(controller.sheet()!.entries).toHaveLength(2);

    const after = await controller.setLookback(30);

    expect(after).toMatchObject({
      kind: 'ready',
      settings: { lookbackDays: 30 },
      last: { ok: true },
    });
    expect(store.resources.get(APP)![schema.settings.lookbackDays]).toBe(30);
    expect(controller.sheet()!.entries).toHaveLength(3);
  });

  it('reconnects through the host and returns when cancelled', async () => {
    const { store } = await configured();
    const seen: ViewState[] = [];
    const controller = await ready(store, seen);

    const back = await controller.reconnect();

    expect(seen.at(-2)?.kind).toBe('connecting');
    expect(back.kind).toBe('ready');
  });

  // The host relays a failed connect to the frame as a message only
  // (AppFrame posts `e.message`), without the proxy's code (0.8.4).
  const RETIRED =
    'The integration proxy refused POST /connect/redeem: this agent id was transferred to another one and can no longer own connections';
  const DENIED =
    'The integration proxy refused POST /connect/redeem: this agent may not use the proxy: not on the list';
  const refusing = (store: PluginStore, message: string): PluginStore => ({
    ...store,
    proxy: {
      ...store.proxy!,
      connect: async () => {
        throw new Error(message);
      },
    },
  });

  it('a connect the proxy refuses for a replaced key or its access check shows that problem, not a raw failure (0.8.4)', async () => {
    const proxy = fixtureProxy(NOW);
    const base = fakeStore({ proxy: proxy.request, connections: [] });

    for (const [message, kind] of [
      [RETIRED, 'agent-retired'],
      [DENIED, 'proxy-access'],
    ] as const) {
      const controller = createController(refusing(base, message));
      await controller.load();
      expect(controller.state().kind).toBe('not-connected');
      expect(await controller.connect()).toEqual({
        kind: 'not-connected',
        problem: { kind, detail: message },
      });
    }

    // Anything else stays a raw failure.
    const other = createController(refusing(base, 'the host broke'));
    await other.load();
    expect(await other.connect()).toEqual({
      kind: 'failed',
      message: 'the host broke',
    });
  });

  it('a reconnect refused for a replaced key keeps the data and shows that problem over it (0.8.4)', async () => {
    const { store } = await configured();
    const controller = await ready(refusing(store, RETIRED));
    const back = await controller.reconnect();
    expect(back).toMatchObject({
      kind: 'ready',
      last: { ok: false, problem: { kind: 'agent-retired' } },
    });
    expect(controller.sheet()!.entries.length).toBeGreaterThan(0);

    const broken = await ready(refusing(store, 'the host broke'));
    expect((await broken.reconnect()).kind).toBe('failed');
  });

  it('opens links and rows only through the host', async () => {
    const { store, schema } = await configured();
    const controller = await ready(store);
    expect(controller.canOpen()).toEqual({ external: false, resource: false });
    expect(
      await controller.openExternal('https://app.clockify.me/tracker'),
    ).toBe(false);
    expect(await controller.openRow('entry-1')).toBe(false);

    const shown: string[] = [];
    const host = Object.assign(store, {
      openExternal: async () => ({ status: 'cancelled' as const }),
      openResource: async (subject: string) => {
        shown.push(subject);

        return { status: 'opened' as const, subject };
      },
    });
    const other = await ready(host);
    expect(other.canOpen()).toEqual({ external: true, resource: true });
    // Cancelled in the host's prompt: not opened.
    expect(await other.openExternal('https://app.clockify.me/tracker')).toBe(
      false,
    );
    expect(await other.openRow('entry-1')).toBe(true);
    expect(store.resources.get(shown[0])![schema.row.entryId]).toBe('entry-1');
    expect(await other.openRow('no-such-entry')).toBe(false);
  });

  it('offers Disconnect only when the host can forget the connection', async () => {
    const { store } = await configured();
    const controller = await ready(store);
    expect(controller.canDisconnect()).toBe(false);
    expect((await controller.disconnect()).kind).toBe('ready');

    const forgotten: string[] = [];
    const withDisconnect = {
      ...store,
      proxy: {
        ...store.proxy!,
        disconnect: async ({ platform }: { platform: string }) => {
          forgotten.push(platform);

          return {
            status: 'disconnected' as const,
            platform,
            connectionIds: ['conn-1'],
          };
        },
      },
    };
    const other = await ready(withDisconnect);
    expect(other.canDisconnect()).toBe(true);
    expect((await other.disconnect()).kind).toBe('not-connected');
    expect(forgotten).toEqual(['clockify']);
  });
});

describe('editing and sending (#123 M3)', () => {
  it('lists an edit, shows it as not sent, and sends it', async () => {
    const { proxy, store } = await configured(7);
    const controller = await ready(store);

    expect(controller.editBlockers('entry-2')).toEqual([]);
    expect(controller.projectChoices().projects.map(p => p.name)).toEqual([
      'Atomic plugins',
      'Research',
    ]);
    await controller.editEntry('entry-2', {
      name: 'Weekly sync (notes)',
      projectId: 'eeeeeeeeeeeeeeeeeeeeeeee',
    });

    const [change] = controller.changes().review;
    expect(change).toMatchObject({
      entryId: 'entry-2',
      fields: ['name', 'projectId'],
      blockers: [],
    });
    const shown = controller.sheet()!.entries.find(e => e.id === 'entry-2')!;
    expect(shown).toMatchObject({
      description: 'Weekly sync (notes)',
      pending: 'update',
      project: { id: 'eeeeeeeeeeeeeeeeeeeeeeee', name: 'Research' },
    });
    expect(proxy.fixture.state.writes).toEqual([]);

    await controller.send();

    expect(controller.changes().outcomes?.results).toMatchObject([
      { entryId: 'entry-2', status: 'sent' },
    ]);
    expect(controller.changes().review).toEqual([]);
    const after = controller.sheet()!.entries.find(e => e.id === 'entry-2')!;
    expect(after.pending).toBeUndefined();
    expect(after.description).toBe('Weekly sync (notes)');
  });

  it('asks to delete, and Discard drops the request', async () => {
    const { store } = await configured(7);
    const controller = await ready(store);

    await controller.deleteEntry('entry-1');
    expect(controller.changes().review).toMatchObject([
      { kind: 'delete', entryId: 'entry-1' },
    ]);
    expect(
      controller.sheet()!.entries.find(e => e.id === 'entry-1')!.pending,
    ).toBe('delete');

    await controller.discard('entry-1');
    expect(controller.changes().review).toEqual([]);
  });

  it('says why an entry cannot be edited', async () => {
    const { proxy, store } = await configured(7);
    proxy.fixture.control({
      action: 'update',
      id: 'entry-2',
      patch: { isLocked: true },
    });
    const controller = await ready(store);

    expect(controller.editBlockers('entry-2')).toEqual([
      'It is locked in Clockify.',
    ]);
  });
});
