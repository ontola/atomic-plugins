// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import { loadBrowserStatus } from '../../../src/daemon/browser-status.js';
import { isSyncAuthError } from '../../../src/daemon/sync-errors.js';
import {
  collectionScope,
  type CollectionConfig,
} from '../../../src/daemon/config.js';
import type { JobStatus } from '../../../src/daemon/runner.js';
const source: CollectionConfig = {
  platform: 'example',
  account: 'work',
  name: 'entries',
  connection: 'invented-connection',
  document: '/invented/document.json',
  collection: 'entries',
  bindings: {},
  query: {},
  pollSeconds: 300,
};
const time = new Date('2026-11-06T09:30:00Z');
const job: JobStatus = {
  alias: 'example/work/entries',
  scope: collectionScope('invented-owner', source, 'invented-hash'),
  state: 'idle',
  revision: 'invented-revision',
  last_error: null,
  next_due: time,
  generation: '1',
  completed: '1',
  last_attempt_at: time,
  last_success_at: time,
  last_failure_at: null,
  error_kind: null,
};
function fixture(jobs: JobStatus[] = [job]) {
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      owner: 'invented-owner',
      connections: [
        {
          connection_id: source.connection,
          platform: source.platform,
          label: 'Work account',
        },
        {
          connection_id: 'other-approved',
          platform: 'other',
          label: 'Available account',
        },
      ],
    }),
  );
  return {
    owner: 'invented-owner',
    collections: [source],
    jobs: async () => jobs,
    hasSnapshot: async () => true,
    session: async () => ({
      issuer: 'https://issuer.example',
      accessToken: 'invented-access-token',
    }),
    fetch: fetchImpl,
  };
}
describe('SyncD connection and sync status', () => {
  it('joins granted remote connections with local collections and real sync times', async () => {
    const options = fixture(),
      result = await loadBrowserStatus(options);
    expect(options.fetch).toHaveBeenCalledTimes(1);
    expect(String(options.fetch.mock.calls[0][0])).toBe(
      'https://issuer.example/connections',
    );
    expect(result.discovery.state).toBe('available');
    expect(result.connections).toHaveLength(2);
    expect(result.connections[0]).toMatchObject({
      label: 'Work account',
      availability: 'approved',
      lastSyncedAt: time.toISOString(),
    });
    expect(result.connections[1].collections).toEqual([]);
    expect(result.collections[0]).toMatchObject({
      state: 'synced',
      lastSyncedAt: time.toISOString(),
      lastAttemptAt: time.toISOString(),
    });
    expect(JSON.stringify(result)).not.toContain('invented-access-token');
  });
  it('keeps absent configured connections separate from available but unconfigured connections', async () => {
    const options = fixture();
    options.fetch.mockResolvedValueOnce(
      Response.json({ owner: options.owner, connections: [] }),
    );
    const result = await loadBrowserStatus(options);
    expect(result.connections[0].availability).toBe('not-approved');
    expect(result.collections[0].hasSnapshot).toBe(true);
  });
  it.each([401, 403, 500, 503])(
    'distinguishes discovery HTTP %s from sync failures',
    async (status) => {
      const options = fixture();
      options.fetch.mockResolvedValueOnce(
        Response.json({ error: 'private upstream text' }, { status }),
      );
      const result = await loadBrowserStatus(options);
      expect(result.discovery.state).toBe(
        status < 500 ? 'auth-required' : 'unavailable',
      );
      expect(result.connections[0].availability).toBe('unknown');
      expect(result.collections[0].state).toBe('synced');
      expect(JSON.stringify(result)).not.toContain('private upstream text');
    },
  );
  it('does not expose another owner’s remote connection metadata', async () => {
    const options = fixture();
    options.fetch.mockResolvedValueOnce(
      Response.json({
        owner: 'other-owner',
        connections: [{ connection_id: 'other-private', platform: 'private' }],
      }),
    );
    const result = await loadBrowserStatus(options);
    expect(result.discovery.state).toBe('auth-required');
    expect(JSON.stringify(result)).not.toContain('other-private');
  });
  it('supports offline browsing when a login is missing', async () => {
    const options = fixture();
    options.session = async () => {
      throw new Error('Login required; sensitive internal text');
    };
    const result = await loadBrowserStatus(options);
    expect(options.fetch).not.toHaveBeenCalled();
    expect(result.discovery.state).toBe('auth-required');
    expect(result.collections[0].hasSnapshot).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sensitive internal text');
  });
  it.each([
    ['auth', 'auth-error'],
    ['sync', 'sync-error'],
    ['checkout', 'checkout-blocked'],
  ] as const)(
    'reports %s errors without forwarding stored diagnostics',
    async (kind, state) => {
      const result = await loadBrowserStatus(
        fixture([
          {
            ...job,
            state: 'failed',
            error_kind: kind,
            last_error: 'invented-private-diagnostic',
            last_failure_at: time,
          },
        ]),
      );
      expect(result.collections[0].state).toBe(state);
      expect(result.collections[0].lastSyncedAt).toBe(time.toISOString());
      expect(result.collections[0].lastFailureAt).toBe(time.toISOString());
      expect(JSON.stringify(result)).not.toContain(
        'invented-private-diagnostic',
      );
    },
  );
  it('does not invent a last-sync timestamp for older snapshots or never-synced data', async () => {
    const options = fixture([{ ...job, last_success_at: null }]);
    expect((await loadBrowserStatus(options)).collections[0]).toMatchObject({
      hasSnapshot: true,
      lastSyncedAt: null,
    });
    options.hasSnapshot = async () => false;
    options.jobs = async () => [];
    expect((await loadBrowserStatus(options)).collections[0]).toMatchObject({
      state: 'not-synced',
      lastSyncedAt: null,
    });
  });
  it('does not attribute an old connection’s last sync to a newly configured connection', async () => {
    const options = fixture();
    options.collections = [{ ...source, connection: 'new-connection' }];
    const result = await loadBrowserStatus(options);
    expect(result.collections[0].lastSyncedAt).toBeNull();
  });
  it('does not classify a 5xx discovery failure as an auth error', () => {
    expect(
      isSyncAuthError(
        Object.assign(new Error('Connection discovery refused (HTTP 500)'), {
          status: 500,
        }),
      ),
    ).toBe(false);
    expect(
      isSyncAuthError(Object.assign(new Error('refused'), { status: 401 })),
    ).toBe(true);
  });
});
