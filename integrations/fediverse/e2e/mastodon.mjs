// @wc-ignore-file
/**
 * A real Mastodon server in Docker, as the remote side of the opt-in
 * interoperability e2e (`mastodon.spec.ts`).
 *
 * Mastodon only talks HTTPS to other servers (WebFinger is always
 * `https://<domain>/.well-known/webfinger`), and atomic-server in the lanes
 * serves plain http. So both sit behind one TLS proxy (`startProxy`), run
 * in this process on `127.0.0.1:<port>` with a certificate from a throwaway
 * test CA for `mastodon.localhost` and the drive host's name. It routes on
 * the `Host` name: Mastodon's to Puma (with `X-Forwarded-Proto: https`),
 * anything else to atomic-server, `Host` unchanged. It logs every request
 * it forwards (method, host, path, the headers that matter for federation
 * and small JSON bodies), which `traffic()` returns.
 *
 * Mastodon, PostgreSQL and Redis run from the official images on the host
 * network, every listener on 127.0.0.1 only, on ports in the 199xx range;
 * no volumes. On the host network because a host firewall may drop traffic
 * from Docker bridge networks to the host (the build VPS's does), and
 * atomic-server and the proxy are on the host. Mastodon trusts only the
 * test CA (`SSL_CERT_FILE`), is told loopback is allowed
 * (`ALLOWED_PRIVATE_ADDRESSES`), and finds the drive host through
 * `/etc/hosts` (`--add-host`).
 *
 * The test CA certificate is written to the lane's
 * `ATOMIC_PLUGIN_E2E_PEER_CA` path, which the debug-build seam makes
 * atomic-server trust for loopback peers, so the server reaches Mastodon at
 * `https://mastodon.localhost:<port>` (`*.localhost` resolves to
 * loopback). Invented accounts only; nothing listens on a public address;
 * `stop()` removes every container and closes the proxy.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
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

/** The image the e2e ran against; override with FEDIVERSE_MASTODON_IMAGE. */
export const DEFAULT_IMAGE = 'ghcr.io/mastodon/mastodon:v4.7.3';
const POSTGRES = 'postgres:17-alpine';
const REDIS = 'redis:7-alpine';

export const MASTODON_HOST = 'mastodon.localhost';

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

const docker = (args, options = {}) =>
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
  const dir = mkdtempSync(join(tmpdir(), 'fediverse-mastodon-ca-'));
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
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', at('ca.key'), '-out', at('ca.csr'), '-subj', '/CN=fediverse Mastodon e2e test CA']);
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
 * The TLS proxy on `127.0.0.1:<port>`: the Mastodon name to `webPort`,
 * anything else to atomic-server on `atomicPort`. Resolves once listening.
 */
async function startProxy({ key, cert, port, webPort, atomicPort, log }) {
  const server = https.createServer({ key, cert }, (req, res) => {
    const host = String(req.headers.host ?? '');
    const toMastodon = host.split(':')[0] === MASTODON_HOST;
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };

      if (toMastodon) {
        headers['x-forwarded-proto'] = 'https';
        headers['x-forwarded-for'] = '127.0.0.1';
      }

      const entry = {
        at: new Date().toISOString(),
        to: toMastodon ? 'mastodon' : 'atomic',
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
          port: toMastodon ? webPort : atomicPort,
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
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', done);
  });

  return server;
}

/**
 * Starts the stack and waits until Mastodon answers `/health` through the
 * proxy. `atomicHost` is the drive host name (no port) the plugin's actor
 * lives on; `atomicPort` is atomic-server's port on this machine.
 */
export async function startMastodon({
  atomicHost,
  atomicPort,
  caPath,
  port = 19943,
  webPort = port - 13,
  dbPort = port - 11,
  redisPort = port - 4,
  image = process.env.FEDIVERSE_MASTODON_IMAGE || DEFAULT_IMAGE,
  name = process.env.FEDIVERSE_MASTODON_NAME || 'fediverse-e2e-mastodon',
  timeoutMs = 600_000,
}) {
  const origin = `https://${MASTODON_HOST}:${port}`;
  const domain = `${MASTODON_HOST}:${port}`;
  const containers = ['sidekiq', 'web', 'redis', 'db'].map(c => `${name}-${c}`);
  const dir = mkdtempSync(join(tmpdir(), 'fediverse-mastodon-'));
  const log = [];
  let proxy;

  const removeContainers = () =>
    spawnSync('docker', ['rm', '--force', '--volumes', ...containers], {
      stdio: 'ignore',
    });

  const stop = () => {
    proxy?.closeAllConnections();
    proxy?.close();
    removeContainers();
    rmSync(dir, { recursive: true, force: true });
  };

  // A stack a previous run left behind (FEDIVERSE_MASTODON_KEEP).
  removeContainers();

  try {
    const { ca, key, cert } = issueCertificate(caPath, [
      MASTODON_HOST,
      atomicHost,
    ]);
    writeFileSync(join(dir, 'ca.pem'), ca);
    chmodSync(join(dir, 'ca.pem'), 0o644);
    chmodSync(dir, 0o755);
    proxy = await startProxy({ key, cert, port, webPort, atomicPort, log });

    const common = ['--detach', '--network', 'host', '--label', name];
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-db`, '--shm-size', '256m', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES, '-c', 'listen_addresses=127.0.0.1', '-c', `port=${dbPort}`]);
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-redis`, REDIS, 'redis-server', '--bind', '127.0.0.1', '--port', String(redisPort), '--save', '', '--appendonly', 'no']);

    const secret = () => randomBytes(64).toString('hex');
    const env = {
      RAILS_ENV: 'production',
      NODE_ENV: 'production',
      LOCAL_DOMAIN: domain,
      LOCAL_HTTPS: 'true',
      DB_HOST: '127.0.0.1',
      DB_PORT: String(dbPort),
      DB_USER: 'postgres',
      DB_NAME: 'mastodon',
      DB_PASS: '',
      REDIS_HOST: '127.0.0.1',
      REDIS_PORT: String(redisPort),
      ES_ENABLED: 'false',
      SECRET_KEY_BASE: secret(),
      OTP_SECRET: secret(),
      ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY: secret().slice(0, 32),
      ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT: secret().slice(0, 32),
      ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY: secret().slice(0, 32),
      // Loopback: the drive host and the proxy are there.
      ALLOWED_PRIVATE_ADDRESSES: '127.0.0.1/32,::1/128',
      SSL_CERT_FILE: '/tls/ca.pem',
      WEB_CONCURRENCY: '0',
      MAX_THREADS: '5',
      BIND: '127.0.0.1',
      PORT: String(webPort),
      SMTP_DELIVERY_METHOD: 'test',
    };
    const mastodonArgs = [
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      '--add-host',
      `${atomicHost}:127.0.0.1`,
      '--add-host',
      `${MASTODON_HOST}:127.0.0.1`,
      '--volume',
      `${dir}:/tls:ro`,
    ];

    await until(
      () =>
        spawnSync('docker', [
          'exec',
          `${name}-db`,
          'pg_isready',
          '-h',
          '127.0.0.1',
          '-p',
          String(dbPort),
          '-U',
          'postgres',
        ]).status === 0,
      'PostgreSQL',
      60_000,
    );
    // prettier-ignore
    docker(['run', '--rm', '--network', 'host', ...mastodonArgs, image, 'bundle', 'exec', 'rails', 'db:setup'], { stdio: 'pipe' });
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-web`, ...mastodonArgs, image, 'bundle', 'exec', 'puma', '-C', 'config/puma.rb']);
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-sidekiq`, ...mastodonArgs, image, 'bundle', 'exec', 'sidekiq']);

    const call = (method, path, { token, body, headers = {} } = {}) =>
      request(ca, port, `${origin}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    await until(
      async () =>
        (await call('GET', '/health').catch(() => undefined))?.status === 200,
      `Mastodon at ${origin}`,
      timeoutMs,
      () => docker(['logs', '--tail', '30', `${name}-web`], { stdio: 'pipe' }),
    );
    const instance = JSON.parse((await call('GET', '/api/v2/instance')).body);

    return {
      origin,
      domain,
      image,
      version: instance.version,
      ca,
      stop,
      call,
      /** Every request the proxy forwarded, oldest first. */
      traffic: () => [...log],
      /** Mastodon's own logs (web and Sidekiq), for diagnosing a failure. */
      logs(lines = 80) {
        return ['web', 'sidekiq']
          .map(c => {
            const out = spawnSync(
              'docker',
              ['logs', '--tail', String(lines), `${name}-${c}`],
              { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
            );

            return `--- ${c}\n${out.stdout}${out.stderr}`;
          })
          .join('\n');
      },
      /**
       * Creates a confirmed, approved local account with an invented
       * address and returns an OAuth token for it (scopes read, write,
       * follow), made directly in Rails: no browser OAuth flow.
       */
      addUser(username) {
        const ruby = `
          account = Account.new(username: ${JSON.stringify(username)})
          user = User.new(email: ${JSON.stringify(`${username}@invented.example`)}, password: SecureRandom.hex, agreement: true, confirmed_at: Time.now.utc, bypass_registration_checks: true, account: account)
          # The address is invented: skip the MX lookup of the validations.
          user.save!(validate: false)
          user.approve!
          app = Doorkeeper::Application.create!(name: 'fediverse-e2e', redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', scopes: 'read write follow')
          token = Doorkeeper::AccessToken.create!(application: app, resource_owner_id: user.id, scopes: 'read write follow')
          puts "TOKEN=#{token.token}"
        `;
        const out = docker(
          ['exec', `${name}-web`, 'bundle', 'exec', 'rails', 'runner', ruby],
          { stdio: 'pipe' },
        );
        const token = /TOKEN=(\S+)/.exec(out)?.[1];
        if (!token) throw new Error(`no token:\n${out}`);

        return token;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

async function until(check, what, timeoutMs, explain = () => '') {
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
