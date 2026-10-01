// @wc-ignore-file
/**
 * A test Solid-OIDC issuer and DPoP client for the Solid lane's e2e. Not an
 * identity provider: there is no login, consent or token endpoint. It
 * serves exactly what a resource server fetches to verify a token —
 * `/.well-known/openid-configuration`, `/jwks` and WebID profiles at
 * `/<name>/profile/card` — and mints DPoP-bound access tokens in process,
 * the way an issuer would after a client-credentials grant. Keys are fresh
 * ES256 pairs per run; every identity is invented.
 */
import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { createServer, type Server } from 'node:http';

const b64url = (data: Buffer | string) =>
  Buffer.from(data).toString('base64url');

interface Jwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
}

class Es256 {
  readonly privateKey: KeyObject;
  readonly jwk: Jwk;

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    this.privateKey = privateKey;
    const { kty, crv, x, y } = publicKey.export({ format: 'jwk' }) as Jwk;
    this.jwk = { kty, crv, x, y };
  }

  /** RFC 7638 thumbprint. */
  thumbprint() {
    const { crv, kty, x, y } = this.jwk;

    return b64url(
      createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest(),
    );
  }

  jwt(header: object, claims: object) {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = sign('sha256', Buffer.from(input), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    });

    return `${input}.${b64url(signature)}`;
  }
}

export interface TestIssuer {
  issuer: string;
  webid(name: string): string;
  /** A DPoP-bound fetch for `name`'s WebID, as a Solid client library uses it. */
  session(name: string, claims?: Record<string, unknown>): typeof fetch;
  /** Makes `name`'s profile name `storage` as its pim:storage. */
  setStorage(name: string, storage: string): void;
  close(): Promise<void>;
}

/** Listens on `origin` (`http://127.0.0.1:<port>`) until closed. */
export async function startIssuer(origin: string): Promise<TestIssuer> {
  const url = new URL(origin);
  const issuer = url.origin;
  const signing = new Es256();
  const kid = `test-${randomUUID()}`;
  const storages = new Map<string, string>();
  const webid = (name: string) => `${issuer}/${name}/profile/card#me`;

  const server: Server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', issuer).pathname;

    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (path === '/.well-known/openid-configuration')
      return json({
        issuer,
        jwks_uri: `${issuer}/jwks`,
        // Advertised for completeness; this fixture never serves them.
        token_endpoint: `${issuer}/token`,
        authorization_endpoint: `${issuer}/authorize`,
        dpop_signing_alg_values_supported: ['ES256'],
        scopes_supported: ['openid', 'webid'],
      });
    if (path === '/jwks')
      return json({
        keys: [{ ...signing.jwk, kid, alg: 'ES256', use: 'sig' }],
      });
    const profile = /^\/([a-z]+)\/profile\/card$/.exec(path);

    if (profile) {
      const storage = storages.get(profile[1]);
      res.writeHead(200, { 'content-type': 'text/turtle' });
      res.end(
        [
          '@prefix solid: <http://www.w3.org/ns/solid/terms#>.',
          '@prefix foaf: <http://xmlns.com/foaf/0.1/>.',
          '@prefix pim: <http://www.w3.org/ns/pim/space#>.',
          `<#me> a foaf:Person; foaf:name "${profile[1]}"; solid:oidcIssuer <${issuer}/>${storage ? `; pim:storage <${storage}>` : ''}.`,
        ].join('\n'),
      );

      return;
    }

    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(Number(url.port), url.hostname, () => resolve());
  });

  return {
    issuer,
    webid,
    setStorage: (name, storage) => storages.set(name, storage),
    session(name, claims = {}) {
      const dpop = new Es256();
      const now = Math.floor(Date.now() / 1000);
      const token = signing.jwt(
        { alg: 'ES256', typ: 'at+jwt', kid },
        {
          iss: issuer,
          aud: ['solid', 'https://app.example/solid-e2e'],
          sub: name,
          webid: webid(name),
          client_id: 'https://app.example/solid-e2e',
          iat: now,
          exp: now + 600,
          jti: randomUUID(),
          cnf: { jkt: dpop.thumbprint() },
          ...claims,
        },
      );
      const ath = b64url(createHash('sha256').update(token).digest());

      return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const target = new URL(
          typeof input === 'string' || input instanceof URL ? input : input.url,
        );
        const method = (init.method ?? 'GET').toUpperCase();
        const proof = dpop.jwt(
          { typ: 'dpop+jwt', alg: 'ES256', jwk: dpop.jwk },
          {
            htm: method,
            htu: `${target.origin}${target.pathname}`,
            iat: Math.floor(Date.now() / 1000),
            jti: randomUUID(),
            ath,
          },
        );
        const headers = new Headers(init.headers);
        headers.set('authorization', `DPoP ${token}`);
        headers.set('dpop', proof);

        return fetch(input, { ...init, headers });
      }) as typeof fetch;
    },
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}
