// @wc-ignore-file
import { manageAccess } from './management.js';
import { DaemonAuth, KeychainCredentials } from './auth.js';
import { loadBrowserStatus, browserJobMatches } from './browser-status.js';
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
    const auth = new DaemonAuth(
      config,
      archive,
      values.interactive || values.manage
        ? undefined
        : new KeychainCredentials(config),
    );
    if (values.interactive || values.manage)
      await auth.login(
        (message) => process.stderr.write(message + '\n'),
        false,
        values.manage === true,
      );
    const jobs = await jobStatuses(archive, config.owner);
    const collections = await Promise.all(
      selected.map(async (source) => ({
        alias: alias(source),
        scope:
          jobs.find(
            (job) =>
              job.alias === alias(source) &&
              browserJobMatches(job, config.owner, source),
          )?.scope ?? (await prepareCollection(config.owner, source)).scope,
      })),
    );
    if (controller.signal.aborted) return;
    server = await startBrowserServer({
      store,
      collections,
      port: Number(port),
      management: {
        issuer: config.issuer,
        request: async (action) =>
          manageAccess(await auth.session(), config.owner, action),
      },
      status: () =>
        loadBrowserStatus({
          owner: config.owner,
          collections: selected,
          jobs: async () => {
            const current = await jobStatuses(archive, config.owner);
            for (const collection of collections) {
              const job = current.find(
                (entry) =>
                  entry.alias === collection.alias &&
                  browserJobMatches(
                    entry,
                    config.owner,
                    selected.find(
                      (source) => alias(source) === collection.alias,
                    )!,
                  ),
              );
              if (job) collection.scope = job.scope;
            }
            return current;
          },
          hasSnapshot: async (name) => {
            const collection = collections.find(
              (entry) => entry.alias === name,
            );
            return Boolean(collection && (await store.head(collection.scope)));
          },
          session: () => auth.session(),
        }),
    });
    process.stdout.write(
      `SyncD data browser: ${server.url}\nLocal snapshots, connection status and IAP access management. Press Ctrl+C to stop.\n`,
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
