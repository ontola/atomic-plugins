import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DaemonAuth,
  type CredentialStore,
  type DeviceCredentials,
} from '../../../src/daemon/auth.js';
import { PostgresArchive } from '../../../src/postgres/archive.js';
import type { DaemonConfig } from '../../../src/daemon/config.js';
const database = process.env.SYNCABLES_TEST_DATABASE_URL;

describe.skipIf(!database)(
  'daemon device credentials (real PostgreSQL locks; invented tokens)',
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
      config: DaemonConfig;
      vault: CredentialStore;
      value: () => DeviceCredentials | undefined;
    } {
      const config: DaemonConfig = {
        version: 1,
        owner: 'auth-test-' + randomUUID(),
        issuer: 'https://issuer.example',
        clientId: 'syncables-cli',
        dataDirectory: '/unused',
        collections: [],
      };
      let value: DeviceCredentials | undefined = {
        issuer: config.issuer,
        accessToken: 'expired',
        refreshToken: 'refresh-old',
        expiresAt: 0,
        tokenEndpoint: config.issuer + '/oauth/device/token',
        sessionId: 'test-session',
        owner: config.owner,
        clientId: config.clientId,
      };
      return {
        config,
        value: () => value,
        vault: {
          get: async () => value,
          set: async (next): Promise<void> => {
            value = next;
          },
          delete: async (): Promise<void> => {
            value = undefined;
          },
        },
      };
    }
    it('serializes rotating refresh across separate auth instances and persists before returning', async () => {
      const h = setup();
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
        expect(String(init?.body)).toContain('refresh_token=refresh-old');
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          token_type: 'Bearer',
          expires_in: 600,
          session_id: 'test-session',
          owner: h.config.owner,
        });
      });
      const a = new DaemonAuth(h.config, archive, h.vault, fetchImpl);
      const b = new DaemonAuth(h.config, archive, h.vault, fetchImpl);
      const sessions = await Promise.all([
        a.session(),
        b.session(),
        a.session(),
      ]);
      expect(sessions.map((s) => s.accessToken)).toEqual([
        'new-access',
        'new-access',
        'new-access',
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(h.value()?.refreshToken).toBe('new-refresh');
      expect(await a.authorizationContext()).toBe('test-session');
    });
    it('clears an uncertain refresh and never retries a possibly consumed token', async () => {
      const h = setup();
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error('invented lost response');
      });
      const auth = new DaemonAuth(h.config, archive, h.vault, fetchImpl);
      await expect(auth.session()).rejects.toThrow('uncertain refresh');
      expect(h.value()).toBeUndefined();
      await expect(auth.session()).rejects.toThrow('Login required');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('rejects a cross-owner or cross-origin vault entry and revokes only the stored device session', async () => {
      const h = setup();
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(null, { status: 200 }),
      );
      const auth = new DaemonAuth(h.config, archive, h.vault, fetchImpl);
      await h.vault.set({
        ...h.value()!,
        tokenEndpoint: 'https://other.example/token',
      });
      await expect(auth.session()).rejects.toThrow('endpoint');
      expect(fetchImpl).not.toHaveBeenCalled();
      await h.vault.set({
        ...h.value()!,
        tokenEndpoint: h.config.issuer + '/oauth/device/token',
        owner: 'other-owner',
      });
      await expect(auth.session()).rejects.toThrow('Login required');
      expect(fetchImpl).not.toHaveBeenCalled();
      await h.vault.set({ ...h.value()!, owner: h.config.owner });
      await auth.logout();
      expect(h.value()).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(String(fetchImpl.mock.calls[0][1]?.body)).toContain(
        'token=refresh-old',
      );
    });
  },
);
