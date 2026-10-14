// Local dogfooding owner hub. Private owner material stays in this process;
// the CLI has no key. Production hubs supply their own existing owner signer.
import { createServer } from 'node:http';
import { createPrivateKey, createPublicKey, createHash, randomBytes, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

if (process.argv.includes('--help')) {
  process.stdout.write('Set ATOMIC_OWNER_SEED to the existing owner Ed25519 seed (base64url, 32 bytes) and DEVICE_PROXY_URL to the proxy URL. Run on the owner machine. Never give this seed to the CLI.\n');
  process.exit(0);
}
const seed = Buffer.from(process.env.ATOMIC_OWNER_SEED || '', 'base64url');
if (seed.length !== 32) throw new Error('ATOMIC_OWNER_SEED must be the existing owner seed (32 bytes, base64url).');
const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
seed.fill(0); delete process.env.ATOMIC_OWNER_SEED;
const publicKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
const owner = `atomic:agent:${publicKey}`;
const proxy = new URL(process.env.DEVICE_PROXY_URL || 'http://127.0.0.1:11874');
if (proxy.search || proxy.hash || proxy.username || proxy.password || !(proxy.protocol === 'https:' || proxy.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(proxy.hostname))) throw new Error('Invalid DEVICE_PROXY_URL');
const proxyUrl = proxy.href.replace(/\/$/, '');
const port = Number(process.env.DEVICE_OWNER_PORT || 11873);
const origin = `http://127.0.0.1:${port}`;
const csrf = randomBytes(32).toString('base64url');
const module = await readFile(new URL('../../static/device-approval.mjs', import.meta.url));
const safeJSON = value => JSON.stringify(value).replaceAll('<', '\\u003c');
const page = `<!doctype html><meta charset=utf-8><title>Local owner approval</title><main id=root></main><script type=module>
import {mountDeviceApproval} from '/approval.mjs';
const signRequest = async request => {
 const response = await fetch('/sign', {method:'POST',headers:{'content-type':'application/json','x-owner-csrf':${safeJSON(csrf)}},body:JSON.stringify(request)});
 if(!response.ok)throw new Error('Owner signing failed'); return response.json();
};
mountDeviceApproval({root:document.getElementById('root'),proxyUrl:${safeJSON(proxyUrl)},signRequest,userCode:new URL(location.href).searchParams.get('user_code')||''});
</script>`;
let lastTimestamp = 0;
createServer(async (req, res) => {
  res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', `default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self' ${proxy.origin}; base-uri 'none'; frame-ancestors 'none'`);
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403).end(); return; }
  const pathname = new URL(req.url, origin).pathname;
  if (req.method === 'GET' && pathname === '/') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); return; }
  if (req.method === 'GET' && pathname === '/approval.mjs') { res.setHeader('content-type', 'text/javascript'); res.end(module); return; }
  if (req.method !== 'POST' || pathname !== '/sign' || req.headers.origin !== origin || req.headers['x-owner-csrf'] !== csrf) { res.writeHead(403).end(); return; }
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new Error('too large'); chunks.push(chunk); }
    const request = JSON.parse(Buffer.concat(chunks));
    if (request.method !== 'POST' || !['/device/challenge', '/device/approve'].some(path => request.url === `${proxyUrl}${path}`) || typeof request.body !== 'string' || request.body.length > 8192) throw new Error('outside approval contract');
    const timestamp = Math.max(Date.now(), lastTimestamp + 1); lastTimestamp = timestamp;
    const digest = createHash('sha256').update(request.body).digest('hex');
    const message = `atomic-request-v2\nPOST\n${request.url}\n${timestamp}\n${digest}`;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ 'x-atomic-agent': owner, 'x-atomic-public-key': publicKey, 'x-atomic-timestamp': String(timestamp), 'x-atomic-signature-version': '2', 'x-atomic-signature': sign(null, Buffer.from(message), key).toString('base64url') }));
  } catch { res.writeHead(400).end('Approval signing failed'); }
}).listen(port, '127.0.0.1', () => process.stdout.write(`Owner approval bridge: ${origin}\nOwner: ${owner}\n`));
