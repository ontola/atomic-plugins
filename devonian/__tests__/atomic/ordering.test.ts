import { describe, expect, it, vi } from 'vitest';
import {
  AtomicConnector,
  AtomicIdentityMap,
  AtomicLens,
  AtomicStore,
  ExternalId,
} from '../../src/main.js';
import {
  atomicOrderLens,
  FlatOrder,
  orderSchema,
  orderVocabulary as v,
} from '../../examples/AtomicExtractEntity.js';

/**
 * Event ordering (#259). `AtomicLens` applies ingested events in call order
 * and keeps no revisions, so a delayed or replayed webhook is applied as it
 * comes. The first group pins that default; the second shows the host-side
 * recipe of docs/atomic-data.md ("Event ordering"): the host keeps the
 * connector's own revision per external id, deletions included, and drops
 * anything not newer. Deterministic fakes; no connector I/O on ingest.
 */

interface Setup {
  store: AtomicStore;
  ids: AtomicIdentityMap;
  lens: AtomicLens<FlatOrder>;
}

function setup(): Setup {
  const store = new AtomicStore(orderSchema());
  const ids = new AtomicIdentityMap(store, 'https://example.com/bridge');
  const connector: AtomicConnector<FlatOrder> = {
    id: (record) => record.id,
    get: vi.fn(async () => {
      throw new Error('ingest never reads the platform');
    }),
    create: vi.fn(async () => {
      throw new Error('ingest never writes the platform');
    }),
    update: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  return { store, ids, lens: atomicOrderLens(store, ids, connector) };
}

const order = (quantity: number): FlatOrder => ({
  id: 'order-37',
  item: 'Anvil',
  quantity,
  customerId: 'customer-90',
  customerName: 'Wile E. Coyote',
});

/**
 * The recipe: a webhook carries the platform's revision for the record (an
 * `updated_at`, a version or a sequence number; connector-specific, so it
 * stays outside the library). The host remembers the newest one it applied
 * per external id, a deletion included (a tombstone), and runs the check and
 * the lens call in one chain, so two events for one id cannot interleave.
 * Persist `revisions` with the store snapshot, at the same checkpoint.
 */
function orderedEvents(
  lens: AtomicLens<FlatOrder>,
  revisions: Map<ExternalId, number>,
): {
  update(record: FlatOrder, revision: number): Promise<string | undefined>;
  remove(id: ExternalId, revision: number): Promise<boolean>;
} {
  let tail: Promise<unknown> = Promise.resolve();
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const stale = (id: ExternalId, revision: number): boolean => {
    const seen = revisions.get(id);
    return seen !== undefined && revision <= seen;
  };
  return {
    update: (record, revision) =>
      run(async () => {
        if (stale(record.id, revision)) return undefined;
        const subject = await lens.ingest(record);
        // Only after it applied: a failed ingest can be retried at the same revision.
        revisions.set(record.id, revision);
        return subject;
      }),
    remove: (id, revision) =>
      run(async () => {
        if (stale(id, revision)) return false;
        await lens.ingestDelete(id);
        revisions.set(id, revision);
        return true;
      }),
  };
}

describe('event ordering: the default is call order (#259)', () => {
  it('a delayed update ingested after a delete brings the resource back', async () => {
    const { store, lens } = setup();
    const subject = await lens.ingest(order(1));
    await lens.ingestDelete('order-37');
    expect(store.get(subject)).toBeUndefined();

    // The update the platform sent before the delete arrives late.
    expect(await lens.ingest(order(2))).toBe(subject);
    expect(store.get(subject)?.[v.quantity]).toBe(2);
  });

  it('replaying the same event is a no-op: same subject, same state', async () => {
    const { store, lens } = setup();
    const subject = await lens.ingest(order(1));
    const before = store.toJSONAD();

    expect(await lens.ingest(order(1))).toBe(subject);
    expect(store.toJSONAD()).toBe(before);
    expect(store.all(v.order)).toHaveLength(1);
  });

  it('an older update that arrives after a newer one overwrites it', async () => {
    const { store, lens } = setup();
    const subject = await lens.ingest(order(3)); // newer, first
    await lens.ingest(order(2)); // older, late
    expect(store.get(subject)?.[v.quantity]).toBe(2);
  });
});

describe('event ordering: the host recipe keeps the newest revision', () => {
  it('drops an update older than a delete, and keeps the tombstone', async () => {
    const { store, lens } = setup();
    const revisions = new Map<ExternalId, number>();
    const events = orderedEvents(lens, revisions);
    const subject = (await events.update(order(1), 1))!;

    expect(await events.remove('order-37', 3)).toBe(true);
    expect(await events.update(order(2), 2)).toBeUndefined();
    expect(store.get(subject)).toBeUndefined();
    expect(revisions.get('order-37')).toBe(3);
    // A genuinely newer record (re-created on the platform) does come back.
    expect(await events.update(order(4), 4)).toBe(subject);
    expect(store.get(subject)?.[v.quantity]).toBe(4);
  });

  it('drops an older update that arrives late, and a replay of the same revision', async () => {
    const { store, lens } = setup();
    const events = orderedEvents(lens, new Map());
    const subject = (await events.update(order(3), 3))!;

    expect(await events.update(order(2), 2)).toBeUndefined();
    expect(await events.update(order(3), 3)).toBeUndefined();
    expect(store.get(subject)?.[v.quantity]).toBe(3);
  });

  it('competing events for one id, sent at once, end at the newest whatever their order', async () => {
    for (const arrival of [
      [1, 2, 3],
      [3, 2, 1],
      [2, 3, 1],
    ]) {
      const { store, lens } = setup();
      const events = orderedEvents(lens, new Map());
      await Promise.all(arrival.map((n) => events.update(order(n), n)));
      expect(store.all(v.order)).toHaveLength(1);
      expect(store.all(v.order)[0]?.[v.quantity]).toBe(3);
    }
  });

  it('a failed ingest records no revision, so the same event can be retried', async () => {
    const { store, lens } = setup();
    const revisions = new Map<ExternalId, number>();
    const events = orderedEvents(lens, revisions);

    // 1.5 is not an integer: the store rejects the projection.
    await expect(events.update(order(1.5), 1)).rejects.toThrow();
    expect(revisions.has('order-37')).toBe(false);
    const subject = await events.update(order(1), 1);
    expect(store.get(subject!)?.[v.quantity]).toBe(1);
  });
});
