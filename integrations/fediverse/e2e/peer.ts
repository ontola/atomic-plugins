// @wc-ignore-file
/**
 * A minimal ActivityPub peer for the Fediverse e2e: one actor (`bob`) on an
 * HTTPS server on this machine, standing in for a Mastodon instance. Not a
 * fediverse server; only what the e2e needs, all of it checked:
 *
 * - It serves bob's actor document with a real RSA public key, a personal
 *   inbox and a shared inbox at `/inbox` (what Mastodon publishes).
 * - `send()` POSTs an activity to the Atomic actor's inbox, signed the way
 *   Mastodon signs (draft-cavage-12, rsa-sha256 over `(request-target) host
 *   date digest content-type`).
 * - Its inboxes record every delivery and verify it: the `Digest` against
 *   the body, the `Date` within 5 minutes, and the signature against the
 *   key the Atomic actor document publishes under the signature's `keyId`
 *   (fetched from the Atomic server, not taken from the request).
 *
 * The certificate is self-signed, made with `openssl` at start: the host
 * only reaches it through atomic-server's debug-build e2e seam
 * (ATOMIC_PLUGIN_E2E_LOOPBACK_PEERS), which lets deliveries and key fetches
 * reach loopback and accept an unverifiable certificate there.
 */
import { execFileSync } from 'node:child_process';
import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Delivery {
  path: string;
  activity: Record<string, unknown>;
  keyId: string;
  /** Digest, date and signature all checked. */
  verified: boolean;
  problem?: string;
}

export interface Peer {
  origin: string;
  actor: string;
  keyId: string;
  sharedInbox: string;
  deliveries: Delivery[];
  send(
    inboxUrl: string,
    activity: Record<string, unknown>,
    options?: { keyId?: string; tamper?: boolean },
  ): Promise<{ status: number; body: string }>;
  close(): Promise<void>;
}

/**
 * A request to the Atomic server's drive host. The drive host is a
 * `*.localhost` name the operating system may not resolve, so this connects
 * to 127.0.0.1 and sends the name as `Host`, which is all atomic-server
 * routes on.
 */
export function atomicRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: target.port,
        method: init.method ?? 'GET',
        path: target.pathname + target.search,
        headers: { host: target.host, ...(init.headers ?? {}) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

function selfSignedCertificate() {
  const dir = mkdtempSync(join(tmpdir(), 'fediverse-peer-'));

  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    );

    return {
      key: readFileSync(join(dir, 'key.pem')),
      cert: readFileSync(join(dir, 'cert.pem')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const digestOf = (body: string) =>
  `SHA-256=${createHash('sha256').update(body).digest('base64')}`;

function parseSignature(header: string) {
  const out: Record<string, string> = {};

  for (const m of header.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];

  return out;
}

async function verifyDelivery(
  req: http.IncomingMessage,
  body: string,
): Promise<{ keyId: string; verified: boolean; problem?: string }> {
  const sig = parseSignature(String(req.headers.signature ?? ''));
  const keyId = sig.keyId ?? '';
  const fail = (problem: string) => ({ keyId, verified: false, problem });
  if (!keyId || !sig.headers || !sig.signature) return fail('no signature');
  if (req.headers.digest !== digestOf(body)) return fail('digest mismatch');
  const date = Date.parse(String(req.headers.date ?? ''));
  if (!(Math.abs(Date.now() - date) < 5 * 60_000)) return fail('stale date');
  const covered = sig.headers.split(' ');
  for (const needed of ['(request-target)', 'host', 'date', 'digest'])
    if (!covered.includes(needed)) return fail(`${needed} not signed`);
  // The key comes from the Atomic actor document, never from the request.
  const doc = await atomicRequest(keyId.split('#')[0], {
    headers: { accept: 'application/activity+json' },
  });
  if (doc.status !== 200) return fail(`actor answered ${doc.status}`);
  const key = JSON.parse(doc.body).publicKey;
  if (key?.id !== keyId) return fail('keyId not in the actor document');
  const signed = covered
    .map(name =>
      name === '(request-target)'
        ? `(request-target): ${req.method!.toLowerCase()} ${req.url}`
        : `${name}: ${req.headers[name]}`,
    )
    .join('\n');
  const ok = createVerify('RSA-SHA256')
    .update(signed)
    .verify(key.publicKeyPem, sig.signature, 'base64');

  return ok ? { keyId, verified: true } : fail('bad signature');
}

export async function startPeer(): Promise<Peer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });
  const deliveries: Delivery[] = [];
  let origin = '';
  const actorPath = '/users/bob';

  const server = https.createServer(selfSignedCertificate(), (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/activity+json' });
        res.end(value === undefined ? '' : JSON.stringify(value));
      };

      if (req.method === 'GET' && req.url === actorPath) {
        return send(200, {
          '@context': [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1',
          ],
          id: `${origin}${actorPath}`,
          type: 'Person',
          preferredUsername: 'bob',
          inbox: `${origin}${actorPath}/inbox`,
          outbox: `${origin}${actorPath}/outbox`,
          endpoints: { sharedInbox: `${origin}/inbox` },
          publicKey: {
            id: `${origin}${actorPath}#main-key`,
            owner: `${origin}${actorPath}`,
            publicKeyPem,
          },
        });
      }

      if (
        req.method === 'POST' &&
        (req.url === '/inbox' || req.url === `${actorPath}/inbox`)
      ) {
        let activity: Record<string, unknown> = {};

        try {
          activity = JSON.parse(body);
        } catch {
          return send(400);
        }
        const check = await verifyDelivery(req, body).catch(e => ({
          keyId: '',
          verified: false,
          problem: String(e),
        }));
        deliveries.push({ path: req.url, activity, ...check });

        return send(check.verified ? 202 : 401);
      }

      send(404);
    });
  });

  await new Promise<void>(done => server.listen(0, done));
  const { port } = server.address() as { port: number };
  origin = `https://localhost:${port}`;
  const actor = `${origin}${actorPath}`;
  const keyId = `${actor}#main-key`;

  return {
    origin,
    actor,
    keyId,
    sharedInbox: `${origin}/inbox`,
    deliveries,
    async send(inboxUrl, activity, options = {}) {
      const target = new URL(inboxUrl);
      const body = JSON.stringify(activity);
      const headers: Record<string, string> = {
        host: target.host,
        date: new Date().toUTCString(),
        digest: digestOf(body),
        'content-type': 'application/activity+json',
      };
      const covered = ['(request-target)', 'host', 'date', 'digest', 'content-type'];
      const signed = covered
        .map(name =>
          name === '(request-target)'
            ? `(request-target): post ${target.pathname}`
            : `${name}: ${headers[name]}`,
        )
        .join('\n');
      const signature = createSign('RSA-SHA256')
        .update(signed)
        .sign(privateKey, 'base64');
      headers.signature = `keyId="${options.keyId ?? keyId}",algorithm="rsa-sha256",headers="${covered.join(' ')}",signature="${signature}"`;
      const sent = await atomicRequest(inboxUrl, {
        method: 'POST',
        headers,
        // A tampered body no longer matches the signed digest.
        body: options.tamper ? body.replace('}', ',"x":1}') : body,
      });

      return { status: sent.status, body: sent.body };
    },
    close: () =>
      new Promise<void>(done => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

/** Waits until `find` returns something, polling every 250 ms. */
export async function waitFor<T>(
  find: () => T | undefined | Promise<T | undefined>,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const until = Date.now() + timeoutMs;

  for (;;) {
    const found = await find();
    if (found !== undefined) return found;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise(done => setTimeout(done, 250));
  }
}

export const writeTemp = (name: string, text: string) => {
  const path = join(tmpdir(), name);
  writeFileSync(path, text);

  return path;
};
