// Local test double for #565's proposed contract. No real account or provider access.
/* global URL, URLSearchParams, process, console */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const devices = new Map();
const tokens = new Set();
const refreshTokens = new Map();
const port = Number(process.env.SYNCABLES_MOCK_PORT ?? 11872);
const origin = `http://127.0.0.1:${port}`;
const owner = process.env.SYNCABLES_MOCK_OWNER ?? 'atomic:agent:demo';

const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const send = (status, body, cacheControl = 'no-store') => {
    response.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': cacheControl,
    });
    response.end(JSON.stringify(body));
  };
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 8192) {
      send(413, {});
      return;
    }
  }
  const form = new URLSearchParams(body);
  if (
    request.method === 'GET' &&
    url.pathname === '/.well-known/oauth-authorization-server'
  ) {
    send(200, {
      issuer: origin,
      device_authorization_endpoint: `${origin}/oauth/device`,
      token_endpoint: `${origin}/oauth/token`,
    });
  } else if (request.method === 'POST' && url.pathname === '/oauth/device') {
    if (form.get('client_id') !== 'syncables-cli-demo') {
      send(400, { error: 'invalid_client' });
      return;
    }
    const deviceCode = randomUUID();
    const userCode = randomUUID().slice(0, 8).toUpperCase();
    devices.set(deviceCode, {
      userCode,
      approved: false,
      expires: Date.now() + 300_000,
    });
    send(200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${origin}/device`,
      expires_in: 300,
      interval: 1,
    });
  } else if (request.method === 'GET' && url.pathname === '/device') {
    response.writeHead(200, {
      'content-type': 'text/html',
      'cache-control': 'no-store',
    });
    response.end(
      '<h1>Syncables mock device approval</h1><p>Invented GitHub connection; no real permissions.</p><form method="POST" action="/approve"><label>Code <input name="code" required></label><button>Approve demo read access</button></form>',
    );
  } else if (request.method === 'POST' && url.pathname === '/approve') {
    const device = [...devices.values()].find(
      (item) => item.userCode === form.get('code') && item.expires > Date.now(),
    );
    if (!device) {
      send(400, { error: 'invalid_code' });
      return;
    }
    device.approved = true;
    send(200, { approved: true });
  } else if (request.method === 'POST' && url.pathname === '/oauth/token') {
    if (
      form.get('grant_type') === 'refresh_token' &&
      form.get('client_id') === 'syncables-cli-demo'
    ) {
      const old = form.get('refresh_token');
      const session = refreshTokens.get(old);
      if (!session) {
        send(400, { error: 'invalid_grant' });
        return;
      }
      refreshTokens.delete(old);
      tokens.delete(session.access);
      const access = randomUUID();
      const refresh = randomUUID();
      tokens.add(access);
      refreshTokens.set(refresh, { ...session, access });
      send(200, {
        access_token: access,
        refresh_token: refresh,
        token_type: 'Bearer',
        expires_in: 300,
        owner,
        session_id: session.id,
      });
      return;
    }
    if (
      form.get('client_id') !== 'syncables-cli-demo' ||
      form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:device_code'
    ) {
      send(400, { error: 'invalid_request' });
      return;
    }
    const code = form.get('device_code');
    const device = devices.get(code);
    if (!device || device.expires <= Date.now()) {
      send(400, { error: 'expired_token' });
      return;
    }
    if (!device.approved) {
      send(400, { error: 'authorization_pending' });
      return;
    }
    devices.delete(code);
    const token = randomUUID();
    tokens.add(token);
    const refresh = randomUUID();
    const id = randomUUID();
    refreshTokens.set(refresh, { id, access: token });
    send(200, {
      access_token: token,
      refresh_token: refresh,
      token_type: 'Bearer',
      expires_in: 300,
      owner,
      session_id: id,
    });
  } else if (
    request.method === 'POST' &&
    url.pathname === '/oauth/device/revoke'
  ) {
    const session = refreshTokens.get(form.get('token'));
    if (session) {
      tokens.delete(session.access);
      refreshTokens.delete(form.get('token'));
    }
    send(200, {});
  } else if (request.method === 'GET' && url.pathname === '/connections') {
    if (!tokens.has(request.headers.authorization?.replace(/^Bearer /, ''))) {
      send(401, {});
      return;
    }
    send(200, {
      owner,
      connections: [
        {
          connection_id: 'demo-connection',
          platform: 'github-issues',
          label: 'Invented issues',
        },
      ],
    });
  } else if (
    request.method === 'GET' &&
    url.pathname ===
      '/proxy/demo-connection/github-issues/repos/example/tasks/issues'
  ) {
    if (!tokens.has(request.headers.authorization?.replace(/^Bearer /, ''))) {
      send(401, {});
      return;
    }
    send(
      200,
      [
        {
          id: 1,
          number: 1,
          title: 'Invented issue',
          state: 'open',
          body: 'An invented note for the compression test. '.repeat(100),
        },
      ],
      'private, max-age=60',
    );
  } else send(404, { error: 'not_available' });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Mock only: ${origin}`);
  console.log(
    `node build/src/cli/main.js auth-test --issuer ${origin} --client-id syncables-cli-demo --path '/repos/example/tasks/issues?per_page=1'`,
  );
});
