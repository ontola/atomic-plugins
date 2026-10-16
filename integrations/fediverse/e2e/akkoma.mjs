// @wc-ignore-file
/**
 * A real Akkoma server in Docker, as the remote side of the opt-in
 * interoperability e2e (`akkoma.spec.ts`).
 *
 * Akkoma publishes no current container image (the `akkoma/akkoma` images
 * on Docker Hub stopped in 2024; its Docker guide builds one from source).
 * Its official binary distribution is the OTP release zip, so this runs that
 * release (`DEFAULT_RELEASE`, the `stable` musl build for this machine's
 * architecture, downloaded at start; `FEDIVERSE_AKKOMA_RELEASE` names
 * another URL or a local zip) on the official `alpine:3.22` image, with
 * PostgreSQL from `postgres:17-alpine`. Both on the host network, every
 * listener on 127.0.0.1 only, on ports in the 199xx range; no volumes; Erlang
 * distribution off (`RELEASE_DISTRIBUTION=none`), so no epmd either.
 *
 * Like Mastodon, Akkoma does WebFinger and delivery over HTTPS only, so it
 * and atomic-server sit behind the shared TLS proxy (`startProxy` in
 * `stack.mjs`) on `127.0.0.1:<port>`, with a certificate from a throwaway
 * test CA for `akkoma.localhost` and the drive host's name. Akkoma's HTTP
 * client trusts the operating system's CA bundle
 * (`:public_key.cacerts_get()`), which the container replaces with the test
 * CA after installing its packages; it finds the drive host through
 * `/etc/hosts` (`--add-host`). Akkoma refuses requests whose `Host` is not
 * exactly `akkoma.localhost:<port>`, which the proxy passes through.
 *
 * The test CA certificate is written to the lane's
 * `ATOMIC_PLUGIN_E2E_PEER_CA` path, which the debug-build seam makes
 * atomic-server trust for loopback peers. Accounts are invented and made
 * through Akkoma's own registration API (open registration, no captcha, no
 * e-mail confirmation: this instance lives only for the test). `stop()`
 * removes every container and closes the proxy.
 */
import { spawnSync } from 'node:child_process';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  docker,
  issueCertificate,
  request,
  startProxy,
  until,
} from './stack.mjs';

const FLAVOUR = process.arch === 'arm64' ? 'arm64-musl' : 'amd64-musl';

/**
 * The release the e2e ran against is whatever `stable` was then (the
 * README records the version and the zip's SHA-256); override with
 * FEDIVERSE_AKKOMA_RELEASE (a URL, or a path to a zip).
 */
export const DEFAULT_RELEASE = `https://akkoma-updates.s3-website.fr-par.scw.cloud/stable/akkoma-${FLAVOUR}.zip`;
export const DEFAULT_IMAGE = 'alpine:3.22';
const POSTGRES = 'postgres:17-alpine';

export const AKKOMA_HOST = 'akkoma.localhost';

/** The release zip at `source` (URL or path), copied to `to`. */
async function fetchRelease(source, to) {
  if (!/^https?:\/\//.test(source)) {
    copyFileSync(source, to);
  } else {
    const response = await fetch(source);
    if (!response.ok)
      throw new Error(
        `${source}: HTTP ${response.status} ${response.statusText}`,
      );
    writeFileSync(to, Buffer.from(await response.arrayBuffer()));
  }

  return createHash('sha256').update(readFileSync(to)).digest('hex');
}

const elixirString = value => JSON.stringify(String(value));

function configFor({ port, webPort, dbPort }) {
  const secret = n => randomBytes(n).toString('base64url').slice(0, n);
  const push = createECDH('prime256v1');
  push.generateKeys();

  return `import Config

config :pleroma, Pleroma.Web.Endpoint,
  url: [host: ${elixirString(AKKOMA_HOST)}, scheme: "https", port: ${port}],
  http: [ip: {127, 0, 0, 1}, port: ${webPort}],
  secret_key_base: ${elixirString(secret(64))},
  signing_salt: ${elixirString(secret(8))},
  live_view: [signing_salt: ${elixirString(secret(8))}]

config :pleroma, :instance,
  name: "Akkoma e2e",
  email: "admin@invented.example",
  notify_email: "admin@invented.example",
  registrations_open: true,
  account_activation_required: false,
  account_approval_required: false,
  healthcheck: true,
  federating: true,
  static_dir: "/var/lib/akkoma/static"

config :pleroma, Pleroma.Captcha, enabled: false
config :pleroma, Pleroma.Emails.Mailer, enabled: false

config :pleroma, Pleroma.Repo,
  adapter: Ecto.Adapters.Postgres,
  username: "postgres",
  password: "",
  database: "akkoma",
  hostname: "127.0.0.1",
  port: ${dbPort},
  pool_size: 10

config :pleroma, :database, rum_enabled: false
config :pleroma, Pleroma.Uploaders.Local, uploads: "/var/lib/akkoma/uploads"
config :pleroma, Pleroma.Upload, base_url: "https://${AKKOMA_HOST}:${port}/media/"

config :web_push_encryption, :vapid_details,
  subject: "mailto:admin@invented.example",
  public_key: ${elixirString(push.getPublicKey('base64url'))},
  private_key: ${elixirString(push.getPrivateKey('base64url'))}

# Akkoma fetches a new peer's NodeInfo from https://<host without port>/,
# which on a shared machine is whatever else listens on 127.0.0.1:443.
config :pleroma, :instances_nodeinfo, enabled: false

config :joken, default_signer: ${elixirString(secret(64))}

config :logger, :console, level: :info
`;
}

/**
 * Starts the stack and waits until Akkoma answers its healthcheck through
 * the proxy. `atomicHost` is the drive host name (no port) the plugin's
 * actor lives on; `atomicPort` is atomic-server's port on this machine.
 */
export async function startAkkoma({
  atomicHost,
  atomicPort,
  caPath,
  port = 19953,
  webPort = port - 3,
  dbPort = port - 2,
  release = process.env.FEDIVERSE_AKKOMA_RELEASE || DEFAULT_RELEASE,
  image = process.env.FEDIVERSE_AKKOMA_IMAGE || DEFAULT_IMAGE,
  name = process.env.FEDIVERSE_AKKOMA_NAME || 'fediverse-e2e-akkoma',
  timeoutMs = 600_000,
}) {
  const origin = `https://${AKKOMA_HOST}:${port}`;
  const domain = `${AKKOMA_HOST}:${port}`;
  const containers = ['web', 'db'].map(c => `${name}-${c}`);
  const dir = mkdtempSync(join(tmpdir(), 'fediverse-akkoma-'));
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

  // A stack a previous run left behind (FEDIVERSE_AKKOMA_KEEP).
  removeContainers();

  try {
    const { ca, key, cert } = issueCertificate(caPath, [
      AKKOMA_HOST,
      atomicHost,
    ]);
    mkdirSync(join(dir, 'tls'));
    mkdirSync(join(dir, 'etc'));
    mkdirSync(join(dir, 'release'));
    writeFileSync(join(dir, 'tls', 'ca.pem'), ca);
    // Akkoma refuses a config file with any world permission.
    writeFileSync(
      join(dir, 'etc', 'config.exs'),
      configFor({ port, webPort, dbPort }),
      { mode: 0o600 },
    );
    const sha256 = await fetchRelease(
      release,
      join(dir, 'release', 'akkoma.zip'),
    );
    for (const sub of ['', 'tls', 'release']) chmodSync(join(dir, sub), 0o755);
    chmodSync(join(dir, 'tls', 'ca.pem'), 0o644);
    chmodSync(join(dir, 'release', 'akkoma.zip'), 0o644);

    proxy = await startProxy({
      key,
      cert,
      port,
      atomicPort,
      log,
      routes: {
        [AKKOMA_HOST]: {
          label: 'akkoma',
          port: webPort,
          headers: { 'x-forwarded-proto': 'https' },
        },
      },
    });

    const common = ['--detach', '--network', 'host', '--label', name];
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-db`, '--shm-size', '256m', '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES, '-c', 'listen_addresses=127.0.0.1', '-c', `port=${dbPort}`]);
    const psql = sql =>
      spawnSync('docker', [
        'exec',
        `${name}-db`,
        'psql',
        '-h',
        '127.0.0.1',
        '-p',
        String(dbPort),
        '-U',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        ...sql.flatMap(s => ['-c', s]),
      ]);
    await until(() => psql(['SELECT 1']).status === 0, 'PostgreSQL', 60_000);
    // What Akkoma's setup_db.psql does, as the superuser it connects as.
    const created = psql(['CREATE DATABASE akkoma']);
    if (created.status !== 0) throw new Error(String(created.stderr));
    const extensions = spawnSync('docker', [
      'exec',
      `${name}-db`,
      'psql',
      '-h',
      '127.0.0.1',
      '-p',
      String(dbPort),
      '-U',
      'postgres',
      '-d',
      'akkoma',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      'CREATE EXTENSION citext; CREATE EXTENSION pg_trgm; CREATE EXTENSION "uuid-ossp";',
    ]);
    if (extensions.status !== 0) throw new Error(String(extensions.stderr));

    // Packages first (apk fetches over HTTPS with the stock CA bundle), then
    // the test CA becomes the only trusted root, then migrate and start.
    const script = [
      'set -e',
      'apk add --no-cache --quiet ncurses libstdc++ file-dev unzip',
      'unzip -q /akkoma/release/akkoma.zip -d /opt',
      'cp /akkoma/tls/ca.pem /etc/ssl/certs/ca-certificates.crt',
      'mkdir -p /var/lib/akkoma/uploads /var/lib/akkoma/static',
      '/opt/release/bin/pleroma_ctl migrate',
      'exec /opt/release/bin/pleroma start',
    ].join('\n');
    // prettier-ignore
    docker(['run', ...common, '--name', `${name}-web`,
      '--env', 'AKKOMA_CONFIG_PATH=/akkoma/etc/config.exs',
      '--env', 'RELEASE_DISTRIBUTION=none',
      '--env', 'ERL_EPMD_ADDRESS=127.0.0.1',
      '--add-host', `${atomicHost}:127.0.0.1`,
      '--add-host', `${AKKOMA_HOST}:127.0.0.1`,
      '--volume', `${dir}:/akkoma:ro`,
      image, 'sh', '-c', script]);

    const webLog = lines => {
      const out = spawnSync(
        'docker',
        ['logs', '--tail', String(lines), `${name}-web`],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );

      return `${out.stdout}${out.stderr}`;
    };

    const call = (method, path, { token, body, form, headers = {} } = {}) => {
      const encoded = form
        ? new URLSearchParams(form).toString()
        : body
          ? JSON.stringify(body)
          : undefined;

      return request(ca, port, `${origin}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(form
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : body
              ? { 'content-type': 'application/json' }
              : {}),
          ...headers,
        },
        body: encoded,
      });
    };

    const running = () =>
      docker(['inspect', '--format', '{{.State.Running}}', `${name}-web`], {
        stdio: 'pipe',
      }).trim() === 'true';
    await until(
      async () => {
        if (!running()) throw new Error(`Akkoma exited:\n${webLog(40)}`);

        return (
          (
            await call('GET', '/api/v1/pleroma/healthcheck').catch(
              () => undefined,
            )
          )?.status === 200
        );
      },
      `Akkoma at ${origin}`,
      timeoutMs,
      () => webLog(40),
    );
    const instance = JSON.parse((await call('GET', '/api/v1/instance')).body);
    const nodeinfo = JSON.parse(
      (await call('GET', '/nodeinfo/2.1.json')).body || '{}',
    );

    const json = async (method, path, options) => {
      const r = await call(method, path, options);
      if (r.status !== 200)
        throw new Error(`${method} ${path}: ${r.status} ${r.body}`);

      return JSON.parse(r.body);
    };

    return {
      origin,
      domain,
      image,
      release,
      sha256,
      version: instance.version,
      software: nodeinfo.software?.version,
      ca,
      stop,
      call,
      /** Every request the proxy forwarded, oldest first. */
      traffic: () => [...log],
      /** Akkoma's own log, for diagnosing a failure. */
      logs: (lines = 120) => `--- akkoma\n${webLog(lines)}`,
      /**
       * Registers a local account with an invented address through
       * Akkoma's own API and returns an OAuth token for it (scopes read,
       * write, follow).
       */
      async addUser(username) {
        const app = await json('POST', '/api/v1/apps', {
          form: {
            client_name: 'fediverse-e2e',
            redirect_uris: 'urn:ietf:wg:oauth:2.0:oob',
            scopes: 'read write follow',
          },
        });
        const appToken = await json('POST', '/oauth/token', {
          form: {
            grant_type: 'client_credentials',
            client_id: app.client_id,
            client_secret: app.client_secret,
            scope: 'read write follow',
          },
        });
        const account = await json('POST', '/api/v1/accounts', {
          token: appToken.access_token,
          form: {
            username,
            email: `${username}@invented.example`,
            password: randomBytes(16).toString('hex'),
            agreement: 'true',
            locale: 'en',
          },
        });
        if (!account.access_token)
          throw new Error(`no token: ${JSON.stringify(account)}`);

        return account.access_token;
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}
