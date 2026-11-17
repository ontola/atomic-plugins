// @wc-ignore-file
import { Script } from 'node:vm';
import { request } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startBrowserServer,
  type BrowserServer,
} from '../../../src/daemon/browser-server.js';
import { BROWSER_SCRIPT } from '../../../src/daemon/browser-ui.js';
import type { BrowserStatus } from '../../../src/daemon/browser-status.js';
import { SOURCE_ID, SOURCE_JSON } from '../../../src/daemon/sync.js';

const revision = 'a'.repeat(64);
const scope = 'invented-scope';
const rows = Array.from({ length: 31 }, (_, i) =>
  JSON.stringify({
    '@id': 'urn:example:' + i,
    [SOURCE_ID]: String(i).padStart(2, '0'),
    [SOURCE_JSON]: { title: 'Task ' + i, status: i % 2 ? 'open' : 'closed' },
  }),
);
const servers: BrowserServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
async function fixture(records = rows, status?: () => Promise<BrowserStatus>) {
  let head: string | undefined = revision;
  const store = {
    head: vi.fn(async () => head),
    resolveRevision: vi.fn(async (selected: string, at?: string) => {
      if (selected !== scope || at !== revision)
        throw new Error('Unknown revision');
      return at;
    }),
    list: vi.fn(async () => records),
  };
  const server = await startBrowserServer({
    store,
    collections: [{ alias: 'example/work/tasks', scope }],
    port: 0,
    ...(status ? { status } : {}),
  });
  servers.push(server);
  const url = new URL(server.url);
  const headers = {
    authorization:
      'Bearer ' + new URLSearchParams(url.hash.slice(1)).get('token'),
  };
  return {
    store,
    server,
    origin: url.origin,
    headers,
    setHead: (value: string | undefined) => {
      head = value;
    },
  };
}

describe('local SyncD data browser', () => {
  it('serves a CSP-protected shell and requires the private link for data', async () => {
    const f = await fixture();
    const shell = await fetch(f.origin);
    expect(shell.headers.get('content-security-policy')).toContain(
      "frame-ancestors 'none'",
    );
    expect(shell.headers.get('cache-control')).toBe('no-store');
    expect(await shell.text()).toContain('Remote connections');
    expect((await fetch(f.origin + '/api/collections')).status).toBe(401);
    const response = await fetch(f.origin + '/api/collections', {
      headers: f.headers,
    });
    expect(await response.json()).toEqual({
      collections: [{ alias: 'example/work/tasks', synced: true }],
    });
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('pages through only source records and pins the revision across head changes', async () => {
    const f = await fixture([
      ...rows,
      JSON.stringify({ '@id': 'urn:example:schema' }),
    ]);
    const first = await (
      await fetch(f.origin + '/api/records?collection=example/work/tasks', {
        headers: f.headers,
      })
    ).json();
    expect(first.total).toBe(31);
    expect(first.records).toHaveLength(25);
    expect(first.revision).toBe(revision);
    f.setHead('b'.repeat(64));
    const second = await (
      await fetch(
        f.origin +
          '/api/records?collection=example/work/tasks&page=2&revision=' +
          first.revision,
        { headers: f.headers },
      )
    ).json();
    expect(second.records).toHaveLength(6);
    expect(second.records[0].id).toBe('25');
    expect(f.store.list).toHaveBeenLastCalledWith(scope, revision);
  });

  it('searches the snapshot and preserves exact large-number JSON', async () => {
    const large =
      '{"@id":"urn:example:large","' +
      SOURCE_ID +
      '":"large","' +
      SOURCE_JSON +
      '":{"title":"Large value","count":9007199254740993}}';
    const f = await fixture([...rows, large]);
    const response = await fetch(
      f.origin + '/api/records?collection=example/work/tasks&q=large',
      { headers: f.headers },
    );
    const result = await response.json();
    expect(result.total).toBe(1);
    expect(result.records[0].raw).toContain('9007199254740993');
    expect(result.records[0].label).toBe('Large value');
  });

  it('distinguishes a never-synced collection from an empty snapshot', async () => {
    const f = await fixture([]);
    f.setHead(undefined);
    const result = await (
      await fetch(f.origin + '/api/records?collection=example/work/tasks', {
        headers: f.headers,
      })
    ).json();
    expect(result.revision).toBeNull();
    expect(f.store.list).not.toHaveBeenCalled();
    f.setHead(revision);
    const empty = await (
      await fetch(f.origin + '/api/records?collection=example/work/tasks', {
        headers: f.headers,
      })
    ).json();
    expect(empty.revision).toBe(revision);
    expect(empty.records).toEqual([]);
  });

  it('rejects foreign origins/hosts, mutations and unknown collections', async () => {
    const f = await fixture();
    expect(
      (
        await fetch(f.origin + '/api/collections', {
          headers: { ...f.headers, origin: 'https://untrusted.example' },
        })
      ).status,
    ).toBe(403);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      request(
        f.origin + '/api/collections',
        { headers: { ...f.headers, host: 'untrusted.example' } },
        (response) => {
          response.resume();
          resolve(response.statusCode!);
        },
      )
        .on('error', reject)
        .end();
    });
    expect(foreignHost).toBe(403);
    expect(
      (
        await fetch(f.origin + '/api/collections', {
          method: 'POST',
          headers: f.headers,
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(f.origin + '/api/records?collection=other/work/tasks', {
          headers: f.headers,
        })
      ).status,
    ).toBe(404);
    expect(f.store.list).not.toHaveBeenCalled();
  });

  it('returns actionable revision/page errors and sanitizes storage failures', async () => {
    const f = await fixture();
    expect(
      (
        await fetch(
          f.origin +
            '/api/records?collection=example/work/tasks&revision=unknown',
          { headers: f.headers },
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(
          f.origin + '/api/records?collection=example/work/tasks&page=-1',
          { headers: f.headers },
        )
      ).status,
    ).toBe(400);
    f.store.list.mockRejectedValueOnce(
      new Error('private database diagnostic'),
    );
    const response = await fetch(
      f.origin + '/api/records?collection=example/work/tasks',
      { headers: f.headers },
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'Could not read the local snapshot',
    });
  });

  it('protects remote status behind the local token and keeps records available if discovery fails', async () => {
    const status = vi.fn(
      async (): Promise<BrowserStatus> => ({
        checkedAt: '2026-11-06T09:30:00Z',
        discovery: { state: 'available', message: null },
        connections: [],
        collections: [],
      }),
    );
    const f = await fixture(rows, status);
    expect((await fetch(f.origin + '/api/status')).status).toBe(401);
    expect(status).not.toHaveBeenCalled();
    expect(
      (await fetch(f.origin + '/api/status', { headers: f.headers })).status,
    ).toBe(200);
    status.mockRejectedValueOnce(new Error('private credential diagnostic'));
    const failed = await fetch(f.origin + '/api/status', {
      headers: f.headers,
    });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('private credential diagnostic');
    expect(
      (
        await fetch(f.origin + '/api/records?collection=example/work/tasks', {
          headers: f.headers,
        })
      ).status,
    ).toBe(200);
  });

  it('ships valid standalone browser JavaScript', () => {
    expect(() => new Script(BROWSER_SCRIPT)).not.toThrow();
  });
});
