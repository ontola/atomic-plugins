// @wc-ignore-file
/**
 * Runs inside the `worker-atproto-tls-*` container, which shares the
 * reference PDS container's network namespace (`pds.ts`). The PDS sees the
 * spec's invented host names at 127.0.0.1 (`--add-host`), so its
 * `https://<handle>/.well-known/...` requests land here, on port 443 of its
 * own namespace. This answers them with the test CA's wildcard certificate
 * and forwards each request over a Unix socket the spec bind-mounts in
 * (`/tls/atomic.sock`), which the spec relays to atomic-server on the host's
 * loopback. No port is published and nothing leaves the machine.
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';

const port = process.env.ATOMIC_PORT;
createServer(
  {
    cert: readFileSync('/tls/cert.pem'),
    key: readFileSync('/tls/key.pem'),
  },
  (req, res) => {
    const host = String(req.headers.host ?? '').replace(/:443$/, '');
    console.log(`${req.method} ${host}${req.url}`);
    const upstream = request(
      {
        socketPath: '/tls/atomic.sock',
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${host}:${port}` },
      },
      answer => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  },
).listen(443, '127.0.0.1', () => console.log('listening'));
