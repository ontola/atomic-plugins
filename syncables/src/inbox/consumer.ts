/**
 * The daemon side of a webhook inbox (#369 step 4): keeps one subscription
 * alive, copies each event into a durable journal **before** acknowledging
 * it, and runs a full reconciliation whenever the receiver says history has
 * a gap (or the subscription is new, or ended while the daemon slept).
 *
 * Durability lives in the caller's {@link InboxJournal} (in Atomic: a
 * Webhook deliveries row with its raw payload, plus a work item). The
 * full read lives in the caller's `reconcile` (in practice syncables' read
 * path). Nothing here assumes a provider.
 *
 * Guarantees, given a journal whose `append` is durable when it resolves:
 * - an event is acknowledged only after it was journaled, so a crash between
 *   the two loses nothing; the receiver redelivers it and `append` reports
 *   it as a duplicate (by delivery id);
 * - a gap, an expiry or a closed subscription is journaled as a gap, and is
 *   followed by a complete `reconcile` before the subscription is marked
 *   reconciled; history inside the gap is not recovered, only current state;
 * - events captured during that reconciliation stay pending and are
 *   journaled on the next steps.
 *
 * The caller's loop: call `step()` again at once after any result except
 * `backoff`, which says how many seconds to wait first. An `idle` step has
 * already waited: each fetch long-polls for up to `wait` seconds (default
 * 25, the receiver's cap), so the loop sends at most about one signed
 * request per `wait` while nothing arrives. Anything `step()` throws is
 * not a refusal a retry fixes (a transport error, a `4xx` other than those
 * above, a journal failure): wait (with backoff of your own) before the
 * next step, and report it.
 *
 * ```ts
 * for (;;) {
 *   const result = await consumer.step();
 *   if (result.kind === 'backoff') await sleep(result.seconds * 1000);
 * }
 * ```
 */
import {
  InboxError,
  type GapMarker,
  type InboxClient,
  type InboxEvent,
  type InboxSubscription,
  type ReconciliationRequired,
  type SubscribeRequest,
} from './client.js';

/** What the consumer keeps about its subscription between runs. */
export interface StoredSubscription {
  id: string;
  /** When to renew next (ISO time), from the last lease. */
  renewAfter?: string;
  /**
   * `acknowledge: 'next-step'` only: the end of the events the last step
   * appended, acknowledged at the start of the next step. Stored with them,
   * so it is durable exactly when they are.
   */
  unacknowledged?: { generation: string; cursor: string };
  /**
   * `acknowledge: 'next-step'` only: a reconciliation the last step ran,
   * reported with `reconciled` at the start of the next step, once its
   * writes are durable.
   */
  unconfirmedReconciliation?: { generation: string; barrier: string };
}

export interface InboxJournal {
  subscription(): Promise<StoredSubscription | undefined>;
  setSubscription(subscription: StoredSubscription | undefined): Promise<void>;
  /**
   * Stores the event (its raw payload and a work item) durably, unless an
   * event with its delivery id is already stored. Resolves `true` when it
   * stored it, `false` for a duplicate. The consumer acknowledges only after
   * this resolves.
   */
  append(event: InboxEvent): Promise<boolean>;
  /**
   * Records a gap in history, as the receiver described it. Must be
   * idempotent: after a crash, or a step that failed before `reconciled`,
   * the receiver reports the same gap again and it is passed here again.
   * Keep one record per subscription, generation, `detectedAt` and reason.
   */
  recordGap(subscription: string, gap: GapMarker): Promise<void>;
}

/** The receiver's cap on `wait`, and the consumer's default. */
export const DEFAULT_WAIT_SECONDS = 25;

export interface InboxConsumerOptions {
  client: InboxClient;
  journal: InboxJournal;
  /** What to subscribe to when there is no live subscription. */
  subscription: SubscribeRequest;
  /**
   * A complete read of the source through the API, after a gap. It must
   * keep pending local edits and conflicts rather than overwrite them.
   */
  reconcile: (reason: string) => Promise<void>;
  /**
   * Seconds a fetch may wait for an event (default 25, the receiver's cap).
   * `0` answers at once; a loop then has to pace itself.
   */
  wait?: number;
  limit?: number;
  /**
   * Base64 payload bytes per fetch (`InboxClient.events`). An event whose
   * body alone is over it reaches `append` without its body
   * (`payload.omitted`); the journal decides what to keep of it. It is
   * acknowledged like any other.
   */
  maxBytes?: number;
  now?: () => number;
  /**
   * When an appended event is acknowledged.
   *
   * - `'immediately'` (the default): in the same step, right after `append`
   *   resolves. The journal's `append` must be durable when it resolves.
   * - `'next-step'`: at the start of the next step. For a host whose writes
   *   become durable only after the step returns, such as an atomic-server
   *   scheduled sandbox run: its writes are intents applied after the run,
   *   and the next run sees them only if they were applied. The step stores
   *   the cursor to acknowledge (`unacknowledged`) through
   *   `setSubscription`, with the events, and `reconciled` is deferred the
   *   same way (`unconfirmedReconciliation`). If the writes are lost, so is
   *   the cursor: nothing is acknowledged, and the receiver delivers the
   *   events again. `append` must then find duplicates among the writes
   *   that did land.
   *
   *   The journal must also read its own writes within one step, before any
   *   of them is durable: `subscription()` returns what `setSubscription`
   *   set earlier in the step, and `append` reports an event appended
   *   earlier in the step as a duplicate.
   */
  acknowledge?: 'immediately' | 'next-step';
}

export type StepResult =
  | { kind: 'subscribed'; subscription: string }
  | { kind: 'reconciled'; reason: string }
  | { kind: 'events'; stored: number; duplicates: number }
  | { kind: 'idle' }
  | { kind: 'ended'; reason: string }
  /** A refusal that passes: wait `seconds` before the next step. */
  | { kind: 'backoff'; seconds: number; reason: string };

/** Whether `error` is a `409` refusal with one of `codes`. */
function stale(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof InboxError &&
    error.status === 409 &&
    error.code !== undefined &&
    codes.includes(error.code)
  );
}

export class InboxConsumer {
  constructor(private readonly options: InboxConsumerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** One unit of work; call it in a loop (see the module comment). */
  async step(): Promise<StepResult> {
    const { journal } = this.options;
    try {
      return await this.work();
    } catch (error) {
      if (!(error instanceof InboxError)) throw error;
      if (error.status === 410 && error.ended) {
        // Expired or closed (for example after a long sleep), from any call:
        // the gap is recorded, and the next step subscribes again and
        // reconciles.
        await journal.recordGap(error.ended.subscription, error.ended.gap);
        await journal.setSubscription(undefined);
        return { kind: 'ended', reason: error.ended.gap.reason };
      }
      if (error.status === 404 && error.code === 'unknown-subscription') {
        // Only the receiver's own answer: a 404 from something in between
        // (a proxy, a route that is not mounted) must not drop it.
        await journal.setSubscription(undefined);
        return { kind: 'ended', reason: 'unknown-subscription' };
      }
      const seconds = error.backoff();
      if (seconds !== undefined) {
        return {
          kind: 'backoff',
          seconds,
          reason: error.code ?? String(error.status),
        };
      }
      throw error;
    }
  }

  private get deferred(): boolean {
    return this.options.acknowledge === 'next-step';
  }

  private async work(): Promise<StepResult> {
    const { client, journal } = this.options;
    let stored = await journal.subscription();
    if (!stored) {
      // A crash between `subscribe` and `remember` leaves a subscription at
      // the receiver that this journal does not know, and the next step
      // subscribes again. The orphan is never acknowledged, so its progress
      // deadline closes it and its retention ends; until then it counts
      // against the owner's quota.
      const subscription = await client.subscribe(this.options.subscription);
      await this.remember(subscription);
      if (subscription.reconciliationRequired) {
        await this.reconcile(subscription.reconciliationRequired);
      }
      return { kind: 'subscribed', subscription: subscription.id };
    }
    if (this.deferred) {
      stored = await this.confirmPrevious(stored);
    }
    if (stored.renewAfter && Date.parse(stored.renewAfter) <= this.now()) {
      await this.remember(await client.renew(stored.id));
    }
    const page = await client.events(stored.id, {
      wait: this.options.wait ?? DEFAULT_WAIT_SECONDS,
      ...(this.options.limit === undefined
        ? {}
        : { limit: this.options.limit }),
      ...(this.options.maxBytes === undefined
        ? {}
        : { maxBytes: this.options.maxBytes }),
    });
    let added = 0;
    let duplicates = 0;
    for (const event of page.events) {
      if (await journal.append(event)) {
        added += 1;
      } else {
        duplicates += 1;
      }
    }
    // Only what is journaled is acknowledged.
    if (page.next !== null && page.events.length > 0) {
      if (this.deferred) {
        await this.patch({
          unacknowledged: { generation: page.generation, cursor: page.next },
        });
      } else {
        await client.ack(stored.id, page.generation, page.next);
      }
    }
    if (page.reconciliationRequired) {
      // After this page is safely journaled: the events it holds are recent
      // hints from before the gap, not complete history.
      return await this.reconcile(page.reconciliationRequired);
    }
    if (page.events.length > 0) {
      return { kind: 'events', stored: added, duplicates };
    }
    return { kind: 'idle' };
  }

  /**
   * `'next-step'`: acknowledges what the last step appended and reports the
   * reconciliation it ran. Both were stored with that step's writes, so
   * finding them here means those writes are durable.
   */
  private async confirmPrevious(
    stored: StoredSubscription,
  ): Promise<StoredSubscription> {
    const { client } = this.options;
    let current = stored;
    if (current.unacknowledged) {
      const { generation, cursor } = current.unacknowledged;
      try {
        await client.ack(current.id, generation, cursor);
      } catch (error) {
        // The stored cursor can never be acknowledged any more: a gap since
        // then ended its generation (`obsolete-generation`), or the receiver
        // no longer recognises the cursor (`cursor-not-issued`, after it
        // rotated the key it authenticates cursors with). Its events are
        // stored; dropping the marker lets the next fetch report the current
        // state instead of resending the same ack forever.
        if (!stale(error, 'obsolete-generation', 'cursor-not-issued')) {
          throw error;
        }
      }
      current = await this.patch({ unacknowledged: undefined });
    }
    if (current.unconfirmedReconciliation) {
      const { generation, barrier } = current.unconfirmedReconciliation;
      try {
        await this.remember(
          await client.reconciled(current.id, generation, barrier),
        );
      } catch (error) {
        // A newer gap since then: it moved the barrier (`barrier-mismatch`)
        // or, as integration-proxy usually answers, started a new generation
        // (`obsolete-generation`). That reconciliation no longer counts;
        // dropping the marker lets the next fetch ask for another one
        // instead of resending the same `reconciled` forever.
        if (!stale(error, 'barrier-mismatch', 'obsolete-generation')) {
          throw error;
        }
      }
      current = await this.patch({ unconfirmedReconciliation: undefined });
    }
    return current;
  }

  /** Changes some stored fields, keeping the others. */
  private async patch(changes: {
    [K in Exclude<keyof StoredSubscription, 'id'>]?:
      | StoredSubscription[K]
      | undefined;
  }): Promise<StoredSubscription> {
    const { journal } = this.options;
    const current = await journal.subscription();
    if (!current) throw new Error('webhook inbox: no stored subscription');
    const next: StoredSubscription = { ...current };
    for (const [name, value] of Object.entries(changes)) {
      if (value === undefined) {
        delete (next as unknown as Record<string, unknown>)[name];
      } else {
        (next as unknown as Record<string, unknown>)[name] = value;
      }
    }
    await journal.setSubscription(next);
    return next;
  }

  /** Stores the receiver's view of the subscription, keeping what is pending. */
  private async remember(subscription: InboxSubscription): Promise<void> {
    const { journal } = this.options;
    const current = await journal.subscription();
    const same = current?.id === subscription.id ? current : undefined;
    await journal.setSubscription({
      id: subscription.id,
      ...(subscription.lease
        ? { renewAfter: subscription.lease.renewAfter }
        : {}),
      ...(same?.unacknowledged ? { unacknowledged: same.unacknowledged } : {}),
      ...(same?.unconfirmedReconciliation
        ? { unconfirmedReconciliation: same.unconfirmedReconciliation }
        : {}),
    });
  }

  private async reconcile(
    required: ReconciliationRequired,
  ): Promise<StepResult> {
    const { client, journal } = this.options;
    await journal.recordGap(required.subscription, required.gap);
    if (
      required.action !== 'reconcile' ||
      !required.generation ||
      !required.barrier
    ) {
      await journal.setSubscription(undefined);
      return { kind: 'ended', reason: required.gap.reason };
    }
    await this.options.reconcile(required.gap.reason);
    // Events captured since the barrier stay pending: they are journaled on
    // the next steps, after this full read.
    if (this.deferred) {
      // Reported at the start of the next step, once this read's writes are
      // known to be durable.
      await this.patch({
        unconfirmedReconciliation: {
          generation: required.generation,
          barrier: required.barrier,
        },
      });
    } else {
      await this.remember(
        await client.reconciled(
          required.subscription,
          required.generation,
          required.barrier,
        ),
      );
    }
    return { kind: 'reconciled', reason: required.gap.reason };
  }
}

/** An in-memory journal: the reference behaviour, for tests and examples. */
export class InMemoryInboxJournal implements InboxJournal {
  stored: StoredSubscription | undefined;
  readonly events: InboxEvent[] = [];
  readonly gaps: { subscription: string; gap: GapMarker }[] = [];
  private readonly deliveries = new Set<string>();
  private readonly gapKeys = new Set<string>();

  async subscription(): Promise<StoredSubscription | undefined> {
    return this.stored;
  }

  async setSubscription(
    subscription: StoredSubscription | undefined,
  ): Promise<void> {
    this.stored = subscription;
  }

  async append(event: InboxEvent): Promise<boolean> {
    if (this.deliveries.has(event.deliveryId)) {
      return false;
    }
    this.deliveries.add(event.deliveryId);
    this.events.push(event);
    return true;
  }

  async recordGap(subscription: string, gap: GapMarker): Promise<void> {
    const key = JSON.stringify([
      subscription,
      gap.generation,
      gap.detectedAt,
      gap.reason,
    ]);
    if (this.gapKeys.has(key)) return;
    this.gapKeys.add(key);
    this.gaps.push({ subscription, gap });
  }
}
