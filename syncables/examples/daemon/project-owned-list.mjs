import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { projectOwnedList } from '../../build/src/daemon/owned-list.js';

// Consumer-side projection of an accepted native plan; no provider reads.
const [planPath, selectionPath, profilePath, outputPath] =
  process.argv.slice(2);
if (
  !planPath ||
  !selectionPath ||
  !profilePath ||
  !outputPath ||
  process.argv.length !== 6
)
  throw new Error(
    'Use project-owned-list.mjs SOURCE_PLAN SELECTION PROFILE OUTPUT',
  );
async function json(path, maxBytes) {
  const absolute = resolve(path);
  if ((await stat(absolute)).size > maxBytes)
    throw new Error('Projection input exceeds its size limit');
  const bytes = await readFile(absolute);
  if (bytes.byteLength > maxBytes)
    throw new Error('Projection input exceeds its size limit');
  return JSON.parse(bytes.toString('utf8'));
}
const plan = await json(planPath, 16 * 1024 * 1024);
const selection = await json(selectionPath, 64 * 1024);
const profile = await json(profilePath, 64 * 1024);
const projected = projectOwnedList(plan, selection, profile);
await writeFile(resolve(outputPath), JSON.stringify(projected) + '\n', {
  mode: 0o600,
  flag: 'wx',
});
process.stdout.write(
  JSON.stringify({
    format: projected.format,
    revision: projected.revision,
    resources: projected.resources.length,
  }) + '\n',
);
