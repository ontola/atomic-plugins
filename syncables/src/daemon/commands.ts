import { EDIT_COMMANDS, editCommand } from './edit-commands.js';
import { lstat, realpath, readFile } from 'node:fs/promises';
import type { SnapshotStore } from './snapshot-store.js';
import { resolve, dirname } from 'node:path';
import { PostgresHistoryStore } from './history-store.js';
import { importGitHistory, exportGitHistory } from './git-io.js';
import { runAtomicTablesPeer } from './atomic-peer.js';
import type { ProjectionContract } from './atomic-tables.js';
import { localArchive } from '../cli/cache.js';
import {
  loadDaemonConfig,
  alias,
  itemSubject,
  selectedCollections,
  type DaemonConfig,
} from './config.js';
import { validateCommitMessage } from './git-store.js';
import { DaemonAuth, KeychainCredentials } from './auth.js';
import { DaemonRunner, jobStatuses } from './runner.js';
import {
  SOURCE_ID,
  SOURCE_JSON,
  prepareCollection,
  upgradeSourceClasses,
} from './sync.js';

function write(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}
function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error('Supply --' + name);
  return value;
}
function positive(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error('Invalid page or page-size');
  return parsed;
}
function pointer(value: unknown, path: string): unknown {
  if (!path.startsWith('/') || /~(?![01])/.test(path))
    throw new Error('Use a JSON Pointer starting with /');
  for (const key of path
    .slice(1)
    .split('/')
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
  )
    throw new Error(
      'Filtering/ordering unsafe numeric values is unsupported; raw data is preserved',
    );
  if (value !== null && typeof value === 'object')
    throw new Error('Filter and order-by must select scalar values');
  return value;
}
async function browse(options: {
  config: DaemonConfig;
  store: SnapshotStore;
  scope: string;
  path: string[];
  at?: string;
  filter?: string;
  order?: string;
  page?: string;
  size?: string;
}): Promise<void> {
  const { config, store, scope, path } = options;
  const commit = await store.resolveRevision(scope, options.at);
  const rows = (await store.list(scope, commit))
    .map((raw) => ({ raw, data: JSON.parse(raw) as Record<string, unknown> }))
    .filter((row) => Object.hasOwn(row.data, SOURCE_ID));
  if (path.length === 4) {
    const row = rows.find((r) => r.data[SOURCE_ID] === path[3]);
    if (!row) throw new Error('Item not present in this revision');
    process.stdout.write(
      '{"commit":' + JSON.stringify(commit) + ',"resource":' + row.raw + '}\n',
    );
    return;
  }
  let filtered = rows;
  if (options.filter) {
    const split = options.filter.indexOf('=');
    if (split < 1) throw new Error('Use --filter /json/pointer=JSON_SCALAR');
    const key = options.filter.slice(0, split);
    const wanted: unknown = JSON.parse(options.filter.slice(split + 1));
    if (
      wanted !== null &&
      !['boolean', 'number', 'string'].includes(typeof wanted)
    )
      throw new Error('Filter value must be a JSON scalar');
    if (
      typeof wanted === 'number' &&
      (!Number.isFinite(wanted) || Math.abs(wanted) > Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Unsafe numeric filter value');
    filtered = rows.filter(
      (row) => pointer(row.data[SOURCE_JSON], key) === wanted,
    );
  }
  const order = options.order?.replace(/:(asc|desc)$/, '');
  const direction = options.order?.endsWith(':desc') ? -1 : 1;
  const compare = (a: unknown, b: unknown): number => {
    const kind = (v: unknown): string => (v === null ? 'null' : typeof v);
    if (kind(a) !== kind(b)) return kind(a) < kind(b) ? -1 : 1;
    if (a === b) return 0;
    return (a as string | number) < (b as string | number) ? -1 : 1;
  };
  filtered.sort((a, b) => {
    const primary = order
      ? compare(
          pointer(a.data[SOURCE_JSON], order),
          pointer(b.data[SOURCE_JSON], order),
        ) * direction
      : 0;
    return primary || compare(a.data['@id'], b.data['@id']);
  });
  const page = positive(options.page, 1, 100_000);
  const pageSize = positive(options.size, 50, 1000);
  const selected = filtered.slice((page - 1) * pageSize, page * pageSize);
  process.stdout.write(
    JSON.stringify({
      owner: config.owner,
      collection: path.join('/'),
      commit,
      page,
      pageSize,
      total: filtered.length,
    }).slice(0, -1) +
      ',"resources":[' +
      selected.map((r) => r.raw).join(',') +
      ']}\n',
  );
}
export async function daemonCommand(
  positionals: string[],
  values: Record<string, string | boolean | undefined>,
): Promise<void> {
  const string = (key: string): string | undefined =>
    typeof values[key] === 'string' ? (values[key] as string) : undefined;
  const config = await loadDaemonConfig(
    requireValue(string('config'), 'config'),
  );
  const command = positionals[0];
  const message = string('message');
  if (message !== undefined) {
    if (command !== 'sync' && command !== 'daemon')
      throw new Error('--message is supported by sync and daemon only');
    validateCommitMessage(message);
  }
  if (string('subject') !== undefined && command !== 'history')
    throw new Error('--subject is supported by history only');
  if (string('projection-contract') !== undefined && command !== 'atomic-peer')
    throw new Error('--projection-contract is supported by atomic-peer only');
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
  try {
    await archive.initialize();
    await store.initialize();
    if (EDIT_COMMANDS.includes(command)) {
      await editCommand(
        config,
        archive,
        store,
        positionals,
        values,
        controller.signal,
      );
      return;
    }
    if (command === 'atomic-peer') {
      if (positionals.length !== 1)
        throw new Error('Unexpected command arguments');
      if (string('collection') && string('collections'))
        throw new Error('Use --collection or --collections, not both');
      const selectors =
        (string('collections') ?? string('collection'))?.split(',') ?? [];
      const prepared = await Promise.all(
        selectedCollections(config, selectors).map((source) =>
          prepareCollection(config.owner, source),
        ),
      );
      let projectionContracts: ProjectionContract[] = [];
      if (string('projection-contract')) {
        const contents = await readFile(
          resolve(string('projection-contract')!),
        );
        if (contents.byteLength > 1024 * 1024)
          throw new Error('Projection contract file exceeds 1 MiB');
        const parsed: unknown = JSON.parse(contents.toString('utf8'));
        // The projector validates the complete contract before native allocation.
        projectionContracts = (
          Array.isArray(parsed) ? parsed : [parsed]
        ) as ProjectionContract[];
      }
      await runAtomicTablesPeer(
        store,
        {
          binary: resolve(requireValue(string('peer-binary'), 'peer-binary')),
          directory: resolve(
            requireValue(string('peer-directory'), 'peer-directory'),
          ),
          signerFile: resolve(
            requireValue(string('signer-file'), 'signer-file'),
          ),
          owner: config.owner,
          collections: prepared,
          readers: requireValue(string('reader'), 'reader').split(','),
          port: Number(string('peer-port') ?? '9901'),
          projectionContracts,
          ...(string('at') ? { at: string('at')! } : {}),
        },
        controller.signal,
        write,
      );
      return;
    }
    if (command === 'migrate') {
      if (positionals.length !== 2 || positionals[1] !== 'git')
        throw new Error('Use migrate git --config FILE [--source ARCHIVE]');
      write(
        await importGitHistory(store, string('source') ?? config.dataDirectory),
      );
      return;
    }
    if (command === 'export') {
      if (positionals.length !== 2 || positionals[1] !== 'git')
        throw new Error(
          'Use export git --subtree PLATFORM/ACCOUNT/COLLECTION --output DIRECTORY',
        );
      const path = requireValue(string('subtree'), 'subtree')
        .replace(/^\//, '')
        .split('/');
      if (path.length < 3 || path.length > 4 || path.some((p) => !p))
        throw new Error(
          'Select a collection subtree, optionally followed by an encoded item ID',
        );
      const name = path.slice(0, 3).join('/');
      const source = selectedCollections(config, [name])[0];
      const job = (await jobStatuses(archive, config.owner)).find(
        (j) => j.alias === name,
      );
      const scope =
        job?.scope ?? (await prepareCollection(config.owner, source)).scope;
      const at = string('at');
      const branches = string('branches') ?? 'all';
      if (branches !== 'all' && branches !== 'current')
        throw new Error('Use --branches all or current');
      const context = await store.context(scope, at);
      if (path.length === 4 && typeof context.resource !== 'string')
        throw new Error('Missing source resource context');
      const subject =
        path.length === 4
          ? itemSubject(
              config.owner,
              source,
              String(context.resource),
              decodeURIComponent(path[3]),
            )
          : undefined;
      write(
        await exportGitHistory(store, {
          scope,
          output: requireValue(string('output'), 'output'),
          branches,
          ...(at ? { at } : {}),
          ...(subject ? { subject } : {}),
        }),
      );
      return;
    }
    if (command === 'checkout') {
      if (positionals.length !== 1)
        throw new Error('Unexpected command arguments');
      const results: {
        alias: string;
        directory?: string;
        revision?: string;
        error?: string;
      }[] = [];
      for (const source of selectedCollections(
        config,
        string('collections')?.split(',') ?? [],
      )) {
        const prepared = await prepareCollection(config.owner, source);
        await store.checkout(prepared.scope, alias(source));
        await upgradeSourceClasses(prepared, store);
        const checkout = await store.checkout(prepared.scope, alias(source));
        results.push({
          alias: alias(source),
          ...(checkout ?? {
            error:
              'No PostgreSQL snapshot; run migrate git for existing histories or sync for new data',
          }),
        });
      }
      write(results);
      if (results.some((r) => 'error' in r)) process.exitCode = 1;
      return;
    }
    if (command === 'status') {
      write(await jobStatuses(archive, config.owner));
      return;
    }
    if (['browse', 'resource', 'history', 'tag'].includes(command)) {
      const path =
        command === 'browse'
          ? (positionals[1]?.split('/') ?? [])
          : requireValue(string('collection'), 'collection').split('/');
      if (path.length === 4) path[3] = decodeURIComponent(path[3]);
      if (positionals.length > 2 || path.length > 4 || path.some((s) => !s))
        throw new Error('Invalid browse path');
      if (path.length < 3) {
        if (command !== 'browse')
          throw new Error('Select a complete collection');
        write(
          [
            ...new Set(
              config.collections
                .filter(
                  (c) =>
                    alias(c).split('/').slice(0, path.length).join('/') ===
                    path.join('/'),
                )
                .map((c) => alias(c).split('/')[path.length]),
            ),
          ].sort(),
        );
        return;
      }
      const name = path.slice(0, 3).join('/');
      selectedCollections(config, [name]);
      const job = (await jobStatuses(archive, config.owner)).find(
        (j) => j.alias === name,
      );
      const source = config.collections.find((c) => alias(c) === name)!;
      const scope =
        job?.scope ?? (await prepareCollection(config.owner, source)).scope;
      if (command === 'tag') {
        if (!positionals[1]) throw new Error('Supply a tag name');
        write({
          tag: positionals[1],
          commit: await store.tag(scope, positionals[1], string('at')),
        });
      } else if (command === 'resource') {
        if (!positionals[1]) throw new Error('Supply a resource or schema IRI');
        const result = await store.resolve(scope, positionals[1], string('at'));
        if (!result.resource)
          throw new Error('Resource or schema absent from this snapshot');
        process.stdout.write(
          '{"commit":' +
            JSON.stringify(result.commit) +
            ',"resource":' +
            result.resource +
            '}\n',
        );
      } else if (command === 'history') {
        if (positionals[1] !== undefined && string('subject') !== undefined)
          throw new Error('Select either an item ID or --subject IRI');
        const context = await store.context(scope);
        if (typeof context.resource !== 'string')
          throw new Error('Missing source resource context');
        const source = config.collections.find((c) => alias(c) === name)!;
        const subject =
          string('subject') ??
          (positionals[1] === undefined
            ? undefined
            : itemSubject(
                config.owner,
                source,
                context.resource,
                positionals[1],
              ));
        if (
          subject !== undefined &&
          !/^(https?:\/\/|urn:)[^\s]+$/.test(subject)
        )
          throw new Error('Supply an absolute resource or schema IRI');
        const commit = await store.resolveRevision(scope, string('at'));
        const entries = await store.historyEntries(scope, subject, commit);
        write({
          collection: name,
          commit,
          ...(subject ? { subject } : {}),
          revisions: entries.map((entry) => entry.commit),
          entries,
        });
      } else
        await browse({
          config,
          store,
          scope,
          path,
          ...(string('at') ? { at: string('at')! } : {}),
          ...(string('filter') ? { filter: string('filter')! } : {}),
          ...(string('order-by') ? { order: string('order-by')! } : {}),
          ...(string('page') ? { page: string('page')! } : {}),
          ...(string('page-size') ? { size: string('page-size')! } : {}),
        });
      return;
    }
    if (positionals.length !== 1)
      throw new Error('Unexpected command arguments');
    if (command === 'sync' || command === 'daemon') {
      const legacy = await lstat(config.dataDirectory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
          return undefined;
        },
      );
      const imported = legacy
        ? (
            await archive.pool.query(
              'SELECT 1 FROM syncables_cache.snapshot_import_refs WHERE owner=$1 AND source=$2 LIMIT 1',
              [config.owner, await realpath(config.dataDirectory)],
            )
          ).rowCount !== 0
        : false;
      if (legacy && !imported) {
        for (const source of selectedCollections(
          config,
          string('collections')?.split(',') ?? [],
        )) {
          const prepared = await prepareCollection(config.owner, source);
          if (!(await store.head(prepared.scope)))
            throw new Error(
              'Existing Git archive found. Run migrate git before syncing into PostgreSQL; original history is preserved.',
            );
        }
      }
    }
    const auth = new DaemonAuth(
      config,
      archive,
      values.interactive ? undefined : new KeychainCredentials(config),
    );
    if (command === 'login' || values.interactive) {
      await auth.login(
        (message) => process.stderr.write(message + '\n'),
        values.write === true,
      );
      if (command === 'login') {
        write({ login: 'approved', persistent: !values.interactive });
        return;
      }
    }
    if (command === 'logout') {
      await auth.logout();
      write({ logout: 'complete' });
      return;
    }
    const runner = new DaemonRunner(
      config,
      archive,
      store,
      auth,
      globalThis.fetch,
      message,
    );
    const selectors = string('collections')?.split(',') ?? [];
    selectedCollections(config, selectors);
    await runner.initialize();
    if (command === 'sync') {
      const results = await runner.sync(selectors, controller.signal);
      write(results);
      if (results.some((r) => r.error) || controller.signal.aborted)
        process.exitCode = 1;
    } else if (command === 'daemon') {
      await runner.daemon(
        controller.signal,
        write,
        selectors,
        process.env.SYNCABLES_WEBHOOK_TOKEN,
      );
    } else throw new Error('Unknown daemon command');
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await archive.close();
  }
}
