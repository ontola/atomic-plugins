/** Device-flow scaffold. Tokens live only for the duration of auth-test. */
export interface AuthOptions {
  issuer: string;
  clientId: string;
  scope?: string;
  deviceEndpoint?: string;
  tokenEndpoint?: string;
}

interface Metadata {
  device: string;
  token: string;
}

export interface Session {
  issuer: string;
  accessToken: string;
}

export interface Connection {
  connection_id: string;
  platform: string;
  label?: string;
}

export interface Hooks {
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  report: (message: string) => void;
}

export function safeUrl(input: string): URL {
  const url = new URL(input);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      'Use HTTPS, or HTTP on loopback, without credentials or fragments',
    );
  return url;
}

function endpoint(input: string, issuer: string): string {
  const url = safeUrl(input);
  if (url.origin !== new URL(issuer).origin)
    throw new Error('Device and token endpoints must share the issuer origin');
  return url.href;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a JSON object from Local Thought');
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    throw new Error(`Missing or invalid ${name}`);
  return value;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  // Never follow redirects carrying a token, device code or client state.
  try {
    return await fetchImpl(url, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error(
      'Local Thought request failed (network, timeout or redirect)',
    );
  }
}

async function json(response: Response): Promise<Record<string, unknown>> {
  try {
    return object(await response.json());
  } catch {
    // Do not include a response body or upstream error in diagnostics: it may contain secrets.
    throw new Error(`Invalid JSON response (HTTP ${response.status})`);
  }
}

async function metadata(
  options: AuthOptions,
  fetchImpl: typeof fetch,
): Promise<Metadata> {
  const issuer = safeUrl(options.issuer);
  if (issuer.pathname !== '/' || issuer.search)
    throw new Error(
      'This scaffold requires an issuer origin, without a path or query',
    );
  if (options.deviceEndpoint || options.tokenEndpoint) {
    if (!options.deviceEndpoint || !options.tokenEndpoint)
      throw new Error('Supply both --device-endpoint and --token-endpoint');
    return {
      device: endpoint(options.deviceEndpoint, options.issuer),
      token: endpoint(options.tokenEndpoint, options.issuer),
    };
  }
  const response = await request(
    fetchImpl,
    new URL('/.well-known/oauth-authorization-server', issuer).href,
    { method: 'GET' },
  );
  if (!response.ok)
    throw new Error(
      `Device-flow discovery unavailable (HTTP ${response.status}); see atomic-plugins#565 or supply the published endpoints`,
    );
  const result = await json(response);
  if (safeUrl(text(result.issuer, 'issuer')).href !== issuer.href)
    throw new Error('Discovery issuer does not match the requested issuer');
  return {
    device: endpoint(
      text(
        result.device_authorization_endpoint,
        'device_authorization_endpoint',
      ),
      options.issuer,
    ),
    token: endpoint(
      text(result.token_endpoint, 'token_endpoint'),
      options.issuer,
    ),
  };
}

export async function deviceLogin(
  options: AuthOptions,
  hooks: Hooks,
): Promise<Session> {
  const fetchImpl = hooks.fetch ?? globalThis.fetch;
  const now = hooks.now ?? Date.now;
  const sleep =
    hooks.sleep ??
    ((ms: number): Promise<void> =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const endpoints = await metadata(options, fetchImpl);
  const form = new URLSearchParams({
    client_id: text(options.clientId, 'client ID'),
  });
  if (options.scope) form.set('scope', options.scope);
  const started = now();
  const response = await request(fetchImpl, endpoints.device, {
    method: 'POST',
    body: form,
  });
  if (!response.ok)
    throw new Error(`Device authorization refused (HTTP ${response.status})`);
  const device = await json(response);
  const code = text(device.device_code, 'device code');
  const userCode = text(device.user_code, 'user code');
  const verification = safeUrl(
    text(device.verification_uri, 'verification URI'),
  );
  if (
    typeof device.expires_in !== 'number' ||
    !Number.isFinite(device.expires_in) ||
    device.expires_in <= 0
  )
    throw new Error('Invalid device-code expiry');
  let interval = device.interval === undefined ? 5 : device.interval;
  if (
    typeof interval !== 'number' ||
    !Number.isFinite(interval) ||
    interval <= 0
  )
    throw new Error('Invalid device polling interval');
  const deadline = started + Math.min(device.expires_in, 900) * 1000;
  hooks.report(
    `Open ${verification.href}\nEnter code: ${userCode}\nWaiting for approval…`,
  );
  while (now() < deadline) {
    await sleep(Math.min(interval * 1000, Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    const poll = await request(fetchImpl, endpoints.token, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: options.clientId,
        device_code: code,
      }),
    });
    const token = await json(poll);
    if (poll.ok) {
      if (text(token.token_type, 'token type').toLowerCase() !== 'bearer')
        throw new Error('Unsupported Local Thought token type');
      return {
        issuer: safeUrl(options.issuer).origin,
        accessToken: text(token.access_token, 'access token'),
      };
    }
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (token.error === 'access_denied')
      throw new Error('Device authorization denied');
    if (token.error === 'expired_token')
      throw new Error('Device authorization expired');
    throw new Error(`Device token request refused (HTTP ${poll.status})`);
  }
  throw new Error('Device authorization expired');
}

export async function listConnections(
  session: Session,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ owner: string; connections: Connection[] }> {
  const response = await request(
    fetchImpl,
    new URL('/connections', session.issuer).href,
    {
      method: 'GET',
      headers: { authorization: `Bearer ${session.accessToken}` },
    },
  );
  if (!response.ok)
    throw new Error(`Connection discovery refused (HTTP ${response.status})`);
  const result = await json(response);
  if (!Array.isArray(result.connections))
    throw new Error('Missing connections array');
  return {
    owner: text(result.owner, 'connection owner'),
    connections: result.connections.map((value: unknown) => {
      const item = object(value);
      return {
        connection_id: text(item.connection_id, 'connection ID'),
        platform: text(item.platform, 'platform'),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
      };
    }),
  };
}

export async function probeApi(
  session: Session,
  connection: Connection,
  path: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<{ status: number; contentType: string | null; bytes: number }> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('#'))
    throw new Error(
      'API path must begin with / and must not contain a fragment',
    );
  const prefix = `/proxy/${encodeURIComponent(connection.connection_id)}/${encodeURIComponent(connection.platform)}/`;
  const url = new URL(prefix + path.slice(1), session.issuer);
  if (!url.pathname.startsWith(prefix))
    throw new Error('API path escapes the selected connection');
  const response = await request(fetchImpl, url.href, {
    method: 'GET',
    headers: { authorization: `Bearer ${session.accessToken}` },
  });
  if (!response.ok)
    throw new Error(
      `API read refused (HTTP ${response.status}); check connection permissions and catalog access`,
    );
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}
