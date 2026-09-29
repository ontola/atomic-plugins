// @wc-ignore-file
/**
 * A minimal Open Cloud Mesh 1.5 peer for the real-host e2e: the "sending
 * server" side, written from the specification (cs3org/OCM-API v1.5.0,
 * IETF-OCM.md) independently of atomic-server's Rust implementation.
 *
 * It serves `/.well-known/ocm` (with `http-sig` and a `jwksUri`), its JWK
 * Set, and one file over WebDAV `GET` behind a bearer `sharedSecret`. It
 * sends Share Creation Notifications signed with RFC 9421 (`tag="ocm"`,
 * covering `@method`, `@target-uri`, `content-digest` and
 * `content-length`), and verifies the notifications it receives the way
 * the specification's appendix B describes: the signer's domain from
 * `senderDomain`, its discovery, its `jwksUri`, the JWK with the `kid`.
 *
 * Plain http on 127.0.0.1 (OCM's "testing setups" fallback). Not a WebDAV
 * server: no PROPFIND, only the one `GET`. Invented data only.
 */
import {
  createHash,
  generateKeyPairSync,
  sign,
  verify,
  createPublicKey,
} from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';

const b64 = bytes => Buffer.from(bytes).toString('base64');

/** `sha-256=:<base64>:` (RFC 9530). */
export const contentDigest = body =>
  `sha-256=:${b64(createHash('sha256').update(body).digest())}:`;

/**
 * The signature base and headers for an RFC 9421 OCM signature of a
 * request with a body (OCM 1.5 "Signing Requirements").
 */
export function signatureBase({ method, url, digest, length, params }) {
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@target-uri": ${url}`,
    `"content-digest": ${digest}`,
    `"content-length": ${length}`,
    `"@signature-params": ${params}`,
  ].join('\n');
}

export function signOcm({ privateKey, keyId, method, url, body, created }) {
  const digest = contentDigest(body);
  const length = Buffer.byteLength(body);
  const params = `("@method" "@target-uri" "content-digest" "content-length");created=${created};keyid="${keyId}";alg="ed25519";tag="ocm"`;
  const signature = sign(
    null,
    Buffer.from(signatureBase({ method, url, digest, length, params })),
    privateKey,
  );

  return {
    'content-digest': digest,
    'content-length': String(length),
    'signature-input': `sig1=${params}`,
    signature: `sig1=:${b64(signature)}:`,
  };
}

/** Parses `label=(<components>);params` members (enough for OCM). */
export function parseSignatureInput(value) {
  const members = [];
  const re =
    /([a-z*][a-z0-9_.*-]*)=(\([^)]*\)((?:;[a-z*][a-z0-9_.*-]*=(?:"(?:[^"\\]|\\.)*"|[^;,\s]+))*))/g;
  let m;

  while ((m = re.exec(value))) {
    const params = {};

    for (const p of m[3].split(';').slice(1)) {
      const at = p.indexOf('=');
      const raw = p.slice(at + 1);
      params[p.slice(0, at)] = raw.startsWith('"')
        ? raw.slice(1, -1)
        : Number(raw);
    }

    const components = [
      ...m[2].slice(1, m[2].indexOf(')')).matchAll(/"([^"]+)"/g),
    ].map(c => c[1]);
    members.push({ label: m[1], serialized: m[2], components, params });
  }

  return members;
}

/**
 * Verifies an OCM-signed request the receiver's way. `fetchJson(url)` is how
 * discovery and the JWK Set are fetched. Returns the signer's domain.
 */
export async function verifyOcm({
  method,
  url,
  headers,
  body,
  fetchJson,
  now = Date.now(),
}) {
  const inputs = parseSignatureInput(headers['signature-input'] ?? '');
  const ocm = inputs.filter(i => i.params.tag === 'ocm');
  if (ocm.length !== 1)
    throw new Error(`expected one tag="ocm" signature, got ${ocm.length}`);
  const [input] = ocm;
  for (const c of [
    '@method',
    '@target-uri',
    'content-digest',
    'content-length',
  ])
    if (!input.components.includes(c))
      throw new Error(`signature does not cover ${c}`);
  if (Math.abs(now / 1000 - input.params.created) > 300)
    throw new Error('stale signature');
  if (headers['content-digest'] !== contentDigest(body))
    throw new Error('content-digest mismatch');
  if (Number(headers['content-length']) !== Buffer.byteLength(body))
    throw new Error('content-length mismatch');
  const signerDomain = JSON.parse(body.toString()).senderDomain;
  const discovery = await fetchJson(`http://${signerDomain}/.well-known/ocm`);
  if (!discovery.capabilities?.includes('http-sig') || !discovery.jwksUri)
    throw new Error('the signer does not advertise http-sig with a jwksUri');
  const set = await fetchJson(discovery.jwksUri);
  const jwk = set.keys.find(k => k.kid === input.params.keyid);
  if (!jwk) throw new Error(`no JWK with kid ${input.params.keyid}`);
  if (jwk.alg !== 'Ed25519') throw new Error(`unexpected JWK alg ${jwk.alg}`);
  const signature = new RegExp(`${input.label}=:([^:]+):`).exec(
    headers.signature ?? '',
  )?.[1];
  if (!signature) throw new Error('no Signature for the OCM label');
  const values = {
    '@method': method.toUpperCase(),
    '@target-uri': url,
    'content-digest': headers['content-digest'],
    'content-length': headers['content-length'],
  };
  const base = [
    ...input.components.map(c => `"${c}": ${values[c] ?? headers[c]}`),
    `"@signature-params": ${input.serialized}`,
  ].join('\n');
  const key = createPublicKey({
    key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x },
    format: 'jwk',
  });
  if (!verify(null, Buffer.from(base), key, Buffer.from(signature, 'base64')))
    throw new Error('the signature does not verify');

  return { domain: signerDomain, keyId: input.params.keyid, discovery };
}

/**
 * GET/POST over plain http to `url`, connecting to 127.0.0.1 whatever the
 * host name (`*.routes.localhost` needs no DNS this way), with the URL's
 * host in `Host`.
 */
export function send(url, { method = 'GET', headers = {}, body } = {}) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: target.port || 80,
        method,
        path: target.pathname + target.search,
        headers: { host: target.host, ...headers },
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export const fetchJson = async url => {
  const res = await send(url, { headers: { accept: 'application/json' } });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}`);

  return JSON.parse(res.body.toString());
};

/**
 * Starts the peer on 127.0.0.1:`port` (0 for any). `files` maps a WebDAV
 * path under `/dav/` to `{ body, type, secret }`.
 */
export async function startPeer({ port = 0, files = {} } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const received = [];
  let origin;
  let domain;
  const keyId = () => `${domain}#peer-key`;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const entry = {
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      };
      received.push(entry);

      const json = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };

      if (req.method === 'GET' && req.url === '/.well-known/ocm')
        return json(200, {
          enabled: true,
          apiVersion: '1.5.0',
          endPoint: `${origin}/ocm`,
          provider: 'OCM peer fixture',
          resourceTypes: [
            {
              name: 'file',
              shareTypes: ['user'],
              protocols: { webdav: '/dav/' },
            },
          ],
          capabilities: ['http-sig', 'notifications'],
          jwksUri: `${origin}/ocm/jwks`,
        });
      if (req.method === 'GET' && req.url === '/ocm/jwks')
        return json(200, {
          keys: [
            {
              ...publicKey.export({ format: 'jwk' }),
              alg: 'Ed25519',
              use: 'sig',
              kid: keyId(),
            },
          ],
        });

      if (req.method === 'GET' && req.url.startsWith('/dav/')) {
        const file = files[req.url.slice('/dav/'.length)];
        if (!file) return json(404, { message: 'no such file' });
        if (req.headers.authorization !== `Bearer ${file.secret}`)
          return json(401, { message: 'wrong or missing secret' });
        res.writeHead(200, { 'content-type': file.type });

        return res.end(file.body);
      }

      if (req.method === 'POST' && req.url === '/ocm/notifications') {
        try {
          entry.verified = await verifyOcm({
            method: 'POST',
            url: `${origin}/ocm/notifications`,
            headers: req.headers,
            body,
            fetchJson,
          });
        } catch (error) {
          entry.refused = error.message;

          return json(401, { message: error.message });
        }

        return json(201, {});
      }

      json(404, { message: 'not found' });
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();
  domain = `127.0.0.1:${address.port}`;
  origin = `http://${domain}`;

  return {
    origin,
    domain,
    received,
    keyId,
    /** POSTs `share` to a receiver's shares endpoint, OCM-signed. */
    async sendShare(sharesUrl, share) {
      const body = JSON.stringify(share);
      const signed = signOcm({
        privateKey,
        keyId: keyId(),
        method: 'POST',
        url: sharesUrl,
        body,
        created: Math.floor(Date.now() / 1000),
      });
      const res = await send(sharesUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signed },
        body,
      });

      return { status: res.status, body: res.body.toString() };
    },
    /** POSTs a notification, OCM-signed. */
    async sendNotification(notificationsUrl, notification) {
      return this.sendShare(notificationsUrl, notification);
    },
    close: () => new Promise(resolve => server.close(resolve)),
  };
}
