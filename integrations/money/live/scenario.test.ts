// @wc-ignore-file
/**
 * Offline tests of the Moneybird live check: the scenarios run against an
 * in-memory Moneybird (the mock proxy's fixture is read-only), and the guard
 * rails against refusals. They say the script does what its assertions
 * claim; nothing about Moneybird itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMINISTRATION,
  OTHER_ADMINISTRATION,
  TOKEN,
  fakeMoneybird,
} from './fakeMoneybird.js';
import { allowFor, runMoneybirdCheck } from './scenario.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const run = async (
  fake: ReturnType<typeof fakeMoneybird>,
  extra: Partial<Parameters<typeof runMoneybirdCheck>[0]> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-moneybird-'));
  dirs.push(dir);
  const logs: string[] = [];
  const result = await runMoneybirdCheck({
    administration: ADMINISTRATION,
    token: TOKEN,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  });

  return { ...result, logs };
};

const writes = (fake: ReturnType<typeof fakeMoneybird>) =>
  fake.calls.filter(c => c.method !== 'GET');

describe('the scenarios, against an in-memory Moneybird', () => {
  it('passes every step, crosses page boundaries and deletes what it created', async () => {
    const fake = fakeMoneybird();
    const { doc } = await run(fake);
    const detail = doc.steps.map(s => ({
      id: s.id,
      status: s.status,
      error: s.error,
      failed: s.assertions
        .filter(a => !a.ok)
        .map(a => `${a.name} ${JSON.stringify(a.detail)}`),
    }));
    expect(detail.filter(d => d.status !== 'passed')).toEqual([]);
    expect(doc.status).toBe('passed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect((doc.cleanup.created as string[]).length).toBe(3);
    expect(fake.contacts.size).toBe(0);
    // Two contacts per page: the app followed the Link header.
    expect(
      doc.requests.filter(r => r.who === 'app' && /page=2/.test(r.path)).length,
    ).toBeGreaterThan(0);
    expect(doc.requests.filter(r => r.who === 'app')).not.toEqual([]);
    expect(
      doc.requests.every(r => !r.who || r.path.startsWith('/api/v2/')),
    ).toBe(true);
    expect(
      doc.requests.filter(r => r.who === 'app' && r.method !== 'GET'),
    ).toEqual([]);
    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
  });

  it('never writes the token to evidence or logs, and sends it only in the header', async () => {
    const fake = fakeMoneybird();
    const { files, logs } = await run(fake);

    for (const text of [
      readFileSync(files.json, 'utf8'),
      readFileSync(files.markdown, 'utf8'),
      logs.join(''),
    ]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toMatch(/Bearer\s+\S{8,}/);
    }

    expect(
      fake.calls.every(c => c.headers.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
  });

  it('fails the base-path assertion when the API does not answer the app 200', async () => {
    // A server that has no /api/v2 route for the app's requests (as the real
    // API answered before #274's fix) fails the run instead of passing it.
    const fake = fakeMoneybird();

    const failing = async (href: string, init: Record<string, unknown>) => {
      const url = new URL(href);
      if (
        String(init.method ?? 'GET') === 'GET' &&
        /\/contacts\.json$/.test(url.pathname) &&
        url.searchParams.has('include_archived') &&
        url.searchParams.get('per_page') === '100' &&
        fake.calls.some(c => c.method === 'POST')
      )
        return {
          status: 404,
          headers: { get: () => null },
          text: async () => '{"error":"not found"}',
        };

      return fake.fetcher(href, init);
    };

    const { doc } = await run(fake, { fetcher: failing });
    expect(doc.status).toBe('failed');
    expect(doc.steps.find(s => s.id === 'S2')?.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
  });
});

describe('guard rails', () => {
  it('refuses an administration whose name does not look disposable, before any write', async () => {
    const fake = fakeMoneybird({ name: 'Studio B.V.' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses an administration that already holds contacts', async () => {
    const fake = fakeMoneybird({ seedForeignContact: true });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/already has contacts/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses an administration the token cannot see, and a wrong token', async () => {
    const fake = fakeMoneybird();
    const unseen = await run(fake, { administration: OTHER_ADMINISTRATION });
    expect(unseen.doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);

    const bad = await run(fake, { token: `${TOKEN}-wrong` });
    expect(bad.doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeMoneybird();
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails and still deletes what it created', async () => {
    const fake = fakeMoneybird();
    const { doc } = await run(fake, { maxMutations: 2 });
    expect(doc.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect(fake.contacts.size).toBe(0);
  });

  describe('allowFor: the scope of every request', () => {
    const created = new Set(['4000000000000001']);
    const allow = allowFor('100000000000000777', id => created.has(id));
    const call = (who: string, method: string, pathname: string) => () =>
      allow({ who, method, pathname });
    const A = '/api/v2/100000000000000777';

    it('permits the app its two reads, and the driver its writes on its own contacts', () => {
      expect(call('app', 'GET', '/api/v2/administrations.json')).not.toThrow();
      expect(call('app', 'GET', `${A}/contacts.json`)).not.toThrow();
      expect(call('driver', 'POST', `${A}/contacts.json`)).not.toThrow();
      expect(
        call('driver', 'PATCH', `${A}/contacts/4000000000000001.json`),
      ).not.toThrow();
      expect(
        call('driver', 'DELETE', `${A}/contacts/4000000000000001.json`),
      ).not.toThrow();
    });

    it('refuses a path without the base path, other administrations, any write by the app, and contacts the run did not create', () => {
      expect(call('app', 'GET', '/administrations.json')).toThrow(/base path/);
      expect(call('app', 'GET', '/100000000000000777/contacts.json')).toThrow(
        /base path/,
      );
      expect(
        call('app', 'GET', '/api/v2/100000000000000888/contacts.json'),
      ).toThrow(/may only touch the administration/);
      expect(
        call('driver', 'POST', '/api/v2/100000000000000888/contacts.json'),
      ).toThrow(/may only touch/);
      expect(call('app', 'POST', `${A}/contacts.json`)).toThrow(/never writes/);
      expect(
        call('app', 'DELETE', `${A}/contacts/4000000000000001.json`),
      ).toThrow(/never writes/);
      expect(
        call('driver', 'DELETE', `${A}/contacts/4000000000000002.json`),
      ).toThrow(/not created by this run/);
      expect(call('driver', 'POST', '/api/v2/administrations.json')).toThrow(
        /read-only/,
      );
      expect(call('driver', 'GET', `${A}/sales_invoices.json`)).toThrow(
        /scope/,
      );
    });
  });
});
