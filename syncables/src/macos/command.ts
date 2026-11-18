import { randomBytes, createHash } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildMacApp, macNative } from './native.js';
import { startMacService } from './service.js';
import { macDocument } from './document.js';

export async function macosCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  if (
    typeof values.directory !== 'string' ||
    typeof values['config-dir'] !== 'string' ||
    typeof values.owner !== 'string'
  )
    throw new Error(
      'Supply --directory ICLOUD_DRIVE --config-dir PRIVATE_DIRECTORY --owner OWNER',
    );
  const directory = await realpath(resolve(values.directory));
  const state = resolve(values['config-dir']);
  const port = Number(values['connector-port'] ?? 9890);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid connector port');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await chmod(state, 0o700);
  const tokenFile = join(state, 'connector.token');
  let token: string;
  try {
    token = (await readFile(tokenFile, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex');
    await writeFile(tokenFile, token, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error('Invalid saved connector token');
  await chmod(tokenFile, 0o600);
  const app = await buildMacApp(state);
  const url = 'http://127.0.0.1:' + port;
  const photos = values.photos === true;
  const writable = values.write === true;
  const document = macDocument(url, directory, photos, writable);
  const documentFile = join(state, 'macos.openapi.json');
  const connection =
    'macos-' +
    createHash('sha256').update(directory).digest('hex').slice(0, 24);
  const config = {
    version: 1,
    owner: values.owner,
    dataDirectory: './data',
    workspaceDirectory: './workspace',
    collections: [
      'files',
      ...(photos ? ['photos'] : []),
      ...(writable ? ['transfers'] : []),
    ].map((name) => ({
      platform: 'macos',
      account: 'personal',
      name,
      connection,
      document: documentFile,
      collection: name,
      bindings: {},
      query: {},
      pollSeconds: 0,
      readLimits: {
        maxRecords: 250_000,
        maxRequests: 1000,
        timeoutMs: 300_000,
      },
      snapshotLimits: { maxRecords: 250_006, maxBytes: 128 * 1024 * 1024 },
      local: { url, tokenFile },
      ...(name === 'transfers' ? { writes: { enabled: true } } : {}),
    })),
  };
  const service = await startMacService({
    directory,
    stateDirectory: state,
    token,
    connection,
    port,
    photos,
    writable,
    native: macNative(app, state),
  });
  await writeFile(documentFile, JSON.stringify(document, null, 2) + '\n', {
    mode: 0o600,
  });
  const configFile = join(state, 'config.json');
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n', {
    mode: 0o600,
  });
  process.stdout.write(
    `macOS connector listening at ${service.url}\nConfig: ${configFile}\nRun syncables sync --config ${JSON.stringify(configFile)}\n`,
  );
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await new Promise<void>((done) =>
      controller.signal.addEventListener('abort', () => done(), { once: true }),
    );
  } finally {
    await service.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
