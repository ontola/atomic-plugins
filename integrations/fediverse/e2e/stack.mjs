// @wc-ignore-file
/**
 * What the opt-in e2es against real fediverse servers share
 * (`mastodon.mjs`, `akkoma.mjs`): a throwaway test CA, the TLS proxy that
 * fronts both the server under test and atomic-server, an HTTPS client that
 * trusts only that CA, and a polling helper.
 *
 * Real servers talk only HTTPS to each other, and atomic-server in the
 * lanes serves plain http. So both sit behind one TLS proxy
 * (`startProxy`), run in this process on `127.0.0.1:<port>` with a
 * certificate from the test CA for every name involved. It routes on the
 * `Host` name (without the port): a name in `routes` to that local port,
 * anything else to atomic-server, `Host` unchanged and with
 * `X-Forwarded-Proto: https`. It logs every request it
 * forwards (method, host, path, the headers that matter for federation and
 * small JSON bodies).
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Request headers the proxy log keeps. */
const KEPT = [
  'accept',
  'content-type',
  'content-length',
  'date',
  'digest',
  'signature',
  'signature-input',
  'content-digest',
  'user-agent',
];

export const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });

/**
 * A throwaway CA and one certificate it issued for `names`, made with
 * `openssl`. The CA certificate is written to `caPath` (atomically: the
 * server reads it at each connection); its key never leaves the temporary
 * directory.
 */
export function issueCertificate(caPath, names) {
  const dir = mkdtempSync(join(tmpdir(), 'fediverse-e2e-ca-'));
  const at = name => join(dir, name);
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' });

  try {
    writeFileSync(
      at('ca.cnf'),
      'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n',
    );
    writeFileSync(
      at('leaf.cnf'),
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${names.map(n => `DNS:${n}`).join(',')},IP:127.0.0.1\n`,
    );
    // prettier-ignore
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('ca.key'), '-out', at('ca.csr'), '-subj', '/CN=fediverse e2e test CA']);
    // prettier-ignore
    run(['x509', '-req', '-in', at('ca.csr'), '-signkey', at('ca.key'), '-out', at('ca.pem'), '-days', '1', '-extfile', at('ca.cnf')]);
    // prettier-ignore
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('key.pem'), '-out', at('leaf.csr'), '-subj', `/CN=${names[0]}`]);
    // prettier-ignore
    run(['x509', '-req', '-in', at('leaf.csr'), '-CA', at('ca.pem'), '-CAkey', at('ca.key'), '-CAcreateserial', '-out', at('cert.pem'), '-days', '1', '-extfile', at('leaf.cnf')]);
    const ca = readFileSync(at('ca.pem'));
    mkdirSync(dirname(caPath), { recursive: true });
    const staged = `${caPath}.${process.pid}.tmp`;
    writeFileSync(staged, ca);
    renameSync(staged, caPath);

    return {
      ca,
      key: readFileSync(at('key.pem')),
      cert: readFileSync(at('cert.pem')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The TLS proxy on `127.0.0.1:<port>`. `routes` maps a host name (no port)
 * to `{ label, port, headers }`: requests for that name go to
 * `127.0.0.1:<port>` with `headers` added; anything else goes to
 * atomic-server on `atomicPort`, labelled `atomic`. Every forwarded request
 * is pushed to `log`. Resolves once listening.
 */
export async function startProxy({ key, cert, port, atomicPort, routes, log }) {
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host ?? '');
    const route = routes[host.split(':')[0]];
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      // atomic-server builds absolute URLs (host-meta's WebFinger
      // template) from the connection's scheme, so it is told what a
      // TLS-terminating reverse proxy would tell it.
      const headers = {
        ...req.headers,
        ...(route?.headers ?? { 'x-forwarded-proto': 'https' }),
      };

      const entry = {
        at: new Date().toISOString(),
        to: route?.label ?? 'atomic',
        method: req.method,
        host,
        path: req.url,
        headers: Object.fromEntries(
          KEPT.filter(n => req.headers[n] !== undefined).map(n => [
            n,
            String(req.headers[n]),
          ]),
        ),
        body:
          /json/.test(String(req.headers['content-type'] ?? '')) &&
          body.length < 65536
            ? body.toString('utf8') || undefined
            : undefined,
      };
      const up = http.request(
        {
          host: '127.0.0.1',
          port: route?.port ?? atomicPort,
          method: req.method,
          path: req.url,
          headers,
        },
        upRes => {
          const out = [];
          upRes.on('data', c => out.push(c));
          upRes.on('end', () => {
            const answer = Buffer.concat(out);
            log.push({
              ...entry,
              status: upRes.statusCode,
              responseType: upRes.headers['content-type'],
              ...(upRes.statusCode >= 400
                ? { response: answer.toString('utf8').slice(0, 2000) }
                : {}),
            });
            const back = { ...upRes.headers };
            delete back['transfer-encoding'];
            back['content-length'] = String(answer.length);
            res.writeHead(upRes.statusCode, back);
            res.end(answer);
          });
        },
      );
      up.on('error', error => {
        log.push({ ...entry, status: 502, error: String(error) });
        res.writeHead(502);
        res.end();
      });
      up.end(body);
    });
  });
  // A handshake that fails never reaches the handler; log it too.
  server.on('tlsClientError', (error, socket) =>
    log.push({
      at: new Date().toISOString(),
      to: 'tls',
      method: '',
      host: String(socket.servername ?? ''),
      path: '',
      headers: {},
      status: 0,
      error: String(error),
    }),
  );
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });

  return server;
}

/** Polls `check` every 2 s until it is truthy, or throws with `explain()`. */
export async function until(check, what, timeoutMs, explain = () => '') {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline)
      throw new Error(`${what} did not come up:\n${explain()}`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

/**
 * An HTTPS request to the proxy on 127.0.0.1:<port> that trusts only the
 * test CA (the name is still checked against the certificate).
 */
export function request(
  ca,
  port,
  url,
  { method = 'GET', headers = {}, body } = {},
) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        servername: target.hostname,
        method,
        path: target.pathname + target.search,
        ca,
        // A fresh connection each time: the proxy closes idle ones.
        agent: false,
        headers: {
          host: target.host,
          ...headers,
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        },
        timeout: 60_000,
      },
      res => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout: ${url}`)));
    req.on('error', reject);
    req.end(body);
  });
}
