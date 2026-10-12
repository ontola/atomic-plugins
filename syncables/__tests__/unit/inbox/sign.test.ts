import { readFileSync } from 'node:fs';
import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  agentKeyFromSeed,
  sha256Hex,
  signedTransport,
  v2Headers,
  v2Message,
} from '../../../src/inbox/sign.js';
import type { TransportRequest } from '../../../src/read/transport.js';

// atomic-server's golden v2 vectors (lib/src/authentication_v2_vectors.json
// at 0fa9c07856de, the candidate20 pin), the same copy integration-proxy
// verifies in signature::tests: what this signer produces, the proxy accepts.
const vectors = JSON.parse(
  readFileSync(
    new URL('../../fixtures/atomic-request-v2-vectors.json', import.meta.url),
    'utf8',
  ),
) as {
  vectors: {
    name: string;
    private_key: string;
    public_key: string;
    agent: string;
    method: string;
    url: string;
    timestamp: number;
    body: string;
    body_sha256_hex: string;
    message: string;
    signature: string;
  }[];
};

describe('Atomic v2 request signatures', () => {
  it.each(vectors.vectors.map((v) => [v.name, v]))(
    'reproduces the golden vector %s',
    (_, vector) => {
      const key = agentKeyFromSeed(vector.private_key);
      expect(key.publicKey).toBe(vector.public_key);
      expect(key.agent).toBe(vector.agent);
      expect(sha256Hex(vector.body)).toBe(vector.body_sha256_hex);
      expect(
        v2Message(vector.method, vector.url, vector.timestamp, vector.body),
      ).toBe(vector.message);
      const headers = v2Headers(
        key,
        {
          method: vector.method.toUpperCase() as TransportRequest['method'],
          url: new URL(vector.url),
          body: vector.body,
        },
        vector.timestamp,
      );
      expect(headers['x-atomic-signature']).toBe(vector.signature);
      expect(headers['x-atomic-signature-version']).toBe('2');
      expect(headers['x-atomic-timestamp']).toBe(String(vector.timestamp));
    },
  );

  it('signs every request anew, with strictly increasing timestamps', async () => {
    const key = agentKeyFromSeed('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    const seen: Record<string, string>[] = [];
    const transport = signedTransport(
      key,
      async (request) => {
        seen.push(request.headers);
        return { status: 200, headers: {}, body: '' };
      },
      () => 1_790_000_000_000,
    );
    const request: TransportRequest = {
      method: 'GET',
      url: new URL('https://proxy.example/subscriptions/s/events?wait=20'),
      headers: {},
    };
    await transport(request);
    await transport(request);
    expect(seen[0]['x-atomic-timestamp']).toBe('1790000000000');
    expect(seen[1]['x-atomic-timestamp']).toBe('1790000000001');
    // Each verifies over its own message.
    const publicKey = createPublicKey(key.privateKey);
    for (const headers of seen) {
      const message = v2Message(
        'GET',
        request.url.href,
        Number(headers['x-atomic-timestamp']),
        '',
      );
      expect(
        verify(
          null,
          Buffer.from(message),
          publicKey,
          Buffer.from(headers['x-atomic-signature'], 'base64url'),
        ),
      ).toBe(true);
    }
  });

  it('refuses a seed that is not 32 bytes', () => {
    expect(() => agentKeyFromSeed('AAAA')).toThrow();
  });
});
