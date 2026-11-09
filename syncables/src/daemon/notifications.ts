// @wc-ignore-file
import { InboxClient } from '../inbox/client.js';
import { InboxConsumer, type StoredSubscription } from '../inbox/consumer.js';
import { nodeHash } from '../postgres/json-graph.js';
import type { PostgresArchive } from '../postgres/archive.js';
import type { Session } from '../cli/auth.js';
import { alias, type CollectionConfig } from './config.js';

/** Local durable subscription state. No provider credentials or payloads. */
export const NOTIFICATION_SCHEMA = `CREATE TABLE IF NOT EXISTS syncables_cache.daemon_notifications (
 owner text NOT NULL, selection text NOT NULL, subscription jsonb,
 PRIMARY KEY(owner, selection)
)`;
export function notificationConsumer(options: {
  archive: PostgresArchive;
  owner: string;
  issuer: string;
  collection: CollectionConfig;
  session(): Promise<Session>;
  trigger(delivery: string): Promise<boolean>;
  reconcile(): Promise<void | 'pending'>;
  fetch?: typeof fetch;
}): InboxConsumer {
  const { archive, owner, collection } = options;
  const spec = collection.notifications!;
  const selection = nodeHash(
    JSON.stringify([
      options.issuer,
      alias(collection),
      collection.connection,
      spec,
    ]),
  );
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const client = new InboxClient(options.issuer, async (request) => {
    const session = await options.session();
    if (!session.scope?.split(' ').includes('notifications:consume'))
      throw new Error(
        'Approve notifications:consume before receiving change notifications',
      );
    const url = new URL(request.url);
    if (url.origin !== new URL(options.issuer).origin)
      throw new Error('Notification request escaped IAP');
    const response = await fetchImpl(url, {
      method: request.method,
      headers: {
        ...request.headers,
        Authorization: 'Bearer ' + session.accessToken,
      },
      ...(request.body === undefined ? {} : { body: request.body }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    const body = await response.text();
    if (body.length > 1024 * 1024)
      throw new Error('Notification page too large');
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return { status: response.status, headers, body };
  });
  return new InboxConsumer({
    client,
    subscription: {
      connection: collection.connection,
      source: spec.source,
      parameters: spec.parameters,
      events: spec.events,
    },
    wait: 0,
    limit: 50,
    maxBytes: 16384,
    journal: {
      async subscription() {
        const result = await archive.pool.query(
          'SELECT subscription FROM syncables_cache.daemon_notifications WHERE owner=$1 AND selection=$2',
          [owner, selection],
        );
        return result.rows[0]?.subscription as StoredSubscription | undefined;
      },
      async setSubscription(value) {
        await archive.pool.query(
          'INSERT INTO syncables_cache.daemon_notifications(owner,selection,subscription) VALUES($1,$2,$3) ON CONFLICT(owner,selection) DO UPDATE SET subscription=EXCLUDED.subscription',
          [owner, selection, value ? JSON.stringify(value) : null],
        );
      },
      async append(event) {
        // trigger commits the local work item before the consumer acknowledges.
        // Ignore the body: source, event and delivery identity are enough to refetch.
        return options.trigger(
          nodeHash(
            JSON.stringify([
              selection,
              event.generation,
              event.cursor,
              event.deliveryId,
            ]),
          ),
        );
      },
      async recordGap(subscription, gap) {
        await options.trigger(
          nodeHash(JSON.stringify([selection, subscription, gap])),
        );
      },
    },
    reconcile: () => options.reconcile(),
  });
}
