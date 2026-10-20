import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { indexJson, renderJson, nodeHash } from '../postgres/json-graph.js';

const FORMAT = 'syncables-json-ad-git-v1\n';
const REVISION = /^[a-f0-9]{64}$/;
export interface AtomicSnapshot {
  /** Stable local scope: verified owner, connection, collection and definition. */
  scope: string;
  resources: Map<string, string>;
  context: Record<string, unknown>;
}

/** Local-only JSON-AD snapshots. Git versions data; this is not Atomic native sync. */
export class GitAtomicStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
  }
  private async git(
    args: string[],
    input = '',
    allowMissing = false,
  ): Promise<string> {
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Syncables',
      GIT_AUTHOR_EMAIL: 'syncables@localhost',
      GIT_COMMITTER_NAME: 'Syncables',
      GIT_COMMITTER_EMAIL: 'syncables@localhost',
    });
    return new Promise<string>((done, reject) => {
      const child = spawn(
        'git',
        [
          '-c',
          'core.hooksPath=/dev/null',
          '-c',
          'protocol.allow=never',
          '--git-dir',
          this.directory,
          ...args,
        ],
        { env, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const chunks: Buffer[] = [];
      let size = 0;
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error('Local Git operation timed out');
        child.kill();
      }, 30_000);
      child.stdout.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          failure = new Error('Local Git output exceeds limit');
          child.kill();
        } else chunks.push(chunk);
      });
      child.stderr.resume();
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (failure) reject(failure);
        else if (code === 0) done(Buffer.concat(chunks).toString('utf8'));
        else if (allowMissing && code === 1) done('');
        else
          reject(
            new Error(
              `Local Git ${args[0]} failed; repository was not published`,
            ),
          );
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async initialize(): Promise<void> {
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    try {
      await mkdir(this.directory, { mode: 0o700 });
      await this.git([
        'init',
        '--bare',
        '--object-format=sha256',
        '--quiet',
        this.directory,
      ]);
      await writeFile(resolve(this.directory, 'SYNCABLES_FORMAT'), FORMAT, {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (
        (await readFile(
          resolve(this.directory, 'SYNCABLES_FORMAT'),
          'utf8',
        ).catch(() => '')) !== FORMAT
      )
        throw new Error(
          'Refusing to use an existing repository not initialized by Syncables',
        );
    }
  }
  private ref(scope: string): string {
    if (!scope || scope.length > 8192) throw new Error('Invalid data scope');
    return 'refs/heads/s-' + nodeHash(scope);
  }
  async head(scope: string): Promise<string | undefined> {
    return (
      (
        await this.git(
          ['for-each-ref', '--format=%(objectname)', this.ref(scope)],
          '',
          true,
        )
      ).trim() || undefined
    );
  }
  async commit(
    snapshot: AtomicSnapshot,
    expected?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (signal?.aborted) throw new Error('Data snapshot publication stopped');
    const current = await this.head(snapshot.scope);
    if (current !== expected)
      throw new Error('Data snapshot changed; refresh before publishing');
    const files: [string, string][] = [];
    if (snapshot.resources.size > 50_000)
      throw new Error('Data snapshot exceeds resource limit');
    let totalBytes = 0;
    for (const [subject, text] of snapshot.resources) {
      if (signal?.aborted) throw new Error('Data snapshot publication stopped');
      totalBytes += Buffer.byteLength(text);
      if (totalBytes > 16 * 1024 * 1024)
        throw new Error('Data snapshot exceeds the 16 MiB stage limit');
      if (!/^(https?:\/\/|urn:)/.test(subject))
        throw new Error('Atomic subject must be an absolute IRI');
      // Validation never reserializes through Number; graph decoding is lossless.
      const graph = indexJson(text);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || parsed['@id'] !== subject)
        throw new Error('JSON-AD resource must identify its subject with @id');
      for (const property of Object.keys(parsed))
        if (property !== '@id' && !/^(https?:\/\/|urn:)/.test(property))
          throw new Error('JSON-AD property must be an absolute IRI');
      const canonical = await renderJson(
        graph.root,
        async (hash) => graph.nodes.get(hash)!,
      );
      const blob = (
        await this.git(
          ['hash-object', '-w', '--stdin', '--no-filters'],
          canonical,
        )
      ).trim();
      files.push(['r-' + nodeHash(subject) + '.json', blob]);
    }
    const metadata = JSON.stringify({
      format: 'syncables-json-ad-git',
      version: 1,
      scope: snapshot.scope,
      context: snapshot.context,
    });
    const context = (
      await this.git(['hash-object', '-w', '--stdin', '--no-filters'], metadata)
    ).trim();
    files.push(['context.json', context]);
    files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const tree = (
      await this.git(
        ['mktree', '-z'],
        files.map(([name, hash]) => `100644 blob ${hash}\t${name}\0`).join(''),
      )
    ).trim();
    if (
      current &&
      (await this.git(['rev-parse', current + '^{tree}'])).trim() === tree
    )
      return current;
    const commit = (
      await this.git(
        ['commit-tree', tree, ...(current ? ['-p', current] : [])],
        'Syncables Atomic Data snapshot\n',
      )
    ).trim();
    // CAS publication is the only visible mutation; failed writers leave only
    // unreachable objects, never a partially visible data copy.
    if (signal?.aborted) throw new Error('Data snapshot publication stopped');
    await this.git([
      'update-ref',
      this.ref(snapshot.scope),
      commit,
      current ?? '0'.repeat(64),
    ]);
    return commit;
  }
  async resolveRevision(scope: string, revision?: string): Promise<string> {
    const head = await this.head(scope);
    if (!head) throw new Error('No data snapshot for this scope');
    if (!revision) return head;
    if (revision.startsWith('tag:')) {
      const ref = this.tagRef(scope, revision.slice(4));
      revision = (
        await this.git(['rev-parse', '--verify', ref + '^{commit}'])
      ).trim();
    }
    if (!REVISION.test(revision))
      throw new Error('Use a full commit ID or tag:NAME');
    const history = (await this.git(['rev-list', head])).trim().split('\n');
    if (!history.includes(revision))
      throw new Error('Revision does not belong to this data scope');
    return revision;
  }
  private tagRef(scope: string, name: string): string {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(name) ||
      name.includes('..') ||
      name.includes('//') ||
      name.endsWith('/') ||
      name.endsWith('.') ||
      name.split('/').some((part) => part.endsWith('.lock'))
    )
      throw new Error('Invalid data tag');
    return 'refs/tags/s-' + nodeHash(scope) + '/' + name;
  }
  /** Namespaced lightweight tags are create-only through this API. */
  async tag(scope: string, name: string, revision?: string): Promise<string> {
    const commit = await this.resolveRevision(scope, revision);
    await this.git([
      'update-ref',
      this.tagRef(scope, name),
      commit,
      '0'.repeat(64),
    ]);
    return commit;
  }
  async resolve(
    scope: string,
    subject: string,
    at?: string,
  ): Promise<{ commit: string; resource: string | undefined }> {
    const commit = await this.resolveRevision(scope, at);
    return { commit, resource: await this.resource(scope, subject, commit) };
  }
  async list(scope: string, revision?: string): Promise<string[]> {
    const commit = await this.resolveRevision(scope, revision);
    const names = (await this.git(['ls-tree', '--name-only', commit]))
      .trim()
      .split('\n')
      .filter((name) => /^r-[a-f0-9]{64}\.json$/.test(name));
    const result: string[] = [];
    for (const name of names)
      result.push(await this.git(['show', commit + ':' + name]));
    return result;
  }
  async context(
    scope: string,
    revision?: string,
  ): Promise<Record<string, unknown>> {
    const commit = await this.resolveRevision(scope, revision);
    const metadata = JSON.parse(
      await this.git(['show', commit + ':context.json']),
    ) as {
      format: string;
      version: number;
      scope: string;
      context: Record<string, unknown>;
    };
    if (
      metadata.format !== 'syncables-json-ad-git' ||
      metadata.version !== 1 ||
      metadata.scope !== scope
    )
      throw new Error('Invalid Atomic Data snapshot context');
    return metadata.context;
  }
  async resource(
    scope: string,
    subject: string,
    revision?: string,
  ): Promise<string | undefined> {
    const commit = await this.resolveRevision(scope, revision);
    const name = 'r-' + nodeHash(subject) + '.json';
    const names = await this.git([
      'ls-tree',
      '--name-only',
      commit,
      '--',
      name,
    ]);
    return names.trim() ? this.git(['show', commit + ':' + name]) : undefined;
  }
  async history(scope: string, subject?: string): Promise<string[]> {
    const head = await this.head(scope);
    if (!head) return [];
    const args = ['rev-list', head];
    if (subject) args.push('--', 'r-' + nodeHash(subject) + '.json');
    return (await this.git(args)).trim().split('\n').filter(Boolean);
  }
}
