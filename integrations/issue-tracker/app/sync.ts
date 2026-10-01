// @wc-ignore-file
/**
 * One sync pass: the Devonian GitHub issues Bridge between the app's table
 * and one GitHub repository, with the host's relay as its only network and
 * the app's own sync resource as its only storage.
 *
 * GitHub writes go through `reviewGate`: a pass never sends a create or an
 * update to GitHub that a person has not approved in this view, content
 * included (see devonian/github-issues/review.mjs). Everything the pass
 * would send is returned as `held`. Writes into the app's own table (the
 * import) are not gated, as for pets and notion.
 */
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
} from 'devonian/atomic';
import { Datatype } from '@tomic/lib';
// Plain JS modules of the lens; see devonian/github-issues/README.md.
import { Bridge } from '../devonian/github-issues/bridge.mjs';
import {
  AtomicPort,
  digest,
  GitHubPort,
} from '../devonian/github-issues/ports.mjs';
import { proxyTransport } from '../devonian/github-issues/proxy.mjs';
import { reviewGate } from '../devonian/github-issues/review.mjs';
import {
  frameStore,
  type FrameAtomicStore,
  type Overlay,
} from './frameStore.js';
import type { SyncState } from './state.js';
import type { HostProxy, PluginStore } from './store.js';
import {
  ABOUT,
  DESCRIPTION,
  LOCAL_ID,
  PARENT,
  type Tracker,
} from './tracker.js';
import { relayDispatch, type Dispatch } from './transport.js';

/** Stable, so saved snapshots keep binding (`Bridge` checks `binding.base`). */
export const BRIDGE_BASE = 'https://github-issues-app.invalid/bridge';

export type Status = 'Todo' | 'Doing' | 'Done';

export interface Held {
  subject: string;
  /** `issue`, or `comment:<issue subject>`. */
  entity: string;
  /** GitHub issue number or comment id; undefined for a create. */
  remoteId?: number;
  before?: { title?: string; body: string; status?: Status };
  after: { title?: string; body: string; status?: Status };
  key: string;
  /** For a comment: its issue's GitHub number, when the issue has one. */
  issueNumber?: number;
  /** An earlier approved attempt got no answer; it may have reached GitHub. */
  unconfirmed?: boolean;
  /** The Atomic resource this write comes from: a table row or a Message. */
  local?: string;
}

export interface Label {
  name: string;
  color?: string;
}

export interface CommentRow {
  subject: string;
  body: string;
  /** GitHub login; absent until GitHub has the comment. */
  author?: string;
  createdAt?: string;
  url?: string;
}

export interface IssueRow {
  subject: string;
  number?: number;
  title: string;
  status: Status;
  body: string;
  labels: Label[];
  assignees: string[];
  /** GitHub's `updated_at`, exact ISO text. */
  updatedAt?: string;
  url?: string;
  author?: string;
  /** Comments in this table (GitHub's plus any waiting to be sent), oldest first. */
  comments: CommentRow[];
}

/** One field of a conflict: last synced value and both sides' current ones. */
export interface ConflictField {
  field: string;
  base: unknown;
  local: unknown;
  remote: unknown;
}

/** A GitHub record that matches what an uncertain create sent. */
export interface Candidate {
  /** GitHub issue number or comment id. */
  id: number;
  title?: string;
  body: string;
  url?: string;
  author?: string;
  createdAt?: string;
}

/**
 * A create that was sent to GitHub and never answered (design state 12).
 * The transport will not send it again; a person says whether it landed
 * (`settleLanded`) or not (`sendAgain`).
 */
export interface Uncertain {
  subject: string;
  /** `issue`, or `comment:<issue subject>`. */
  entity: string;
  /** What the create sent. */
  sent: { title?: string; body: string };
  /**
   * Unbound GitHub records with exactly that title and body (a comment: that
   * body, on the same issue). They are not imported while this is open.
   */
  candidates: Candidate[];
  /** The table row or Message it is about. */
  local?: string;
  /** For a comment: its issue's GitHub number. */
  issueNumber?: number;
}

export interface PassResult {
  issues: number;
  comments: number;
  /** Resources the pass created or changed in this drive. */
  addedHere: number;
  updatedHere: number;
  /** Creates and updates sent to GitHub (approved ones only). */
  sentToGitHub: number;
  held: Held[];
  /** Creates whose outcome on GitHub is unknown; not in `held`. */
  uncertain: Uncertain[];
  /** The table's issues after the pass, as the Bridge reads them. */
  rows: IssueRow[];
}

/** Error from a pass, with what the view needs to offer a way out. */
export interface PassError extends Error {
  subject?: string;
  entity?: string;
  fields?: string[];
  /** The Atomic row or Message it is about, when bound. */
  local?: string;
  /** "Missing … record": which side lost a bound record, and which one. */
  missing?: { side: 'local' | 'remote'; subject: string; entity?: string };
}

/**
 * `AtomicPort` over the frame store. Two app-specific narrowings:
 * - Comments are the Messages in the app's own comments folder. A comment
 *   made in the data-browser's comment panel on a row lives in the drive's
 *   comments folder, outside the app's subtree, which the app cannot write
 *   back to; it is left alone instead of failing every pass.
 * - The GitHub source is stored as JSON text (a string property), so its
 *   key order, which the Bridge compares, survives the round trip.
 */
class FrameAtomicPort extends AtomicPort {
  declare store: FrameAtomicStore;
  declare config: { commentsFolder: string; provenance: string };

  async subjects(property: string, value: string): Promise<string[]> {
    const subjects: string[] = await super.subjects(property, value);
    if (property !== ABOUT) return subjects;
    const own: string[] = [];

    for (const subject of subjects) {
      const resource = await this.store.getResource(subject);
      if (resource.get(PARENT) === this.config.commentsFolder)
        own.push(subject);
    }

    return own;
  }

  values(
    entity: string,
    value: unknown,
    metadata: unknown,
    context: unknown,
  ): ReturnType<AtomicPort['values']> {
    const values = super.values(entity, value, metadata, context);
    const all = values as Record<string, unknown>;
    const provenance = this.config.provenance;
    if (all[provenance] !== undefined)
      all[provenance] = JSON.stringify(all[provenance]);

    return values;
  }
}

const devonian = {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
  Datatype,
};

type Port = {
  scope: string;
  list(...args: unknown[]): Promise<unknown[]>;
  get(...args: unknown[]): Promise<unknown>;
  create(...args: unknown[]): Promise<unknown>;
  update(...args: unknown[]): Promise<unknown>;
};

/** Counts writes that reached a side; `list`/`get` pass through. */
function counted(port: Port, count: { value: number }): Port {
  return {
    get scope() {
      return port.scope;
    },
    list: (...args) => port.list(...args),
    get: (...args) => port.get(...args),
    async create(...args) {
      const result = await port.create(...args);
      count.value++;

      return result;
    },
    async update(...args) {
      const result = await port.update(...args);
      count.value++;

      return result;
    },
  };
}

export interface PassOptions {
  store: PluginStore;
  proxy: HostProxy;
  connectionId: string;
  repository: string;
  tracker: Tracker;
  state: SyncState;
  /** Proposal keys a person approved in this view. */
  approved?: Set<string>;
  /** The app's own saves, corrected for on read; lives as long as the view. */
  overlay?: Overlay;
  /** Tests inject the relay directly. */
  dispatch?: Dispatch;
  /**
   * Called as the pass imports GitHub issues and comments into the table,
   * so the view can show them before the pass ends.
   */
  onImported?: (imported: Imported) => void;
}

/** One record a pass imported from GitHub, as the board shows it. */
export type Imported =
  | { entity: 'issue'; row: IssueRow }
  | { entity: 'comment'; issue: string; comment: CommentRow };

/**
 * During an import the sync state is written every this many imported
 * records, or after this long, whichever comes first, instead of before
 * every record: the state holds every imported issue's text, so writing it
 * per record made the import quadratic (#206).
 */
export const IMPORT_FLUSH_EVERY = 25;
export const IMPORT_FLUSH_MS = 10_000;

function bridgeFor(options: PassOptions) {
  const { store, repository, tracker, state } = options;
  const atomicStore = frameStore(store, {
    known: state.state.known,
    indexed: [PARENT, ABOUT, LOCAL_ID],
    ...(options.overlay ? { overlay: options.overlay } : {}),
  });
  const local = new FrameAtomicPort(atomicStore, {
    connection: {
      drive: tracker.app,
      table: tracker.table,
      rowClass: tracker.rowClass,
      body: 'https://atomicdata.dev/properties/description',
      status: tracker.properties.status,
      number: tracker.properties.number,
      tags: tracker.tags,
    },
    provenance: tracker.properties.provenance,
    commentsFolder: tracker.commentsFolder,
  });
  const transport = proxyTransport({
    repository,
    journal: state.state.journal,
    save: () => state.saveJournal(),
    dispatch:
      options.dispatch ?? relayDispatch(options.proxy, options.connectionId),
  });
  const remote = new GitHubPort(undefined, { repository }, transport);
  const journal = state.state.journal as Record<
    string,
    { signature?: string; receipt?: unknown } | undefined
  >;
  // The transport's journal id of a create, as GitHubPort derives it from
  // AtomicLens's idempotency key.
  const createId = (entity: string, subject: string) =>
    digest(`${JSON.stringify([remote.scope, entity, subject])}:create`);
  const uncertain = {
    async sent(entity: string, subject: string) {
      const entry = journal[await createId(entity, subject)];
      if (!entry?.signature || entry.receipt) return undefined;
      const { args } = JSON.parse(entry.signature) as {
        args: { title?: string; body?: string };
      };

      return entity === 'issue'
        ? { title: args.title, body: args.body ?? '' }
        : { body: args.body ?? '' };
    },
    async forget(entity: string, subject: string) {
      const id = await createId(entity, subject);
      if (journal[id]?.receipt) return;
      delete journal[id];
      await state.saveJournal();
    },
  };
  const sent = { value: 0 };
  let sinceFlush = 0;
  let flushedAt = Date.now();

  const imported = async ({
    entity,
    row,
    context,
  }: {
    entity: string;
    row: ImportedRow;
    context: { issueId?: string };
  }) => {
    if (
      ++sinceFlush >= IMPORT_FLUSH_EVERY ||
      Date.now() - flushedAt >= IMPORT_FLUSH_MS
    ) {
      sinceFlush = 0;
      flushedAt = Date.now();
      await state.flush();
    }

    const notify = options.onImported;
    if (!notify) return;
    if (entity === 'issue') notify({ entity, row: issueRow(row, []) });
    else if (context.issueId)
      notify({
        entity: 'comment',
        issue: context.issueId,
        comment: commentRow(row.id, row.value.body, row.metadata ?? {}),
      });
  };

  const bridge = new Bridge({
    imported,
    devonian,
    local,
    remote: reviewGate(counted(remote, sent), options.approved ?? new Set()),
    base: BRIDGE_BASE,
    snapshot: state.state.snapshot,
    save: (snapshot: unknown) => state.saveSnapshot(snapshot),
    uncertain,
  });

  return { bridge, atomicStore, sent, local };
}

async function summary(
  bridge: Bridge,
  atomicStore: FrameAtomicStore,
  sent: { value: number },
  local: FrameAtomicPort,
  options: PassOptions,
): Promise<PassResult> {
  const writes = { ...atomicStore.writes };
  const rows = await tableRows(atomicStore, local, options);
  const bound = Object.entries(
    bridge.records as Record<string, { entity: string }>,
  ).filter(
    ([subject, record]) =>
      bridge.id('local', record.entity, subject) !== undefined &&
      bridge.id('remote', record.entity, subject) !== undefined,
  );

  return {
    issues: bound.filter(([, r]) => r.entity === 'issue').length,
    comments: bound.filter(([, r]) => r.entity !== 'issue').length,
    addedHere: writes.creates,
    updatedHere: writes.saves,
    sentToGitHub: sent.value,
    held: [...(bridge.held as Map<string, Held>).values()].map(held => {
      const at = bridge.id('local', held.entity, held.subject);
      const withLocal = typeof at === 'string' ? { ...held, local: at } : held;
      if (held.entity === 'issue') return withLocal;
      const issue = held.entity.slice('comment:'.length);
      const issueNumber = bridge.id('remote', 'issue', issue);

      return issueNumber === undefined
        ? withLocal
        : { ...withLocal, issueNumber };
    }),
    uncertain: [
      ...(bridge.unsettled as Map<string, BridgeUnsettled>).values(),
    ].map(u => {
      const at = bridge.id('local', u.entity, u.subject);
      const issueNumber =
        u.entity === 'issue'
          ? undefined
          : bridge.id('remote', 'issue', u.entity.slice('comment:'.length));

      return {
        subject: u.subject,
        entity: u.entity,
        sent: u.sent,
        candidates: u.candidates.map(candidate),
        ...(typeof at === 'string' ? { local: at } : {}),
        ...(typeof issueNumber === 'number' ? { issueNumber } : {}),
      };
    }),
    rows,
  };
}

interface BridgeUnsettled {
  subject: string;
  entity: string;
  sent: { title?: string; body: string };
  candidates: ImportedRow[];
}

function candidate(row: ImportedRow): Candidate {
  const m = row.metadata ?? {};
  const value = row.value as { title?: string; body?: string };
  const optional = {
    title: text(value.title),
    url: text(m.url),
    author: text(m.author),
    createdAt: text(m.createdAt),
  };

  return {
    id: Number(row.id),
    body: value.body ?? '',
    ...Object.fromEntries(
      Object.entries(optional).filter(([, v]) => v !== undefined),
    ),
  };
}

async function tableRows(
  atomicStore: FrameAtomicStore,
  local: FrameAtomicPort,
  options: PassOptions,
): Promise<IssueRow[]> {
  const comments = await commentsByIssue(atomicStore, options);

  return ((await local.list('issue')) as ImportedRow[]).map(row =>
    issueRow(row, comments.get(row.id) ?? []),
  );
}

/**
 * The table's issues as they are now, without a pass: for the board while
 * sync is paused or failed, so a reload never shows an empty board. Reads
 * only; nothing is sent or written.
 */
export async function readRows(options: PassOptions): Promise<IssueRow[]> {
  const { atomicStore, local } = bridgeFor(options);

  return tableRows(atomicStore, local, options);
}

/** One pass. Throws a `PassError`; the state is flushed either way. */
export async function runPass(options: PassOptions): Promise<PassResult> {
  const { bridge, atomicStore, sent, local } = bridgeFor(options);

  // Always written at the end: `known` subjects change on every pass.
  try {
    await bridge.sync();
  } catch (error) {
    // Name the Atomic resource a conflict is about, for the view's marker.
    const e = error as PassError;

    const gone = /^Missing (local|remote) record: (.+)$/.exec(e?.message ?? '');

    if (gone) {
      const subject = gone[2];
      const entity = (bridge.records as Record<string, { entity: string }>)[
        subject
      ]?.entity;
      e.missing = { side: gone[1] as 'local' | 'remote', subject, entity };
      e.entity ??= entity;
      e.subject ??= subject;
    }

    if (e?.subject && e.entity) {
      const at = bridge.id('local', e.entity, e.subject);
      if (typeof at === 'string') e.local = at;
    }

    // Keep the pass's own error; a failing flush would only hide it.
    await options.state.flush().catch(() => {});
    throw error;
  }

  await options.state.flush();

  return summary(bridge, atomicStore, sent, local, options);
}

/** Per-field detail of a conflict the last pass reported. Reads only. */
export async function describeConflict(
  options: PassOptions,
  subject: string,
): Promise<ConflictField[]> {
  const { bridge } = bridgeFor(options);

  return bridge.describeConflict(subject);
}

export type Side = 'local' | 'remote';

/**
 * Settles a conflict the last pass reported, for one side or per field;
 * writes nothing to either side.
 */
export async function resolveConflict(
  options: PassOptions,
  subject: string,
  keep: Side | Record<string, Side>,
): Promise<string[]> {
  const { bridge } = bridgeFor(options);

  try {
    return await bridge.resolveConflict(subject, keep);
  } finally {
    await options.state.flushIfDirty();
  }
}

const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;

interface ImportedRow {
  id: string;
  remoteId?: number;
  value: { title: string; body: string; status: Status };
  metadata?: Record<string, unknown>;
}

function commentRow(
  subject: string,
  body: string | undefined,
  source: Record<string, unknown>,
): CommentRow {
  return {
    subject,
    body: body ?? '',
    ...(text(source.author) ? { author: text(source.author) } : {}),
    ...(text(source.createdAt) ? { createdAt: text(source.createdAt) } : {}),
    ...(text(source.url) ? { url: text(source.url) } : {}),
  };
}

function issueRow(row: ImportedRow, comments: CommentRow[]): IssueRow {
  const m = row.metadata ?? {};
  const labels = Array.isArray(m.labels)
    ? (m.labels as Label[]).filter(l => typeof l?.name === 'string')
    : [];
  const optional = {
    updatedAt: text(m.updatedAt),
    url: text(m.url),
    author: text(m.author),
  };

  return {
    subject: row.id,
    ...(row.remoteId === undefined ? {} : { number: row.remoteId }),
    title: row.value.title,
    status: row.value.status,
    body: row.value.body ?? '',
    labels,
    assignees: Array.isArray(m.assignees)
      ? (m.assignees as unknown[]).filter(
          (a): a is string => typeof a === 'string',
        )
      : [],
    ...Object.fromEntries(
      Object.entries(optional).filter(([, v]) => v !== undefined),
    ),
    comments,
  };
}

/**
 * The Messages in the app's comments folder, by the row they are about,
 * oldest first (GitHub's creation time; not yet sent ones last).
 */
async function commentsByIssue(
  atomicStore: FrameAtomicStore,
  options: PassOptions,
): Promise<Map<string, CommentRow[]>> {
  const { tracker } = options;
  const out = new Map<string, CommentRow[]>();
  const { subjects } = await atomicStore.queryLocalDb({
    drive: tracker.app,
    property: PARENT,
    value: tracker.commentsFolder,
  });

  for (const subject of subjects) {
    const r = await atomicStore.getResource(subject);
    const about = r.get(ABOUT);
    if (typeof about !== 'string') continue;
    let source: Record<string, unknown> = {};

    try {
      const raw = r.get(tracker.properties.provenance);
      if (typeof raw === 'string') source = JSON.parse(raw);
    } catch {
      // Unreadable provenance: shown without an author.
    }

    const comment = commentRow(subject, text(r.get(DESCRIPTION)), source);
    const list = out.get(about) ?? [];
    list.push(comment);
    out.set(about, list);
  }

  for (const list of out.values())
    list.sort((a, b) =>
      (a.createdAt ?? '\uffff').localeCompare(b.createdAt ?? '\uffff'),
    );

  return out;
}

/**
 * "Keep here only" for an issue GitHub no longer has: the Bridge forgets
 * its GitHub identity (and its comments'), and the row's issue-number
 * column is cleared so nothing binds it back. Sends nothing to GitHub.
 */
export async function keepLocalOnly(
  options: PassOptions,
  subject: string,
): Promise<void> {
  const { bridge } = bridgeFor(options);
  const row = bridge.id('local', 'issue', subject);

  try {
    await bridge.keepLocalOnly(subject);

    if (typeof row === 'string') {
      const resource = await options.store.getResource(row);
      if (resource.get(options.tracker.properties.number) !== undefined)
        await resource.remove(options.tracker.properties.number).save();
    }
  } finally {
    await options.state.flush();
  }
}

/**
 * "Remove from board" for an issue GitHub no longer has: the Bridge forgets
 * it on both sides, then its row and comment Messages are deleted from the
 * table. Sends nothing to GitHub.
 */
export async function removeFromBoard(
  options: PassOptions,
  subject: string,
): Promise<void> {
  const { bridge } = bridgeFor(options);
  let local: string[] = [];

  try {
    local = await bridge.forget(subject);
  } finally {
    await options.state.flush();
  }

  for (const id of local) {
    const resource = await options.store.getResource(id).catch(() => undefined);
    await resource?.destroy();
  }
}

/**
 * "It landed as #N": binds an uncertain create to the GitHub record it
 * became (`Bridge.landed`), and writes an issue's number into its row.
 * Reads that record from GitHub first; sends nothing to it.
 */
export async function settleLanded(
  options: PassOptions,
  subject: string,
  id: number,
): Promise<void> {
  const { bridge, atomicStore } = bridgeFor(options);
  let entity: string | undefined;

  try {
    await bridge.landed(subject, id);
    entity = (bridge.records as Record<string, { entity: string }>)[subject]
      ?.entity;
  } finally {
    await options.state.flush();
  }

  const row = bridge.id('local', 'issue', subject);

  if (entity === 'issue' && typeof row === 'string') {
    const resource = await atomicStore.getResource(row);
    resource.set(options.tracker.properties.number, id);
    await resource.save();
  }
}

/**
 * "It did not arrive": GitHub shows nothing matching an uncertain create,
 * so its journal entry goes and the create is held for review again
 * (`Bridge.notArrived`, which refuses while a match exists).
 */
export async function sendAgain(
  options: PassOptions,
  subject: string,
): Promise<void> {
  const { bridge } = bridgeFor(options);

  try {
    await bridge.notArrived(subject);
  } finally {
    await options.state.flush();
  }
}
