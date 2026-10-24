import { resolve, dirname } from 'node:path';
import { localArchive } from '../cli/cache.js';
import { alias, loadDaemonConfig, selectedCollections } from './config.js';
import { PostgresHistoryStore } from './history-store.js';
import { prepareCollection } from './sync.js';
import { startBraidServer, type BraidServer } from './braid.js';

/** Local-only serving, independent of the provider scheduler and credentials. */
export async function braidCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const string = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const file = string('config');
  const selectors = string('collections');
  if (!file || !selectors)
    throw new Error('Supply --config and --collections for Braid');
  const config = await loadDaemonConfig(file);
  const selected = selectedCollections(config, selectors.split(','));
  const portText = string('braid-port') ?? '9888';
  if (
    !/^\d+$/.test(portText) ||
    Number(portText) < 1 ||
    Number(portText) > 65535
  )
    throw new Error('Braid port must be 1–65535');
  const archive = localArchive();
  const store = new PostgresHistoryStore(
    archive.pool,
    config.owner,
    config.workspaceDirectory ??
      resolve(dirname(config.dataDirectory), 'workspace'),
  );
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let server: BraidServer | undefined;
  try {
    await archive.initialize();
    await store.initialize();
    const collections = await Promise.all(
      selected.map(async (source) => ({
        alias: alias(source),
        scope: (await prepareCollection(config.owner, source)).scope,
      })),
    );
    const allowedOrigin = string('braid-origin');
    if (controller.signal.aborted) return;
    server = await startBraidServer({
      store,
      collections,
      token: process.env.SYNCABLES_BRAID_TOKEN ?? '',
      port: Number(portText),
      ...(allowedOrigin === undefined ? {} : { allowedOrigin }),
    });
    process.stdout.write(
      JSON.stringify({
        braid: 'listening',
        readOnly: true,
        collections: collections.map((c) => ({
          alias: c.alias,
          url: server!.url + '/collections/' + encodeURIComponent(c.alias),
        })),
      }) + '\n',
    );
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), {
        once: true,
      });
      if (controller.signal.aborted) resolve();
    });
  } finally {
    await server?.close();
    await archive.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
