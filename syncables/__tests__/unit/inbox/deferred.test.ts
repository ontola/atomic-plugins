import { describe, expect, it } from 'vitest';

import {
  InboxClient,
  type GapMarker,
  type InboxEvent,
} from '../../../src/inbox/client.js';
import {
  InboxConsumer,
  InMemoryInboxJournal,
  type InboxJournal,
  type StoredSubscription,
} from '../../../src/inbox/consumer.js';
import { FakeInbox, json } from './fake-inbox.js';

/**
 * A journal whose writes become durable only when the host applies them
 * after the step, like atomic-server's scheduled sandbox runs: `commit()`
 * applies what the step wrote, `drop()` loses it (the run's intents were
 * never applied).
 */
class StagedJournal implements InboxJournal {
  readonly durable = new InMemoryInboxJournal();
  private staged: ((journal: InMemoryInboxJournal) => Promise<unknown>)[] = [];
  private stagedIds = new Set<string>();
  private view: { value: StoredSubscription | undefined } | undefined;

  async subscription(): Promise<StoredSubscription | undefined> {
    return this.view ? this.view.value : this.durable.stored;
  }

  async setSubscription(
    subscription: StoredSubscription | undefined,
  ): Promise<void> {
    this.view = { value: subscription };
    this.staged.push((journal) => journal.setSubscription(subscription));
  }

  async append(event: InboxEvent): Promise<boolean> {
    const known =
      this.stagedIds.has(event.deliveryId) ||
      this.durable.events.some((e) => e.deliveryId === event.deliveryId);
    if (known) return false;
    this.stagedIds.add(event.deliveryId);
    this.staged.push((journal) => journal.append(event));
    return true;
  }

  async recordGap(subscription: string, gap: GapMarker): Promise<void> {
    this.staged.push((journal) => journal.recordGap(subscription, gap));
  }

  async commit(): Promise<void> {
    for (const write of this.staged) await write(this.durable);
    this.drop();
  }

  drop(): void {
    this.staged = [];
    this.stagedIds = new Set();
    this.view = undefined;
  }
}

function setup(inbox = new FakeInbox()): {
  inbox: FakeInbox;
  journal: StagedJournal;
  consumer: InboxConsumer;
  reconciles: string[];
  since: () => string[];
} {
  const journal = new StagedJournal();
  const reconciles: string[] = [];
  const consumer = new InboxConsumer({
    client: new InboxClient('https://proxy.example', inbox.transport),
    journal,
    subscription: {
      connection: 'c-1',
      source: 'project',
      parameters: { projectId: 'p-1' },
      events: ['task'],
    },
    reconcile: async (reason): Promise<void> => {
      reconciles.push(reason);
    },
    now: (): number => inbox.now,
    acknowledge: 'next-step',
    wait: 0,
  });
  let seen = 0;
  // The requests sent since the last call.
  const since = (): string[] => {
    const out = inbox.requests.slice(seen);
    seen = inbox.requests.length;
    return out;
  };
  return { inbox, journal, consumer, reconciles, since };
}

const ids = (events: InboxEvent[]): string[] => events.map((e) => e.deliveryId);

describe("InboxConsumer with acknowledge: 'next-step'", () => {
  it('acknowledges and reports a reconciliation only on the next step, after the writes are durable', async () => {
    const { inbox, journal, consumer, reconciles, since } = setup();
    expect(await consumer.step()).toEqual({
      kind: 'subscribed',
      subscription: 'sub-1',
    });
    expect(reconciles).toEqual(['initial']);
    // The full read ran, but `reconciled` waits for its writes.
    expect(since()).toEqual(['POST /connections/c-1/subscriptions']);
    await journal.commit();
    expect(journal.durable.stored?.unconfirmedReconciliation).toBeDefined();

    expect(await consumer.step()).toEqual({ kind: 'idle' });
    expect(since()).toEqual([
      'POST /subscriptions/sub-1/reconciled',
      'GET /subscriptions/sub-1/events',
    ]);
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
    await journal.commit();

    inbox.deliver('d-1');
    inbox.deliver('d-2');
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 2,
      duplicates: 0,
    });
    // Appended, not acknowledged.
    expect(since()).toEqual(['GET /subscriptions/sub-1/events']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(2);
    await journal.commit();
    expect(journal.durable.stored?.unacknowledged).toEqual({
      generation: 'g1',
      cursor: '1:2',
    });

    expect(await consumer.step()).toEqual({ kind: 'idle' });
    expect(since()).toEqual([
      'POST /subscriptions/sub-1/ack',
      'GET /subscriptions/sub-1/events',
    ]);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    await journal.commit();
    expect(journal.durable.stored?.unacknowledged).toBeUndefined();
    expect(ids(journal.durable.events)).toEqual(['d-1', 'd-2']);
  });

  it('loses nothing when a step’s writes are never applied', async () => {
    const { inbox, journal, consumer, since } = setup();
    await consumer.step();
    await journal.commit();
    await consumer.step();
    await journal.commit();
    inbox.deliver('d-1');
    await consumer.step();
    // The run's intents were not applied: neither the event nor its cursor.
    journal.drop();
    since();
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 1,
      duplicates: 0,
    });
    expect(since()).toEqual(['GET /subscriptions/sub-1/events']);
    await journal.commit();
    await consumer.step();
    expect(since()[0]).toBe('POST /subscriptions/sub-1/ack');
    await journal.commit();
    expect(ids(journal.durable.events)).toEqual(['d-1']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
  });

  it('runs a lost reconciliation again, then reports it once its writes land', async () => {
    const inbox = new FakeInbox();
    inbox.maxPending = 3;
    const { journal, consumer, reconciles, since } = setup(inbox);
    await consumer.step();
    await journal.commit();
    await consumer.step();
    await journal.commit();
    for (const id of ['d-1', 'd-2', 'd-3', 'd-4', 'd-5']) inbox.deliver(id);
    expect(await consumer.step()).toEqual({
      kind: 'reconciled',
      reason: 'subscription-events-limit',
    });
    journal.drop();
    expect(await consumer.step()).toEqual({
      kind: 'reconciled',
      reason: 'subscription-events-limit',
    });
    expect(reconciles).toEqual([
      'initial',
      'subscription-events-limit',
      'subscription-events-limit',
    ]);
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(true);
    await journal.commit();
    since();
    // Acknowledge the last of generation 1, report the reconciliation, then
    // the events captured after the barrier.
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 2,
      duplicates: 0,
    });
    expect(since()).toEqual([
      'POST /subscriptions/sub-1/ack',
      'POST /subscriptions/sub-1/reconciled',
      'GET /subscriptions/sub-1/events',
    ]);
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
    await journal.commit();
    expect(ids(journal.durable.events)).toEqual(['d-3', 'd-4', 'd-5']);
    expect(
      journal.durable.gaps
        .map((g) => g.gap.reason)
        .filter((r) => r !== 'initial'),
    ).toEqual(['subscription-events-limit']);
  });

  it('drops a reconciliation whose barrier moved, and reconciles again', async () => {
    const { inbox, journal, consumer, reconciles } = setup();
    await consumer.step();
    await journal.commit();
    inbox.answerOnce.set(
      'POST /reconciled',
      json(409, { status: 'error', code: 'barrier-mismatch' }),
    );
    // The stale marker is dropped; the fetch still asks for a reconciliation.
    expect(await consumer.step()).toEqual({
      kind: 'reconciled',
      reason: 'initial',
    });
    expect(reconciles).toEqual(['initial', 'initial']);
    await journal.commit();
    await consumer.step();
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
  });
});
