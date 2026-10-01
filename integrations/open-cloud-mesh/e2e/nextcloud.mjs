// @wc-ignore-file
/**
 * A real Nextcloud server in Docker, as the sending side of an Open Cloud
 * Mesh share, for the opt-in interoperability e2e (`nextcloud.spec.ts`).
 *
 * The official `nextcloud` image (Apache), on the host network so that it
 * reaches atomic-server's `*.routes.localhost` origin on loopback, with
 * Apache listening on `127.0.0.1:<port>` only and serving HTTPS with a
 * certificate from the same throwaway test CA as the invented peer
 * (`peer.mjs` `issueCertificate`), which the lane's
 * `ATOMIC_PLUGIN_E2E_PEER_CA` seam makes the server trust for loopback.
 * SQLite, no volumes: the container and its data are removed by `stop()`.
 * Invented users and files only; nothing listens on a public address.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { issueCertificate } from './peer.mjs';

/** The image the e2e ran against; override with OCM_NEXTCLOUD_IMAGE. */
export const DEFAULT_IMAGE = 'nextcloud:35.0.1-apache';

const docker = (args, options = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', ...options });

/**
 * Starts Nextcloud on `https://localhost:<port>` and waits until it is
 * installed. Returns helpers to run `occ`, call its OCS API as a user, and
 * stop it.
 */
export async function startNextcloud({
  port = 18443,
  image = process.env.OCM_NEXTCLOUD_IMAGE || DEFAULT_IMAGE,
  name = `ocm-e2e-nextcloud-${port}`,
  timeoutMs = 300_000,
} = {}) {
  const { ca, key, cert } = issueCertificate();
  const dir = mkdtempSync(join(tmpdir(), 'ocm-nextcloud-'));
  writeFileSync(join(dir, 'cert.pem'), cert);
  writeFileSync(join(dir, 'key.pem'), key);
  writeFileSync(join(dir, 'ports.conf'), `Listen 127.0.0.1:${port}\n`);
  writeFileSync(
    join(dir, 'site.conf'),
    [
      `<VirtualHost 127.0.0.1:${port}>`,
      '  DocumentRoot /var/www/html',
      '  SSLEngine on',
      '  SSLCertificateFile /ocm-tls/cert.pem',
      '  SSLCertificateKeyFile /ocm-tls/key.pem',
      '</VirtualHost>',
      '',
    ].join('\n'),
  );
  // The container's Apache runs as www-data and must read the key.
  for (const file of ['cert.pem', 'key.pem', 'ports.conf', 'site.conf'])
    chmodSync(join(dir, file), 0o644);
  chmodSync(dir, 0o755);

  const origin = `https://localhost:${port}`;
  const adminPassword = `invented-${randomBytes(9).toString('hex')}`;
  spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--network',
    'host',
    '--env',
    'SQLITE_DATABASE=nextcloud',
    '--env',
    'NEXTCLOUD_ADMIN_USER=admin',
    '--env',
    `NEXTCLOUD_ADMIN_PASSWORD=${adminPassword}`,
    '--env',
    `NEXTCLOUD_TRUSTED_DOMAINS=localhost:${port}`,
    '--env',
    `OVERWRITECLIURL=${origin}`,
    '--env',
    'OVERWRITEPROTOCOL=https',
    '--env',
    `OVERWRITEHOST=localhost:${port}`,
    '--volume',
    `${dir}:/ocm-tls:ro`,
    '--volume',
    `${join(dir, 'ports.conf')}:/etc/apache2/ports.conf:ro`,
    '--volume',
    `${join(dir, 'site.conf')}:/etc/apache2/sites-enabled/000-default.conf:ro`,
    image,
    'sh',
    '-c',
    'a2enmod ssl >/dev/null && exec /entrypoint.sh apache2-foreground',
  ]);

  const occ = (...args) =>
    docker(['exec', '--user', 'www-data', name, 'php', 'occ', ...args]);

  const stop = () => {
    spawnSync('docker', ['rm', '--force', name], { stdio: 'ignore' });
    rmSync(dir, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      const status = await request(ca, `${origin}/status.php`).catch(
        () => undefined,
      );
      if (status?.status === 200 && JSON.parse(status.body).installed) break;
      if (Date.now() > deadline)
        throw new Error(
          `Nextcloud did not come up at ${origin}:\n${docker(['logs', '--tail', '40', name], { stdio: 'pipe' })}`,
        );
      await new Promise(r => setTimeout(r, 2000));
    }

    // The receiver is on loopback (`*.routes.localhost`), which Nextcloud
    // refuses to contact unless told otherwise.
    occ(
      'config:system:set',
      'allow_local_remote_servers',
      '--value=true',
      '--type=boolean',
    );
    // Debug level: Nextcloud logs a refused OCM POST only there.
    occ('config:system:set', 'loglevel', '--value=0', '--type=integer');
    const version = JSON.parse(
      (await request(ca, `${origin}/status.php`)).body,
    ).versionstring;

    return {
      origin,
      domain: `localhost:${port}`,
      name,
      version,
      image,
      ca,
      occ,
      stop,
      /** Creates an invented user with a password. */
      addUser(user, displayName) {
        const password = `invented-${randomBytes(9).toString('hex')}`;
        docker(
          [
            'exec',
            '--user',
            'www-data',
            '--env',
            `OC_PASS=${password}`,
            name,
            'php',
            'occ',
            'user:add',
            '--password-from-env',
            `--display-name=${displayName}`,
            user,
          ],
          { stdio: 'pipe' },
        );

        return password;
      },
      /** Uploads a file into a user's home over WebDAV. */
      async upload(user, password, path, body) {
        return request(ca, `${origin}/remote.php/dav/files/${user}/${path}`, {
          method: 'PUT',
          headers: { authorization: basic(user, password) },
          body,
        });
      },
      /** The OCS Share API, as a user (`format=json`). */
      async ocs(user, password, method, path, form) {
        const body = form ? new URLSearchParams(form).toString() : undefined;

        return request(
          ca,
          `${origin}/ocs/v2.php${path}${path.includes('?') ? '&' : '?'}format=json`,
          {
            method,
            headers: {
              authorization: basic(user, password),
              'ocs-apirequest': 'true',
              ...(body
                ? { 'content-type': 'application/x-www-form-urlencoded' }
                : {}),
            },
            body,
          },
        );
      },
      /**
       * Nextcloud's last log entries (debug level), one line each: level,
       * message and exception message, for diagnosing a refused share.
       */
      log(lines = 5000) {
        const raw = spawnSync(
          'docker',
          [
            'exec',
            name,
            'tail',
            '-n',
            String(lines),
            '/var/www/html/data/nextcloud.log',
          ],
          // Debug-level lines are long; the default 1 MiB cuts them off.
          { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
        ).stdout;

        return (raw ?? '')
          .split('\n')
          .filter(
            line =>
              line &&
              /ocm|shar|federat|signature|Client error|discover/i.test(line),
          )
          .filter(line => !line.includes('dirty table reads'))
          .slice(-30)
          .map(line => {
            try {
              const entry = JSON.parse(line);
              const exception = entry.exception?.Message;

              return `[${entry.level}] ${entry.message}${exception && exception !== entry.message ? ` | ${exception}` : ''}`.slice(
                0,
                600,
              );
            } catch {
              return line.slice(0, 600);
            }
          })
          .join('\n');
      },
    };
  } catch (error) {
    stop();
    throw error;
  }
}

const basic = (user, password) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/** An HTTPS request that trusts only the test CA. */
export function request(ca, url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        ca,
        headers: body
          ? { ...headers, 'content-length': Buffer.byteLength(body) }
          : headers,
        timeout: 30_000,
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
