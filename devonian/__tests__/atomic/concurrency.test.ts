import { describe, expect, it, vi } from 'vitest';
import {
  AtomicConnector,
  AtomicIdentityMap,
  AtomicLens,
  AtomicStore,
  ExternalId,
  IS_A,
} from '../../src/main.js';
import {
  atomicOrderLens,
  FlatOrder,
  orderSchema,
  orderVocabulary as v,
} from '../../examples/AtomicExtractEntity.js';

/**
 * The concurrency contract of `AtomicLens` (docs/atomic-data.md,
 * "Concurrency"), pinned as it is today (#259): one lens instance queues its
 * own operations; nothing coordinates two instances or direct store edits.
 * Deterministic fakes only, no timers.
 */

const SCOPE = 'https://example.com/accounts/acme';
const ORDER = 'https://example.com/drive/orders/new-1';
const CUSTOMER = 'https://example.com/drive/customers/c-90';

/** A promise and the function that resolves it, to hold a connector call open. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

interface Setup {
  store: AtomicStore;
  ids: AtomicIdentityMap;
  connector: AtomicConnector<FlatOrder>;
  records: Map<ExternalId, FlatOrder>;
  /** Set to hold the next `get` or `create` open until the test opens it. */
  hold: {
    get?: Promise<void> | undefined;
    create?: Promise<void> | undefined;
  };
  lens: () => AtomicLens<FlatOrder>;
}

function setup({ honoursKey = true } = {}): Setup {
  const store = new AtomicStore(orderSchema());
  const ids = new AtomicIdentityMap(store, 'https://example.com/bridge');
  const records = new Map<ExternalId, FlatOrder>();
  const byKey = new Map<string, FlatOrder>();
  let next = 0;
  const hold: Setup['hold'] = {};
  const connector: AtomicConnector<FlatOrder> = {
    id: (record) => record.id,
    get: vi.fn(async (id) => {
      const wait = hold.get;
      hold.get = undefined;
      await wait;
      const record = records.get(id);
      if (!record) throw new Error('missing');
      return structuredClone(record);
    }),
    create: vi.fn(async (record, key) => {
      const wait = hold.create;
      hold.create = undefined;
      await wait;
      if (honoursKey && byKey.has(key)) return byKey.get(key)!;
      const created = { ...record, id: `server-${next++}` };
      byKey.set(key, created);
      records.set(created.id, created);
      return created;
    }),
    update: vi.fn(async (id, record) => {
      records.set(id, structuredClone(record));
    }),
    delete: vi.fn(async (id) => {
      records.delete(id);
    }),
  };
  // A native order nobody has published yet, for a customer the platform knows.
  store.apply([
    {
      subject: CUSTOMER,
      patch: { set: { [IS_A]: [v.customer], [v.name]: 'Wile E. Coyote' } },
    },
    {
      subject: ORDER,
      patch: {
        set: {
          [IS_A]: [v.order],
          [v.item]: 'Anvil',
          [v.quantity]: 1,
          [v.customerLink]: CUSTOMER,
        },
      },
    },
  ]);
  ids.bind({ scope: SCOPE, entity: 'customer' }, 'customer-90', CUSTOMER);
  const lens = (): AtomicLens<FlatOrder> =>
    atomicOrderLens(store, ids, connector);
  return { store, ids, connector, records, hold, lens };
}

describe('AtomicLens concurrency contract (#259)', () => {
  it('one lens queues its own calls: two publishes of a new resource create once, then update', async () => {
    const { connector, records, lens } = setup({ honoursKey: false });
    const one = lens();
    const [a, b] = await Promise.all([one.publish(ORDER), one.publish(ORDER)]);

    expect(a).toBe('server-0');
    expect(b).toBe('server-0');
    expect(connector.create).toHaveBeenCalledTimes(1);
    expect(connector.update).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(1);
  });

  it('two lenses are not coordinated: both create, and only the idempotency key keeps it one record', async () => {
    for (const honoursKey of [true, false]) {
      const { connector, records, ids, lens } = setup({ honoursKey });
      const [first, second] = [lens(), lens()];
      const [a, b] = await Promise.allSettled([
        first.publish(ORDER),
        second.publish(ORDER),
      ]);

      // Each instance saw no identity yet and asked to create, with the same key.
      expect(connector.create).toHaveBeenCalledTimes(2);
      const keys = vi.mocked(connector.create).mock.calls.map(([, key]) => key);
      expect(keys[0]).toBe(keys[1]);
      expect(ids.externalId({ scope: SCOPE, entity: 'order' }, ORDER)).toBe(
        'server-0',
      );
      if (honoursKey) {
        expect(a).toEqual({ status: 'fulfilled', value: 'server-0' });
        expect(b).toEqual({ status: 'fulfilled', value: 'server-0' });
        expect(records.size).toBe(1);
      } else {
        // A connector that ignores the key makes a duplicate: the second
        // publish then rejects on the identity map, and the platform keeps an
        // orphan record (server-1) the host has to find and remove itself.
        expect(a).toEqual({ status: 'fulfilled', value: 'server-0' });
        expect(b).toMatchObject({
          status: 'rejected',
          reason: { message: 'Conflicting identity mapping' },
        });
        expect([...records.keys()]).toEqual(['server-0', 'server-1']);
      }
    }
  });

  it('publish reads the resource when its turn starts: an edit made while it awaits the platform is not sent', async () => {
    const { store, records, hold, connector, lens } = setup();
    const one = lens();
    await one.publish(ORDER); // created as server-0
    const { opened, open } = gate();
    hold.get = opened;

    const sending = one.publish(ORDER);
    // Let the operation start and reach `connector.get`.
    await vi.waitFor(() => expect(connector.get).toHaveBeenCalledTimes(1));
    store.patch(ORDER, { set: { [v.quantity]: 2 } });
    store.patch(CUSTOMER, { set: { [v.name]: 'Road Runner' } });
    open();
    await sending;

    // The order was read before the await, so its new quantity waits for the
    // next publish; the linked customer is read inside write(), after it.
    expect(records.get('server-0')).toMatchObject({
      quantity: 1,
      customerName: 'Road Runner',
    });
    await one.publish(ORDER);
    expect(records.get('server-0')).toMatchObject({ quantity: 2 });
  });

  it('an edit made after publish() is called but before its turn is sent', async () => {
    const { store, records, hold, lens } = setup();
    const one = lens();
    const { opened, open } = gate();
    hold.create = opened;

    const creating = one.publish(ORDER); // holds the queue at create
    const updating = one.publish(ORDER); // queued behind it
    store.patch(ORDER, { set: { [v.quantity]: 5 } });
    open();
    await Promise.all([creating, updating]);

    expect(records.get('server-0')).toMatchObject({ quantity: 5 });
  });

  it('the host locking recipe: one lock shared by both lenses makes one create even without key support', async () => {
    const { connector, records, lens } = setup({ honoursKey: false });
    // docs/atomic-data.md, "Concurrency": chain every lens call that touches
    // the same resources through one promise, as the lens queue does inside.
    let tail: Promise<unknown> = Promise.resolve();
    const locked = <T>(operation: () => Promise<T>): Promise<T> => {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    };
    const [first, second] = [lens(), lens()];
    const [a, b] = await Promise.all([
      locked(() => first.publish(ORDER)),
      locked(() => second.publish(ORDER)),
    ]);

    expect([a, b]).toEqual(['server-0', 'server-0']);
    expect(connector.create).toHaveBeenCalledTimes(1);
    expect(connector.update).toHaveBeenCalledTimes(1);
    expect(records.size).toBe(1);
  });
});
