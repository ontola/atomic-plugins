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
 *
 * Since 0.2.0 (#177 item 6):
 * - Rows are `issue-v1`; their shared fields are read by subject through
 *   `ontology-kit`'s resolver. A status that is not exactly one of the four
 *   task/v1 tags is shown as it is and not synced, instead of failing the
 *   pass.
 * - A row with no GitHub issue behind it is local only: the pass leaves it
 *   alone until a person chooses "Publish to GitHub" (#177 Q6, this
 *   plugin's choice). Then its create is held for review like any write.
 * - The Bridge's per-record baseline lives on the row (and on a comment's
 *   Message) as `github-sync-baseline`, not in the sync state (#177
 *   decision 7). See `bridgeFor`.
 */
import {
  AtomicIdentityMap,
  AtomicLens,
  AtomicSchema,
  AtomicStore,
} from 'devonian/atomic';
import { Datatype } from '@tomic/lib';
import { createResolver } from '../../../ontology-kit/resolver.mjs';
import { classes } from '../../../ontology-kit/terms.mjs';
// Plain JS modules of the lens; see devonian/github-issues/README.md.
import { Bridge } from '../devonian/github-issues/bridge.mjs';
import {
  AtomicPort,
  digest,
  GitHubPort,
} from '../devonian/github-issues/ports.mjs';
import { proxyTransport } from '../devonian/github-issues/proxy.mjs';
import { reviewGate } from '../devonian/github-issues/review.mjs';
import { assertSaved } from '../devonian/github-issues/target.mjs';
import {
  frameStore,
  type FrameAtomicStore,
  type FrameResource,
  type Overlay,
} from './frameStore.js';
import type { SyncState } from './state.js';
import type { HostProxy, JSONValue, PluginStore } from './store.js';
import {
  ABOUT,
  DESCRIPTION,
  IS_A,
  LOCAL_ID,
  NAME,
  PARENT,
  SHORTNAME,
  STATUSES,
  TASK_BODY,
  TASK_STATUS,
  TASK_TAGS,
  type Tracker,
} from './tracker.js';
import { relayDispatch, type Dispatch } from './transport.js';

/** Stable, so saved snapshots keep binding (`Bridge` checks `binding.base`). */
export const BRIDGE_BASE = 'https://github-issues-app.invalid/bridge';

export type Status = 'Todo' | 'Doing' | 'Blocked' | 'Done';

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
  /**
   * Not on GitHub and not asked to be: only "Publish to GitHub" sends it
   * (#177 Q6).
   */
  localOnly?: boolean;
  /**
   * The row's own status when it is not exactly one task/v1 tag (another
   * tag, or several), by name. It is shown as it is and not synced; `status`
   * is then the last one GitHub agreed with.
   */
  statusAsIs?: string[];
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

/** Reads `issue-v1` rows by property subject, strictly (#177 decision 1). */
const ISSUE_V1 = classes['issue-v1'];
const resolver = createResolver({ classes: [ISSUE_V1] });
const ISSUE_FIELDS = [...ISSUE_V1.requires, ...ISSUE_V1.recommends];
const STATUS_BY_TAG = new Map<string, Status>(
  STATUSES.map(status => [TASK_TAGS[status], status]),
);

const sortKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [
              key,
              sortKeys((value as Record<string, unknown>)[key]),
            ]),
        )
      : value;

/** JSON text that is the same whatever the key order: compares baselines. */
export const stableJson = (value: unknown): string =>
  JSON.stringify(sortKeys(value));

const isStatus = (value: unknown): value is Status =>
  STATUSES.includes(value as Status);

interface PortConfig {
  connection: {
    drive: string;
    table: string;
    rowClass: string;
    body: string;
    status: string;
    number: string;
    tags: Record<Status, string>;
  };
  provenance: string;
  /** The row extra holding the baseline (#177 decision 7). */
  baseline: string;
  commentsFolder: string;
  /** Rows a person chose "Publish to GitHub" for, not yet in the Bridge. */
  publish: Set<string>;
}

/** A table row as the board shows it, local-only ones included. */
interface ListedRow extends ImportedRow {
  localOnly?: boolean;
}

/**
 * `AtomicPort` over the frame store. App-specific narrowings:
 * - Comments are the Messages in the app's own comments folder. A comment
 *   made in the data-browser's comment panel on a row lives in the drive's
 *   comments folder, outside the app's subtree, which the app cannot write
 *   back to; it is left alone instead of failing every pass.
 * - The GitHub source and the baseline are stored as JSON text (string
 *   properties), so the source's key order, which the Bridge compares,
 *   survives the round trip.
 * - Issue rows are `issue-v1`, read through the resolver. A status that is
 *   not exactly one of the four task/v1 tags (another tag, or several) does
 *   not fail the pass: the row reports the status of its baseline, so the
 *   Bridge sees no status change to send, and the stored tags are kept in
 *   `asIs` for the view. A write the Bridge makes leaves such a status
 *   alone unless GitHub changed the status.
 * - Rows with no GitHub issue behind them are local only (`list` leaves
 *   them out) unless the Bridge already has them or a person asked to
 *   publish them.
 */
class FrameAtomicPort extends AtomicPort {
  declare store: FrameAtomicStore;
  declare config: PortConfig;
  declare connection: PortConfig['connection'];
  /** Whether the Bridge already has a record for this local row; set by `bridgeFor`. */
  bound: (entity: string, id: string) => boolean = () => false;
  /** Called with each row's stored baseline as it is read; set by `bridgeFor`. */
  onBaseline: (entity: string, id: string, baseline: unknown) => void =
    () => {};
  /** Row -> `stableJson` of the baseline it holds, as last read or written. */
  readonly baselines = new Map<string, string | undefined>();
  /** Rows whose status is shown as it is: their task/v1 status values. */
  readonly asIs = new Map<string, string[]>();

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

  /** The row's stored baseline, or undefined when it has none or it is unreadable. */
  private storedBaseline(r: { subject: string; get(p: string): unknown }) {
    const raw = r.get(this.config.baseline);
    let baseline: unknown;

    try {
      baseline = typeof raw === 'string' ? JSON.parse(raw) : undefined;
    } catch {
      baseline = undefined;
    }

    this.baselines.set(
      r.subject,
      baseline === undefined ? undefined : stableJson(baseline),
    );

    return baseline;
  }

  row(entity: string, r: FrameResource, context: object = {}) {
    const baseline = this.storedBaseline(r);

    if (entity !== 'issue') {
      const row = super.row(entity, r, context);
      this.onBaseline(entity, r.subject, baseline);

      return row;
    }

    const c = this.connection;
    const isA = r.get(IS_A);
    if (
      !Array.isArray(isA) ||
      !isA.includes(c.rowClass) ||
      r.get(PARENT) !== c.table
    )
      throw new Error('Resource is not a row of this issue tracker');
    const { values } = resolver.read(
      Object.fromEntries(ISSUE_FIELDS.map(p => [p, r.get(p)])),
      c.rowClass,
    );
    const tags = Array.isArray(values[TASK_STATUS])
      ? (values[TASK_STATUS] as unknown[]).filter(
          (t): t is string => typeof t === 'string',
        )
      : [];
    let status =
      tags.length === 0
        ? 'Todo'
        : tags.length === 1
          ? STATUS_BY_TAG.get(tags[0])
          : undefined;

    if (status) this.asIs.delete(r.subject);
    else {
      this.asIs.set(r.subject, tags);
      const agreed = (baseline as { status?: unknown } | undefined)?.status;
      status = isStatus(agreed) ? agreed : 'Todo';
    }

    const title = values[NAME];
    const body = values[TASK_BODY] ?? '';
    if (typeof title !== 'string' || !title.trim() || typeof body !== 'string')
      throw new Error('Invalid Atomic issue');
    const remoteId = r.get(c.number);
    if (
      remoteId !== undefined &&
      (!Number.isSafeInteger(remoteId) || (remoteId as number) <= 0)
    )
      throw new Error('Invalid GitHub issue number');
    let metadata = r.get(this.config.provenance);
    if (typeof metadata === 'string') metadata = JSON.parse(metadata);
    this.onBaseline(entity, r.subject, baseline);

    return {
      id: r.subject,
      remoteId,
      value: { title, body, status },
      ...(metadata ? { metadata } : {}),
    };
  }

  /** Whether an issue row is local only: no GitHub issue, not in the Bridge, not asked to publish. */
  private localOnly(id: string, r: FrameResource): boolean {
    return (
      r.get(this.connection.number) === undefined &&
      !this.bound('issue', id) &&
      !this.config.publish.has(id)
    );
  }

  /** Issue rows of this table's class, read; `all` keeps local-only ones too. */
  private async issueRows(all: boolean) {
    const out: { id: string; r: FrameResource; localOnly: boolean }[] = [];

    for (const id of await this.subjects(PARENT, this.connection.table)) {
      const r = (await this.resource(id)) as FrameResource;
      const isA = r.get(IS_A);
      if (!Array.isArray(isA) || !isA.includes(this.connection.rowClass))
        continue;
      const localOnly = this.localOnly(id, r);
      if (localOnly && !all) continue;
      out.push({ id, r, localOnly });
    }

    return out;
  }

  async list(entity: string, context: object = {}) {
    if (entity !== 'issue') return super.list(entity, context);

    return (await this.issueRows(false)).map(({ r }) =>
      this.row(entity, r, context),
    );
  }

  /**
   * Every issue row of the table for the board, local-only ones included.
   * Never fails on one row: a row the Bridge would refuse (no title) is
   * shown with what it has.
   */
  async listAll(): Promise<ListedRow[]> {
    const out: ListedRow[] = [];

    for (const { r, localOnly } of await this.issueRows(true)) {
      let row: ImportedRow;

      try {
        row = this.row('issue', r) as ImportedRow;
      } catch {
        const title = r.get(NAME);
        const body = r.get(TASK_BODY);
        row = {
          id: r.subject,
          value: {
            title: typeof title === 'string' ? title : '',
            body: typeof body === 'string' ? body : '',
            status: 'Todo',
          },
        };
      }

      out.push(localOnly ? { ...row, localOnly } : row);
    }

    return out;
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
    // The Bridge writes a row only with what both sides now agree on.
    all[this.config.baseline] = JSON.stringify(value);

    return values;
  }

  async update(
    entity: string,
    id: string,
    value: { status?: Status },
    _key: unknown,
    metadata: unknown,
    context: object,
  ) {
    const r = (await this.resource(id)) as FrameResource;
    const current = this.row(entity, r, context) as ImportedRow;
    // A status shown as it is stays, unless GitHub changed the status.
    const keep =
      entity === 'issue' &&
      this.asIs.has(id) &&
      current.value.status === value.status;

    for (const [p, v] of Object.entries(
      this.values(entity, value, metadata, context),
    )) {
      if (keep && p === this.connection.status) continue;
      r.set(p, v as JSONValue);
    }

    assertSaved(this.store, this.connection.drive, r, await r.save());
    this.baselines.set(id, stableJson(value));
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
      body: tracker.properties.body,
      status: tracker.properties.status,
      number: tracker.properties.number,
      tags: tracker.tags,
    },
    provenance: tracker.properties.provenance,
    baseline: tracker.properties.baseline,
    commentsFolder: tracker.commentsFolder,
    publish: new Set(state.state.publish ?? []),
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

  /**
   * Baselines on the rows (#177 decision 7). The Bridge keeps them in its
   * records; at each checkpoint, a baseline that differs from what its row
   * holds is written onto the row, and the sync state is saved without it.
   * A row the Bridge itself writes gets its baseline in the same write
   * (`FrameAtomicPort.values`), so an import costs no extra write. Reading a
   * row puts its baseline back into the record (`onBaseline`). A record
   * whose row was never read keeps the baseline the snapshot had: that is
   * how a 0.1.x state, which kept them all in the snapshot, moves onto the
   * rows at its first pass.
   */
  // The Bridge's live records; read only after it is constructed below.
  let records: Record<string, { entity: string; baseline?: unknown }> = {};
  /** Per live Bridge record: the baseline object its row is known to hold. */
  const onRow = new WeakMap<object, unknown>();

  const saveSnapshot = async (snapshot: {
    records?: Record<string, { entity: string; baseline?: unknown }>;
  }) => {
    for (const [subject, record] of Object.entries(records)) {
      if (record.baseline === undefined) continue;

      // The Bridge replaces a baseline object whenever it changes one, so an
      // unchanged one is skipped without a lookup (`bridge.id` scans every
      // identity) or comparing its text.
      if (onRow.get(record) !== record.baseline) {
        const id = bridge.id('local', record.entity, subject);
        if (typeof id !== 'string') continue;
        const json = stableJson(record.baseline);

        if (local.baselines.get(id) !== json) {
          const row = await atomicStore.getResource(id);
          row.set(tracker.properties.baseline, JSON.stringify(record.baseline));
          await row.save();
          // Bookkeeping, not a change to what the row says.
          atomicStore.writes.saves--;
          local.baselines.set(id, json);
        }

        onRow.set(record, record.baseline);
      }

      const saved = snapshot.records?.[subject];
      if (saved) delete saved.baseline;
    }

    await state.saveSnapshot(snapshot);
  };

  const bridge = new Bridge({
    imported,
    devonian,
    local,
    remote: reviewGate(counted(remote, sent), options.approved ?? new Set()),
    base: BRIDGE_BASE,
    snapshot: state.state.snapshot,
    save: saveSnapshot,
    uncertain,
  });
  records = bridge.records;
  const subjectOf = (entity: string, id: string): string | undefined =>
    bridge.identities.lookup(bridge.scope('local', entity), id);
  local.bound = (entity, id) => subjectOf(entity, id) !== undefined;

  local.onBaseline = (entity, id, baseline) => {
    const subject = subjectOf(entity, id);
    const record = subject ? records[subject] : undefined;
    if (baseline === undefined || !record) return;
    record.baseline = structuredClone(baseline);
    onRow.set(record, record.baseline);
  };

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
  const names = new Map<string, string>();

  const nameOf = async (tag: string) => {
    if (!names.has(tag)) {
      const known = STATUSES.find(s => TASK_TAGS[s] === tag);
      const resource = known
        ? undefined
        : await atomicStore.getResource(tag).catch(() => undefined);
      const name = resource?.get(NAME) ?? resource?.get(SHORTNAME);
      names.set(
        tag,
        known ??
          (typeof name === 'string' && name ? name : tag.split('/').pop()!),
      );
    }

    return names.get(tag)!;
  };

  const out: IssueRow[] = [];

  for (const row of await local.listAll()) {
    const asIs = local.asIs.get(row.id);
    out.push({
      ...issueRow(row, comments.get(row.id) ?? []),
      ...(row.localOnly ? { localOnly: true } : {}),
      ...(asIs ? { statusAsIs: await Promise.all(asIs.map(nameOf)) } : {}),
    });
  }

  return out;
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

  // A row asked to be published is in the Bridge now (held or sent).
  const publish = options.state.state.publish ?? [];
  const left = publish.filter(id => !local.bound('issue', id));
  if (left.length !== publish.length) options.state.state.publish = left;
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
