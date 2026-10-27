// Outbound-only public client. Device and bearer secrets are held in memory
// and never printed. Runs against the real proxy or the companion CLI mock.
const issuer = (process.env.DEVICE_PROXY_URL || 'http://127.0.0.1:11874').replace(/\/$/, '');
const client = process.env.DEVICE_CLIENT_ID || 'syncables-cli';
const request = async (url, options = {}) => {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  return { response, value };
};
const post = (url, fields) => request(url, { method: 'POST', body: new URLSearchParams(fields) });
const { value: metadata, response: discovery } = await request(`${issuer}/.well-known/oauth-authorization-server`);
if (!discovery.ok || metadata.issuer !== issuer) throw new Error('Device authentication is unavailable on this issuer.');
for (const endpoint of [metadata.device_authorization_endpoint, metadata.token_endpoint]) {
  if (new URL(endpoint).origin !== new URL(issuer).origin) throw new Error('Unexpected endpoint origin');
}
const { response, value: device } = await post(metadata.device_authorization_endpoint, { client_id: client, scope: 'connections:read proxy:read' });
if (!response.ok) throw new Error(`Device authorization refused: ${device.error}`);
process.stdout.write(`Open ${device.verification_uri}\nEnter code ${device.user_code}\n`);
const deadline = Date.now() + device.expires_in * 1000;
let interval = device.interval || 5;
let token;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, interval * 1000));
  const result = await post(metadata.token_endpoint, { client_id: client, grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code });
  if (result.response.ok) { token = result.value; break; }
  if (result.value.error === 'slow_down') interval += 5;
  else if (result.value.error !== 'authorization_pending') throw new Error(`Login ended: ${result.value.error}`);
}
if (!token) throw new Error('Device request expired');
const headers = { authorization: `Bearer ${token.access_token}` };
const { response: listed, value: connections } = await request(`${issuer}/connections`, { headers });
if (!listed.ok) throw new Error(`Connection discovery refused: ${connections.error}`);
process.stdout.write(`${JSON.stringify(connections, null, 2)}\n`);
if (process.env.DEVICE_PROBE_PATH) {
  const connection = connections.connections.find(c => c.connection_id === process.env.DEVICE_CONNECTION_ID) || connections.connections[0];
  if (!connection || !process.env.DEVICE_PROBE_PATH.startsWith('/')) throw new Error('Choose an approved connection and absolute provider path');
  const result = await fetch(`${issuer}/proxy/${encodeURIComponent(connection.connection_id)}/${encodeURIComponent(connection.platform)}${process.env.DEVICE_PROBE_PATH}`, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
  process.stdout.write(`Provider GET status: ${result.status}\n`);
  await result.body?.cancel();
}
const logout = await fetch(metadata.revocation_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: client, token: token.refresh_token }), redirect: 'error', signal: AbortSignal.timeout(15000) });
if (!logout.ok) throw new Error('Logout failed');
process.stdout.write('Client session revoked.\n');
