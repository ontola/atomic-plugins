import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('./server.sh', import.meta.url));
const oldPin = '30994948b5adadd765ecfcdccdf0aad14ef5be1a';
const compatible = 'a450e20fc0d949958ec8187724dfa6c9423a8f66';

// No real Docker or network: verify the auth preflight runs before the
// destructive container replacement, and preserve explicit test receivers.
function run(sha, proxy) {
  const dir = mkdtempSync(join(tmpdir(), 'usertest-server-'));
  const calls = join(dir, 'calls');
  writeFileSync(
    join(dir, 'docker'),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DOCKER_CALLS"\n',
  );
  chmodSync(join(dir, 'docker'), 0o700);
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    DOCKER_CALLS: calls,
  };
  delete env.ATOMIC_INTEGRATION_PROXY_URL;
  delete env.USERTEST_PLUGIN_ROUTES;
  if (proxy !== undefined) env.ATOMIC_INTEGRATION_PROXY_URL = proxy;
  try {
    const result = spawnSync('sh', [script, 'usertest.invalid', sha], {
      env,
      encoding: 'utf8',
    });
    let arguments_ = '';
    try {
      arguments_ = readFileSync(calls, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { ...result, arguments_ };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('refuses the incompatible pin before pulling or replacing a container', () => {
  for (const proxy of [undefined, 'https://integrations.atomic.place/']) {
    const result = run(oldPin, proxy);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lacks IAP connection-key auth/);
    assert.equal(result.arguments_, '');
  }
});

test('uses IAP with a compatible host build', () => {
  const result = run(compatible);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.arguments_,
    /^ATOMIC_INTEGRATION_PROXY_URL=https:\/\/integrations.atomic.place$/m,
  );
});

test('preserves explicit custom and loopback proxies for historical hosts', () => {
  for (const proxy of ['https://proxy.test', 'http://127.0.0.1:8090']) {
    const result = run(oldPin, proxy);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.arguments_
        .split('\n')
        .includes(`ATOMIC_INTEGRATION_PROXY_URL=${proxy}`),
    );
  }
});
