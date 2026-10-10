import { describe, expect, it } from 'vitest';

import { InboxClient } from '../../../src/inbox/client.js';
import {
  InboxConsumer,
  InMemoryInboxJournal,
} from '../../../src/inbox/consumer.js';
import type { InboxEvent } from '../../../src/inbox/client.js';
import { FakeInbox } from './fake-inbox.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup(
  inbox = new FakeInbox(),
  journal = new InMemoryInboxJournal(),
): {
  inbox: FakeInbox;
  journal: InMemoryInboxJournal;
  consumer: InboxConsumer;
  reconciles: string[];
} {
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
  });
  return { inbox, journal, consumer, reconciles };
}

const ids = (events: InboxEvent[]): string[] => events.map((e) => e.deliveryId);

describe('InboxConsumer', () => {
  it('subscribes, reconciles once, then journals and acknowledges events', async () => {
    const { inbox, journal, consumer, reconciles } = setup();
    expect(await consumer.step()).toEqual({
      kind: 'subscribed',
      subscription: 'sub-1',
    });
    expect(reconciles).toEqual(['initial']);
    expect(journal.gaps.map((g) => g.gap.reason)).toEqual(['initial']);
    inbox.deliver('d-1');
    inbox.deliver('d-2');
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 2,
      duplicates: 0,
    });
    expect(ids(journal.events)).toEqual(['d-1', 'd-2']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    expect(await consumer.step()).toEqual({ kind: 'idle' });
  });

  it('never acknowledges what it did not journal, and a crash before the ack loses nothing', async () => {
    const { inbox, journal, consumer } = setup();
    await consumer.step();
    inbox.deliver('d-1');
    // The journal write succeeds, then the connection drops before the ack.
    inbox.failOnce.add('POST /ack');
    await expect(consumer.step()).rejects.toThrow('connection lost');
    expect(ids(journal.events)).toEqual(['d-1']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(1);
    // A new process on the same journal: the redelivery is a duplicate.
    const again = setup(inbox, journal);
    expect(await again.consumer.step()).toEqual({
      kind: 'events',
      stored: 0,
      duplicates: 1,
    });
    expect(ids(journal.events)).toEqual(['d-1']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);

    // A journal that fails: nothing is acknowledged.
    const failing = new InMemoryInboxJournal();
    const broken = setup(inbox, failing);
    await broken.consumer.step();
    inbox.deliver('d-2');
    failing.append = async (): Promise<boolean> => {
      throw new Error('disk full');
    };
    await expect(broken.consumer.step()).rejects.toThrow('disk full');
    expect(inbox.requests.filter((r) => r.endsWith('/ack'))).toHaveLength(2);
  });

  it('after sleeping past the lease, records the gap, subscribes again and reconciles', async () => {
    const { inbox, journal, consumer, reconciles } = setup();
    await consumer.step();
    inbox.deliver('d-1');
    inbox.now += 8 * DAY;
    inbox.deliver('d-lost');
    expect(await consumer.step()).toEqual({
      kind: 'ended',
      reason: 'lease-expired',
    });
    expect(journal.stored).toBeUndefined();
    expect(await consumer.step()).toEqual({
      kind: 'subscribed',
      subscription: 'sub-2',
    });
    expect(reconciles).toEqual(['initial', 'initial']);
    expect(journal.gaps.map((g) => g.gap.reason)).toEqual([
      'initial',
      'lease-expired',
      'initial',
    ]);
    // History inside the gap is not replayed: only a full read restores state.
    expect(ids(journal.events)).toEqual([]);
  });

  it('reconciles against the barrier after a gap, keeping the recent events it still gets', async () => {
    const inbox = new FakeInbox();
    inbox.maxPending = 3;
    const { journal, consumer, reconciles } = setup(inbox);
    await consumer.step();
    for (const id of ['d-1', 'd-2', 'd-3', 'd-4', 'd-5']) inbox.deliver(id);
    // The page holds what is left of generation 1, with the gap.
    expect(await consumer.step()).toEqual({
      kind: 'reconciled',
      reason: 'subscription-events-limit',
    });
    expect(reconciles).toEqual(['initial', 'subscription-events-limit']);
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
    // d-1 and d-2 were evicted; d-3, the last of generation 1, came with the
    // gap and was journaled before the reconciliation.
    expect(ids(journal.events)).toEqual(['d-3']);
    // d-4 and d-5, captured after the barrier, arrive on the next step.
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 2,
      duplicates: 0,
    });
    expect(ids(journal.events)).toEqual(['d-3', 'd-4', 'd-5']);
    expect(journal.events.map((e) => e.generation)).toEqual(['g1', 'g2', 'g2']);
  });

  it('journals events captured during the reconciliation scan on the next steps', async () => {
    const inbox = new FakeInbox();
    const journal = new InMemoryInboxJournal();
    const reconciles: string[] = [];
    const consumer = new InboxConsumer({
      client: new InboxClient('https://proxy.example', inbox.transport),
      journal,
      subscription: {
        connection: 'c-1',
        source: 'project',
        parameters: {},
        events: ['task'],
      },
      // A provider change lands while the full read runs.
      reconcile: async (reason): Promise<void> => {
        reconciles.push(reason);
        inbox.deliver('during-scan');
      },
      now: (): number => inbox.now,
    });
    await consumer.step();
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
    expect(await consumer.step()).toEqual({
      kind: 'events',
      stored: 1,
      duplicates: 0,
    });
    expect(ids(journal.events)).toEqual(['during-scan']);
  });

  it('renews the lease once renewAfter has passed, and not before', async () => {
    const { inbox, consumer } = setup();
    await consumer.step();
    await consumer.step();
    expect(inbox.requests.filter((r) => r.endsWith('/renew'))).toHaveLength(0);
    inbox.now += 13 * HOUR;
    await consumer.step();
    expect(inbox.requests.filter((r) => r.endsWith('/renew'))).toHaveLength(1);
    await consumer.step();
    expect(inbox.requests.filter((r) => r.endsWith('/renew'))).toHaveLength(1);
  });

  it('forgets a subscription the receiver does not know', async () => {
    const { inbox, journal, consumer } = setup();
    await journal.setSubscription({ id: 'sub-unknown' });
    expect(await consumer.step()).toEqual({
      kind: 'ended',
      reason: 'unknown-subscription',
    });
    expect(journal.stored).toBeUndefined();
    expect(await consumer.step()).toMatchObject({ kind: 'subscribed' });
    expect(inbox.subs.size).toBe(1);
  });
});
