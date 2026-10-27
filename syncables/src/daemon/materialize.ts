import {
  realpath,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  writeFile,
  rm,
} from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nodeHash } from '../postgres/json-graph.js';
import { CheckoutBlockedError } from './git-store.js';

const MARKER = '.syncables-snapshot.json';
interface Manifest {
  version: 1;
  owner: string;
  scope: string;
  revision: string;
  files: Record<string, string>;
}
const fileName = (name: string): boolean =>
  name === 'context.json' || /^r-[a-f0-9]{64}\.json$/.test(name);
/** A normal folder, with no Git dependency. Local changes block publication. */
export async function materialize(
  root: string,
  collection: string,
  owner: string,
  scope: string,
  revision: string,
  files: Map<string, string>,
): Promise<string> {
  const parts = collection.split('/');
  if (
    parts.length !== 3 ||
    parts.some((p) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(p))
  )
    throw new Error('Invalid checkout collection alias');
  root = resolve(root);
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  root = resolve(await realpath(dirname(root)), basename(root));
  const directory = resolve(root, ...parts);
  const blocked = (reason: string): CheckoutBlockedError =>
    new CheckoutBlockedError(`Working folder ${directory}: ${reason}`);
  // Inspect all ancestors, including those above the configured root.
  const ensure = async (path: string): Promise<void> => {
    if (path !== dirname(root) && dirname(path) !== path)
      await ensure(dirname(path));
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw blocked('refusing a symlink or non-directory');
  };
  await ensure(dirname(directory));
  const lock = resolve(dirname(directory), '.' + parts[2] + '.syncables-lock');
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST')
      throw blocked(
        'checkout is busy; inspect an interrupted checkout before removing its lock',
      );
    throw e;
  }
  let stage: string | undefined;
  try {
    const inspect = async (path: string): Promise<Manifest | undefined> => {
      const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return undefined;
      });
      if (!info) return undefined;
      if (!info.isDirectory() || info.isSymbolicLink())
        throw blocked('refusing a symlink or non-directory');
      const marker = await lstat(resolve(path, MARKER)).catch(() => undefined);
      if (!marker?.isFile() || marker.isSymbolicLink())
        throw blocked(
          'not a managed PostgreSQL snapshot folder; choose another workspaceDirectory',
        );
      const manifest = JSON.parse(
        await readFile(resolve(path, MARKER), 'utf8'),
      ) as Manifest;
      if (
        manifest.version !== 1 ||
        manifest.owner !== owner ||
        manifest.scope !== scope ||
        !manifest.files ||
        Object.keys(manifest.files).some((n) => !fileName(n))
      )
        throw blocked('invalid snapshot manifest');
      const names = await readdir(path);
      if (
        names.length !== Object.keys(manifest.files).length + 1 ||
        names.some((n) => n !== MARKER && !Object.hasOwn(manifest.files, n))
      )
        throw blocked(
          'local additions need attention; no files were overwritten',
        );
      for (const [name, hash] of Object.entries(manifest.files)) {
        const info = await lstat(resolve(path, name));
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          nodeHash(await readFile(resolve(path, name), 'utf8')) !== hash
        )
          throw blocked(
            'local edits need attention; no files were overwritten',
          );
      }
      return manifest;
    };
    const previous = await inspect(directory);
    if (previous?.revision === revision) return directory;
    stage = resolve(
      dirname(directory),
      '.' + parts[2] + '.stage-' + randomUUID(),
    );
    await mkdir(stage, { mode: 0o700 });
    const manifest: Manifest = {
      version: 1,
      owner,
      scope,
      revision,
      files: Object.create(null),
    };
    for (const [name, text] of files) {
      if (!fileName(name)) throw new Error('Invalid snapshot filename');
      await writeFile(resolve(stage, name), text, { flag: 'wx', mode: 0o600 });
      manifest.files[name] = nodeHash(text);
    }
    await writeFile(
      resolve(stage, MARKER),
      JSON.stringify(manifest, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    );
    if (previous) {
      await inspect(directory);
      // Keep the previous folder for recovery, including edits made during publication.
      // Its name is reported in the documentation; PostgreSQL remains authoritative.
      const backup = resolve(
        dirname(directory),
        '.' + parts[2] + '.previous-' + randomUUID(),
      );
      await rename(directory, backup);
      try {
        await inspect(backup);
        await rename(stage, directory);
      } catch (e) {
        await rename(backup, directory);
        throw e;
      }
    } else await rename(stage, directory);
    stage = undefined;
    return directory;
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true });
    await rmdir(lock);
  }
}
