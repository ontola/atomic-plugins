import { describe, expect, it, vi } from 'vitest';
import { notificationConsumer } from '../../../src/daemon/notifications.js';
import type { PostgresArchive } from '../../../src/postgres/archive.js';

describe('IAP change hints', () => {
  it('does not acknowledge when durable local work scheduling fails, then retries', async () => {
    let durable = false;
    const trigger = vi.fn<(delivery: string) => Promise<boolean>>(async () => {
      if (!durable) throw new Error('disk unavailable');
      return true;
    });
    const calls: string[] = [];
    const archive = {
      pool: {
        query: async () => ({ rows: [{ subscription: { id: 'sub-1' } }] }),
      },
    } as unknown as PostgresArchive;
    const consumer = notificationConsumer({
      archive,
      owner: 'owner',
      issuer: 'https://iap.example',
      collection: {
        platform: 'example',
        account: 'a',
        name: 'tasks',
        connection: 'conn-1',
        document: '/unused',
        collection: 'tasks',
        bindings: {},
        query: {},
        pollSeconds: 300,
        notifications: {
          source: 'project',
          parameters: { project: 'p' },
          events: ['changed'],
        },
      },
      session: async () => ({
        issuer: 'https://iap.example',
        accessToken: 'private',
        scope: 'notifications:consume',
      }),
      trigger,
      reconcile: async () => {},
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname;
        calls.push(path);
        expect(init?.headers).toMatchObject({
          Authorization: 'Bearer private',
        });
        if (path.endsWith('/ack')) return Response.json({});
        return Response.json({
          generation: 'generation',
          events: [
            {
              cursor: 'cursor',
              generation: 'generation',
              deliveryId: 'delivery',
              payload: { body: 'not-for-storage' },
            },
          ],
          next: 'cursor',
          more: false,
        });
      },
    });
    await expect(consumer.step()).rejects.toThrow('disk unavailable');
    expect(calls.some((path) => path.endsWith('/ack'))).toBe(false);
    durable = true;
    expect((await consumer.step()).kind).toBe('events');
    expect(calls.at(-1)).toBe('/subscriptions/sub-1/ack');
    expect(trigger.mock.calls[0][0]).toBe(trigger.mock.calls[1][0]);
    expect(trigger.mock.calls[0][0]).not.toContain('not-for-storage');
  });
});
