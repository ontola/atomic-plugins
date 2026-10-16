// @wc-ignore-file
/**
 * Bluesky's reference identity code, pointed at the loopback test host.
 *
 * `@atproto/identity`'s resolvers build their own URLs: the handle at
 * `https://<handle>/.well-known/atproto-did`, a did:web document at
 * `https://<host>/.well-known/did.json`, both on port 443. A PDS or AppView
 * fetches them with the package's default fetch, `safeFetchWrap` from
 * `@atproto-labs/fetch-node`. This module wraps that same function with the
 * same options as the package's `createDefaultFetch` (no IP hosts, no
 * custom ports, no plain http, explicit redirect mode, the forbidden-domain
 * list, the 512 kB and 10 s limits), with two changes the loopback needs:
 *
 * - `allowPrivateIps: true`, because the host is 127.0.0.1. Production
 *   refuses private addresses at connect time;
 * - the request leaves through an undici Agent whose connector dials a TLS
 *   terminator on 127.0.0.1 instead of `<name>:443`, sending the original
 *   name as SNI. So the URL, Host header and certificate check are the ones
 *   production sees; only the socket's destination differs. The terminator
 *   forwards to atomic-server's port with that name in `Host`, which is how
 *   the rest of the spec reaches bound host names.
 *
 * The certificate is a wildcard for the spec's invented domain, issued by a
 * throwaway CA made with `openssl` in the OS temporary directory, which only
 * this module's Agent trusts (the server never needs to: the plugin makes
 * no outbound calls). Nothing here contacts DNS or any other machine:
 * `LoopbackHandleResolver` turns off the DNS TXT method, which on these
 * invented names would ask public DNS, and the plugin does not publish TXT
 * records anyway.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFetchWrap } from '@atproto-labs/fetch-node';
import { DidResolver, HandleResolver } from '@atproto/identity';
import { Agent, buildConnector, fetch as undiciFetch } from 'undici';

/** One request the reference resolver made, as the terminator saw it. */
export type Seen = { method: string; host: string; path: string };

export type Reference = {
  handles: HandleResolver;
  dids: DidResolver;
  /** Every request that reached the terminator, in order. */
  seen: Seen[];
  close(): Promise<void>;
};

/**
 * A test CA and a `*.<domain>` (plus `<domain>`) certificate it issued,
 * as PEM strings. The key material stays in memory once read.
 */
export function issueCertificate(domain: string) {
  const dir = mkdtempSync(join(tmpdir(), 'atproto-reference-'));
  const at = (name: string) => join(dir, name);
  const run = (args: string[]) =>
    execFileSync('openssl', args, { stdio: 'ignore' });

  try {
    writeFileSync(
      at('ca.cnf'),
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
    );
    writeFileSync(
      at('leaf.cnf'),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:*.${domain},DNS:${domain}\n`,
    );
    run([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      at('ca.key'),
      '-subj',
      '/CN=atproto e2e test CA',
      '-out',
      at('ca.csr'),
    ]);
    run([
      'x509',
      '-req',
      '-in',
      at('ca.csr'),
      '-signkey',
      at('ca.key'),
      '-days',
      '1',
      '-extfile',
      at('ca.cnf'),
      '-out',
      at('ca.pem'),
    ]);
    run([
      'req',
      '-new',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      at('leaf.key'),
      '-subj',
      `/CN=*.${domain}`,
      '-out',
      at('leaf.csr'),
    ]);
    run([
      'x509',
      '-req',
      '-in',
      at('leaf.csr'),
      '-CA',
      at('ca.pem'),
      '-CAkey',
      at('ca.key'),
      '-CAcreateserial',
      '-days',
      '1',
      '-extfile',
      at('leaf.cnf'),
      '-out',
      at('leaf.pem'),
    ]);

    return {
      ca: readFileSync(at('ca.pem'), 'utf8'),
      cert: readFileSync(at('leaf.pem'), 'utf8'),
      key: readFileSync(at('leaf.key'), 'utf8'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The package's handle resolver without its DNS TXT method (see above). */
export class LoopbackHandleResolver extends HandleResolver {
  override async resolveDns() {
    return undefined;
  }
}

/**
 * Starts the TLS terminator for `domain` in front of atomic-server at
 * `serverPort` and returns the reference resolvers wired to it.
 */
export async function startReference(
  domain: string,
  serverPort: number,
): Promise<Reference> {
  const { ca, cert, key } = issueCertificate(domain);
  const seen: Seen[] = [];
  const terminator: Server = createServer({ cert, key }, (req, res) => {
    const host = String(req.headers.host ?? '');
    seen.push({ method: req.method ?? '', host, path: req.url ?? '' });
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: serverPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${host}:${serverPort}` },
        // No pooled keep-alive connection (see `send` in the spec).
        agent: false,
      },
      answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });
  await new Promise<void>(done =>
    terminator.listen(0, '127.0.0.1', () => done()),
  );
  const tlsPort = (terminator.address() as AddressInfo).port;

  const connector = buildConnector({ ca });
  const agent = new Agent({
    connect: (options, callback) =>
      connector(
        {
          ...options,
          hostname: '127.0.0.1',
          port: String(tlsPort),
          servername: options.hostname,
        },
        callback,
      ),
  });

  /**
   * What `safeFetchWrap` calls once its checks pass. It hands over a
   * `Request` of Node's built-in undici plus its own dispatcher; this
   * re-issues the request through the package's undici with the loopback
   * Agent instead. Only GET/HEAD are needed (identity resolution).
   */
  const loopbackFetch = (async (
    input: Request | URL | string,
    init?: RequestInit,
  ) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await undiciFetch(request.url, {
      method: request.method,
      headers: [...request.headers],
      redirect: init?.redirect ?? request.redirect,
      signal: init?.signal ?? request.signal,
      dispatcher: agent,
    });

    return new Response(await response.arrayBuffer(), {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
    });
  }) as typeof globalThis.fetch;

  // createDefaultFetch's options, plus private IPs (the loopback).
  const fetch = safeFetchWrap({
    fetch: loopbackFetch,
    allowIpHost: false,
    allowImplicitRedirect: false,
    allowPrivateIps: true,
  });

  return {
    handles: new LoopbackHandleResolver({ fetch }),
    // A PLC directory URL that is never dialed: the spec resolves did:web only.
    dids: new DidResolver({ fetch, plcUrl: 'https://plc.invalid' }),
    seen,
    close: async () => {
      await agent.close();
      await new Promise(done => terminator.close(done));
    },
  };
}
