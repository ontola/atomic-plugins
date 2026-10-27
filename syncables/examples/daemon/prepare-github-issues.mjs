import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';

// Immutable upstream input; no provider credentials or private data are used.
const revision = '091431739208d017c11b0b0589ab33293f8b3690';
const path = 'APIs/github.com/api.github.com/1.1.4/openapi.yaml';
const url = `https://raw.githubusercontent.com/ontola/openapi-directory/${revision}/${path}`;
const expectedHash =
  'aeb35e488d0ad4c3a43e96bad41f66f734760ccd5fb12f7cb3e2175a73344bcc';
const args = process.argv.slice(2);
const output = resolve(
  args.find((a) => !a.startsWith('--')) ??
    fileURLToPath(new URL('./generated/github-issues.json', import.meta.url)),
);
const source = args
  .find((a) => a.startsWith('--source='))
  ?.slice('--source='.length);
const response = source
  ? undefined
  : await globalThis.fetch(url, {
      signal: globalThis.AbortSignal.timeout(30000),
    });
if (response && !response.ok)
  throw new Error(`Upstream OAD request failed: ${response.status}`);
const original = source
  ? await readFile(source, 'utf8')
  : await response.text();
if (createHash('sha256').update(original).digest('hex') !== expectedHash)
  throw new Error('The upstream OAD hash does not match its pin');
const document = load(original);
const annotations = JSON.parse(
  await readFile(
    new URL('./github-issues.annotations.json', import.meta.url),
    'utf8',
  ),
);
if (
  !document.paths?.['/repos/{owner}/{repo}/issues']?.get?.responses?.['200'] ||
  !document.components?.schemas
) {
  throw new Error('The complete GitHub OAD is required');
}
Object.assign(document.components, annotations.components);
Object.assign(
  document.paths['/repos/{owner}/{repo}/issues'].get,
  annotations.paths['/repos/{owner}/{repo}/issues'].get,
);
if (
  !document.paths[
    annotations.components.crudResources.issue.identity.urlTemplate
  ]?.get
)
  throw new Error('Issue identity must match a real upstream operation');
document['x-syncd-source'] = {
  repository: 'https://github.com/ontola/openapi-directory',
  revision,
  path,
  sha256: createHash('sha256').update(original).digest('hex'),
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(document) + '\n', {
  mode: 0o600,
  flag: args.includes('--force') ? 'w' : 'wx',
});
process.stdout.write(
  JSON.stringify({
    output,
    paths: Object.keys(document.paths).length,
    schemas: Object.keys(document.components.schemas).length,
  }) + '\n',
);
