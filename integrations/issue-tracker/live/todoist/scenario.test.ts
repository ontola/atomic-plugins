// @wc-ignore-file
/**
 * Offline tests of the Todoist live check: the scenarios run against the mock
 * proxy's (synthetic) Todoist fixture, and the guard rails against refusals.
 * They say the script does what its assertions claim; nothing about Todoist
 * itself, and nothing about what it answers for a completed task (#46): both
 * answers are modelled and the run must pass with either.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OTHER_PROJECT, PROJECT, TOKEN, fakeTodoist } from './fakeTodoist.js';
import { allowFor, runTodoistCheck } from './scenario.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const run = async (
  fake: ReturnType<typeof fakeTodoist>,
  extra: Partial<Parameters<typeof runTodoistCheck>[0]> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-todoist-'));
  dirs.push(dir);
  const logs: string[] = [];
  const result = await runTodoistCheck({
    project: PROJECT,
    token: TOKEN,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  });

  return { ...result, logs };
};

const writes = (fake: ReturnType<typeof fakeTodoist>) =>
  fake.calls.filter(c => c.method !== 'GET');

const failures = (doc: Awaited<ReturnType<typeof run>>['doc']) =>
  doc.steps
    .map(s => ({
      id: s.id,
      status: s.status,
      error: s.error,
      failed: s.assertions
        .filter(a => !a.ok)
        .map(a => `${a.name} ${JSON.stringify(a.detail)}`),
    }))
    .filter(d => d.status !== 'passed');

describe('the scenarios, against the mock Todoist', () => {
  it('passes every step when a completed task is still returned with checked: true, and deletes what it created', async () => {
    const fake = fakeTodoist({ completedLookup: 'checked' });
    const { doc } = await run(fake);
    expect(failures(doc)).toEqual([]);
    expect(doc.status).toBe('passed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect((doc.cleanup.created as string[]).length).toBe(3);
    const completion = doc.steps
      .find(s => s.id === 'S5')
      ?.observations?.find(o => o.name.startsWith('GET /tasks/{id}'));
    expect(completion?.value).toMatchObject({ status: 200, checked: true });
    expect(
      doc.steps
        .find(s => s.id === 'S5')
        ?.observations?.find(o => o.name.startsWith('the lookup')),
    ).toMatchObject({ value: { presence: 'completed', done: true } });
    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
    expect(
      doc.requests.filter(r => r.who === 'app' && r.method !== 'GET'),
    ).toEqual([]);
  });

  it('passes every step when Todoist answers 404 for a completed task, and records that', async () => {
    const fake = fakeTodoist({ completedLookup: '404' });
    const { doc } = await run(fake);
    expect(failures(doc)).toEqual([]);
    expect(doc.status).toBe('passed');
    expect(
      doc.steps
        .find(s => s.id === 'S5')
        ?.observations?.find(o => o.name.startsWith('GET /tasks/{id}')),
    ).toMatchObject({ value: { status: 404 } });
    expect(
      doc.steps
        .find(s => s.id === 'S5')
        ?.observations?.find(o => o.name.startsWith('the lookup')),
    ).toMatchObject({ value: { lookupStatus: 404, presence: 'unavailable' } });
  });

  it('never writes the token to evidence or logs, and sends it only in the header', async () => {
    const fake = fakeTodoist();
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
});

describe('guard rails', () => {
  it('refuses a project whose name does not look disposable, before any write', async () => {
    const fake = fakeTodoist({ name: 'Groceries' });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses an account that already has active tasks', async () => {
    const fake = fakeTodoist({ blank: false });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/dedicated, empty test account/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses the Inbox, a project the token cannot see and a wrong token', async () => {
    const fake = fakeTodoist();
    const inbox = await run(fake, { project: OTHER_PROJECT });
    expect(inbox.doc.status).toBe('failed');

    const unseen = await run(fake, { project: 'nope' });
    expect(unseen.doc.status).toBe('failed');

    const bad = await run(fake, { token: `${TOKEN}0` });
    expect(bad.doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeTodoist();
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails and still deletes what it created', async () => {
    const fake = fakeTodoist();
    const { doc } = await run(fake, { maxMutations: 2 });
    expect(doc.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect(fake.api.snapshot().unreachable.length).toBe(2);
  });

  describe('allowFor: the scope of every request', () => {
    const created = new Set(['t1']);
    const allow = allowFor('p1', id => created.has(id));
    const call = (who: string, method: string, pathname: string) => () =>
      allow({ who, method, pathname });

    it('permits the app its reads, and the driver its writes on its own tasks', () => {
      expect(call('app', 'GET', '/api/v1/projects')).not.toThrow();
      expect(call('app', 'GET', '/api/v1/tasks')).not.toThrow();
      expect(call('app', 'GET', '/api/v1/tasks/t1')).not.toThrow();
      expect(call('driver', 'GET', '/api/v1/projects/p1')).not.toThrow();
      expect(call('driver', 'POST', '/api/v1/tasks')).not.toThrow();
      expect(call('driver', 'POST', '/api/v1/tasks/t1')).not.toThrow();
      expect(call('driver', 'POST', '/api/v1/tasks/t1/close')).not.toThrow();
      expect(call('driver', 'POST', '/api/v1/tasks/t1/reopen')).not.toThrow();
      expect(call('driver', 'DELETE', '/api/v1/tasks/t1')).not.toThrow();
    });

    it('refuses any write by the app, other projects, tasks the run did not create and anything else', () => {
      expect(call('app', 'POST', '/api/v1/tasks')).toThrow(/scope/);
      expect(call('app', 'POST', '/api/v1/tasks/t1/close')).toThrow(
        /never writes/,
      );
      expect(call('app', 'DELETE', '/api/v1/tasks/t1')).toThrow(/never writes/);
      expect(call('driver', 'GET', '/api/v1/projects/p2')).toThrow(
        /may only touch the project/,
      );
      expect(call('app', 'GET', '/api/v1/projects/p1')).toThrow(/scope/);
      expect(call('driver', 'POST', '/api/v1/projects')).toThrow(/scope/);
      expect(call('driver', 'POST', '/api/v1/tasks/t2/close')).toThrow(
        /not created by this run/,
      );
      expect(call('app', 'GET', '/api/v1/tasks/t2')).toThrow(
        /not created by this run/,
      );
      expect(call('driver', 'DELETE', '/api/v1/tasks/t1/close')).toThrow(
        /scope/,
      );
      expect(call('app', 'GET', '/rest/v2/tasks')).toThrow(/\/api\/v1\//);
      expect(call('driver', 'GET', '/api/v1/user')).toThrow(/scope/);
    });
  });
});
