import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { isAbsolute } from 'node:path';
import { indexJson, nodeHash } from '../postgres/json-graph.js';
import type { PostgresHistoryStore } from './history-store.js';
import { SOURCE_ID } from './sync.js';
import { atomicTablesProjection, TABLE_BINDING } from './atomic-tables.js';

const MAX_BYTES = 64 * 1024 * 1024;
const IS_A = 'https://atomicdata.dev/properties/is-a';
export interface AtomicProjection {
  owner: string;
  collection: string;
  scope: string;
  revision: string;
  context: string;
  resources: {
    subject: string;
    raw: string;
    hash: string;
    item: boolean;
    types: string[];
  }[];
}
export interface AtomicPeerStatus {
  drive: string;
  revision: string | null;
  properties: Record<string, string>;
}
export interface AtomicPeerOptions {
  binary: string;
  directory: string;
  signerFile: string;
  owner: string;
  collection: string;
  scope: string;
  readers: string[];
  port: number;
  at?: string;
}

/** Read an accepted, immutable PostgreSQL revision, never an HTTP archive run. */
export async function atomicProjection(
  store: PostgresHistoryStore,
  collection: string,
  scope: string,
  at: string,
): Promise<AtomicProjection> {
  const revision = await store.revision(at);
  if (revision.scope !== scope)
    throw new Error('Atomic projection revision belongs to another scope');
  const resources: AtomicProjection['resources'] = [];
  let total = Buffer.byteLength(revision.context_text);
  for (const [subject, root] of Object.entries(revision.resources).sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )) {
    const raw = await store.render(root);
    total += Buffer.byteLength(raw);
    if (total > 16 * 1024 * 1024)
      throw new Error('Atomic projection exceeds the 16 MiB source limit');
    // JSON.parse below reads only identity/type strings. Numeric values travel
    // exclusively as the original text, after lossless hash verification.
    if (indexJson(raw, { maxBytes: 16 * 1024 * 1024 }).root !== root)
      throw new Error('Atomic projection source hash mismatch');
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['@id'] !== subject)
      throw new Error('Atomic projection source subject mismatch');
    const types = value[IS_A];
    resources.push({
      subject,
      raw,
      hash: nodeHash(raw),
      item: Object.hasOwn(value, SOURCE_ID),
      types: Array.isArray(types)
        ? types.filter((v): v is string => typeof v === 'string')
        : [],
    });
  }
  return {
    owner: store.owner,
    collection,
    scope,
    revision: revision.id,
    context: revision.context_text,
    resources,
  };
}

class NativePeer {
  private readonly child: ChildProcessWithoutNullStreams;
  private pending:
    | {
        resolve: (status: AtomicPeerStatus) => void;
        reject: (error: Error) => void;
      }
    | undefined;
  private failure?: Error;
  private readonly closed: Promise<void>;
  constructor(binary: string) {
    // No PostgreSQL URL, device token or provider credential enters the peer.
    this.child = spawn(binary, [], { env: {}, stdio: 'pipe' });
    this.child.stderr.resume();
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        if (line.length > 64 * 1024) throw new Error('Oversized peer status');
        const status = JSON.parse(line) as AtomicPeerStatus;
        if (
          typeof status.drive !== 'string' ||
          !status.drive.startsWith('atomic:') ||
          (status.revision !== null &&
            !/^[a-f0-9]{64}$/.test(status.revision)) ||
          !status.properties ||
          typeof status.properties !== 'object'
        )
          throw new Error('Invalid native peer status');
        if (!this.pending) throw new Error('Unexpected native peer status');
        this.pending.resolve(status);
        this.pending = undefined;
      } catch {
        this.fail(new Error('Invalid native Atomic peer response'));
        this.child.kill();
      }
    });
    this.child.on('error', () =>
      this.fail(new Error('Could not start the native Atomic peer binary')),
    );
    this.child.stdin.on('error', () =>
      this.fail(new Error('Native Atomic peer control stream closed')),
    );
    this.closed = new Promise((resolve) => {
      this.child.once('close', () => {
        lines.close();
        this.fail(
          new Error(
            'Native Atomic peer stopped; check signer identity, private file permissions and projection binding',
          ),
        );
        resolve();
      });
    });
  }
  private fail(error: Error): void {
    this.failure ??= error;
    this.pending?.reject(this.failure);
    this.pending = undefined;
  }
  check(): void {
    if (this.failure) throw this.failure;
  }
  async request(
    value: unknown,
    signal: AbortSignal,
  ): Promise<AtomicPeerStatus> {
    if (this.failure) throw this.failure;
    signal.throwIfAborted();
    const bytes = JSON.stringify(value) + '\n';
    if (Buffer.byteLength(bytes) > MAX_BYTES)
      throw new Error('Atomic peer control message exceeds 64 MiB');
    return new Promise<AtomicPeerStatus>((resolve, reject) => {
      const abort = (): void => {
        this.fail(new Error('Atomic peer stopped'));
        this.child.kill();
      };
      const timer = setTimeout(() => {
        this.fail(new Error('Native Atomic peer operation timed out'));
        this.child.kill();
      }, 300_000);
      const finish = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
      };
      this.pending = {
        resolve: (status): void => {
          finish();
          resolve(status);
        },
        reject: (error): void => {
          finish();
          reject(error);
        },
      };
      signal.addEventListener('abort', abort, { once: true });
      this.child.stdin.write(bytes);
    });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 3000);
    try {
      await this.closed;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Foreground companion to the fetching daemon; only accepted local revisions. */
export async function runAtomicPeer(
  store: PostgresHistoryStore,
  options: AtomicPeerOptions,
  signal: AbortSignal,
  report: (status: AtomicPeerStatus) => void,
): Promise<void> {
  if (
    ![options.binary, options.directory, options.signerFile].every(
      isAbsolute,
    ) ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.readers.length ||
    options.readers.length > 100 ||
    options.readers.some((reader) => !reader.startsWith('atomic:agent:')) ||
    options.owner !== store.owner
  )
    throw new Error('Invalid native Atomic peer paths, port, owner or readers');
  const initial = options.at
    ? await store.resolveRevision(options.scope, options.at)
    : await store.head(options.scope);
  if (!initial)
    throw new Error('No accepted PostgreSQL collection revision to publish');
  const native = new NativePeer(options.binary);
  try {
    let status = await native.request(
      {
        directory: options.directory,
        signerFile: options.signerFile,
        owner: options.owner,
        collection: options.collection,
        readers: options.readers,
        port: options.port,
      },
      signal,
    );
    let listening = false;
    while (!signal.aborted) {
      native.check();
      const head = options.at ? initial : await store.head(options.scope);
      if (!head) throw new Error('PostgreSQL collection head disappeared');
      if (head !== status.revision) {
        const revisions = await store.ancestry(head);
        const checkpoint = revisions.findIndex((r) => r.id === status.revision);
        for (const revision of revisions.slice(checkpoint + 1)) {
          if (revision.scope !== options.scope)
            throw new Error('Atomic peer ancestry crosses collection scopes');
          const projection = await atomicProjection(
            store,
            options.collection,
            options.scope,
            revision.id,
          );
          const next = await native.request(
            { type: 'project', projection },
            signal,
          );
          if (next.drive !== status.drive || next.revision !== revision.id)
            throw new Error(
              'Native Atomic peer did not acknowledge the revision',
            );
          status = next;
          report(status);
        }
      }
      if (!listening) {
        // Always replay the pinned current revision before opening the socket:
        // a prior crash may have left a durable pending projection journal.
        const projection = await atomicProjection(
          store,
          options.collection,
          options.scope,
          head,
        );
        const checked = await native.request(
          { type: 'project', projection },
          signal,
        );
        if (checked.drive !== status.drive || checked.revision !== head)
          throw new Error(
            'Native Atomic peer recovery did not acknowledge the revision',
          );
        status = await native.request({ type: 'listen' }, signal);
        listening = true;
        report(status);
      }
      await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await native.close();
  }
}

export interface AtomicTablesPeerOptions
  extends Omit<AtomicPeerOptions, 'collection' | 'scope'> {
  collections: import('./sync.js').PreparedCollection[];
}

/** One owner-scoped drive containing native account folders and collection tables. */
export async function runAtomicTablesPeer(
  store: PostgresHistoryStore,
  options: AtomicTablesPeerOptions,
  signal: AbortSignal,
  report: (status: AtomicPeerStatus) => void,
): Promise<void> {
  if (
    ![options.binary, options.directory, options.signerFile].every(
      isAbsolute,
    ) ||
    options.owner !== store.owner ||
    !Number.isSafeInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535 ||
    !options.readers.length ||
    options.readers.length > 100 ||
    options.readers.some((r) => !r.startsWith('atomic:agent:')) ||
    !options.collections.length ||
    options.collections.length > 100 ||
    (options.at && options.collections.length !== 1)
  )
    throw new Error(
      'Invalid native table peer paths, collections, owner, readers or revision selection',
    );
  const native = new NativePeer(options.binary);
  try {
    let status = await native.request(
      {
        directory: options.directory,
        signerFile: options.signerFile,
        owner: options.owner,
        collection: TABLE_BINDING,
        readers: options.readers,
        port: options.port,
      },
      signal,
    );
    let previous = '',
      listening = false;
    while (!signal.aborted) {
      native.check();
      const sources: import('./atomic-tables.js').TableSource[] = [];
      for (const prepared of options.collections) {
        const revision = options.at
          ? await store.resolveRevision(prepared.scope, options.at)
          : await store.head(prepared.scope);
        if (!revision)
          throw new Error(
            `No accepted PostgreSQL revision for ${prepared.source.platform}/${prepared.source.account}/${prepared.source.name}`,
          );
        sources.push({ prepared, revision });
      }
      const signature = JSON.stringify(
        sources.map((s) => [s.prepared.scope, s.revision]),
      );
      if (signature !== previous) {
        const projection = await atomicTablesProjection(store, sources);
        status = await native.request(
          { type: 'projectTables', projection },
          signal,
        );
        if (status.revision !== projection.revision)
          throw new Error(
            'Native table peer did not acknowledge the graph revision',
          );
        previous = signature;
        report(status);
      }
      if (!listening) {
        status = await native.request({ type: 'listen' }, signal);
        listening = true;
        report(status);
      }
      await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    await native.close();
  }
}
