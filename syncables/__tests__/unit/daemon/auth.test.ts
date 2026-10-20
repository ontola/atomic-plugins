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
    const owners: string[] = [];
    beforeAll(async () => {
      archive = new PostgresArchive(database!);
      await archive.initialize();
    });
    afterAll(async () => {
      if (archive)
        await archive.pool.query(
          'DELETE FROM syncables_cache.device_login_required WHERE owner=ANY($1::text[])',
          [owners],
        );
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
      owners.push(config.owner);
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
    it('keeps a durable guard across restart even if the vault refuses deletion', async () => {
      const h = setup();
      const fetchImpl = vi.fn<typeof fetch>(async () => {
        throw new Error('invented lost response');
      });
      const refused: CredentialStore = {
        ...h.vault,
        delete: async (): Promise<void> => {
          throw new Error('vault refused');
        },
      };
      const auth = new DaemonAuth(h.config, archive, refused, fetchImpl);
      await expect(auth.session()).rejects.toThrow('uncertain refresh');
      expect(h.value()?.refreshToken).toBe('refresh-old');
      const restarted = new DaemonAuth(h.config, archive, refused, fetchImpl);
      await expect(restarted.session()).rejects.toThrow('interrupted refresh');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    it('requires fresh persistent login after a crash; an in-memory grant cannot unblock the stale vault', async () => {
      const h = setup();
      await archive.pool.query(
        'INSERT INTO syncables_cache.device_login_required(owner,issuer,client_id) VALUES($1,$2,$3)',
        [h.config.owner, h.config.issuer, h.config.clientId],
      );
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/.well-known/oauth-authorization-server')
          return Response.json({
            issuer: h.config.issuer,
            device_authorization_endpoint: h.config.issuer + '/device',
            token_endpoint: h.config.issuer + '/token',
          });
        if (path === '/device')
          return Response.json({
            device_code: 'invented-code',
            user_code: 'TEST-CODE',
            verification_uri: h.config.issuer + '/approve',
            interval: 1,
            expires_in: 60,
          });
        if (path === '/token')
          return Response.json({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            token_type: 'Bearer',
            session_id: 'fresh-session',
            expires_in: 600,
          });
        if (path === '/connections')
          return Response.json({ owner: h.config.owner, connections: [] });
        throw new Error('Unexpected invented request');
      });
      const persistent = new DaemonAuth(h.config, archive, h.vault, fetchImpl);
      await expect(persistent.session()).rejects.toThrow('interrupted refresh');
      expect(fetchImpl).not.toHaveBeenCalled();
      const memory = new DaemonAuth(h.config, archive, undefined, fetchImpl);
      await memory.login(() => {});
      expect((await memory.session()).accessToken).toBe('fresh-access');
      await expect(persistent.session()).rejects.toThrow('interrupted refresh');
      await persistent.login(() => {});
      expect((await persistent.session()).accessToken).toBe('fresh-access');
      expect(
        (
          await archive.pool.query(
            'SELECT 1 FROM syncables_cache.device_login_required WHERE owner=$1',
            [h.config.owner],
          )
        ).rowCount,
      ).toBe(0);
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
