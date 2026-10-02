// @wc-ignore-file
/**
 * Offline tests of the Notion live check: the scenarios run against the mock
 * proxy's Notion fixture, and the guard rails against refusals. They say the
 * script does what its assertions claim; nothing about Notion itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DATA_SOURCE_ID, TOKEN, fakeNotion } from './fakeNotion.js';
import { allowFor, runNotionCheck } from './scenario.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const run = async (
  fake: ReturnType<typeof fakeNotion>,
  extra: Partial<Parameters<typeof runNotionCheck>[0]> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-notion-'));
  dirs.push(dir);
  const logs: string[] = [];
  const result = await runNotionCheck({
    dataSource: DATA_SOURCE_ID,
    token: TOKEN,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  });

  return { ...result, logs };
};

const writes = (fake: ReturnType<typeof fakeNotion>) =>
  fake.calls.filter(
    c =>
      c.method !== 'GET' &&
      !(c.method === 'POST' && /\/(search|query)$/.test(c.path)),
  );

describe('the scenarios, against the mock Notion', () => {
  it('passes every step, moves what it created to the trash and records the archive observation', async () => {
    const fake = fakeNotion();
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
    expect(doc.steps.map(s => s.id)).toEqual([
      'S0',
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
    ]);
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect((doc.cleanup.created as string[]).length).toBe(2);

    for (const id of (doc.cleanup.created as string[]).map(c =>
      c.slice('page:'.length),
    )) {
      const page = fake.api.getPage(
        `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`,
      );
      expect(page.in_trash).toBe(true);
    }

    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
    // POST search and query are reads: they cost no write budget.
    expect(doc.requests.some(r => r.method === 'POST' && r.read === true)).toBe(
      true,
    );
    // The app never created a page and never deleted anything.
    expect(
      doc.requests.filter(
        r =>
          r.who === 'app' &&
          !r.read &&
          r.method !== 'GET' &&
          r.method !== 'PATCH',
      ),
    ).toEqual([]);
    const observed = doc.steps.flatMap(s => s.observations ?? []);
    expect(observed.map(o => o.name)).toContain(
      'what the sync reports for the archived page',
    );
  });

  it('never writes the secret to evidence or logs, and sends it only in the header', async () => {
    const fake = fakeNotion();
    const { files, logs } = await run(fake);

    for (const text of [
      readFileSync(files.json, 'utf8'),
      readFileSync(files.markdown, 'utf8'),
      logs.join(''),
    ]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('ntn_');
      expect(text).not.toMatch(/Bearer\s+\S{8,}/);
    }

    expect(
      fake.calls.every(c => c.headers.authorization === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(
      fake.calls.every(c => c.headers['notion-version'] === '2026-03-11'),
    ).toBe(true);
  });
});

describe('guard rails', () => {
  it('refuses a data source whose title does not look disposable, before any write', async () => {
    const fake = fakeNotion({ title: 'Roadmap' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses when the integration is shared with another data source', async () => {
    const fake = fakeNotion({ scenario: 'two-sources' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/shared with other data sources/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a data source that already holds pages', async () => {
    const fake = fakeNotion({ blank: false });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/not leftovers of this kit/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a wrong secret and a data source the integration cannot see', async () => {
    const fake = fakeNotion();
    const bad = await run(fake, { token: `${TOKEN}-wrong` });
    expect(bad.doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);

    const other = await run(fakeNotion(), {
      dataSource: '00000000-0000-4000-8000-000000000000',
    });
    expect(other.doc.status).toBe('failed');
    expect(other.doc.steps[0].error).toMatch(/not reachable|may only touch/);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeNotion();
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails and still trashes what it created', async () => {
    const fake = fakeNotion();
    const { doc } = await run(fake, { maxMutations: 3 });
    expect(doc.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect((doc.cleanup.created as string[]).length).toBeGreaterThan(0);
  });

  describe('allowFor: the scope of every request', () => {
    const created = new Set(['aaaa1111']);
    const allow = allowFor('1111-2222-aaaa', id => created.has(id));
    const call = (who: string, method: string, pathname: string) => () =>
      allow({ who, method, pathname });

    it('permits the app its operations on the named data source and the pages this run made', () => {
      expect(call('app', 'POST', '/v1/search')).not.toThrow();
      expect(
        call('app', 'POST', '/v1/data_sources/1111-2222-AAAA/query'),
      ).not.toThrow();
      expect(call('app', 'POST', '/v1/data_sources/1111222aaaa/query')).toThrow(
        /may only touch the data source/,
      );
      expect(call('app', 'GET', '/v1/pages/aaaa-1111')).not.toThrow();
      expect(call('app', 'PATCH', '/v1/pages/aaaa1111')).not.toThrow();
      expect(call('driver', 'POST', '/v1/pages')).not.toThrow();
      expect(call('driver', 'GET', '/v1/users/me')).not.toThrow();
    });

    it('refuses other data sources, other pages, page creation by the app, deletion and anything else', () => {
      expect(call('app', 'POST', '/v1/data_sources/other/query')).toThrow(
        /may only touch/,
      );
      expect(call('driver', 'GET', '/v1/data_sources/other')).toThrow(
        /may only touch/,
      );
      expect(call('app', 'GET', '/v1/data_sources/1111-2222-aaaa')).toThrow(
        /scope/,
      );
      expect(call('app', 'PATCH', '/v1/pages/bbbb2222')).toThrow(
        /not created by this run/,
      );
      expect(call('app', 'POST', '/v1/pages')).toThrow(/never does/);
      expect(call('driver', 'DELETE', '/v1/pages/aaaa1111')).toThrow(/scope/);
      expect(
        call('driver', 'PATCH', '/v1/data_sources/1111-2222-aaaa'),
      ).toThrow(/scope/);
      expect(call('driver', 'POST', '/v1/databases')).toThrow(/scope/);
      expect(call('app', 'GET', '/v1/users/me')).toThrow(/scope/);
      expect(call('app', 'GET', '/v1/blocks/x/children')).toThrow(/scope/);
    });
  });
});
