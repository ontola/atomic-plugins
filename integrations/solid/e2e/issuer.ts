// @wc-ignore-file
/**
 * A test Solid-OIDC issuer and DPoP client for the Solid lane's e2e. Not an
 * identity provider: there is no login, consent or token endpoint. It
 * serves exactly what a resource server fetches to verify a token —
 * `/.well-known/openid-configuration`, `/jwks` and WebID profiles at
 * `/<name>/profile/card` — and mints DPoP-bound access tokens in process,
 * the way an issuer would after a client-credentials grant. Keys are fresh
 * ES256 pairs per run; every identity is invented.
 *
 * The signing key stays the same for a whole Playwright run when
 * `startIssuer` gets a `keyFile`: a retry runs in a new worker, which starts
 * this issuer again on the same origin, while the lane's atomic-server keeps
 * the JWKS it fetched for that issuer and refetches it for an unknown `kid`
 * at most once a minute (`JWKS_REFETCH_MS` in its `route_dpop.rs`). A real
 * issuer does not rotate its key between two of a client's requests, so a
 * fresh key per attempt failed every retry with 401 "no key of the issuer
 * has this `kid`" (CI run 37057638058, 2026-10-02).
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

  constructor(privateKey?: KeyObject) {
    this.privateKey =
      privateKey ??
      generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const { kty, crv, x, y } = createPublicKey(this.privateKey).export({
      format: 'jwk',
    }) as Jwk;
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

/**
 * The issuer's signing key and its `kid`: read from `keyFile` if an earlier
 * attempt of this run wrote it, else made and written there.
 */
function signingKey(keyFile?: string): { signing: Es256; kid: string } {
  if (keyFile && existsSync(keyFile)) {
    const { pkcs8, kid } = JSON.parse(readFileSync(keyFile, 'utf8')) as {
      pkcs8: string;
      kid: string;
    };

    return { signing: new Es256(createPrivateKey(pkcs8)), kid };
  }

  const signing = new Es256();
  const kid = `test-${randomUUID()}`;

  if (keyFile) {
    const pkcs8 = signing.privateKey.export({ format: 'pem', type: 'pkcs8' });
    writeFileSync(keyFile, JSON.stringify({ pkcs8, kid }), { mode: 0o600 });
  }

  return { signing, kid };
}

/**
 * Listens on `origin` (`http://127.0.0.1:<port>`) until closed. `keyFile`
 * keeps the signing key across the attempts of one run (see above); pass a
 * path that is new for each run.
 */
export async function startIssuer(
  origin: string,
  keyFile?: string,
): Promise<TestIssuer> {
  const url = new URL(origin);
  const issuer = url.origin;
  const { signing, kid } = signingKey(keyFile);
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
