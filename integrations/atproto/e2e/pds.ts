// @wc-ignore-file
/**
 * Bluesky's reference PDS (`ghcr.io/bluesky-social/pds`) in Docker, on the
 * loopback only, resolving the spec's invented names through atomic-server.
 * Opt-in (`ATPROTO_PDS_E2E=1`): it needs Docker and pulls about 200 MB.
 *
 * Two containers, named `worker-atproto-pds-<run>` and
 * `worker-atproto-tls-<run>` and removed with their anonymous volumes
 * afterwards:
 *
 * - the PDS, its XRPC port published on 127.0.0.1 only. `--add-host` maps
 *   each test name to 127.0.0.1 in its namespace and `--dns 127.0.0.1`
 *   gives it no working resolver, so its DNS TXT handle lookups fail
 *   locally instead of asking public DNS. It trusts the test CA through
 *   `NODE_EXTRA_CA_CERTS`. `PDS_DISABLE_SSRF_PROTECTION=true` is the one
 *   relaxation: with SSRF protection on, the PDS refuses to fetch from a
 *   loopback address at all;
 * - a TLS terminator (`pds-terminator.mjs`, run by the PDS image's own
 *   Node) in the PDS's network namespace on port 443, forwarding over a
 *   Unix socket that this module relays to atomic-server's loopback port.
 *
 * Invented data only: the account's e-mail address and password are made
 * up per run, and the PDS's secrets are random per run.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Keypair } from '@atproto/crypto';
import { issueCertificate } from './reference';

/** `ghcr.io/bluesky-social/pds:latest` on 2026-10-02: @atproto/pds 0.5.36. */
export const PDS_IMAGE =
  'ghcr.io/bluesky-social/pds@sha256:95d6179bc9fb10cc36ccd6dea0407fc6d99f21374bf2a1f9e8f28c0427c7e336';
export const PDS_HOSTNAME = 'pds.e2e.atomicdata.dev';

export type Pds = {
  url: string;
  /** An XRPC call: a procedure (POST) with `body` or `post`, else a query. */
  xrpc(
    method: string,
    options?: {
      params?: Record<string, string>;
      body?: unknown;
      post?: boolean;
      token?: string;
    },
    // XRPC bodies the spec reads field by field.
    // oxlint-disable-next-line typescript/no-explicit-any
  ): Promise<{ status: number; body: any }>;
  logs(): string;
  /** The requests the PDS made to the test names, as the terminator saw them. */
  fetched(): string[];
  close(): void;
};

function docker(args: string[]) {
  return execFileSync('docker', args, { encoding: 'utf8' }).trim();
}

export async function startPds(options: {
  run: string;
  domain: string;
  names: string[];
  serverPort: number;
}): Promise<Pds> {
  const dir = mkdtempSync(join(tmpdir(), 'atproto-pds-'));
  const { ca, cert, key } = issueCertificate(options.domain);
  writeFileSync(join(dir, 'ca.pem'), ca);
  writeFileSync(join(dir, 'cert.pem'), cert);
  writeFileSync(join(dir, 'key.pem'), key);

  // The Unix socket the terminator forwards to, relayed to atomic-server.
  const relay: Server = createServer(socket => {
    const upstream = connect(options.serverPort, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(done =>
    relay.listen(join(dir, 'atomic.sock'), () => done()),
  );

  const pdsName = `worker-atproto-pds-${options.run}`;
  const tlsName = `worker-atproto-tls-${options.run}`;

  const close = () => {
    for (const name of [tlsName, pdsName]) {
      try {
        docker(['rm', '-f', '-v', name]);
      } catch {
        // Not started.
      }
    }

    relay.close();
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    docker([
      'run',
      '-d',
      '--name',
      pdsName,
      '-p',
      '127.0.0.1::3000',
      '--dns',
      '127.0.0.1',
      ...options.names.flatMap(name => ['--add-host', `${name}:127.0.0.1`]),
      '-v',
      `${dir}:/tls:ro`,
      // The PDS's databases and blobs, gone with the container.
      '--tmpfs',
      '/pds',
      '-e',
      'NODE_EXTRA_CA_CERTS=/tls/ca.pem',
      '-e',
      `PDS_HOSTNAME=${PDS_HOSTNAME}`,
      '-e',
      `PDS_JWT_SECRET=${randomBytes(16).toString('hex')}`,
      '-e',
      `PDS_ADMIN_PASSWORD=${randomBytes(16).toString('hex')}`,
      '-e',
      `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX=${randomBytes(32).toString('hex')}`,
      '-e',
      'PDS_DATA_DIRECTORY=/pds',
      '-e',
      'PDS_BLOBSTORE_DISK_LOCATION=/pds/blocks',
      // Never contacted: the spec's identity is did:web.
      '-e',
      'PDS_DID_PLC_URL=https://plc.invalid',
      '-e',
      'PDS_INVITE_REQUIRED=false',
      '-e',
      'PDS_RATE_LIMITS_ENABLED=false',
      '-e',
      'PDS_DISABLE_SSRF_PROTECTION=true',
      PDS_IMAGE,
    ]);
    docker([
      'run',
      '-d',
      '--name',
      tlsName,
      '--network',
      `container:${pdsName}`,
      '-v',
      `${dir}:/tls`,
      '-v',
      `${resolve(__dirname, 'pds-terminator.mjs')}:/terminator.mjs:ro`,
      '-e',
      `ATOMIC_PORT=${options.serverPort}`,
      '--entrypoint',
      'node',
      PDS_IMAGE,
      '/terminator.mjs',
    ]);
    const published = docker(['port', pdsName, '3000/tcp']).split('\n')[0];
    const url = `http://${published}`;

    const xrpc: Pds['xrpc'] = async (
      method,
      { params, body, post, token } = {},
    ) => {
      const query = params ? `?${new URLSearchParams(params)}` : '';
      const response = await fetch(`${url}/xrpc/${method}${query}`, {
        method: body === undefined && !post ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;

      try {
        parsed = JSON.parse(text);
      } catch {
        // Not JSON.
      }

      return { status: response.status, body: parsed };
    };

    const deadline = Date.now() + 90_000;

    for (;;) {
      try {
        if ((await fetch(`${url}/xrpc/_health`)).ok) break;
      } catch {
        // Starting.
      }

      if (Date.now() > deadline)
        throw new Error(`PDS did not start:\n${docker(['logs', pdsName])}`);
      await new Promise(done => setTimeout(done, 500));
    }

    return {
      url,
      xrpc,
      logs: () =>
        `${docker(['logs', pdsName])}\n--- terminator ---\n${docker(['logs', tlsName])}`,
      fetched: () =>
        docker(['logs', tlsName])
          .split('\n')
          .filter(line => /^(GET|HEAD|POST) /.test(line)),
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * An inter-service auth token (`createServiceJwt` in
 * `@atproto/xrpc-server`): the DID's `#atproto` key signs `iss`, `aud`,
 * `lxm` and the expiry, as a migrating client does for createAccount.
 */
export async function serviceJwt(
  key: Keypair,
  claims: { iss: string; aud: string; lxm: string },
) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ typ: 'JWT', alg: key.jwtAlg })}.${encode({
    iat: now,
    exp: now + 60,
    jti: randomBytes(16).toString('hex'),
    ...claims,
  })}`;
  const signature = await key.sign(new TextEncoder().encode(unsigned));

  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}
