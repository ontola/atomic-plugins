// Installed-tarball smoke test. Invented loopback issuer only; no live grants.
/* global process, URL, URLSearchParams, AbortSignal, fetch, setTimeout, console */
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const database = process.env.SYNCABLES_TEST_DATABASE_URL;
if (!database || !process.argv[2])
  throw new Error(
    'Supply a tarball and SYNCABLES_TEST_DATABASE_URL (disposable local database)',
  );
const tarball = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), 'syncables-installed-'));
const owner = 'invented-smoke-' + randomUUID();
const children = [];
async function port() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  return address.port;
}
async function waitUntil(check) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Smoke test timed out');
    await new Promise((done) => setTimeout(done, 25));
  }
}
const issuer = 'http://127.0.0.1:' + (await port());
function launch(command, args, env) {
  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  let errors = '';
  let approving = false;
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    errors += chunk;
    const code = errors.match(/Enter code: (\S+)/)?.[1];
    if (code && !approving) {
      approving = true;
      // Only this invented loopback issuer gets automatic approval.
      void fetch(issuer + '/approve', {
        method: 'POST',
        body: new URLSearchParams({ code }),
        signal: AbortSignal.timeout(2000),
      }).catch(() => child.kill());
    }
  });
  const closed = new Promise((done, reject) => {
    child.on('error', reject);
    child.on('close', (code) => done(code));
  });
  return { child, output: () => output, closed };
}
let cleanup;
try {
  await writeFile(
    join(directory, 'package.json'),
    '{"private":true,"type":"module"}\n',
  );
  await exec(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: directory },
  );
  const cli = join(directory, 'node_modules/syncables/build/src/cli/main.js');
  const mock = launch(
    process.execPath,
    [resolve('examples/cli-device-server.mjs')],
    {
      ...process.env,
      SYNCABLES_MOCK_PORT: new URL(issuer).port,
      SYNCABLES_MOCK_OWNER: owner,
    },
  );
  await waitUntil(() => mock.output().includes('Mock only:'));
  const config = JSON.parse(
    await readFile('examples/daemon/config.demo.json', 'utf8'),
  );
  config.owner = owner;
  config.issuer = issuer;
  config.dataDirectory = join(directory, 'data.git');
  config.webhookPort = await port();
  config.collections[0].document = resolve(
    '__tests__/fixtures/daemon-smoke-api.json',
  );
  config.collections[0].pollSeconds = 0;
  const file = join(directory, 'config.json');
  await writeFile(file, JSON.stringify(config));
  const env = {
    ...process.env,
    SYNCABLES_DATABASE_URL: database,
    SYNCABLES_WEBHOOK_TOKEN: 'invented-local-webhook-smoke-secret',
  };
  async function run(args) {
    const task = launch(
      process.execPath,
      [cli, ...args, '--config', file],
      env,
    );
    assert.equal(await task.closed, 0, 'CLI command failed: ' + args[0]);
    return JSON.parse(task.output());
  }
  const synced = await run([
    'sync',
    '--interactive',
    '--message',
    'Capture a baseline\nReview schema α before proceeding',
  ]);
  const commit = synced[0].result.revision;
  assert.match(commit, /^[a-f0-9]{64}$/);
  assert.equal(synced[0].result.records, 1);
  const daemon = launch(
    process.execPath,
    [cli, 'daemon', '--interactive', '--config', file],
    env,
  );
  await waitUntil(() => daemon.output().includes('"running"'));
  const endpoint =
    'http://127.0.0.1:' +
    config.webhookPort +
    '/webhooks/github-issues%2Fexample%2Ftasks';
  assert.equal(
    (
      await fetch(endpoint, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + env.SYNCABLES_WEBHOOK_TOKEN,
          'x-syncables-delivery-id': 'invented-delivery',
        },
        body: '{}',
      })
    ).status,
    204,
  );
  await waitUntil(() => (daemon.output().match(/"result"/g) ?? []).length >= 1);
  daemon.child.kill('SIGTERM');
  assert.equal(await daemon.closed, 0);
  mock.child.kill('SIGTERM');
  await mock.closed;
  const browse = await run([
    'browse',
    'github-issues/example/tasks',
    '--filter',
    '/state="open"',
    '--order-by',
    '/number:desc',
    '--at',
    commit,
  ]);
  assert.equal(browse.commit, commit);
  assert.equal(browse.resources.length, 1);
  assert.deepEqual(await run(['browse']), ['github-issues']);
  await run([
    'tag',
    'baseline',
    '--collection',
    'github-issues/example/tasks',
    '--at',
    commit,
  ]);
  const schema = await run([
    'resource',
    'urn:syncables:class:source-record',
    '--collection',
    'github-issues/example/tasks',
    '--at',
    'tag:baseline',
  ]);
  assert.equal(schema.commit, commit);
  const history = await run([
    'history',
    '1',
    '--collection',
    'github-issues/example/tasks',
  ]);
  assert.ok(history.revisions.includes(commit));
  const entry = history.entries.find((entry) => entry.commit === commit);
  assert.ok(
    entry.message.includes(
      'Intent (user supplied):\n  Capture a baseline\n  Review schema α before proceeding',
    ),
  );
  assert.ok(entry.message.includes('Syncables-Trigger: manual'));
  assert.ok(entry.message.includes('Syncables-Run: ' + synced[0].result.run));
  const schemaHistory = await run([
    'history',
    '--subject',
    'urn:syncables:class:source-record',
    '--collection',
    'github-issues/example/tasks',
    '--at',
    'tag:baseline',
  ]);
  assert.equal(schemaHistory.commit, commit);
  assert.deepEqual(schemaHistory.revisions, [commit]);
  assert.equal(schemaHistory.entries[0].message, entry.message);
  const checked=await run(['checkout']);
  assert.equal(checked[0].revision,(await run(['history','--collection','github-issues/example/tasks'])).commit);
  const exported=await run(['export','git','--subtree','github-issues/example/tasks','--output',join(directory,'export')]);
  assert.ok(exported.revisions >= 2);
  assert.ok(exported.mapping[commit]);
  const status = await run(['status']);
  assert.equal(status[0].state, 'idle');
  const rootImport = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('syncables'); await import('syncables/browser'); await import('syncables/daemon'); if (process._getActiveHandles().some(h => h.constructor.name === 'Socket' && h.remoteAddress)) process.exit(1)",
    ],
    { cwd: directory, env: { ...process.env, SYNCABLES_DATABASE_URL: '' } },
  );
  assert.equal(rootImport.stderr, '');
  const { PostgresArchive } = await import('../build/src/postgres/archive.js');
  cleanup = new PostgresArchive(database);
  for (const table of [
    'snapshot_import_refs',
    'snapshot_imports',
    'snapshot_git_tags',
    'snapshot_refs',
    'snapshot_members',
    'snapshot_revisions',
    'daemon_inbox',
    'daemon_jobs',
    'heads',
    'leases',
    'attempts',
    'payloads',
    'runs',
    'json_nodes',
  ])
    await cleanup.pool.query(
      `DELETE FROM syncables_cache.${table} WHERE owner=$1`,
      [owner],
    );
  console.log(
    'Installed tarball: sync, daemon/webhook, clean shutdown, offline hierarchy/filter/order/pinned browse, schema tag, history, status and isolated imports passed.',
  );
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGTERM');
  await cleanup?.close();
  await rm(directory, { recursive: true, force: true });
}
