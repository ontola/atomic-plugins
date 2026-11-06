import { describe, expect, it, vi } from 'vitest';
import { manageAccess } from '../../../src/daemon/management.js';
import { startBrowserServer } from '../../../src/daemon/browser-server.js';

const session = {
  issuer: 'https://iap.example',
  accessToken: 'private-device-token',
  scope: 'connections:read connections:manage sessions:manage',
};
describe('IAP management bridge', () => {
  it('routes only fixed operations and requires independently approved scopes', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      manageAccess(
        { ...session, scope: 'proxy:write' },
        'owner',
        { action: 'disconnect', connection: 'id' },
        request,
      ),
    ).rejects.toThrow('Approve');
    await expect(
      manageAccess(
        session,
        'owner',
        { action: 'fetch', url: 'https://evil.example' },
        request,
      ),
    ).rejects.toThrow('Unknown');
    expect(request).not.toHaveBeenCalled();
    await manageAccess(
      session,
      'owner',
      {
        action: 'revoke-delegation',
        connection: 'id',
        agent: 'atomic:agent:key',
      },
      request,
    );
    expect(request.mock.calls[0][0]).toBe(
      'https://iap.example/connections/id/agents/atomic%3Aagent%3Akey',
    );
    expect(request.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      redirect: 'error',
      credentials: 'omit',
    });
  });
  it('checks the configured owner before exposing the remote connection list', async () => {
    const request = vi.fn(async () =>
      Response.json({ owner: 'different', connections: [] }),
    );
    await expect(
      manageAccess(session, 'owner', { action: 'overview' }, request),
    ).rejects.toThrow('owner mismatch');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('requires a private local token and exact Origin before accepting a frame action', async () => {
    const manage = vi.fn(async () => ({ connections: [], sessions: [] }));
    const server = await startBrowserServer({
      store: {
        head: async () => undefined,
        resolveRevision: async () => '',
        list: async () => [],
      },
      collections: [],
      port: 0,
      management: { issuer: session.issuer, request: manage },
    });
    try {
      const url = new URL(server.url);
      const token = new URLSearchParams(url.hash.slice(1)).get('token');
      const init = {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
        body: '{"action":"overview"}',
      };
      expect((await fetch(url.origin + '/api/management', init)).status).toBe(
        403,
      );
      expect(
        (
          await fetch(url.origin + '/api/management', {
            ...init,
            headers: { ...init.headers, Origin: 'https://evil.example' },
          })
        ).status,
      ).toBe(403);
      expect(manage).not.toHaveBeenCalled();
      expect(
        (
          await fetch(url.origin + '/api/management', {
            ...init,
            headers: { ...init.headers, Origin: url.origin },
          })
        ).status,
      ).toBe(200);
      expect(manage).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});
