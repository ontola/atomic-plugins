import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import {
  PostgresHistoryStore,
  scopeRef,
} from '../../../src/daemon/history-store.js';
import {
  GitAtomicStore,
  type AtomicSnapshot,
} from '../../../src/daemon/git-store.js';
import {
  historyGit,
  importGitHistory,
  exportGitHistory,
} from '../../../src/daemon/git-io.js';
import { nodeHash } from '../../../src/postgres/json-graph.js';
import { DaemonAuth } from '../../../src/daemon/auth.js';
import { daemonCommand } from '../../../src/daemon/commands.js';
import { prepareCollection } from '../../../src/daemon/sync.js';

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
const prefix = 'snapshot-history-' + randomUUID();
const SUBJECT = 'urn:example:note';
const VALUE = 'urn:example:value';
const raw = (value: string): string =>
  `{"@id":"${SUBJECT}","${VALUE}":${value}}`;

describe.skipIf(!database)(
  'PostgreSQL snapshot history and Git round trips',
  () => {
    let archive: PostgresArchive;
    let root: string;
    let counter = 0;
    beforeAll(async () => {
      archive = new PostgresArchive(database!);
      await archive.initialize();
      root = await mkdtemp(join(tmpdir(), 'syncables-history-'));
    });
    afterAll(async () => {
      if (!archive) return;
      for (const table of [
        'snapshot_import_refs',
        'snapshot_imports',
        'snapshot_git_tags',
        'snapshot_refs',
        'snapshot_members',
        'snapshot_revisions',
        'daemon_jobs',
        'json_nodes',
      ])
        await archive.pool.query(
          `DELETE FROM syncables_cache.${table} WHERE owner LIKE $1`,
          [prefix + '%'],
        );
      await archive.close();
      await rm(root, { recursive: true, force: true });
    });
    async function fixture(): Promise<{
      store: PostgresHistoryStore;
      git: GitAtomicStore;
      scope: string;
      owner: string;
      dir: string;
      snapshot: (value: string, message?: string) => AtomicSnapshot;
    }> {
      const owner = prefix + '-' + counter++;
      const dir = join(root, String(counter));
      const store = new PostgresHistoryStore(
        archive.pool,
        owner,
        join(dir, 'workspace'),
      );
      await store.initialize();
      const git = new GitAtomicStore(join(dir, 'legacy.git'));
      await git.initialize();
      const scope = JSON.stringify([owner, 'connection', 'notes']);
      const snapshot = (value: string, message?: string): AtomicSnapshot => ({
        scope,
        context: { owner, resource: 'note' },
        resources: new Map([[SUBJECT, raw(value)]]),
        ...(message ? { message } : {}),
      });
      return { store, git, scope, owner, dir, snapshot };
    }
    it('shares hash-addressed JSON nodes, rejects stale heads and scopes reads by owner', async () => {
      const { store, scope, owner, snapshot } = await fixture();
      const one = await store.commit(
        snapshot('{"id":9007199254740993,"n":1.2300}'),
      );
      const count = async (): Promise<number> =>
        Number(
          (
            await archive.pool.query(
              'SELECT count(*) FROM syncables_cache.json_nodes WHERE owner=$1',
              [owner],
            )
          ).rows[0].count,
        );
      // Initializing another client must not repeat index DDL while a writer
      // holds row locks on revisions and membership (lock-order inversion).
      await Promise.all([
        store.initialize(),
        store.initialize(),
        store.initialize(),
      ]);
      const writer = await archive.pool.connect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let initializing: Promise<void> | undefined;
      try {
        await writer.query('BEGIN');
        await writer.query(
          'LOCK TABLE syncables_cache.snapshot_revisions IN ACCESS EXCLUSIVE MODE',
        );
        initializing = store.initialize();
        await Promise.race([
          initializing,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('Initialized history repeated revision-table DDL'),
                ),
              2000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        await writer.query('ROLLBACK');
        writer.release();
        await initializing?.catch(() => {});
      }
      const firstCount = await count();
      const two = await store.commit(
        snapshot('{"id":9007199254740993,"n":1.2300}', 'same data, new intent'),
        one,
      );
      expect(two).not.toBe(one);
      expect(await count()).toBe(firstCount);
      expect(await store.resource(scope, SUBJECT)).toContain(
        '9007199254740993',
      );
      expect(await store.resource(scope, SUBJECT)).toContain('1.2300');
      await expect(store.commit(snapshot('2'), one)).rejects.toThrow('changed');
      expect(await store.head(scope)).toBe(two);
      const controller = new AbortController();
      controller.abort();
      await expect(
        store.commit(snapshot('3'), two, controller.signal),
      ).rejects.toThrow('stopped');
      expect(await store.head(scope)).toBe(two);
      const competing = await Promise.allSettled([
        store.commit(snapshot('3', 'writer A'), two),
        store.commit(snapshot('4', 'writer B'), two),
      ]);
      expect(competing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter((r) => r.status === 'rejected')).toHaveLength(1);
      const winner = competing.find((r) => r.status === 'fulfilled');
      expect(await store.head(scope)).toBe(
        winner?.status === 'fulfilled' ? winner.value : undefined,
      );
      const other = new PostgresHistoryStore(
        archive.pool,
        owner + 'other',
        join(root, 'other'),
      );
      expect(await other.head(scope)).toBeUndefined();
      await expect(other.revision(one)).rejects.toThrow('Unknown');
      await expect(
        store.commit(
          { ...snapshot('1'), context: { owner: 'someone-else' } },
          await store.head(scope),
        ),
      ).rejects.toThrow('owner');
    });
    it('imports branch/merge/tag history atomically, exports the exact original commits and is idempotent after new syncs', async () => {
      const { store, git, scope, snapshot, dir } = await fixture();
      const one = await git.commit(snapshot('1', 'first\n\nDetailed intent α'));
      const two = await git.commit(snapshot('2', 'second'), one);
      const branch = scopeRef(scope);
      await historyGit(git.directory, ['update-ref', 'refs/heads/side', one]);
      const tree = (
        await historyGit(git.directory, ['rev-parse', one + '^{tree}'])
      ).trim();
      const identity = 'Tester <test@example.invalid> 1700000000 +0230';
      const side = (
        await historyGit(
          git.directory,
          ['hash-object', '-w', '-t', 'commit', '--stdin'],
          `tree ${tree}\nparent ${one}\nauthor ${identity}\ncommitter ${identity}\n\nside intent\n`,
        )
      ).trim();
      await historyGit(git.directory, ['update-ref', 'refs/heads/side', side]);
      const mergeTree = (
        await historyGit(git.directory, ['rev-parse', two + '^{tree}'])
      ).trim();
      const merge = (
        await historyGit(
          git.directory,
          ['hash-object', '-w', '-t', 'commit', '--stdin'],
          `tree ${mergeTree}\nparent ${two}\nparent ${side}\nauthor ${identity}\ncommitter ${identity}\n\nmerge intent\n`,
        )
      ).trim();
      await historyGit(git.directory, ['update-ref', branch, merge]);
      await git.tag(scope, 'baseline', one);
      const tag = (
        await historyGit(
          git.directory,
          ['hash-object', '-w', '-t', 'tag', '--stdin'],
          `object ${merge}\ntype commit\ntag annotated\ntagger ${identity}\n\nTag intent\n`,
        )
      ).trim();
      await historyGit(git.directory, [
        'update-ref',
        'refs/tags/annotated',
        tag,
      ]);
      const originalRefs = await historyGit(git.directory, [
        'for-each-ref',
        '--format=%(refname) %(objectname)',
      ]);
      const imported = await importGitHistory(store, git.directory);
      expect(imported.revisions).toBe(4);
      expect(imported.refs).toBe(4);
      expect(await store.resolveRevision(scope, one)).toBe(
        imported.mapping[one],
      );
      const exported = await exportGitHistory(store, {
        scope,
        output: join(dir, 'export'),
      });
      expect(
        await historyGit(exported.directory, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
        ]),
      ).toBe(originalRefs);
      for (const [original, id] of Object.entries(imported.mapping))
        expect(exported.mapping[id]).toBe(original);
      expect(
        await historyGit(git.directory, [
          'for-each-ref',
          '--format=%(refname) %(objectname)',
        ]),
      ).toBe(originalRefs);
      expect(
        (
          await historyGit(exported.directory, ['status', '--porcelain'])
        ).trim(),
      ).toBe('');
      await expect(
        exportGitHistory(store, { scope, output: exported.directory }),
      ).rejects.toThrow('exists');
      const next = await store.commit(
        snapshot('3', 'after migration'),
        await store.head(scope),
      );
      await importGitHistory(store, git.directory);
      expect(await store.head(scope)).toBe(next);
      await historyGit(git.directory, ['update-ref', 'refs/heads/side', one]);
      await expect(importGitHistory(store, git.directory)).rejects.toThrow(
        'refs changed',
      );
      expect(await store.head(scope)).toBe(next);
    });
    it('preserves disappearance, reappearance, empty projected commits and numeric lexemes in item exports', async () => {
      const { store, scope, snapshot, dir } = await fixture();
      const one = await store.commit(
        snapshot('{"n":9007199254740993,"decimal":1.2300}', 'present'),
      );
      const two = await store.commit(
        { ...snapshot('null', 'absent'), resources: new Map() },
        one,
      );
      const three = await store.commit(
        snapshot('{"n":9007199254740993,"decimal":1.2300}', 'reappeared'),
        two,
      );
      await store.tag(scope, 'before', one);
      const exported = await exportGitHistory(store, {
        scope,
        subject: SUBJECT,
        output: join(dir, 'subtree'),
      });
      expect(exported.revisions).toBe(3);
      const file = 'r-' + nodeHash(SUBJECT) + '.json';
      expect(
        await historyGit(exported.directory, [
          'show',
          exported.mapping[one] + ':' + file,
        ]),
      ).toContain('9007199254740993');
      expect(
        await historyGit(exported.directory, [
          'ls-tree',
          '--name-only',
          exported.mapping[two],
        ]),
      ).not.toContain(file);
      expect(
        await historyGit(exported.directory, [
          'show',
          exported.mapping[three] + ':' + file,
        ]),
      ).toContain('1.2300');
      expect(
        (await store.historyEntries(scope, SUBJECT)).map((r) => r.commit),
      ).toEqual([three, two, one]);
    });
    it('does not publish any import ref if a legacy snapshot has another owner', async () => {
      const { store, git, scope, snapshot } = await fixture();
      await git.commit(snapshot('1'));
      await git.commit({
        ...snapshot('2'),
        scope: 'other',
        context: { owner: 'someone-else' },
      });
      await expect(importGitHistory(store, git.directory)).rejects.toThrow(
        'owner mismatch',
      );
      expect(await store.head(scope)).toBeUndefined();
    });
    it('materializes without Git and preserves local edits, additions, symlinks and legacy folders', async () => {
      const { store, scope, snapshot, dir } = await fixture();
      const one = await store.commit(snapshot('1'));
      const checkout = await store.checkout(scope, 'example/work/notes');
      expect(checkout?.revision).toBe(one);
      expect(await readdir(checkout!.directory)).not.toContain('.git');
      await store.commit(snapshot('2', 'new'), one);
      await writeFile(join(checkout!.directory, 'local.txt'), 'local');
      await expect(store.checkout(scope, 'example/work/notes')).rejects.toThrow(
        'local additions',
      );
      await rm(join(checkout!.directory, 'local.txt'));
      const file = join(
        checkout!.directory,
        'r-' + nodeHash(SUBJECT) + '.json',
      );
      await writeFile(file, 'local edits');
      await expect(store.checkout(scope, 'example/work/notes')).rejects.toThrow(
        'local edits',
      );
      expect(await readFile(file, 'utf8')).toBe('local edits');
      await writeFile(file, raw('1'));
      await store.checkout(scope, 'example/work/notes');
      expect(await readFile(file, 'utf8')).toBe(raw('2'));
      await symlink(checkout!.directory, join(dir, 'workspace', 'linked'));
      await expect(store.checkout(scope, 'linked/work/notes')).rejects.toThrow(
        'symlink',
      );
      const noGit = process.env.PATH;
      vi.stubEnv('PATH', '/nonexistent');
      try {
        expect(await store.head(scope)).toBeDefined();
        expect(await store.checkout(scope, 'example/work/notes')).toBeDefined();
      } finally {
        vi.stubEnv('PATH', noGit!);
      }
    });
    it('exposes migrate, PostgreSQL checkout, history and subtree export through the CLI without authentication', async () => {
      const { store, git, owner, dir } = await fixture();
      const document = join(dir, 'source.json');
      await writeFile(
        document,
        JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Invented', version: '1' },
          servers: [{ url: 'https://example.invalid' }],
          paths: {
            '/notes': {
              get: { responses: { '200': { description: 'Notes' } } },
            },
          },
          components: {
            crudResources: {
              note: {
                identity: {
                  urlTemplate: '/notes/{id}',
                  bindings: { id: { field: 'id' } },
                },
                collections: {
                  notes: {
                    urlTemplate: '/notes',
                    envelope: { itemsField: 'notes' },
                  },
                },
              },
            },
          },
        }),
      );
      const source = {
        platform: 'example',
        account: 'work',
        name: 'notes',
        connection: 'c',
        document,
        collection: 'notes',
        bindings: {},
        query: {},
        pollSeconds: 0,
      };
      const prepared = await prepareCollection(owner, source);
      await git.commit({
        scope: prepared.scope,
        context: { owner, resource: 'note' },
        resources: new Map([[SUBJECT, raw('9007199254740993')]]),
      });
      const config = join(dir, 'config.json');
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          owner,
          dataDirectory: git.directory,
          workspaceDirectory: store.checkoutDirectory,
          collections: [source],
        }),
      );
      vi.stubEnv('SYNCABLES_DATABASE_URL', database!);
      const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
      try {
        await expect(daemonCommand(['sync'], { config })).rejects.toThrow(
          'Run migrate git',
        );
        await daemonCommand(['migrate', 'git'], { config });
        expect(JSON.parse(String(output.mock.calls.at(-1)![0])).revisions).toBe(
          1,
        );
        await daemonCommand(['history'], {
          config,
          collection: 'example/work/notes',
        });
        expect(
          JSON.parse(String(output.mock.calls.at(-1)![0])).entries,
        ).toHaveLength(1);
        await daemonCommand(['checkout'], { config });
        expect(
          JSON.parse(String(output.mock.calls.at(-1)![0]))[0].directory,
        ).toContain('workspace');
        await daemonCommand(['export', 'git'], {
          config,
          subtree: 'example/work/notes',
          output: join(dir, 'cli-export'),
        });
        expect(JSON.parse(String(output.mock.calls.at(-1)![0])).revisions).toBe(
          2,
        );
        // Preserving an imported archive must not block a later new source scope.
        const nextSource = { ...source, connection: 'new-invented-connection' };
        await writeFile(
          config,
          JSON.stringify({
            version: 1,
            owner,
            dataDirectory: git.directory,
            workspaceDirectory: join(dir, 'new-workspace'),
            collections: [nextSource],
          }),
        );
        const session = vi
          .spyOn(DaemonAuth.prototype, 'session')
          .mockRejectedValue(new Error('Login required: invented test'));
        const previousExitCode = process.exitCode;
        try {
          await daemonCommand(['sync'], { config });
          expect(session).toHaveBeenCalledOnce();
          expect(
            JSON.parse(String(output.mock.calls.at(-1)![0]))[0].error,
          ).toContain('Authorization needs attention');
        } finally {
          session.mockRestore();
          process.exitCode = previousExitCode;
        }
      } finally {
        output.mockRestore();
        vi.unstubAllEnvs();
      }
    });
  },
);
