import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { safeUrl } from './auth.js';

export interface ReplicationConnection {
  name: string;
  backend: 'atomic' | 'nextgraph' | 'remotestorage';
  collections: string[];
  destination: Record<string, string>;
  status: 'configured';
}

export function configDirectory(): string {
  return process.platform === 'darwin'
    ? join(
        homedir(),
        'Library',
        'Application Support',
        'Syncables',
        'replication',
      )
    : join(homedir(), '.config', 'syncables', 'replication');
}

function name(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value))
    throw new Error(
      'Connection name must use 1–64 letters, digits, hyphens or underscores',
    );
  return value;
}

function destinationUrl(value: string): string {
  const url = safeUrl(value);
  if (url.search)
    throw new Error(
      'Replication endpoint URLs must not contain query parameters',
    );
  return url.href;
}

export function defineConnection(
  options: Record<string, string | boolean | undefined>,
): ReplicationConnection {
  const requireOption = (key: string): string => {
    const value = options[key];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Missing --${key}`);
    return value;
  };
  const backend = requireOption('backend');
  const destination: Record<string, string> = {};
  if (backend === 'atomic') {
    destination.server = destinationUrl(requireOption('url'));
    destination.drive = requireOption('drive');
    if (!/^atomic:\S+$/.test(destination.drive))
      throw new Error('Atomic drive must use an atomic: identifier');
  } else if (backend === 'nextgraph') {
    destination.graph = requireOption('graph');
    if (!/^did:ng:\S+$/.test(destination.graph))
      throw new Error('NextGraph graph must use a did:ng: identifier');
    if (typeof options.broker === 'string')
      destination.broker = destinationUrl(options.broker);
  } else if (backend === 'remotestorage') {
    destination.address = requireOption('address');
    if (!/^[^\s@]+@[^\s@/]+$/.test(destination.address))
      throw new Error('remoteStorage address must be user@host');
    destination.module = requireOption('module');
    if (!/^[a-zA-Z0-9_-]+$/.test(destination.module))
      throw new Error('remoteStorage module must be one path segment');
  } else throw new Error('Backend must be atomic, nextgraph or remotestorage');
  const collections = requireOption('collections')
    .split(',')
    .map((value) => value.trim());
  if (collections.some((value) => !value))
    throw new Error('Collection scope must not contain empty names');
  return {
    name: name(requireOption('name')),
    backend,
    collections,
    destination,
    status: 'configured',
  };
}

export async function addConnection(
  directory: string,
  connection: ReplicationConnection,
): Promise<void> {
  const target = join(directory, `${name(connection.name)}.json`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(connection, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    // Publish a complete file atomically; never replace an existing definition.
    await link(temporary, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Replication connection ${connection.name} already exists`,
      );
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export async function listReplication(
  directory: string,
): Promise<ReplicationConnection[]> {
  const { readdir } = await import('node:fs/promises');
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries: ReplicationConnection[] = [];
  for (const file of files.filter((file) => file.endsWith('.json')).sort()) {
    const entry = JSON.parse(
      await readFile(join(directory, file), 'utf8'),
    ) as ReplicationConnection;
    if (
      !entry ||
      entry.status !== 'configured' ||
      !Array.isArray(entry.collections) ||
      !entry.destination
    )
      throw new Error(`Invalid replication definition: ${file}`);
    entries.push(entry);
  }
  return entries;
}
