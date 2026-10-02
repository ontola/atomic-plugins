// @wc-ignore-file
/**
 * Opt-in: the remoteStorage REST API test suite
 * (https://github.com/remotestorage/api-test-suite, Ruby/minitest) against
 * this plugin on atomic-server built with the `plugin-routes` feature at
 * `--plugin-routes read-write`.
 *
 * It installs the unchanged bundle in two drives (the second installation is
 * the suite's "other user"), gets the suite's three tokens through the real
 * OAuth flow and the host's consent page (Allow): `api-test:rw`,
 * `api-test:r` and `*:rw`. Then it runs the suite's `rake test` and compares
 * each test's outcome with KNOWN_FAILURES below, so a new failure and a newly
 * passing test both fail this spec (the README's table must follow).
 *
 * Skipped unless REMOTESTORAGE_API_SUITE names a checkout of the suite. The
 * suite pins Ruby 2.6/2.7 gems (json 1.8.6), so by default it runs in Docker
 * (`ruby:2.7-bullseye`, host network); REMOTESTORAGE_API_SUITE_RUBY=local runs
 * `bundle` from PATH instead:
 *
 *   git clone https://github.com/remotestorage/api-test-suite /tmp/rs-api-suite
 *   REMOTESTORAGE_API_SUITE=/tmp/rs-api-suite \
 *     node integrations/tooling/run-lane.mjs remotestorage --tier e2e
 */
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { before, newDrive } from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { installServer, LEVEL, ROUTES_ORIGIN } from './helpers';

const SUITE = process.env.REMOTESTORAGE_API_SUITE ?? '';
const RUBY = process.env.REMOTESTORAGE_API_SUITE_RUBY ?? 'docker';
const RUBY_IMAGE = 'ruby:2.7-bullseye';
const CATEGORY = 'api-test';

/**
 * Tests that fail at the pin, by "<describe> > <test>", with the reason.
 * Each one is explained in the README ("remoteStorage API test suite").
 */
const KNOWN_FAILURES: Record<string, string> = {
  'OPTIONS::GET > returns a valid response':
    "#167 §4: the server's global CORS layer answers every preflight, without Access-Control-Expose-Headers",
  'OPTIONS::PUT and DELETE > returns a valid response':
    "#167 §4: the server's global CORS layer answers every preflight, without Access-Control-Expose-Headers",
  'Requests::PUT with Content-Range > returns a 400':
    '#167 §4: the host does not pass Content-Range to the handler, so it stores the body',
  'Requests::GET a JSON object > works':
    "#167 §4: the server's Compress middleware gzips the response to Ruby's default Accept-Encoding, which drops Content-Length",
  'Requests::GET a JSON object while accepting compressed content > works':
    "#167 §4: the server's Compress middleware answers with Content-Encoding: br",
  'Requests::in a public folder::GET without a token > works':
    '#167 §3: the suite sends an empty Authorization header; an authOptional route treats any Authorization header as credentials (401)',
  'Requests::in a public folder::HEAD without a token > works':
    '#167 §3: the suite sends an empty Authorization header; an authOptional route treats any Authorization header as credentials (401)',
};

test.describe('remoteStorage API test suite', () => {
  test.skip(
    LEVEL !== 'read-write' || !ROUTES_ORIGIN,
    'run through run-lane.mjs, which starts atomic-server at --plugin-routes read-write with a routes origin',
  );
  test.skip(
    !SUITE,
    'opt-in: set REMOTESTORAGE_API_SUITE to a checkout of remotestorage/api-test-suite',
  );
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('passes except for the known host gaps', async ({ page }, testInfo) => {
    test.setTimeout(600_000);
    const main = await installServer(page, 'remoteStorage API suite');
    // The suite's "other user": the same plugin in another drive (a drive
    // installs a plugin once), so another origin with its own tokens.
    await newDrive(page);
    await enableIntegrationDiscovery(page);
    const other = await installServer(page, 'remoteStorage API suite (other)');

    // A page for the OAuth redirect to land on, on its own origin.
    const app = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>remoteStorage API suite</title>');
    });
    await new Promise<void>(done => app.listen(0, done));
    const APP = `http://rs-suite.localhost:${(app.address() as AddressInfo).port}/`;

    try {
      const token = await authorize(page, main.origin, APP, `${CATEGORY}:rw`);
      const readOnly = await authorize(page, main.origin, APP, `${CATEGORY}:r`);
      const root = await authorize(page, main.origin, APP, '*:rw');

      const dir = mkdtempSync(join(tmpdir(), 'rs-api-suite-'));
      cpSync(SUITE, dir, {
        recursive: true,
        filter: source => !source.includes('/.git'),
      });
      writeFileSync(
        join(dir, 'config.yml'),
        [
          `storage_base_url: ${main.origin}/storage`,
          `storage_base_url_other: ${other.origin}/storage`,
          `category: ${CATEGORY}`,
          `token: ${token}`,
          `read_only_token: ${readOnly}`,
          `root_token: ${root}`,
          '',
        ].join('\n'),
      );
      const output = runSuite(dir, [main.origin, other.origin]);
      await testInfo.attach('api-test-suite.txt', {
        body: output,
        contentType: 'text/plain',
      });
      const results = parseResults(output);
      await testInfo.attach('api-test-suite.json', {
        body: JSON.stringify(results, null, 2),
        contentType: 'application/json',
      });
      console.log(
        `remoteStorage API test suite: ${results.filter(r => r.outcome === 'PASS').length} of ${results.length} passed`,
      );
      for (const r of results) console.log(`  ${r.outcome} ${r.name}`);

      // Every test the suite has ran: 53 at its 2022-02-11 commit 55cc9a2.
      expect(results.length, output).toBeGreaterThanOrEqual(53);
      const failing = results
        .filter(r => r.outcome !== 'PASS')
        .map(r => r.name)
        .sort();
      expect(failing, output).toEqual(Object.keys(KNOWN_FAILURES).sort());

      // The two compression failures are the host's: without Accept-Encoding
      // the plugin's own headers are what the suite asks for, and with it the
      // Compress middleware rewrites the body and drops Content-Length.
      const doc = `${main.origin}/storage/${CATEGORY}/encoding-check.json`;
      const body = JSON.stringify({ compressible: 'x'.repeat(200) });
      const put = await raw(
        'PUT',
        doc,
        {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
        body,
      );
      expect(put.status).toBe(201);
      const identity = await raw('GET', doc, {
        authorization: `Bearer ${token}`,
      });
      expect(identity).toMatchObject({
        status: 200,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'cache-control': 'no-cache',
          etag: put.headers.etag,
        },
      });
      expect(identity.headers['content-encoding']).toBeUndefined();
      const gzip = await raw('GET', doc, {
        authorization: `Bearer ${token}`,
        'accept-encoding': 'gzip',
      });
      expect(gzip.headers['content-encoding']).toBe('gzip');
      expect(gzip.headers['content-length']).toBeUndefined();
      await raw('DELETE', doc, { authorization: `Bearer ${token}` });
    } finally {
      app.close();
    }
  });
});

/**
 * The implicit grant as an app starts it: the storage's OAuth endpoint, the
 * host's consent page (Allow), and the token in the redirect fragment.
 */
async function authorize(
  page: Page,
  origin: string,
  redirect: string,
  scope: string,
) {
  const url = new URL(`${origin}/oauth`);
  url.searchParams.set('redirect_uri', redirect);
  url.searchParams.set('client_id', new URL(redirect).origin);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('scope', scope);
  url.searchParams.set('state', 'api-suite');
  await page.goto(url.href);
  await page.waitForURL(/\/app\/route-consent\?request=/, { timeout: 30_000 });
  await expect(page.getByText(scope)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.waitForURL(`${redirect}**`, { timeout: 30_000 });
  const fragment = new URLSearchParams(new URL(page.url()).hash.slice(1));
  const token = fragment.get('access_token') ?? '';
  expect(token).toMatch(/^atr_/);

  return token;
}

/**
 * One request with exactly these headers (no Accept-Encoding unless given),
 * to loopback with the routes origin's Host.
 */
function raw(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: string,
) {
  const target = new URL(url);

  return new Promise<{ status: number; headers: IncomingHttpHeaders }>(
    (done, fail) => {
      const req = request(
        {
          method,
          host: '127.0.0.1',
          port: target.port,
          path: target.pathname,
          headers: { ...headers, host: target.host },
        },
        res => {
          res.resume();
          res.on('end', () =>
            done({ status: res.statusCode ?? 0, headers: res.headers }),
          );
        },
      );
      req.on('error', fail);
      req.end(body);
    },
  );
}

/** Runs `rake test` in `dir`; returns its combined output. */
function runSuite(dir: string, origins: string[]) {
  const script = 'bundle install --quiet && bundle exec rake test';
  const result =
    RUBY === 'local'
      ? spawnSync('sh', ['-c', script], { cwd: dir, encoding: 'utf8' })
      : spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--network',
            'host',
            // Ruby's resolver does not map *.localhost to loopback.
            ...origins.flatMap(o => [
              '--add-host',
              `${new URL(o).hostname}:127.0.0.1`,
            ]),
            '-v',
            `${dir}:/suite`,
            // The gems, kept between runs (the image's GEM_HOME).
            '-v',
            'atomic-plugins-rs-api-suite-gems:/usr/local/bundle',
            '-w',
            '/suite',
            RUBY_IMAGE,
            'sh',
            '-c',
            script,
          ],
          { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
        );
  if (result.error) throw result.error;

  return `${result.stdout}\n${result.stderr}`;
}

type Result = { name: string; outcome: string };

/**
 * minitest-reporters' SpecReporter: a describe path on its own line, then
 * `  test_0001_<name>   PASS (0.01s)` per test.
 */
function parseResults(output: string): Result[] {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;]*m/g, '').split('\n');
  const results: Result[] = [];
  let group = '';

  for (const line of lines) {
    const outcome = /^\s+test_\d+_(.+?)\s+(PASS|FAIL|ERROR|SKIP) \(/.exec(line);

    if (outcome) {
      results.push({ name: `${group} > ${outcome[1]}`, outcome: outcome[2] });
      continue;
    }

    // Every describe in the suite is nested (`Requests::GET a JSON object`).
    if (/^\S[^:]*::/.test(line)) group = line.trim();
  }

  return results;
}
