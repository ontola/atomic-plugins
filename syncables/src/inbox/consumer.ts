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
  /** Records a gap in history, as the receiver described it. */
  recordGap(subscription: string, gap: GapMarker): Promise<void>;
}

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
  /** Seconds a fetch may wait for an event (the receiver caps it at 25). */
  wait?: number;
  limit?: number;
  now?: () => number;
}

export type StepResult =
  | { kind: 'subscribed'; subscription: string }
  | { kind: 'reconciled'; reason: string }
  | { kind: 'events'; stored: number; duplicates: number }
  | { kind: 'idle' }
  | { kind: 'ended'; reason: string };

export class InboxConsumer {
  constructor(private readonly options: InboxConsumerOptions) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** One unit of work; call it in a loop. */
  async step(): Promise<StepResult> {
    const { client, journal } = this.options;
    const stored = await journal.subscription();
    if (!stored) {
      const subscription = await client.subscribe(this.options.subscription);
      await this.remember(subscription);
      if (subscription.reconciliationRequired) {
        await this.reconcile(subscription.reconciliationRequired);
      }
      return { kind: 'subscribed', subscription: subscription.id };
    }
    try {
      if (stored.renewAfter && Date.parse(stored.renewAfter) <= this.now()) {
        await this.remember(await client.renew(stored.id));
      }
      const page = await client.events(stored.id, {
        ...(this.options.wait === undefined ? {} : { wait: this.options.wait }),
        ...(this.options.limit === undefined
          ? {}
          : { limit: this.options.limit }),
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
        await client.ack(stored.id, page.generation, page.next);
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
    } catch (error) {
      if (error instanceof InboxError && error.status === 410 && error.ended) {
        // Expired or closed (for example after a long sleep): the gap is
        // recorded, and the next step subscribes again and reconciles.
        await journal.recordGap(stored.id, error.ended.gap);
        await journal.setSubscription(undefined);
        return { kind: 'ended', reason: error.ended.gap.reason };
      }
      if (error instanceof InboxError && error.status === 404) {
        await journal.setSubscription(undefined);
        return { kind: 'ended', reason: 'unknown-subscription' };
      }
      throw error;
    }
  }

  private async remember(subscription: InboxSubscription): Promise<void> {
    await this.options.journal.setSubscription({
      id: subscription.id,
      ...(subscription.lease
        ? { renewAfter: subscription.lease.renewAfter }
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
    await this.remember(
      await client.reconciled(
        required.subscription,
        required.generation,
        required.barrier,
      ),
    );
    return { kind: 'reconciled', reason: required.gap.reason };
  }
}

/** An in-memory journal: the reference behaviour, for tests and examples. */
export class InMemoryInboxJournal implements InboxJournal {
  stored: StoredSubscription | undefined;
  readonly events: InboxEvent[] = [];
  readonly gaps: { subscription: string; gap: GapMarker }[] = [];
  private readonly deliveries = new Set<string>();

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
    this.gaps.push({ subscription, gap });
  }
}
