// @wc-ignore-file
/**
 * The webhook inbox journal for an atomic-server sync session (#369 step
 * 4b): the preview/step continuation protocol an Installation runs
 * unattended through `sync_worker.rs` and `sync_session.rs`. A step's
 * writes are effects the host applies after the step returns, so this
 * journal never writes anything itself: it collects create intents for one
 * `atomic` effect. The consumer runs with `acknowledge: 'next-step'`.
 *
 * Where the state lives:
 * - The subscription, and the cursor and reconciliation still to report,
 *   travel in `ctx.connection` as one record (`INBOX_RECORD`, its baseline
 *   the state). The run's last effect is a `checkpoint` that writes it, after
 *   the `atomic` effect with the deliveries has landed; the host allows one
 *   checkpoint per run, last, and always clears the connection's own
 *   `cursor`, so a record is the only place that survives. The next run
 *   reads it from `ctx.connection`, so it acknowledges only events whose
 *   rows a checkpointed run wrote.
 * - Deliveries, work items and gaps are rows in the tables the config
 *   names. They are not connection records: the connection state is capped
 *   at 8 MiB and would grow by one per delivery. Subjects are minted by the
 *   host, so duplicates are found by querying the delivery id (or gap key)
 *   and checking the row's parent.
 */
import type {
  GapMarker,
  InboxEvent,
  InboxJournal,
  ReconciliationRequired,
  StoredSubscription,
} from 'syncables/browser';

const PARENT = 'https://atomicdata.dev/properties/parent';

/** What a run may ask of its host, read-only. */
export interface JournalHost {
  query(property: string, value: string): string[];
  read(subject: string): Record<string, unknown>;
}

export interface Destination {
  table: string;
  rowClass: string;
}

export interface JournalConfig {
  /** Property subjects by shortname, as the host's set-up created them. */
  properties: Record<string, string>;
  deliveries: Destination;
  work: Destination;
  gaps: Destination;
}

export interface Intent {
  op: 'create';
  localId: string;
  parent: string;
  isA: string[];
  set: Record<string, string>;
}

/**
 * Base64 payload bytes one run collects at most. Its rows travel in the
 * saved sync session, which the host caps at 8 MiB (`sync_session::save`);
 * the rest of the session (the envelopes, the intents, the receipt) gets
 * the other 2 MiB. An event past the budget ends the step without error:
 * the rows collected so far are written and nothing is acknowledged, so
 * the next run fetches the same page, finds those rows by delivery id and
 * goes on from there. The first new event of a run is always taken.
 */
export const RUN_PAYLOAD_BUDGET = 6 * 1024 * 1024;

/**
 * The largest base64 payload one event may have: the session cap less
 * 512 KiB for the rest of the session. A larger event is refused, and the
 * run records `lastError`: its effect could not be saved, and the host
 * retries a session it cannot save every 2 s without recording an error
 * (an atomic-server bug, reported separately).
 */
export const MAX_EVENT_PAYLOAD = 8 * 1024 * 1024 - 512 * 1024;

/** The run's payload budget is spent. Not a failure. */
export class BudgetReached extends Error {
  constructor(bytes: number) {
    super(`webhook inbox: run payload budget reached at ${bytes} bytes`);
    this.name = 'BudgetReached';
  }
}

/** The connection record that holds the inbox state. */
export const INBOX_RECORD = 'webhook-inbox:subscription';

/** The state's format version. */
export const STATE_VERSION = 1;

interface StateBaseline {
  v: typeof STATE_VERSION;
  subscription: StoredSubscription | null;
  /** Why the last run's consumer step failed, and when (RFC 3339). */
  lastError?: { message: string; at: string };
  /** The rows the last run wrote, from its Atomic receipt. */
  lastWritten?: string[];
}

/** What the host hands a run as `ctx.connection` (`connection_state::State`). */
export interface ConnectionState {
  revision?: number;
  records?: Record<string, { local: string; baseline: unknown }>;
}

/**
 * The stored subscription in `ctx.connection`. No record (a first run) is
 * none. A record in another format is refused rather than read as none:
 * that would subscribe again and orphan the subscription it names.
 */
export function readState(
  connection: ConnectionState | null | undefined,
): StoredSubscription | undefined {
  const record = connection?.records?.[INBOX_RECORD];
  if (!record) return undefined;
  const state = record.baseline as Partial<StateBaseline> | null;

  if (state?.v !== STATE_VERSION) {
    throw new Error(
      `webhook inbox: unknown state version ${JSON.stringify(state?.v)}`,
    );
  }

  return state.subscription ?? undefined;
}

/** Why the last run's consumer step failed, if it did. */
export function lastError(
  connection: ConnectionState | null | undefined,
): { message: string; at: string } | undefined {
  const baseline = connection?.records?.[INBOX_RECORD]?.baseline as
    | Partial<StateBaseline>
    | undefined;

  return baseline?.lastError;
}

/**
 * The checkpoint record that stores `subscription`. `local` is the
 * deliveries table: a record must name a local resource, never rebound, and
 * no other record of this installation uses it. Both projections are the
 * state, as a checkpoint requires them to agree.
 */
export function stateRecord(
  subscription: StoredSubscription | undefined,
  local: string,
  error?: { message: string; at: string },
  lastWritten?: string[],
) {
  const baseline: StateBaseline = {
    v: STATE_VERSION,
    subscription: subscription ?? null,
    ...(error ? { lastError: error } : {}),
    ...(lastWritten?.length ? { lastWritten } : {}),
  };

  return {
    remote: INBOX_RECORD,
    local,
    local_projection: baseline,
    remote_projection: baseline,
  };
}

/** One gap, whichever step reports it. */
export function gapKey(subscription: string, gap: GapMarker): string {
  return JSON.stringify([
    subscription,
    gap.generation,
    gap.detectedAt,
    gap.reason,
  ]);
}

export class SandboxInboxJournal implements InboxJournal {
  readonly intents: Intent[] = [];
  private state: StoredSubscription | undefined;
  private readonly appended = new Set<string>();
  private readonly gapsWritten = new Set<string>();
  private readonly reconcilesWritten = new Set<string>();
  private next = 0;
  private payloadBytes = 0;

  constructor(
    private readonly host: JournalHost,
    private readonly config: JournalConfig,
    state: StoredSubscription | undefined,
  ) {
    this.state = state;
  }

  private property(shortname: string): string {
    const subject = this.config.properties[shortname];

    if (!subject) {
      throw new Error(
        `Configure this plugin: no property for ${shortname} in config.properties`,
      );
    }

    return subject;
  }

  /** Rows of `table` whose `shortname` property is exactly `value`. */
  private rows(table: string, shortname: string, value: string): string[] {
    const property = this.property(shortname);

    return this.host.query(property, value).filter(subject => {
      const row = this.host.read(subject);

      return row[PARENT] === table && row[property] === value;
    });
  }

  private create(
    destination: Destination,
    values: Record<string, string | null | undefined>,
  ): string {
    const localId = `inbox-${this.next++}`;
    const set: Record<string, string> = {};

    for (const [shortname, value] of Object.entries(values)) {
      if (value !== null && value !== undefined && value !== '') {
        set[this.property(shortname)] = value;
      }
    }

    this.intents.push({
      op: 'create',
      localId,
      parent: destination.table,
      isA: [destination.rowClass],
      set,
    });

    return `local:${localId}`;
  }

  async subscription(): Promise<StoredSubscription | undefined> {
    return this.state;
  }

  async setSubscription(
    subscription: StoredSubscription | undefined,
  ): Promise<void> {
    this.state = subscription;
  }

  async append(event: InboxEvent): Promise<boolean> {
    const id = event.deliveryId;

    if (
      this.appended.has(id) ||
      this.rows(this.config.deliveries.table, 'webhook-delivery-id', id)
        .length > 0
    ) {
      return false;
    }

    const size = event.payload.body.length;

    if (size > MAX_EVENT_PAYLOAD) {
      throw new Error(
        `webhook inbox: delivery ${id} is ${size} bytes in base64, over the ${MAX_EVENT_PAYLOAD} one run can save`,
      );
    }

    if (
      this.payloadBytes > 0 &&
      this.payloadBytes + size > RUN_PAYLOAD_BUDGET
    ) {
      throw new BudgetReached(this.payloadBytes);
    }

    this.payloadBytes += size;
    this.appended.add(id);
    const delivery = this.create(this.config.deliveries, {
      'webhook-delivery-id': id,
      'webhook-event-type': event.eventType,
      'webhook-action': event.action,
      'webhook-received-at': event.receivedAt,
      'webhook-source-kind': event.source.kind,
      'webhook-source-key': event.source.key,
      'webhook-subscription': this.state?.id,
      'webhook-generation': event.generation,
      'webhook-cursor': event.cursor,
      'webhook-media-type': event.payload.mediaType,
      'webhook-payload-bytes': String(event.payload.bytes),
      'webhook-payload-sha256': event.payload.sha256,
      'webhook-payload': event.payload.body,
    });
    this.create(this.config.work, {
      'webhook-work-kind': 'delivery',
      'webhook-work-status': 'pending',
      'webhook-delivery': delivery,
    });

    return true;
  }

  async recordGap(subscription: string, gap: GapMarker): Promise<void> {
    const key = gapKey(subscription, gap);

    if (
      this.gapsWritten.has(key) ||
      this.rows(this.config.gaps.table, 'webhook-gap-key', key).length > 0
    ) {
      return;
    }

    this.gapsWritten.add(key);
    this.create(this.config.gaps, {
      'webhook-gap-key': key,
      'webhook-gap-reason': gap.reason,
      'webhook-subscription': subscription,
      'webhook-generation': gap.generation,
      'webhook-detected-at': gap.detectedAt,
      'webhook-last-acknowledged': gap.lastAcknowledged,
      'webhook-earliest-available': gap.earliestAvailableCursor,
    });
  }

  /**
   * The consumer's `reconcile`: the full read runs as separate work (a
   * `reconcile` work item, done by the issue table's sync), so this answers
   * `'pending'` until that item is `done`. Until then the receiver is not
   * told, and keeps asking.
   */
  async reconcile(
    _reason: string,
    required: ReconciliationRequired,
  ): Promise<void | 'pending'> {
    const key = gapKey(required.subscription, required.gap);
    const items = this.rows(this.config.work.table, 'webhook-gap-key', key);
    const status = this.property('webhook-work-status');

    if (items.some(subject => this.host.read(subject)[status] === 'done')) {
      return undefined;
    }

    if (items.length === 0 && !this.reconcilesWritten.has(key)) {
      this.reconcilesWritten.add(key);
      this.create(this.config.work, {
        'webhook-work-kind': 'reconcile',
        'webhook-work-status': 'pending',
        'webhook-gap-key': key,
      });
    }

    return 'pending';
  }

  /** The state to checkpoint: what `setSubscription` last set. */
  current(): StoredSubscription | undefined {
    return this.state;
  }
}
