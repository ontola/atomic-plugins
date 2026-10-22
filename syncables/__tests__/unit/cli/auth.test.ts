import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  deviceLogin,
  listConnections,
  probeApi,
} from '../../../src/cli/auth.js';

const issuer = 'http://127.0.0.1:11872';

function fixture(results: Array<{ status: number; body: unknown }>): {
  fetch: typeof fetch;
  requests: Array<{ url: string; init: RequestInit }>;
} {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  return {
    requests,
    fetch: (async (
      url: string | URL | Request,
      init: RequestInit = {},
    ): Promise<Response> => {
      requests.push({ url: String(url), init });
      const next = results.shift();
      if (!next) throw new Error('Unexpected request');
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}

const discovery = {
  status: 200,
  body: {
    issuer,
    device_authorization_endpoint: `${issuer}/device`,
    token_endpoint: `${issuer}/token`,
  },
};
const device = {
  status: 200,
  body: {
    device_code: 'invented-device-code',
    user_code: 'DEMO-CODE',
    verification_uri: `${issuer}/approve`,
    expires_in: 60,
    interval: 1,
  },
};
const granted = {
  status: 200,
  body: { access_token: 'invented-access-token', token_type: 'Bearer' },
};

describe('CLI device authorization', () => {
  it('prints the complete approval link carrying the matching user code', async () => {
    const complete = `${issuer}/approve?user_code=DEMO-CODE`;
    const fake = fixture([
      discovery,
      {
        ...device,
        body: { ...device.body, verification_uri_complete: complete },
      },
      granted,
    ]);
    const messages: string[] = [];
    await deviceLogin(
      { issuer, clientId: 'demo' },
      {
        fetch: fake.fetch,
        sleep: async () => {},
        report: (message) => {
          messages.push(message);
        },
      },
    );
    expect(messages.join('\n')).toContain('Open ' + complete + '\n');
    expect(messages.join('\n')).toContain('Continue to owner approval');
    expect(messages.join('\n')).not.toContain('invented-device-code');
    expect(messages.join('\n')).not.toContain('invented-access-token');
  });

  it.each([
    `https://other.example/approve?user_code=DEMO-CODE`,
    `${issuer}/other?user_code=DEMO-CODE`,
    `${issuer}/approve?user_code=OTHER-CODE`,
    `${issuer}/approve?user_code=DEMO-CODE&user_code=OTHER-CODE`,
    `${issuer}/approve`,
  ])(
    'rejects a complete approval URI outside the expected endpoint/code: %s',
    async (complete) => {
      const fake = fixture([
        discovery,
        {
          ...device,
          body: { ...device.body, verification_uri_complete: complete },
        },
      ]);
      const messages: string[] = [];
      await expect(
        deviceLogin(
          { issuer, clientId: 'demo' },
          {
            fetch: fake.fetch,
            sleep: async () => {},
            report: (message) => {
              messages.push(message);
            },
          },
        ),
      ).rejects.toThrow('complete verification URI');
      expect(messages).toEqual([]);
      expect(fake.requests).toHaveLength(2);
    },
  );

  it('uses the published proxy device contract for login, discovery and an API read', async () => {
    const contract = JSON.parse(
      readFileSync(
        new URL(
          '../../../../integration-proxy/tests/fixtures/device-contract.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const fake = fixture([
      {
        status: 200,
        body: {
          issuer,
          device_authorization_endpoint:
            issuer + contract.device_authorization_path,
          token_endpoint: issuer + contract.token_path,
          token_endpoint_auth_methods_supported: ['none'],
        },
      },
      device,
      granted,
      {
        status: 200,
        body: {
          owner: 'atomic:agent:demo',
          client_id: contract.public_client.client_id,
          session_id: 'invented-session',
          connections: [
            {
              connection_id: 'demo',
              platform: 'github-issues',
              owner: 'atomic:agent:demo',
            },
          ],
        },
      },
      { status: 200, body: [{ id: 1 }] },
    ]);
    const session = await deviceLogin(
      {
        issuer,
        clientId: contract.public_client.client_id,
        scope: contract.scopes.join(' '),
      },
      { fetch: fake.fetch, sleep: async () => {}, report: () => {} },
    );
    const available = await listConnections(session, fake.fetch);
    await probeApi(
      session,
      available.connections[0],
      '/repos/demo/tasks/issues',
      fake.fetch,
    );
    expect(fake.requests.map(({ url }) => new URL(url).pathname)).toEqual([
      contract.discovery_path,
      contract.device_authorization_path,
      contract.token_path,
      '/connections',
      '/proxy/demo/github-issues/repos/demo/tasks/issues',
    ]);
    const form = fake.requests[1].init.body as URLSearchParams;
    expect(form.get('client_id')).toBe(contract.public_client.client_id);
    expect(form.get('scope')).toBe(contract.scopes.join(' '));
    expect(form.has('client_secret')).toBe(false);
  });

  it('honours pending and slow_down, then verifies connections and a read-only API', async () => {
    const fake = fixture([
      discovery,
      device,
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 400, body: { error: 'slow_down' } },
      granted,
      {
        status: 200,
        body: {
          owner: 'atomic:agent:demo',
          connections: [{ connection_id: 'demo', platform: 'github-issues' }],
        },
      },
      { status: 200, body: [{ id: 1 }] },
    ]);
    let clock = 0;
    const delays: number[] = [];
    const messages: string[] = [];
    const session = await deviceLogin(
      { issuer, clientId: 'demo-client', scope: 'demo-read' },
      {
        fetch: fake.fetch,
        now: () => clock,
        sleep: async (ms) => {
          delays.push(ms);
          clock += ms;
        },
        report: (message) => {
          messages.push(message);
        },
      },
    );
    expect(delays).toEqual([1000, 1000, 6000]);
    expect(messages.join('\n')).toContain('DEMO-CODE');
    expect(messages.join('\n')).not.toContain('invented-access-token');
    expect(messages.join('\n')).not.toContain('invented-device-code');
    expect(String(fake.requests[1].init.body)).toContain('scope=demo-read');
    expect(String(fake.requests[2].init.body)).toContain(
      'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code',
    );
    const available = await listConnections(session, fake.fetch);
    expect(available.owner).toBe('atomic:agent:demo');
    const result = await probeApi(
      session,
      available.connections[0],
      '/repos/demo/tasks/issues?per_page=1',
      fake.fetch,
    );
    expect(result.status).toBe(200);
    expect(fake.requests.at(-1)?.init.method).toBe('GET');
    expect(fake.requests.at(-1)?.init.headers).toEqual({
      authorization: 'Bearer invented-access-token',
    });
    expect(fake.requests.every((item) => item.init.redirect === 'error')).toBe(
      true,
    );
  });

  it.each(['access_denied', 'expired_token'])('stops on %s', async (error) => {
    const fake = fixture([discovery, device, { status: 400, body: { error } }]);
    await expect(
      deviceLogin(
        { issuer, clientId: 'demo' },
        { fetch: fake.fetch, sleep: async () => {}, report: () => {} },
      ),
    ).rejects.toThrow(error === 'access_denied' ? 'denied' : 'expired');
    expect(fake.requests).toHaveLength(3);
  });

  it('expires locally without polling beyond the device deadline', async () => {
    const fake = fixture([
      discovery,
      { ...device, body: { ...device.body, expires_in: 1, interval: 5 } },
    ]);
    let clock = 0;
    await expect(
      deviceLogin(
        { issuer, clientId: 'demo' },
        {
          fetch: fake.fetch,
          now: () => clock,
          sleep: async (ms) => {
            clock += ms;
          },
          report: () => {},
        },
      ),
    ).rejects.toThrow('expired');
    expect(fake.requests).toHaveLength(2);
  });

  it('refuses cross-origin token endpoints before sending a device secret', async () => {
    const fake = fixture([
      {
        status: 200,
        body: {
          ...discovery.body,
          token_endpoint: 'https://other.example/token',
        },
      },
    ]);
    await expect(
      deviceLogin(
        { issuer, clientId: 'demo' },
        { fetch: fake.fetch, report: () => {} },
      ),
    ).rejects.toThrow('issuer origin');
    expect(fake.requests).toHaveLength(1);
  });

  it('reports missing deployment without exposing the server error body', async () => {
    const fake = fixture([
      { status: 404, body: { secret: 'must-not-be-printed' } },
    ]);
    await expect(
      deviceLogin(
        { issuer, clientId: 'demo' },
        { fetch: fake.fetch, report: () => {} },
      ),
    ).rejects.toThrow('#565');
  });

  it('does not follow token-bearing redirects or expose transport errors', async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new Error('invented-access-token');
    }) as typeof fetch;
    await expect(
      listConnections(
        { issuer, accessToken: 'invented-access-token' },
        fetchImpl,
      ),
    ).rejects.toThrow('network, timeout or redirect');
  });

  it('rejects an API path that escapes its connection before any request', async () => {
    const fake = fixture([]);
    await expect(
      probeApi(
        { issuer, accessToken: 'demo' },
        { connection_id: 'demo', platform: 'github-issues' },
        '/../../connections',
        fake.fetch,
      ),
    ).rejects.toThrow('escapes');
    expect(fake.requests).toHaveLength(0);
  });

  it('checks denied API access rather than treating successful login as access proof', async () => {
    const fake = fixture([{ status: 403, body: { error: 'invented-secret' } }]);
    await expect(
      probeApi(
        { issuer, accessToken: 'demo' },
        { connection_id: 'demo', platform: 'github-issues' },
        '/repos/demo/tasks/issues',
        fake.fetch,
      ),
    ).rejects.toThrow('HTTP 403');
  });
});
