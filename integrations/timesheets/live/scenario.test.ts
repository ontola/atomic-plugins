// @wc-ignore-file
/**
 * Offline tests of the Timesheets live check: the scenarios run against the
 * mock proxy's Clockify fixture, and the guard rails against refusals. They
 * say the script does what its assertions claim; they say nothing about
 * Clockify itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_KEY, WORKSPACE, fakeClockify } from './fakeClockify.js';
import { allowFor, runTimesheetsCheck } from './scenario.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = async (
  fake: ReturnType<typeof fakeClockify>,
  extra: Partial<Parameters<typeof runTimesheetsCheck>[0]> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-timesheets-'));
  dirs.push(dir);
  const logs: string[] = [];
  const result = await runTimesheetsCheck({
    workspaceId: WORKSPACE.id,
    apiKey: API_KEY,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  });

  return { ...result, logs };
};
const writes = (fake: ReturnType<typeof fakeClockify>) => fake.calls.filter(c => c.method !== 'GET');

describe('the scenarios, against the mock Clockify', () => {
  it('passes every step and cleans up exactly what it created', async () => {
    const fake = fakeClockify();
    const { doc } = await run(fake);
    const detail = doc.steps.map(s => ({ id: s.id, status: s.status, error: s.error, failed: s.assertions.filter(a => !a.ok).map(a => `${a.name} ${JSON.stringify(a.detail)}`) }));
    expect(detail.filter(d => d.status !== 'passed')).toEqual([]);
    expect(doc.status).toBe('passed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect(fake.fixture.state.entries).toEqual([]);
    expect(fake.tags.size).toBe(0);
    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
    // The app only used the declared time-entry writes.
    const appWrites = doc.requests.filter(r => r.who === 'app' && r.method !== 'GET');
    expect(appWrites.every(r => /\/time-entries/.test(r.path))).toBe(true);
    expect(appWrites.some(r => r.method === 'POST')).toBe(true);
    expect(doc.steps.find(s => s.id === 'S6')?.observations?.length).toBeGreaterThan(0);
  });

  it('never writes the API key to evidence or logs', async () => {
    const fake = fakeClockify();
    const { files, logs } = await run(fake);
    for (const text of [readFileSync(files.json, 'utf8'), readFileSync(files.markdown, 'utf8'), logs.join('')]) {
      expect(text).not.toContain(API_KEY);
      expect(text).not.toMatch(/x-api-key/i);
    }
    expect(fake.calls.every(c => c.headers['x-api-key'] === API_KEY)).toBe(true);
  });
});

describe('guard rails', () => {
  it('refuses a workspace whose name does not look disposable, before any write', async () => {
    const fake = fakeClockify({ workspaceName: 'Ontola' });
    const { doc } = await run(fake);
    WORKSPACE.name = 'Test workspace';
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a workspace that already has entries', async () => {
    const fake = fakeClockify({ existingEntries: true });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
    expect(fake.fixture.state.entries.length).toBeGreaterThan(0);
  });

  it('refuses an id the key cannot see', async () => {
    const fake = fakeClockify();
    const { doc } = await run(fake, { workspaceId: 'ffffffffffffffffffffffff' });
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeClockify();
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails and still removes what it created', async () => {
    const fake = fakeClockify();
    const { doc } = await run(fake, { maxMutations: 4 });
    expect(doc.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect(fake.fixture.state.entries).toEqual([]);
  });

  describe('allowFor: the scope of every request', () => {
    const allow = allowFor('w1');
    const call = (who: string, method: string, pathname: string) => () => allow({ who, method, pathname });

    it('permits reads of the account and the workspace, and the app its declared writes', () => {
      expect(call('app', 'GET', '/api/v1/user')).not.toThrow();
      expect(call('app', 'GET', '/api/v1/workspaces')).not.toThrow();
      expect(call('app', 'GET', '/api/v1/workspaces/w1/projects')).not.toThrow();
      expect(call('app', 'POST', '/api/v1/workspaces/w1/time-entries')).not.toThrow();
      expect(call('app', 'PUT', '/api/v1/workspaces/w1/time-entries/e1')).not.toThrow();
      expect(call('app', 'DELETE', '/api/v1/workspaces/w1/time-entries/e1')).not.toThrow();
    });

    it('refuses another workspace, an account write and anything outside the API', () => {
      expect(call('app', 'GET', '/api/v1/workspaces/w2/projects')).toThrow(/may only touch the workspace/);
      expect(call('driver', 'POST', '/api/v1/workspaces/w2/time-entries')).toThrow(/may only touch/);
      expect(call('driver', 'POST', '/api/v1/user')).toThrow(/not declare|read only/);
      expect(call('driver', 'GET', '/other')).toThrow(/outside/);
    });

    it('lets only the driver touch tags, and nothing else beyond time entries', () => {
      expect(call('driver', 'POST', '/api/v1/workspaces/w1/tags')).not.toThrow();
      expect(call('driver', 'DELETE', '/api/v1/workspaces/w1/tags/t1')).not.toThrow();
      expect(call('app', 'POST', '/api/v1/workspaces/w1/tags')).toThrow();
      expect(call('driver', 'POST', '/api/v1/workspaces/w1/projects')).toThrow(/not in this check's scope/);
    });
  });
});
