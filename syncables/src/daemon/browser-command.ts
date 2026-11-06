// @wc-ignore-file
import { dirname, resolve } from 'node:path';
import { localArchive } from '../cli/cache.js';
import { alias, loadDaemonConfig, selectedCollections } from './config.js';
import { PostgresHistoryStore } from './history-store.js';
import { jobStatuses } from './runner.js';
import { prepareCollection } from './sync.js';
import { startBrowserServer, type BrowserServer } from './browser-server.js';

/** Browse local committed data independently of the provider scheduler. */
export async function browserCommand(
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const file = values.config;
  if (typeof file !== 'string' || !file)
    throw new Error('Supply --config for the data browser');
  const config = await loadDaemonConfig(file);
  const selectors =
    typeof values.collections === 'string' ? values.collections.split(',') : [];
  const selected = selectedCollections(config, selectors);
  const port = values['browser-port'] ?? '9889';
  if (
    typeof port !== 'string' ||
    !/^\d+$/.test(port) ||
    Number(port) < 1 ||
    Number(port) > 65535
  ) {
    throw new Error('Browser port must be 1–65535');
  }
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
  let server: BrowserServer | undefined;
  try {
    await archive.initialize();
    await store.initialize();
    const jobs = await jobStatuses(archive, config.owner);
    const collections = await Promise.all(
      selected.map(async (source) => ({
        alias: alias(source),
        scope:
          jobs.find((job) => job.alias === alias(source))?.scope ??
          (await prepareCollection(config.owner, source)).scope,
      })),
    );
    if (controller.signal.aborted) return;
    server = await startBrowserServer({
      store,
      collections,
      port: Number(port),
    });
    process.stdout.write(
      `SyncD data browser: ${server.url}\nRead-only local snapshots. Press Ctrl+C to stop.\n`,
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
