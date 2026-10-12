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
  /** Set to hold the next create open until the test resolves it. */
  hold: Promise<void> | undefined;
  /** Called as each create request arrives, before it is applied. */
  onCreate: (() => void) | undefined;
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
        this.onCreate?.();
        const wait = this.hold;
        this.hold = undefined;
        await wait;
        if (this.honoursKey && this.byKey.has(key))
          return structuredClone(this.byKey.get(key)!);
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
 * marker in the body, which people may see), and look it up before
 * creating. Specific to the platform, so it lives in the connector, not the
 * library. The lookup below reads `platform.records` directly: the ideal
 * case, complete and current. A real platform's search may lag behind a
 * create, and then this is not enough; nor is lookup-then-create atomic
 * against a second host (docs/atomic-data.md, "Recovering from a crash").
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
    let release!: () => void;
    platform.hold = new Promise<void>((resolve) => (release = resolve));
    let creating!: () => void;
    const created = new Promise<void>((resolve) => (creating = resolve));
    platform.onCreate = creating;
    const publishing = first.lens.publish(ORDER);
    await created; // the publish is now awaiting the platform's create
    const during = first.store.toJSONAD(); // too early
    release();
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

  /**
   * The intent log of docs/atomic-data.md: (1) write the subject to the log
   * before the create is sent, (2) publish, (3) write the checkpoint,
   * (4) then remove the subject. `crash` stops the host after a step; the
   * log and the checkpoint are what survives.
   */
  function withIntentLog(): {
    durable: { intents: string[]; checkpoint: string };
    publishNew(
      h: Host,
      subject: string,
      crash?: 'after-publish' | 'after-checkpoint',
    ): Promise<void>;
    recover(h: Host): { uncertain: string[]; stale: string[] };
  } {
    const durable = { intents: [] as string[], checkpoint: '' };
    return {
      durable,
      async publishNew(h, subject, crash): Promise<void> {
        const first = h.ids.externalId(ORDERS, subject) === undefined;
        if (first) durable.intents = [...durable.intents, subject]; // 1
        await h.lens.publish(subject); // 2
        if (crash === 'after-publish') return;
        durable.checkpoint = h.store.toJSONAD(); // 3
        if (crash === 'after-checkpoint') return;
        durable.intents = durable.intents.filter((s) => s !== subject); // 4
      },
      recover(h): { uncertain: string[]; stale: string[] } {
        const bound = (s: string): boolean =>
          h.ids.externalId(ORDERS, s) !== undefined;
        const stale = durable.intents.filter(bound);
        const uncertain = durable.intents.filter((s) => !bound(s));
        durable.intents = uncertain; // a stale intent is cleared, not published
        return { uncertain, stale };
      },
    };
  }

  it('the intent log is written before the create request is sent', async () => {
    const platform = new Platform(false);
    const log = withIntentLog();
    const first = host(platform.connector());
    log.durable.checkpoint = first.store.toJSONAD();
    let seen: string[] | undefined;
    platform.onCreate = (): void => {
      seen = [...log.durable.intents];
    };
    await log.publishNew(first, ORDER);

    expect(seen).toEqual([ORDER]);
    expect(log.durable.intents).toEqual([]);
  });

  it('a crash after the create names it as uncertain, so nothing is resent blind', async () => {
    const platform = new Platform(false);
    const log = withIntentLog();
    const first = host(platform.connector());
    log.durable.checkpoint = first.store.toJSONAD();
    await log.publishNew(first, ORDER, 'after-publish');

    const second = host(platform.connector(), log.durable.checkpoint);
    expect(log.recover(second)).toEqual({ uncertain: [ORDER], stale: [] });
    // The host asks the person; here they find server-0 on the platform and
    // bind it, and the next publish updates it instead of creating another.
    second.ids.bind(ORDERS, 'server-0', ORDER);
    await log.publishNew(second, ORDER);
    expect(platform.records.size).toBe(1);
    expect(log.durable.intents).toEqual([]);
    expect(
      host(platform.connector(), log.durable.checkpoint).ids.externalId(
        ORDERS,
        ORDER,
      ),
    ).toBe('server-0');
  });

  it('a crash after the checkpoint leaves a stale intent: cleared, not published', async () => {
    const platform = new Platform(false);
    const log = withIntentLog();
    const first = host(platform.connector());
    log.durable.checkpoint = first.store.toJSONAD();
    await log.publishNew(first, ORDER, 'after-checkpoint');
    expect(log.durable.intents).toEqual([ORDER]);

    const second = host(platform.connector(), log.durable.checkpoint);
    expect(log.recover(second)).toEqual({ uncertain: [], stale: [ORDER] });
    expect(log.durable.intents).toEqual([]);
    expect(platform.records.size).toBe(1);
  });

  it('a lost intent log reports nothing, and a blind re-publish duplicates', async () => {
    const platform = new Platform(false);
    const log = withIntentLog();
    const first = host(platform.connector());
    log.durable.checkpoint = first.store.toJSONAD();
    await log.publishNew(first, ORDER, 'after-publish');
    log.durable.intents = []; // lost, or older than the checkpoint

    const second = host(platform.connector(), log.durable.checkpoint);
    expect(log.recover(second)).toEqual({ uncertain: [], stale: [] });
    await second.lens.publish(ORDER);
    expect(platform.records.size).toBe(2);
  });
});
