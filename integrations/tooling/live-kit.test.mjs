import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetError,
  CONFIRM_FLAG,
  GuardError,
  confirmedTarget,
  createBudget,
  createLogger,
  createProvider,
  createRecorder,
  createRedactor,
  looksDisposable,
  liveSettings,
  parseArgs,
  readSecret,
  relayStandIn,
  renderMarkdown,
  requireDisposableName,
  writeEvidence,
} from './live-kit.mjs';
import { APPS, USAGE, main, redactingWriter } from './live-check.mjs';

const TOKEN = 'ya29.A0-fake-credential-for-offline-tests-0123456789';

test('the confirm flag must name the target; absent, empty or bare is refused', () => {
  assert.equal(
    confirmedTarget(parseArgs([CONFIRM_FLAG, 'abc@group.calendar.google.com']).flags, 'calendar id'),
    'abc@group.calendar.google.com',
  );
  assert.equal(
    confirmedTarget(parseArgs([`${CONFIRM_FLAG}=ws1`]).flags, 'workspace id'),
    'ws1',
  );
  for (const argv of [[], [CONFIRM_FLAG], [CONFIRM_FLAG, '--out', 'x'], [CONFIRM_FLAG, '  ']])
    assert.throws(
      () => confirmedTarget(parseArgs(argv).flags, 'calendar id'),
      error => error instanceof GuardError && /Nothing was sent/.test(error.message) && error.message.includes(CONFIRM_FLAG),
    );
});

test('a name looks disposable only as a whole word', () => {
  for (const ok of ['atomic live-check test', 'Test calendar', 'my-sandbox', 'scratch_ws', 'ws (disposable)', 'atomic-plugins-test'])
    assert.equal(looksDisposable(ok), true, ok);
  for (const bad of ['Family', 'Ontola', 'latest', 'contest', 'attestation', '', undefined, 42])
    assert.equal(looksDisposable(bad), false, String(bad));
  assert.throws(() => requireDisposableName('calendar', 'Work'), /does not look disposable/);
  assert.doesNotThrow(() => requireDisposableName('calendar', 'Work test'));
});

test('credentials come from the environment or a hidden prompt, never anywhere else', async () => {
  assert.equal(await readSecret('X_TOKEN', { env: { X_TOKEN: ' abc12345 ' } }), 'abc12345');
  await assert.rejects(
    readSecret('X_TOKEN', { env: {}, isTTY: false }),
    error => error instanceof GuardError && /never from a file or a flag/.test(error.message),
  );
  const asked = [];
  assert.equal(
    await readSecret('X_TOKEN', { env: {}, isTTY: true, label: 'The token', prompt: async q => (asked.push(q), 'typed-secret-1') }),
    'typed-secret-1',
  );
  assert.match(asked[0], /The token/);
  await assert.rejects(readSecret('X_TOKEN', { env: {}, isTTY: true, prompt: async () => '' }), /No credential/);
});

test('redaction removes the credential in every encoding, known token shapes and emails', () => {
  const redact = createRedactor({ TOKEN }, { keep: ['keep@group.calendar.google.com'] });
  const samples = [
    `Authorization: Bearer ${TOKEN}`,
    `url?access_token=${encodeURIComponent(TOKEN)}`,
    `basic ${Buffer.from(`:${TOKEN}`).toString('base64')}`,
    `x-api-key: ${TOKEN}`,
    `plain ${TOKEN} inside`,
  ];
  for (const sample of samples) {
    const out = redact(sample);
    assert.ok(!out.includes(TOKEN), out);
    assert.ok(!out.includes(encodeURIComponent(TOKEN)), out);
    assert.ok(!out.includes(Buffer.from(`:${TOKEN}`).toString('base64')), out);
  }
  assert.equal(redact('Bearer ya29.aaaaaaaaaaaaaaaaaaaa'), 'Bearer [redacted]');
  assert.equal(redact('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), '[redacted-github-token]');
  assert.equal(redact('github_pat_11ABCDEFG0abcdefghijklmnop_qrstuvwxyz'), '[redacted-github-token]');
  assert.equal(redact('ntn_abcdefghijklmnopqrstuvwxyz'), '[redacted-notion-token]');
  assert.equal(redact('mail me at someone@example.com'), 'mail me at [email]');
  assert.equal(redact('calendar keep@group.calendar.google.com ok'), 'calendar keep@group.calendar.google.com ok');
  assert.deepEqual(redact.deep({ [`k ${TOKEN}`]: ['a@b.co', { v: TOKEN }], n: 1 }), {
    'k [redacted:TOKEN]': ['[email]', { v: '[redacted:TOKEN]' }],
    n: 1,
  });
  assert.throws(() => createRedactor({ SHORT: 'abc' }), /too short to be a credential/);
});

test('the logger and the child-output writer redact too, also across chunk boundaries', () => {
  const redact = createRedactor({ TOKEN });
  const lines = [];
  createLogger(redact, l => lines.push(l))('sending', { auth: `Bearer ${TOKEN}` });
  assert.ok(!lines.join('').includes(TOKEN));

  const out = [];
  const writer = redactingWriter(redact, l => out.push(l));
  writer.push(TOKEN.slice(0, 20));
  writer.push(`${TOKEN.slice(20)}\nsecond ${TOKEN}`);
  writer.end();
  assert.ok(!out.join('').includes(TOKEN));
  assert.equal(out.length, 2);
});

test('the budget stops after the write limit and the time limit; reads are free', () => {
  const budget = createBudget({ maxMutations: 2, maxMs: 1000, now: () => 0 });
  for (let i = 0; i < 10; i++) budget.spend('GET');
  budget.spend('POST');
  budget.spend('PATCH');
  assert.throws(() => budget.spend('DELETE'), BudgetError);
  assert.equal(budget.mutations, 2);
  budget.extendForCleanup(3);
  assert.doesNotThrow(() => budget.spend('DELETE'));

  let clock = 0;
  const timed = createBudget({ maxMs: 1000, now: () => clock });
  timed.spend('GET');
  clock = 1001;
  assert.throws(() => timed.spend('GET'), /A timeout is a failure/);
});

function fakeFetch(handler) {
  const seen = [];
  const fetcher = async (href, init) => {
    seen.push({ href, init });
    const { status = 200, body = {}, headers = {} } = handler(href, init) ?? {};

    return {
      status,
      headers: { get: name => headers[name] ?? null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  };

  return { fetcher, seen };
}

test('the provider client adds the credential itself, enforces scope and budget, and records no bodies', async () => {
  const redact = createRedactor({ TOKEN });
  const { fetcher, seen } = fakeFetch(() => ({ body: { ok: true }, headers: { etag: '"1"' } }));
  const provider = createProvider({
    baseUrl: 'https://api.example.test',
    authHeaders: () => ({ authorization: `Bearer ${TOKEN}` }),
    allow: ({ method, pathname }) => {
      if (!pathname.startsWith('/v1/ok')) throw new GuardError(`out of scope ${method} ${pathname}`);
    },
    budget: createBudget({ maxMutations: 1 }),
    redact,
    fetcher,
  });
  const response = await provider.request({
    who: 'driver',
    method: 'post',
    path: '/v1/ok',
    query: { a: '1' },
    body: JSON.stringify({ secretish: 'x', other: 2 }),
    ifMatch: '"0"',
  });
  assert.deepEqual(response, { status: 200, headers: { etag: '"1"' }, body: { ok: true } });
  assert.equal(seen[0].href, 'https://api.example.test/v1/ok?a=1');
  assert.equal(seen[0].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].init.headers['if-match'], '"0"');
  assert.deepEqual(provider.requests[0].bodyKeys, ['other', 'secretish']);
  assert.ok(!JSON.stringify(provider.requests).includes(TOKEN));

  await assert.rejects(provider.request({ who: 'app', path: '/v1/other' }), /out of scope/);
  await assert.rejects(provider.request({ who: 'app', path: '/v1/ok', method: 'DELETE' }), BudgetError);
  assert.equal(seen.length, 1, 'refused requests never reach the network');
  await assert.rejects(provider.request({ who: 'app', path: '@evil.test/x' }), /Refusing a request outside/);
});

test('a network error is recorded and re-thrown without the credential', async () => {
  const redact = createRedactor({ TOKEN });
  const provider = createProvider({
    baseUrl: 'https://api.example.test',
    authHeaders: () => ({ authorization: `Bearer ${TOKEN}` }),
    allow: () => {},
    budget: createBudget(),
    redact,
    fetcher: async () => {
      throw new Error(`connect failed for Bearer ${TOKEN}`);
    },
  });
  await assert.rejects(provider.request({ who: 'app', path: '/x' }), error => !error.message.includes(TOKEN));
  assert.equal(provider.requests[0].status, 'network-error');
});

test('the relay stand-in names one connection and holds no credential', async () => {
  const calls = [];
  const provider = { request: async r => (calls.push(r), { status: 200, headers: {}, body: null }) };
  const proxy = relayStandIn(provider, 'clockify');
  assert.deepEqual(await proxy.connections({ platform: 'clockify' }), [{ connectionId: 'live-check', platform: 'clockify' }]);
  assert.deepEqual(await proxy.connections({ platform: 'other' }), []);
  await proxy.request({ platform: 'clockify', connectionId: 'live-check', path: '/api/v1/user' });
  assert.equal(calls[0].who, 'app');
  assert.equal(JSON.stringify(calls[0]).includes('authorization'), false);
  await assert.rejects(proxy.request({ platform: 'github-issues', connectionId: 'live-check', path: '/x' }), GuardError);
  await assert.rejects(proxy.request({ platform: 'clockify', connectionId: 'other', path: '/x' }), /Connect again/);
});

test('the recorder stops at the first failed step and the evidence carries no secret', async () => {
  const redact = createRedactor({ TOKEN }, { keep: ['cal@group.x.com'] });
  const dir = mkdtempSync(join(tmpdir(), 'live-kit-'));
  try {
    const budget = createBudget();
    const recorder = createRecorder({
      app: 'calendar',
      provider: 'Test provider',
      apiVersion: 'v0',
      candidate: { app: 'calendar', appVersion: '0.0.0', bundlePath: 'apps/calendar/0.0.0/ui.js', ranAgainst: 'a test' },
      target: { kind: 'calendar', id: 'cal@group.x.com' },
      redact,
      limits: budget,
      now: () => new Date('2026-10-02T10:00:00Z'),
    });
    await recorder.step('A', 'first', async ({ check, equal }) => {
      check('ok', true);
      equal('values', { a: 1 }, { a: 1 });
    });
    await recorder.step('B', 'second', async ({ equal }) => {
      equal('leaks', `Bearer ${TOKEN} for who@example.com`, 'x');
      throw new Error(`boom ${TOKEN}`);
    });
    await recorder.step('C', 'third', async ({ check }) => check('never', true));
    const doc = recorder.document({ cleanup: { status: 'passed' }, notCovered: ['a thing'] });
    assert.deepEqual(
      doc.steps.map(s => s.status),
      ['passed', 'failed', 'skipped'],
    );
    assert.equal(doc.status, 'failed');
    const files = writeEvidence(doc, join(dir, 'nested'), redact);
    const json = readFileSync(files.json, 'utf8');
    const md = readFileSync(files.markdown, 'utf8');
    for (const text of [json, md]) {
      assert.ok(!text.includes(TOKEN));
      assert.ok(!text.includes('who@example.com'));
    }
    assert.match(files.json, /calendar-20261002T100000Z\.json$/);
    assert.match(md, /Result: \*\*failed\*\*/);
    assert.match(renderMarkdown(JSON.parse(json)), /Not covered by this run/);
    assert.equal(JSON.parse(json).target.id, 'cal@group.x.com');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('liveSettings refuses a scenario started without the command', () => {
  assert.throws(() => liveSettings({}), /live-check\.mjs/);
  assert.throws(() => liveSettings({ LIVE_CHECK_CONFIRMED: 'x', LIVE_CHECK_MAX_MUTATIONS: 'many' }), /positive whole number/);
  assert.deepEqual(
    liveSettings({ LIVE_CHECK_CONFIRMED: ' t ', LIVE_CHECK_MAX_MINUTES: '3', LIVE_CHECK_PREFLIGHT_ONLY: '1', LIVE_CHECK_OUT: '/o' }),
    { target: 't', outDir: '/o', maxMutations: undefined, maxMs: 180000, preflightOnly: true },
  );
});

/* ------------------------------------------------------------------ CLI */

function cliWorld({ withLayout = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'live-cli-'));
  if (withLayout) {
    mkdirSync(join(root, 'browser/node_modules/.bin'), { recursive: true });
    writeFileSync(join(root, 'browser/node_modules/.bin/vitest'), '');
    for (const app of Object.values(APPS)) {
      mkdirSync(join(root, 'integrations', app.dir), { recursive: true });
      writeFileSync(join(root, 'integrations', app.dir, 'vitest.live.config.ts'), '');
    }
  }
  const out = [];
  const err = [];
  const spawned = [];
  const spawn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawned.push({ cmd, args, options });
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(`token is ${options.env[Object.values(APPS).map(a => a.secret).find(s => options.env[s])]}\n`));
      child.stderr.emit('data', Buffer.from('done'));
      child.emit('close', 0);
    });

    return child;
  };

  return { root, out, err, spawned, deps: { root, spawn, out: l => out.push(l), err: l => err.push(l), isTTY: false } };
}

test('the command refuses without the confirm flag, before reading the credential or starting anything', async () => {
  const w = cliWorld();
  try {
    const code = await main(['calendar'], { ...w.deps, env: { GOOGLE_CALENDAR_ACCESS_TOKEN: TOKEN } });
    assert.equal(code, 2);
    assert.match(w.err.join(''), /Refusing to run/);
    assert.match(w.err.join(''), /--i-understand-this-writes-to <calendar id>/);
    assert.deepEqual(w.spawned, []);
    assert.ok(!w.err.join('').includes(TOKEN));
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the command refuses without a credential in the environment when there is no terminal', async () => {
  const w = cliWorld();
  try {
    const code = await main(['timesheets', CONFIRM_FLAG, 'ws1'], { ...w.deps, env: {} });
    assert.equal(code, 2);
    assert.match(w.err.join(''), /CLOCKIFY_API_KEY is not set/);
    assert.deepEqual(w.spawned, []);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('the command rejects unknown apps and options, and a missing layout', async () => {
  const w = cliWorld();
  const none = cliWorld({ withLayout: false });
  const env = { GOOGLE_CALENDAR_ACCESS_TOKEN: TOKEN };
  try {
    assert.equal(await main(['nope', CONFIRM_FLAG, 'x'], { ...w.deps, env }), 2);
    assert.equal(await main(['calendar', CONFIRM_FLAG, 'x', '--force'], { ...w.deps, env }), 2);
    assert.match(w.err.join(''), /Unknown option --force/);
    assert.equal(await main(['calendar', CONFIRM_FLAG, 'x'], { ...none.deps, env }), 2);
    assert.match(none.err.join(''), /link-atomic-server\.mjs/);
    assert.equal(await main([], { ...w.deps, env }), 2);
    assert.equal(await main(['--help'], { ...w.deps, env }), 0);
    assert.ok(w.out.join('').includes(USAGE));
    assert.deepEqual([...w.spawned, ...none.spawned], []);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
    rmSync(none.root, { recursive: true, force: true });
  }
});

test('the command hands the child the target and the credential through the environment only, and redacts its output', async () => {
  const w = cliWorld();
  try {
    const code = await main(
      ['calendar', CONFIRM_FLAG, 'abc@group.calendar.google.com', '--max-mutations', '12', '--preflight-only'],
      { ...w.deps, env: { GOOGLE_CALENDAR_ACCESS_TOKEN: TOKEN, PATH: process.env.PATH } },
    );
    assert.equal(code, 0);
    assert.equal(w.spawned.length, 1);
    const { cmd, args, options } = w.spawned[0];
    assert.match(cmd, /browser\/node_modules\/\.bin\/vitest$/);
    assert.deepEqual(args, ['run', '--config', 'integrations/calendar/vitest.live.config.ts']);
    assert.ok(!JSON.stringify([cmd, args]).includes(TOKEN), 'argv never carries the credential');
    assert.equal(options.env.GOOGLE_CALENDAR_ACCESS_TOKEN, TOKEN);
    assert.equal(options.env.LIVE_CHECK_CONFIRMED, 'abc@group.calendar.google.com');
    assert.equal(options.env.LIVE_CHECK_MAX_MUTATIONS, '12');
    assert.equal(options.env.LIVE_CHECK_PREFLIGHT_ONLY, '1');
    const everything = [...w.out, ...w.err].join('');
    assert.ok(!everything.includes(TOKEN), 'the child printed the token; the command must not pass it on');
    assert.match(everything, /\[redacted:GOOGLE_CALENDAR_ACCESS_TOKEN\]/);
    assert.match(everything, /abc@group\.calendar\.google\.com/);
  } finally {
    rmSync(w.root, { recursive: true, force: true });
  }
});

test('every app in the registry has a scenario config, a credential variable and a target name', () => {
  for (const [name, app] of Object.entries(APPS)) {
    assert.ok(app.dir && app.secret && app.target && app.provider, name);
    assert.match(app.secret, /^[A-Z_]+$/);
  }
});
