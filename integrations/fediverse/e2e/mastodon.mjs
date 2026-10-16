// @wc-ignore-file
/**
 * A real Mastodon server in Docker, as the remote side of the opt-in
 * interoperability e2e (`mastodon.spec.ts`).
 *
 * Mastodon only talks HTTPS to other servers (WebFinger is always
 * `https://<domain>/.well-known/webfinger`), and atomic-server in the lanes
 * serves plain http. So both sit behind one TLS proxy (`startProxy` in
 * `stack.mjs`, shared with `akkoma.mjs`), run in this process on `127.0.0.1:<port>` with a certificate from a throwaway
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
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  docker,
  issueCertificate,
  request,
  startProxy,
  until,
} from './stack.mjs';

export { issueCertificate, request } from './stack.mjs';

/** The image the e2e ran against; override with FEDIVERSE_MASTODON_IMAGE. */
export const DEFAULT_IMAGE = 'ghcr.io/mastodon/mastodon:v4.7.3';
const POSTGRES = 'postgres:17-alpine';
const REDIS = 'redis:7-alpine';

export const MASTODON_HOST = 'mastodon.localhost';

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
    proxy = await startProxy({
      key,
      cert,
      port,
      atomicPort,
      log,
      routes: {
        [MASTODON_HOST]: {
          label: 'mastodon',
          port: webPort,
          headers: {
            'x-forwarded-proto': 'https',
            'x-forwarded-for': '127.0.0.1',
          },
        },
      },
    });

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
