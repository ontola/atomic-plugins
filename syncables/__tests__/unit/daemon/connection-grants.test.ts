import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DaemonAuth,
  type DeviceCredentials,
} from '../../../src/daemon/auth.js';
import {
  readConnectionGrant,
  type ConnectionGrant,
  type ConnectionGrantBinding,
  type ConnectionGrantStore,
} from '../../../src/daemon/connection-grants.js';
import { isSyncAuthError } from '../../../src/daemon/sync-errors.js';
import type { DaemonConfig } from '../../../src/daemon/config.js';
import { PostgresArchive } from '../../../src/postgres/archive.js';

const sealed = 's1.inventedConfidentialGrant';
const example: ConnectionGrant = {
  version: 1,
  issuer: 'https://issuer.example',
  owner: 'atomic:agent:example',
  clientId: 'syncables-cli',
  sessionId: 'test-session',
  connectionId: 'approved-connection',
  grant: sealed,
  expiresAt: Math.floor(Date.now() / 1000) + 600,
};

describe('connection grant import input', () => {
  it('reads a single bounded v1 object across multiple stdin chunks', async () => {
    const input = Readable.from([
      Buffer.from(JSON.stringify(example)),
      Buffer.from('\n'),
    ]);
    await expect(readConnectionGrant(input)).resolves.toEqual(example);
  });

  it('rejects invalid or oversized input without echoing it', async () => {
    for (const [input, message] of [
      [`{"grant":"${sealed}" trailing-data`, 'Invalid connection grant JSON'],
      [
        JSON.stringify({ ...example, grant: 'k1.rawSecret' }),
        'Invalid connection grant envelope',
      ],
      [
        JSON.stringify({ ...example, extra: sealed }),
        'Invalid connection grant envelope',
      ],
      [
        JSON.stringify(example) + ' '.repeat(8192),
        'Connection grant input exceeds 8192 bytes',
      ],
    ]) {
      await expect(readConnectionGrant(Readable.from([input]))).rejects.toThrow(
        new Error(message),
      );
    }
  });

  it('times out without returning partial input', async () => {
    vi.useFakeTimers();
    try {
      const stalled = new Readable({ read(): void {} });
      const reading = readConnectionGrant(stalled).catch(
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await reading).toEqual(
        new Error('Connection grant input timed out'),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

const database = process.env.SYNCABLES_TEST_DATABASE_URL;
describe.skipIf(!database)(
  'connection grant lifetime (real auth locks, in-memory vault)',
  () => {
    let archive: PostgresArchive;
    beforeAll(async () => {
      archive = new PostgresArchive(database!);
      await archive.initialize();
    });
    afterAll(async () => {
      await archive?.close();
    });

    function setup(): {
      auth: () => DaemonAuth;
      envelope: ConnectionGrant;
      fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
      saved: Map<string, ConnectionGrant>;
      denyVault: () => void;
      newSession: () => void;
    } {
      const config: DaemonConfig = {
        version: 1,
        issuer: example.issuer,
        owner: 'grant-test-' + randomUUID(),
        clientId: example.clientId,
        dataDirectory: '/unused',
        collections: [],
      };
      let session: DeviceCredentials = {
        issuer: config.issuer,
        owner: config.owner,
        clientId: config.clientId,
        sessionId: example.sessionId,
        tokenEndpoint: config.issuer + '/oauth/device/token',
        accessToken: 'invented-access',
        refreshToken: 'invented-refresh',
        expiresAt: Date.now() + 600_000,
      };
      const key = (binding: ConnectionGrantBinding): string =>
        JSON.stringify([
          binding.issuer,
          binding.owner,
          binding.clientId,
          binding.sessionId,
          binding.connectionId,
        ]);
      const saved = new Map<string, ConnectionGrant>();
      let denied = false;
      const store: ConnectionGrantStore = {
        get: async (binding) => {
          if (denied) throw new Error(sealed);
          return saved.get(key(binding));
        },
        set: async (value) => {
          saved.set(key(value), value);
        },
      };
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        expect(String(input)).toBe(config.issuer + '/connections');
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer invented-access',
        );
        expect(new Headers(init?.headers).get('x-connection-key')).toBeNull();
        return Response.json({
          owner: config.owner,
          connections: [
            { connection_id: example.connectionId, platform: 'dropbox' },
          ],
        });
      });
      const auth = (): DaemonAuth =>
        new DaemonAuth(
          config,
          archive,
          {
            get: async (): Promise<DeviceCredentials> => session,
            set: async (value): Promise<void> => {
              session = value;
            },
            delete: async (): Promise<void> => {},
          },
          fetchImpl,
          store,
        );
      return {
        auth,
        envelope: { ...example, owner: config.owner },
        fetchImpl,
        saved,
        denyVault: (): void => {
          denied = true;
        },
        newSession: (): void => {
          session = { ...session, sessionId: 'replacement' };
        },
      };
    }

    it('checks live approval, reloads after restart and isolates connections and sessions', async () => {
      const { auth, envelope, fetchImpl, saved, newSession } = setup();
      const initial = auth();
      expect(
        await initial.connectionGrant(example.connectionId),
      ).toBeUndefined();
      await initial.importConnectionGrant(envelope);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(saved.size).toBe(1);

      const restarted = auth();
      const forSession = await restarted.session();
      expect(
        await restarted.connectionGrant(example.connectionId, forSession),
      ).toBe(sealed);
      expect(
        await restarted.connectionGrant('other-connection', forSession),
      ).toBeUndefined();
      newSession();
      expect(
        await restarted.connectionGrant(example.connectionId),
      ).toBeUndefined();
    });

    it('rejects an incorrect binding or unapproved connection before storing a grant', async () => {
      const { auth, envelope, fetchImpl, saved } = setup();
      const instance = auth();
      for (const field of [
        'issuer',
        'owner',
        'clientId',
        'sessionId',
      ] as const) {
        await expect(
          instance.importConnectionGrant({ ...envelope, [field]: 'wrong' }),
        ).rejects.toThrow('does not match');
      }
      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(
        instance.importConnectionGrant({ ...envelope, connectionId: 'other' }),
      ).rejects.toThrow('not approved');
      fetchImpl.mockResolvedValueOnce(
        Response.json({
          owner: 'another-owner',
          connections: [
            { connection_id: example.connectionId, platform: 'dropbox' },
          ],
        }),
      );
      await expect(instance.importConnectionGrant(envelope)).rejects.toThrow(
        'not approved',
      );
      expect(saved.size).toBe(0);
    });

    it('classifies Keychain access failure without reflecting raw vault errors', async () => {
      const { auth, denyVault } = setup();
      denyVault();
      const error = await auth()
        .connectionGrant(example.connectionId)
        .catch((failure: unknown) => failure);
      expect(isSyncAuthError(error)).toBe(true);
      expect(error).toEqual(
        new Error(
          'Could not read the connection grant from Keychain; check Keychain access and re-import the grant if needed',
        ),
      );
      expect(String(error)).not.toContain(sealed);
    });

    it('rejects expired and excessive expiry and points users to fresh import for a stored grant', async () => {
      const { auth, envelope, fetchImpl, saved } = setup();
      const instance = auth();
      const now = Math.floor(Date.now() / 1000);
      await expect(
        instance.importConnectionGrant({ ...envelope, expiresAt: now }),
      ).rejects.toThrow('import a fresh grant');
      await expect(
        instance.importConnectionGrant({
          ...envelope,
          expiresAt: now + 30 * 24 * 60 * 60 + 10,
        }),
      ).rejects.toThrow('expiry exceeds 30 days');
      expect(fetchImpl).not.toHaveBeenCalled();

      await instance.importConnectionGrant(envelope);
      const [account] = saved.keys();
      saved.set(account, { ...envelope, expiresAt: now });
      await expect(
        auth().connectionGrant(example.connectionId),
      ).rejects.toThrow('import a fresh grant');
      saved.set(account, { ...envelope, sessionId: 'wrong' });
      await expect(
        auth().connectionGrant(example.connectionId),
      ).rejects.toThrow('Stored connection grant is invalid');
    });
  },
);
