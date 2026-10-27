import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { nodeHash } from '../postgres/json-graph.js';
import {
  PostgresHistoryStore,
  type ImportRevision,
  type ImportRef,
  type HistoryRevision,
  validateHistoryRef,
} from './history-store.js';

/** Git plumbing is deliberately confined to migration and explicit exports. */
export async function historyGit(
  directory: string,
  args: string[],
  input = '',
): Promise<string> {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (key.startsWith('GIT_')) delete env[key];
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  });
  return new Promise((done, reject) => {
    const child = spawn(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'protocol.allow=never',
        '-c',
        'submodule.recurse=false',
        '-C',
        directory,
        ...args,
      ],
      { env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error('Git history operation timed out');
      child.kill();
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        failure = new Error('Git history output exceeds limit');
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Git history ${args[0]} failed`));
      else done(Buffer.concat(chunks).toString('utf8'));
    });
    child.stdin.end(input);
  });
}
async function refs(
  directory: string,
): Promise<{ name: string; target: string }[]> {
  const text = await historyGit(directory, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]);
  return text
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, target] = line.split(' ');
      validateHistoryRef(name);
      return { name, target };
    });
}
function splitCommit(raw: string): {
  headers: string;
  message: string;
  parents: string[];
  author: string;
  committer: string;
} {
  const at = raw.indexOf('\n\n');
  if (at < 0) throw new Error('Invalid Git commit');
  const headers = raw.slice(0, at);
  const lines = headers.split('\n');
  const field = (name: string): string => {
    const value = lines
      .find((l) => l.startsWith(name + ' '))
      ?.slice(name.length + 1);
    if (!value) throw new Error('Missing Git ' + name);
    return value;
  };
  const author = field('author'),
    committer = field('committer');
  if (!/ \d+ [+-]\d{4}$/.test(author) || !/ \d+ [+-]\d{4}$/.test(committer))
    throw new Error('Invalid Git identity timestamp');
  return {
    headers,
    message: raw.slice(at + 2),
    parents: lines
      .filter((l) => l.startsWith('parent '))
      .map((l) => l.slice(7)),
    author,
    committer,
  };
}
export async function importGitHistory(
  store: PostgresHistoryStore,
  directory: string,
): Promise<{
  revisions: number;
  refs: number;
  mapping: Record<string, string>;
  source: string;
}> {
  directory = await realpath(directory);
  if (
    (await readFile(resolve(directory, 'SYNCABLES_FORMAT'), 'utf8')) !==
    'syncables-json-ad-git-v1\n'
  )
    throw new Error('Import requires a Syncables Git archive');
  if (
    (
      await historyGit(directory, ['rev-parse', '--show-object-format'])
    ).trim() !== 'sha256'
  )
    throw new Error('Unsupported legacy Git object format');
  const sourceRefs = await refs(directory);
  if (!sourceRefs.length) throw new Error('Legacy archive has no refs');
  const ids = (
    await historyGit(directory, [
      'rev-list',
      '--topo-order',
      '--reverse',
      ...sourceRefs.map((r) => r.name),
    ])
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  const revisions: ImportRevision[] = [];
  const scopes = new Map<string, string>();
  for (const gitId of ids) {
    const meta = splitCommit(
      await historyGit(directory, ['cat-file', 'commit', gitId]),
    );
    const contextText = await historyGit(directory, [
      'show',
      gitId + ':context.json',
    ]);
    const context = JSON.parse(contextText) as {
      format: string;
      version: number;
      scope: string;
      context: Record<string, unknown>;
    };
    if (
      context.format !== 'syncables-json-ad-git' ||
      context.version !== 1 ||
      typeof context.scope !== 'string' ||
      context.context?.owner !== store.owner
    )
      throw new Error('Legacy snapshot context or owner mismatch');
    for (const parent of meta.parents)
      if (scopes.get(parent) !== context.scope)
        throw new Error('Cross-scope legacy ancestry is unsupported');
    const tree = (await historyGit(directory, ['ls-tree', '-z', gitId]))
      .split('\0')
      .filter(Boolean);
    const resources = new Map<string, string>();
    for (const entry of tree) {
      const match =
        /^100644 blob ([a-f0-9]{64})\t(context\.json|r-[a-f0-9]{64}\.json)$/.exec(
          entry,
        );
      if (!match) throw new Error('Unsupported legacy tree entry');
      if (match[2] === 'context.json') continue;
      const text = await historyGit(directory, ['cat-file', 'blob', match[1]]);
      const subject = (JSON.parse(text) as { '@id': string })['@id'];
      if (
        typeof subject !== 'string' ||
        match[2] !== 'r-' + nodeHash(subject) + '.json' ||
        resources.has(subject)
      )
        throw new Error('Invalid legacy resource filename');
      resources.set(subject, text);
    }
    scopes.set(gitId, context.scope);
    revisions.push({
      gitId,
      snapshot: { scope: context.scope, context: context.context, resources },
      ...meta,
      contextText,
    });
  }
  const imports: ImportRef[] = [];
  for (const ref of sourceRefs) {
    const gitId = (
      await historyGit(directory, ['rev-parse', ref.name + '^{commit}'])
    ).trim();
    const scope = scopes.get(gitId);
    if (!scope) throw new Error('Missing legacy ref revision');
    const type = (
      await historyGit(directory, ['cat-file', '-t', ref.target])
    ).trim();
    let tagHeaders: string | undefined;
    if (type === 'tag') {
      tagHeaders = await historyGit(directory, ['cat-file', 'tag', ref.target]);
      if (!tagHeaders.startsWith('object ' + gitId + '\ntype commit\n'))
        throw new Error('Nested Git tags are unsupported');
    } else if (type !== 'commit')
      throw new Error('Unsupported legacy ref target');
    imports.push({
      name: ref.name,
      gitId,
      scope,
      ...(tagHeaders ? { tagHeaders } : {}),
    });
  }
  if (JSON.stringify(sourceRefs) !== JSON.stringify(await refs(directory)))
    throw new Error(
      'Legacy refs changed during import; retry after stopping legacy writers',
    );
  const map = await store.importHistory(
    directory,
    revisions,
    imports,
    sourceRefs,
  );
  return {
    revisions: map.size,
    refs: sourceRefs.length,
    mapping: Object.fromEntries(map),
    source: directory,
  };
}
export interface ExportOptions {
  scope: string;
  output: string;
  subject?: string;
  at?: string;
  branches?: 'all' | 'current';
}
export interface GitExportResult {
  directory: string;
  revisions: number;
  refs: number;
  mapping: Record<string, string>;
}
/** A subtree projection retains every ancestor (including empty commits) and merge edge. */
export async function exportGitHistory(
  store: PostgresHistoryStore,
  options: ExportOptions,
): Promise<GitExportResult> {
  const directory = resolve(options.output);
  if (
    await lstat(directory).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return false;
      },
    )
  )
    throw new Error(
      'Export destination already exists; choose a new directory',
    );
  const selected =
    options.at || options.branches === 'current'
      ? [
          {
            name: 'refs/heads/main',
            revision: await store.resolveRevision(options.scope, options.at),
            headers: undefined as string | undefined,
          },
        ]
      : await store.refs(options.scope);
  if (!selected.length) throw new Error('No snapshot refs to export');
  const revisions = new Map<string, HistoryRevision>();
  for (const ref of selected)
    for (const r of await store.ancestry(ref.revision)) revisions.set(r.id, r);
  if (
    options.subject &&
    ![...revisions.values()].some((r) =>
      Object.hasOwn(r.resources, options.subject!),
    )
  )
    throw new Error('Item is absent from the selected history');
  const map = new Map<string, string>();
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  try {
    await historyGit(directory, ['init', '--quiet', '--object-format=sha256']);
    await historyGit(directory, ['config', 'core.logAllRefUpdates', 'false']);
    for (const r of revisions.values()) {
      const files: [string, string][] = [];
      for (const [subject, root] of Object.entries(r.resources)) {
        if (options.subject && subject !== options.subject) continue;
        files.push([
          'r-' + nodeHash(subject) + '.json',
          await store.render(root),
        ]);
      }
      files.push(['context.json', r.context_text]);
      files.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const entries: string[] = [];
      for (const [name, text] of files)
        entries.push(
          `100644 blob ${(await historyGit(directory, ['hash-object', '-w', '--stdin', '--no-filters'], text)).trim()}\t${name}\0`,
        );
      const tree = (
        await historyGit(directory, ['mktree', '-z'], entries.join(''))
      ).trim();
      const parents = r.parents.map((p) => {
        const id = map.get(p);
        if (!id) throw new Error('Export parent is missing');
        return id;
      });
      // Preserve original commit headers verbatim for a complete migration round trip.
      // Signed/mergetag commits cannot retain a valid signature after projection.
      let headers =
        r.git_headers ??
        `tree ${tree}\n${parents.map((p) => 'parent ' + p + '\n').join('')}author ${r.author}\ncommitter ${r.committer}`;
      if (r.git_headers) {
        const originalTree = /^tree ([a-f0-9]+)$/m.exec(headers)?.[1];
        const originalParents = [
          ...headers.matchAll(/^parent ([a-f0-9]+)$/gm),
        ].map((m) => m[1]);
        if (
          (originalTree !== tree ||
            originalParents.some((p, i) => p !== parents[i])) &&
          /^(gpgsig(?:-sha256)?|mergetag) /m.test(headers)
        )
          throw new Error(
            'Cannot project signed Git commits; export the full collection',
          );
        let parent = 0;
        headers = headers
          .replace(/^tree .*$/m, 'tree ' + tree)
          .replace(/^parent .*$/gm, () => 'parent ' + parents[parent++]);
      }
      const gitId = (
        await historyGit(
          directory,
          ['hash-object', '-w', '-t', 'commit', '--stdin'],
          headers + '\n\n' + r.message,
        )
      ).trim();
      map.set(r.id, gitId);
    }
    for (const ref of selected) {
      validateHistoryRef(ref.name);
      let id = map.get(ref.revision)!;
      if (ref.headers) {
        const old = /^object ([a-f0-9]+)$/m.exec(ref.headers)?.[1];
        if (old !== id && /-----BEGIN /.test(ref.headers))
          throw new Error('Cannot project a signed Git tag');
        id = (
          await historyGit(
            directory,
            ['hash-object', '-w', '-t', 'tag', '--stdin'],
            ref.headers.replace(/^object .*$/m, 'object ' + id),
          )
        ).trim();
      }
      await historyGit(directory, ['update-ref', ref.name, id, '0'.repeat(64)]);
    }
    const head = selected.find((r) => r.name.startsWith('refs/heads/'));
    if (!head) throw new Error('Export needs a branch to check out');
    await historyGit(directory, ['symbolic-ref', 'HEAD', head.name]);
    await historyGit(directory, ['reset', '--hard', '--quiet']);
    await historyGit(directory, ['fsck', '--strict', '--no-reflogs']);
    return {
      directory,
      revisions: map.size,
      refs: selected.length,
      mapping: Object.fromEntries(map),
    };
  } catch (error) {
    // Retain failed output for inspection; never erase a user file introduced mid-export.
    throw new Error(
      'Git export incomplete; original repositories and PostgreSQL history are unchanged. Inspect ' +
        directory,
      { cause: error },
    );
  }
}
