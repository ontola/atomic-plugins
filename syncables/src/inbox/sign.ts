/**
 * Atomic request signatures, version 2 (ontola/atomic-plugins#54), for a
 * Node consumer of the integration proxy: what `integration-proxy`'s
 * `signature.rs` verifies. The signed message is five lines joined by `\n`:
 *
 * ```text
 * atomic-request-v2
 * {METHOD}
 * {full URL, including query}
 * {timestamp, Unix ms}
 * {sha-256 hex of the body}
 * ```
 *
 * Node only (`node:crypto`); the browser export does not include it.
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import type { Transport, TransportRequest } from '../read/transport.js';

/** PKCS#8 DER prefix of an Ed25519 private key; the 32-byte seed follows. */
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

export interface AtomicAgentKey {
  /** `atomic:agent:<public key, base64url>` */
  readonly agent: string;
  /** The public key, base64url without padding. */
  readonly publicKey: string;
  readonly privateKey: KeyObject;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** An agent key from its 32-byte Ed25519 seed (base64 or base64url). */
export function agentKeyFromSeed(seed: string): AtomicAgentKey {
  const bytes = Buffer.from(
    seed.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
  if (bytes.length !== 32) {
    throw new Error('an Ed25519 seed is 32 bytes');
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const publicKey = base64url(spki.subarray(spki.length - 32));
  return { agent: `atomic:agent:${publicKey}`, publicKey, privateKey };
}

export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** The exact message a v2 signature covers. */
export function v2Message(
  method: string,
  url: string,
  timestampMs: number,
  body: string,
): string {
  return [
    'atomic-request-v2',
    method.toUpperCase(),
    url,
    String(timestampMs),
    sha256Hex(body),
  ].join('\n');
}

/** The v2 headers for one request, signed by `key` at `timestampMs`. */
export function v2Headers(
  key: AtomicAgentKey,
  request: Pick<TransportRequest, 'method' | 'url' | 'body'>,
  timestampMs: number,
): Record<string, string> {
  const message = v2Message(
    request.method,
    request.url.href,
    timestampMs,
    request.body ?? '',
  );
  return {
    'x-atomic-agent': key.agent,
    'x-atomic-public-key': key.publicKey,
    'x-atomic-timestamp': String(timestampMs),
    'x-atomic-signature': base64url(
      sign(null, Buffer.from(message, 'utf8'), key.privateKey),
    ),
    'x-atomic-signature-version': '2',
  };
}

/**
 * A transport that signs every request with `key`. The proxy accepts each
 * signature once, so a retried request is signed again. Timestamps are kept
 * strictly increasing, so two identical requests in one millisecond still
 * differ.
 */
export function signedTransport(
  key: AtomicAgentKey,
  transport: Transport,
  now: () => number = Date.now,
): Transport {
  let last = 0;
  return (request) => {
    const timestampMs = Math.max(now(), last + 1);
    last = timestampMs;
    return transport({
      ...request,
      headers: { ...request.headers, ...v2Headers(key, request, timestampMs) },
    });
  };
}
