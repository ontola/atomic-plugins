import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  INTERACTIVE_GRANT_BINDING_PREFIX,
  MemoryConnectionGrants,
  interactiveGrantConnection,
  validateInteractiveGrantOptions,
  withInteractiveConnectionGrant,
} from '../../../src/daemon/interactive-grant.js';
import type {
  DaemonConfig,
  CollectionConfig,
} from '../../../src/daemon/config.js';
import type { ConnectionGrant } from '../../../src/daemon/connection-grants.js';
import type { PostgresArchive } from '../../../src/postgres/archive.js';
import { proxyRequest, proxyReadTransport } from '../../../src/cli/auth.js';
import { proxyWriteTransport } from '../../../src/daemon/write-transport.js';
import { keychainCommand } from '../../../src/daemon/keychain.js';

vi.mock('../../../src/daemon/keychain.js', () => ({
  keychainCommand: vi.fn(async () => {
    throw new Error('Keychain must not be called');
  }),
}));

const issuer = 'https://issuer.example';
const sealed = 's1.inventedSealedGrant';
const config: DaemonConfig = {
  version: 1,
  issuer,
  owner: 'invented-owner',
  clientId: 'test-client',
  dataDirectory: '/unused',
  collections: [],
};
const connection = {
  connection_id: 'selected-connection',
  platform: 'google-keep',
};
const envelope = (): ConnectionGrant => ({
  version: 1,
  issuer,
  owner: config.owner,
  clientId: config.clientId,
  sessionId: 'new-session',
  connectionId: connection.connection_id,
  grant: sealed,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
});

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
interface Setup {
  options: {
    config: DaemonConfig;
    archive: PostgresArchive;
    connection: typeof connection;
    write: boolean;
    input: Readable;
    report: (message: string) => void;
    fetch: FetchMock;
  };
  queries: string[];
  reports: string[];
  fetchImpl: FetchMock;
  revocations: () => FetchMock['mock']['calls'];
  providerCalls: () => FetchMock['mock']['calls'];
}

function setup({
  write = false,
  wrongOwner = false,
  unselected = false,
  revokeFails = false,
} = {}): Setup {
  const queries: string[] = [],
    reports: string[] = [];
  const client = {
    query: async (
      sql: string,
    ): Promise<{ rowCount: number; rows: unknown[] }> => {
      queries.push(sql);
      return { rowCount: 0, rows: [] };
    },
    release: (): void => {},
  };
  const archive = {
    pool: {
      connect: async (): Promise<typeof client> => client,
    },
  } as unknown as PostgresArchive;
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return Response.json({
        issuer,
        device_authorization_endpoint: issuer + '/oauth/device/code',
        token_endpoint: issuer + '/oauth/device/token',
      });
    if (url.pathname === '/oauth/device/code')
      return Response.json({
        device_code: 'invented-device-secret',
        user_code: 'TEST-CODE',
        verification_uri: issuer + '/device',
        expires_in: 600,
        interval: 0.001,
      });
    if (url.pathname === '/oauth/device/token')
      return Response.json({
        access_token: 'invented-access-secret',
        refresh_token: 'invented-refresh-secret',
        token_type: 'Bearer',
        scope: 'connections:read proxy:read' + (write ? ' proxy:write' : ''),
        expires_in: 600,
        session_id: 'new-session',
      });
    if (url.pathname === '/connections')
      return Response.json({
        owner: wrongOwner ? 'other-owner' : config.owner,
        connections: unselected ? [] : [connection],
      });
    if (url.pathname === '/oauth/device/revoke')
      return new Response(null, { status: revokeFails ? 500 : 200 });
    if (url.pathname.startsWith('/proxy/')) return Response.json([]);
    throw new Error('Unexpected invented endpoint');
  });
  const options = {
    config,
    archive,
    connection,
    write,
    input: Readable.from([JSON.stringify(envelope())]),
    report: (message: string): void => {
      reports.push(message);
    },
    fetch: fetchImpl,
  };
  const revocations = (): typeof fetchImpl.mock.calls =>
    fetchImpl.mock.calls.filter(
      ([url]) => new URL(String(url)).pathname === '/oauth/device/revoke',
    );
  const providerCalls = (): typeof fetchImpl.mock.calls =>
    fetchImpl.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.startsWith('/proxy/'),
    );
  return { options, queries, reports, fetchImpl, revocations, providerCalls };
}

describe('interactive grant opt-in', () => {
  it('requires a pipe before starting device authorization', async () => {
    const h = setup();
    h.options.input = Object.assign(Readable.from([]), { isTTY: true });
    await expect(
      withInteractiveConnectionGrant(h.options, vi.fn()),
    ).rejects.toThrow('Pipe the owner-issued connection grant');
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it('accepts only explicit interactive sync/send and one declared remote connection', () => {
    for (const command of ['sync', 'send'])
      expect(() =>
        validateInteractiveGrantOptions(command, {
          'connection-grant-stdin': true,
          interactive: true,
        }),
      ).not.toThrow();
    for (const command of ['login', 'daemon', 'ui', 'adopt-edit', 'browse'])
      expect(() =>
        validateInteractiveGrantOptions(command, {
          'connection-grant-stdin': true,
          interactive: true,
        }),
      ).toThrow();
    for (const extra of [{}, { write: true }, { manage: true }])
      expect(() =>
        validateInteractiveGrantOptions('sync', {
          'connection-grant-stdin': true,
          ...extra,
        }),
      ).toThrow();
    const source = {
      ...connection,
      connection: connection.connection_id,
      platform: connection.platform,
    } as unknown as CollectionConfig;
    expect(interactiveGrantConnection([source, { ...source }])).toEqual(
      connection,
    );
    for (const rows of [
      [],
      [source, { ...source, connection: 'other' }],
      [source, { ...source, platform: 'other' }],
      [{ ...source, local: { url: 'http://127.0.0.1', tokenFile: '/unused' } }],
      [
        {
          ...source,
          fileInventory: {
            provider: 'icloud-drive' as const,
            directory: '/unused',
          },
        },
      ],
      [{ ...source, connection: 'local-index:example' }],
    ])
      expect(() => interactiveGrantConnection(rows)).toThrow();
  });
  it('clones and validates memory values, rejects raw keys, and drops references on clear', async () => {
    const store = new MemoryConnectionGrants(),
      value = envelope();
    await store.set(value);
    value.grant = 's1.changedByCaller';
    const returned = await store.get(value);
    expect(returned?.grant).toBe(sealed);
    expect(Object.isFrozen(returned)).toBe(true);
    await expect(
      store.set({ ...envelope(), grant: 'k1.rawKey' }),
    ).rejects.toThrow();
    await expect(store.set({ ...envelope(), expiresAt: 0 })).rejects.toThrow();
    expect(
      await store.get({ ...value, sessionId: 'different' }),
    ).toBeUndefined();
    store.clear();
    expect(await store.get(value)).toBeUndefined();
  });
  it('emits only public binding, imports into memory, reads, and revokes without Keychain', async () => {
    const h = setup();
    await withInteractiveConnectionGrant(
      h.options,
      async (auth, session, selected, grant) => {
        expect(grant).toBe(sealed);
        const transport = proxyReadTransport(
          session,
          selected,
          h.fetchImpl,
          await auth.connectionGrant(selected.connection_id, session),
        );
        expect(
          (await transport(proxyRequest(session, selected, '/v1/notes')))
            .status,
        ).toBe(200);
      },
    );
    expect(h.providerCalls()).toHaveLength(1);
    expect(h.revocations()).toHaveLength(1);
    expect(
      new Headers(h.providerCalls()[0][1]?.headers).get('x-connection-key'),
    ).toBe(sealed);
    const line = h.reports.find((message) =>
      message.startsWith(INTERACTIVE_GRANT_BINDING_PREFIX),
    )!;
    expect(
      JSON.parse(line.slice(INTERACTIVE_GRANT_BINDING_PREFIX.length)),
    ).toEqual({
      version: 1,
      issuer,
      owner: config.owner,
      clientId: config.clientId,
      sessionId: 'new-session',
      connectionId: connection.connection_id,
      platform: connection.platform,
    });
    for (const secret of [
      sealed,
      'invented-access-secret',
      'invented-refresh-secret',
      'invented-device-secret',
    ])
      expect(h.reports.join('\n')).not.toContain(secret);
    expect(vi.mocked(keychainCommand)).not.toHaveBeenCalled();
    expect(
      h.queries.every((sql) => sql.startsWith('SELECT pg_advisory_')),
    ).toBe(true);
  });
  it.each([
    'sessionId',
    'issuer',
    'owner',
    'clientId',
    'connectionId',
    'expiresAt',
    'raw',
    'extra',
  ] as const)(
    'rejects %s mismatch before dispatch, then revokes',
    async (field) => {
      const h = setup(),
        bad: Record<string, unknown> = { ...envelope() };
      if (field === 'expiresAt') bad.expiresAt = 0;
      else if (field === 'raw') bad.grant = 'k1.inventedRaw';
      else if (field === 'extra') bad.extra = 'not-allowed';
      else bad[field] = 'different';
      h.options.input = Readable.from([JSON.stringify(bad)]);
      const action = vi.fn();
      await expect(
        withInteractiveConnectionGrant(h.options, action),
      ).rejects.toThrow();
      expect(action).not.toHaveBeenCalled();
      expect(h.providerCalls()).toHaveLength(0);
      expect(h.revocations()).toHaveLength(1);
    },
  );
  it.each([{ wrongOwner: true }, { unselected: true }])(
    'revokes fresh authorization even if owner/selection checks fail',
    async (settings) => {
      const h = setup(settings),
        action = vi.fn();
      await expect(
        withInteractiveConnectionGrant(h.options, action),
      ).rejects.toThrow();
      expect(action).not.toHaveBeenCalled();
      expect(h.revocations()).toHaveLength(1);
    },
  );
  it('requires fresh write approval even with a valid sealed grant', async () => {
    const h = setup();
    h.options.write = true;
    await expect(
      withInteractiveConnectionGrant(
        h.options,
        async (_auth, session, selected, grant) =>
          proxyWriteTransport(session, selected, undefined, h.fetchImpl, grant),
      ),
    ).rejects.toThrow('approve proxy:write');
    expect(h.providerCalls()).toHaveLength(0);
    expect(h.revocations()).toHaveLength(1);
  });
  it('a readonly session cannot dispatch writes even with a valid grant', async () => {
    const h = setup();
    await expect(
      withInteractiveConnectionGrant(
        h.options,
        async (_auth, session, selected, grant) =>
          proxyWriteTransport(session, selected, undefined, h.fetchImpl, grant),
      ),
    ).rejects.toThrow('Read and write login required');
    expect(h.providerCalls()).toHaveLength(0);
    expect(h.revocations()).toHaveLength(1);
  });
  it('explicit fresh write approval sends only the imported opaque grant and revokes', async () => {
    const h = setup({ write: true });
    await withInteractiveConnectionGrant(
      h.options,
      async (_auth, session, selected, grant) => {
        const transport = proxyWriteTransport(
          session,
          selected,
          undefined,
          h.fetchImpl,
          grant,
        );
        const request = proxyRequest(session, selected, '/v1/notes');
        await transport({
          ...request,
          method: 'POST',
          body: '{"title":"invented"}',
        });
      },
    );
    expect(h.providerCalls()).toHaveLength(1);
    expect(h.revocations()).toHaveLength(1);
    expect(
      new Headers(h.providerCalls()[0][1]?.headers).get('x-connection-key'),
    ).toBe(sealed);
  });
  it('revokes after action failure and reports cleanup failure without replacing the original error', async () => {
    const h = setup({ revokeFails: true });
    await expect(
      withInteractiveConnectionGrant(h.options, async () => {
        throw new Error('Invented action failure');
      }),
    ).rejects.toThrow('Invented action failure');
    expect(h.revocations()).toHaveLength(1);
    expect(h.reports).toContain('Ephemeral device session revocation failed');
  });
  it('revokes even when the local database becomes unavailable during the operation', async () => {
    const h = setup();
    await expect(
      withInteractiveConnectionGrant(h.options, async () => {
        h.options.archive.pool.connect = vi.fn(async () => {
          throw new Error('Invented database failure');
        }) as typeof h.options.archive.pool.connect;
        throw new Error('Invented database failure');
      }),
    ).rejects.toThrow('Invented database failure');
    expect(h.revocations()).toHaveLength(1);
  });
  it('revokes after bounded stdin timeout without dispatch or Keychain use', async () => {
    const h = setup();
    h.options.input = new Readable({ read(): void {} });
    let bindingReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      bindingReady = resolve;
    });
    const report = h.options.report;
    h.options.report = (message): void => {
      report(message);
      if (message.startsWith(INTERACTIVE_GRANT_BINDING_PREFIX)) {
        vi.useFakeTimers();
        bindingReady();
      }
    };
    const action = vi.fn();
    const outcome = withInteractiveConnectionGrant(h.options, action).catch(
      (error: unknown) => error,
    );
    try {
      await ready;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await outcome).toEqual(
        new Error('Connection grant input timed out'),
      );
      expect(action).not.toHaveBeenCalled();
      expect(h.revocations()).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
