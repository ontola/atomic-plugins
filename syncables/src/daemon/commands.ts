import { localArchive } from '../cli/cache.js';
import {
  loadDaemonConfig,
  alias,
  itemSubject,
  selectedCollections,
  type DaemonConfig,
} from './config.js';
import { GitAtomicStore } from './git-store.js';
import { DaemonAuth, KeychainCredentials } from './auth.js';
import { DaemonRunner, jobStatuses } from './runner.js';
import { SOURCE_ID, SOURCE_JSON } from './sync.js';

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
  store: GitAtomicStore;
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
  const archive = localArchive();
  const store = new GitAtomicStore(config.dataDirectory);
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await archive.initialize();
    await store.initialize();
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
      if (!job)
        throw new Error('Collection has not been initialized; run sync');
      const scope = job.scope;
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
        const context = await store.context(scope);
        if (typeof context.resource !== 'string')
          throw new Error('Missing source resource context');
        const source = config.collections.find((c) => alias(c) === name)!;
        const subject =
          positionals[1] === undefined
            ? undefined
            : itemSubject(
                config.owner,
                source,
                context.resource,
                positionals[1],
              );
        write({
          collection: name,
          ...(subject ? { subject } : {}),
          revisions: await store.history(scope, subject),
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
    const auth = new DaemonAuth(
      config,
      archive,
      values.interactive ? undefined : new KeychainCredentials(config),
    );
    if (command === 'login' || values.interactive) {
      await auth.login((message) => process.stderr.write(message + '\n'));
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
    const runner = new DaemonRunner(config, archive, store, auth);
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
