// The e2e peer's own RFC 9421 code, against itself and a live loopback
// round trip: what it signs, it verifies; what is changed, it refuses. The
// real-host lane then checks it against atomic-server in both directions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  signOcm,
  verifyOcm,
  parseSignatureInput,
  startPeer,
  send,
  fetchJson,
} from './e2e/peer.mjs';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  alg: 'Ed25519',
  kid: 'signer.test#k',
};
const docs = {
  'http://signer.test/.well-known/ocm': {
    capabilities: ['http-sig'],
    jwksUri: 'http://signer.test/jwks',
  },
  'http://signer.test/jwks': { keys: [jwk] },
};
const fetchDocs = async url => docs[url];
const body = JSON.stringify({
  notificationType: 'SHARE_ACCEPTED',
  senderDomain: 'signer.test',
});
const url = 'http://peer.test/ocm/notifications';
const signed = () =>
  signOcm({
    privateKey,
    keyId: 'signer.test#k',
    method: 'POST',
    url,
    body,
    created: Math.floor(Date.now() / 1000),
  });

test('an OCM signature verifies, and a changed request does not', async () => {
  const headers = signed();
  const ok = await verifyOcm({
    method: 'POST',
    url,
    headers,
    body: Buffer.from(body),
    fetchJson: fetchDocs,
  });
  assert.equal(ok.domain, 'signer.test');
  await assert.rejects(
    verifyOcm({
      method: 'POST',
      url: url + '?x',
      headers,
      body: Buffer.from(body),
      fetchJson: fetchDocs,
    }),
    /does not verify/,
  );
  await assert.rejects(
    verifyOcm({
      method: 'POST',
      url,
      headers,
      body: Buffer.from(body + ' '),
      fetchJson: fetchDocs,
    }),
    /content-digest/,
  );
  const untagged = {
    ...headers,
    'signature-input': headers['signature-input'].replace(';tag="ocm"', ''),
  };
  await assert.rejects(
    verifyOcm({
      method: 'POST',
      url,
      headers: untagged,
      body: Buffer.from(body),
      fetchJson: fetchDocs,
    }),
    /one tag="ocm"/,
  );
});

test('signature inputs parse the way atomic-server serializes them', () => {
  const [input] = parseSignatureInput(
    'sig1=("@method" "@target-uri" "content-digest" "content-length");created=1700000000;keyid="x.routes.localhost:1#ocm-key";alg="ed25519";tag="ocm"',
  );
  assert.deepEqual(input.components, [
    '@method',
    '@target-uri',
    'content-digest',
    'content-length',
  ]);
  assert.deepEqual(input.params, {
    created: 1700000000,
    keyid: 'x.routes.localhost:1#ocm-key',
    alg: 'ed25519',
    tag: 'ocm',
  });
});

test('the peer serves discovery, its JWK Set and a secret-guarded file', async () => {
  const peer = await startPeer({
    files: {
      'spec.txt': {
        body: 'invented file',
        type: 'text/plain',
        secret: 'invented',
      },
    },
  });

  try {
    const discovery = await fetchJson(`${peer.origin}/.well-known/ocm`);
    assert.equal(discovery.apiVersion, '1.5.0');
    assert.equal(discovery.jwksUri, `${peer.origin}/ocm/jwks`);
    const set = await fetchJson(discovery.jwksUri);
    assert.equal(set.keys[0].kid, `${peer.domain}#peer-key`);
    assert.equal((await send(`${peer.origin}/dav/spec.txt`)).status, 401);
    const file = await send(`${peer.origin}/dav/spec.txt`, {
      headers: { authorization: 'Bearer invented' },
    });
    assert.equal(file.status, 200);
    assert.equal(file.body.toString(), 'invented file');
  } finally {
    await peer.close();
  }
});
