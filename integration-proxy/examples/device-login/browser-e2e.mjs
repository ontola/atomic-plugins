// Opt-in browser test against the actual Rust proxy and local owner bridge.
// Only invented records/owner material; bearer secrets are never logged.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
const { chromium } = await import(process.env.DEVICE_PLAYWRIGHT_MODULE || 'playwright');
const issuer = process.env.DEVICE_PROXY_URL;
const bridgeOrigin = `http://127.0.0.1:${process.env.DEVICE_OWNER_PORT}`;
const bridge = spawn(process.execPath, [new URL('./owner-bridge.mjs', import.meta.url).pathname], { stdio: 'ignore', env: process.env });
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { ready = (await fetch(bridgeOrigin)).ok; } catch { /* startup */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'owner bridge starts');
  // A cross-origin page cannot use the owner's local signing endpoint.
  const refused = await fetch(`${bridgeOrigin}/sign`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 403);
  const post = async (path, fields) => {
    const response = await fetch(`${issuer}${path}`, { method: 'POST', body: new URLSearchParams(fields), redirect: 'error' });
    return { response, value: response.headers.get('content-type')?.includes('json') ? await response.json() : null };
  };
  const { response, value: device } = await post('/oauth/device/code', { client_id: 'syncables-cli', scope: 'connections:read proxy:read' });
  assert.equal(response.status, 200);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(device.verification_uri_complete);
  await page.getByRole('link', { name: 'Continue to owner approval' }).click();
  assert.equal(await page.locator('input:not([type=checkbox])').inputValue(), device.user_code.replace('-', ''));
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('heading', { name: 'Syncables CLI', exact: true }).waitFor();
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 0);
  const selected = page.locator('label').filter({ hasText: process.env.DEVICE_CONNECTION_ID }).locator('input[type=checkbox]');
  await selected.check();
  await page.getByRole('button', { name: 'Approve selected connections', exact: true }).click();
  await page.getByText('Approved. Return to your CLI.', { exact: true }).waitFor();
  let interval = device.interval;
  let token;
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    const polled = await post('/oauth/device/token', { client_id: 'syncables-cli', grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code });
    if (polled.response.ok) { token = polled.value; break; }
    if (polled.value.error === 'slow_down') interval += 5;
    else assert.equal(polled.value.error, 'authorization_pending');
  }
  assert.ok(token, 'outbound client obtains a token');
  const headers = { authorization: `Bearer ${token.access_token}` };
  const list = await fetch(`${issuer}/connections`, { headers });
  assert.equal(list.status, 200);
  const value = await list.json();
  assert.equal(value.connections.length, 1);
  assert.equal(value.connections[0].connection_id, process.env.DEVICE_CONNECTION_ID);
  assert.equal(value.owner, token.owner);
  const resource = `${issuer}/proxy/${value.connections[0].connection_id}/${value.connections[0].platform}/records`;
  const read = await fetch(resource, { headers });
  assert.equal(read.status, 200); assert.deepEqual(await read.json(), { records: [] });
  assert.equal((await fetch(resource, { method: 'POST', headers })).status, 403);
  const loggedOut = await post('/oauth/device/revoke', { client_id: 'syncables-cli', token: token.refresh_token });
  assert.equal(loggedOut.response.status, 200);
  assert.equal((await fetch(`${issuer}/connections`, { headers })).status, 401);
  process.stdout.write('Browser owner approval, outbound device login, scoped GET, write refusal and logout passed.\n');
} finally {
  await browser?.close(); bridge.kill();
}
