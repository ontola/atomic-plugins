import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { URL } from 'node:url';
import { load } from 'js-yaml';

// This changes projection metadata only, never an accepted source snapshot.
const [documentPath, outputPath] = process.argv.slice(2);
if (!documentPath || !outputPath || process.argv.length !== 4)
  throw new Error('Use prepare-github-relationships.mjs SOURCE-OAD OUTPUT');
const original = await readFile(resolve(documentPath), 'utf8');
const document = load(original);
for (const path of ['/users/{username}', '/repos/{owner}/{repo}/labels/{name}'])
  if (!document.paths?.[path]?.get)
    throw new Error('The source OAD must describe the target item reads');
if (
  !document.components?.crudResources?.issue ||
  !document.components.schemas?.['nullable-simple-user'] ||
  !document.components.schemas?.label
)
  throw new Error('The complete annotated GitHub OAD is required');
const overlay = JSON.parse(
  await readFile(
    new URL('./github-issues.relationships.overlay.json', import.meta.url),
    'utf8',
  ),
);
const contract = {
  sourceDocumentHash: createHash('sha256').update(original).digest('hex'),
  overlay,
};
const output = resolve(outputPath);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(contract) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
process.stdout.write(
  JSON.stringify({ output, sourceDocumentHash: contract.sourceDocumentHash }) +
    '\n',
);
