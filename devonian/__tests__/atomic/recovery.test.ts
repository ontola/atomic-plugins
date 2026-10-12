import { describe, expect, it } from 'vitest';
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
 * Restart and recovery (#259), as a host recipe (docs/atomic-data.md,
 * "Persistence and restart"). A "crash" here is the host losing everything
 * in memory: the next process restores the last JSON-AD checkpoint into a
 * fresh store, identity map and lens. The platform keeps whatever it was
 * sent. Deterministic fakes only.
 */

const SCOPE = 'https://example.com/accounts/acme';
const ORDERS = { scope: SCOPE, entity: 'order' };
const ORDER = 'https://example.com/drive/orders/new-1';
const CUSTOMER = 'https://example.com/drive/customers/c-90';

/** What the platform holds; it outlives every host process. */
class Platform {
  records = new Map<ExternalId, FlatOrder>();
  private byKey = new Map<string, FlatOrder>();
  private next = 0;
  constructor(readonly honoursKey: boolean) {}

  /** The platform's own API, as a connector sees it. */
  connector(): AtomicConnector<FlatOrder> {
    return {
      id: (record) => record.id,
      get: async (id): Promise<FlatOrder> => {
        const record = this.records.get(id);
        if (!record) throw new Error('missing');
        return structuredClone(record);
      },
      create: async (record, key): Promise<FlatOrder> => {
        if (this.honoursKey && this.byKey.has(key)) return this.byKey.get(key)!;
        const created = { ...record, id: `server-${this.next++}` };
        this.byKey.set(key, created);
        this.records.set(created.id, structuredClone(created));
        return created;
      },
      update: async (id, record): Promise<void> => {
        this.records.set(id, structuredClone(record));
      },
      delete: async (id): Promise<void> => {
        this.records.delete(id);
      },
    };
  }
}

interface Host {
  store: AtomicStore;
  ids: AtomicIdentityMap;
  lens: AtomicLens<FlatOrder>;
}

/** A host process: from a checkpoint, or the first one with a new order. */
function host(
  connector: AtomicConnector<FlatOrder>,
  checkpoint?: string,
): Host {
  const store = new AtomicStore(orderSchema());
  const ids = new AtomicIdentityMap(store, 'https://example.com/bridge');
  if (checkpoint) store.loadJSONAD(checkpoint);
  else {
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
  }
  return { store, ids, lens: atomicOrderLens(store, ids, connector) };
}

/**
 * Connector-side reconciliation for a platform that ignores idempotency
 * keys: write the key into a field the platform stores (here the order's
 * free `platformNote`; on a real platform a custom field, a label or a
 * hidden marker in the body), and look it up before creating. Specific to
 * the platform, so it lives in the connector, not the library; it needs a
 * lookup the platform answers completely (a search that can lag behind a
 * create is not enough).
 */
function markerIdempotent(
  inner: AtomicConnector<FlatOrder>,
  platform: Platform,
): AtomicConnector<FlatOrder> {
  const marker = (key: string): string => `devonian-create:${key}`;
  return {
    ...inner,
    create: async (record, key): Promise<FlatOrder> => {
      const found = [...platform.records.values()].find(
        (r) => r.platformNote === marker(key),
      );
      if (found) return structuredClone(found);
      return inner.create({ ...record, platformNote: marker(key) }, key);
    },
  };
}

describe('restart and recovery recipe (#259)', () => {
  it('checkpoint after awaited work: one taken during a publish misses the new identity', async () => {
    const platform = new Platform(true);
    const first = host(platform.connector());
    const publishing = first.lens.publish(ORDER);
    const during = first.store.toJSONAD(); // not awaited: too early
    await publishing;
    const after = first.store.toJSONAD();

    expect(
      host(platform.connector(), during).ids.externalId(ORDERS, ORDER),
    ).toBe(undefined);
    expect(
      host(platform.connector(), after).ids.externalId(ORDERS, ORDER),
    ).toBe('server-0');
  });

  it('a crash after the remote create, before the checkpoint: a key-honouring platform gives the same record', async () => {
    const platform = new Platform(true);
    const first = host(platform.connector());
    const checkpoint = first.store.toJSONAD(); // the last one before publish
    await first.lens.publish(ORDER); // created; the host dies before checkpointing

    const second = host(platform.connector(), checkpoint);
    expect(second.ids.externalId(ORDERS, ORDER)).toBeUndefined();
    expect(await second.lens.publish(ORDER)).toBe('server-0');
    expect(second.ids.externalId(ORDERS, ORDER)).toBe('server-0');
    expect(platform.records.size).toBe(1);
  });

  it('the same crash on a platform that ignores keys creates a duplicate (the documented limit)', async () => {
    const platform = new Platform(false);
    const first = host(platform.connector());
    const checkpoint = first.store.toJSONAD();
    await first.lens.publish(ORDER);

    const second = host(platform.connector(), checkpoint);
    expect(await second.lens.publish(ORDER)).toBe('server-1');
    expect([...platform.records.keys()]).toEqual(['server-0', 'server-1']);
  });

  it('a connector that marks and looks up its creates turns that crash into one record', async () => {
    const platform = new Platform(false);
    const connector = (): AtomicConnector<FlatOrder> =>
      markerIdempotent(platform.connector(), platform);
    const first = host(connector());
    const checkpoint = first.store.toJSONAD();
    await first.lens.publish(ORDER);

    const second = host(connector(), checkpoint);
    expect(await second.lens.publish(ORDER)).toBe('server-0');
    expect(platform.records.size).toBe(1);
    // The marker is the connector's: the native order never holds it.
    expect(JSON.stringify(second.store.get(ORDER))).not.toContain(
      'devonian-create',
    );
  });

  it('explicit uncertain creates: an intent log names what a restart cannot tell, so nothing is resent blind', async () => {
    const platform = new Platform(false);
    // Durable next to the checkpoint: subjects whose create was asked for and
    // not yet checkpointed. Written before publish, cleared after the checkpoint.
    let intents: string[] = [];
    let checkpoint = '';
    const first = host(platform.connector());
    const publishNew = async (h: Host, subject: string): Promise<void> => {
      if (h.ids.externalId(ORDERS, subject) === undefined)
        intents = [...intents, subject];
      await h.lens.publish(subject);
      checkpoint = h.store.toJSONAD();
      intents = intents.filter((s) => s !== subject);
    };
    checkpoint = first.store.toJSONAD();
    intents = [ORDER];
    await first.lens.publish(ORDER); // the host dies here: intent kept

    const second = host(platform.connector(), checkpoint);
    const uncertain = intents.filter(
      (s) => second.ids.externalId(ORDERS, s) === undefined,
    );
    expect(uncertain).toEqual([ORDER]);
    // The host asks the person; here they find server-0 on the platform and
    // bind it, and the next publish updates it instead of creating another.
    second.ids.bind(ORDERS, 'server-0', ORDER);
    await publishNew(second, ORDER);
    expect(platform.records.size).toBe(1);
    expect(intents).toEqual([]);
    expect(
      host(platform.connector(), checkpoint).ids.externalId(ORDERS, ORDER),
    ).toBe('server-0');
  });
});
