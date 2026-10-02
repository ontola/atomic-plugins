// @wc-ignore-file
/**
 * Offline tests of the GitHub issues live check: the scenarios run against
 * the mock proxy's GitHub fixture, and the guard rails against refusals. They
 * say the script does what its assertions claim; nothing about GitHub itself.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPOSITORY, TOKEN, fakeGithub } from './fakeGithub.js';
import { allowFor, runGithubCheck } from './scenario.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const run = async (
  fake: ReturnType<typeof fakeGithub>,
  extra: Partial<Parameters<typeof runGithubCheck>[0]> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'live-github-'));
  dirs.push(dir);
  const logs: string[] = [];
  const result = await runGithubCheck({
    repository: REPOSITORY,
    token: TOKEN,
    fetcher: fake.fetcher,
    outDir: dir,
    log: line => logs.push(line),
    ...extra,
  });

  return { ...result, logs };
};
const writes = (fake: ReturnType<typeof fakeGithub>) => fake.calls.filter(c => c.method !== 'GET');

describe('the scenarios, against the mock GitHub', () => {
  it('passes every step, closes what it created and deletes its comments', async () => {
    const fake = fakeGithub();
    const { doc } = await run(fake);
    const detail = doc.steps.map(s => ({
      id: s.id,
      status: s.status,
      error: s.error,
      failed: s.assertions.filter(a => !a.ok).map(a => `${a.name} ${JSON.stringify(a.detail)}`),
    }));
    expect(detail.filter(d => d.status !== 'passed')).toEqual([]);
    expect(doc.status).toBe('passed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    const { issues, comments } = fake.tracker.snapshot(REPOSITORY);
    expect(issues.length).toBe(3);
    expect(issues.every((i: { state: string }) => i.state === 'closed')).toBe(true);
    expect(fake.deletedComments.size).toBe(comments.length);
    expect(doc.limits.mutations).toBeLessThanOrEqual(doc.limits.maxMutations);
    expect(doc.requests.filter(r => r.who === 'app' && r.method === 'DELETE' && !/labels/.test(r.path))).toEqual([]);
  });

  it('never writes the token to evidence or logs', async () => {
    const fake = fakeGithub();
    const { files, logs } = await run(fake);
    for (const text of [readFileSync(files.json, 'utf8'), readFileSync(files.markdown, 'utf8'), logs.join('')]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('github_pat_');
      expect(text).not.toMatch(/Bearer\s+\S{8,}/);
    }
    expect(fake.calls.every(c => c.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});

describe('guard rails', () => {
  it('refuses a repository whose name does not look disposable, before any write', async () => {
    const fake = fakeGithub({ repository: 'someone/website' });
    const { doc } = await run(fake, { repository: 'someone/website' });
    expect(doc.status).toBe('failed');
    expect(doc.steps[0].error).toMatch(/does not look disposable/);
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a repository that holds issues that are not closed livecheck leftovers', async () => {
    const fake = fakeGithub({ seedForeignIssue: true });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('refuses a token that cannot push', async () => {
    const fake = fakeGithub({ push: false });
    const { doc } = await run(fake);
    expect(doc.status).toBe('failed');
    expect(writes(fake)).toEqual([]);
  });

  it('a preflight-only run writes nothing', async () => {
    const fake = fakeGithub();
    const { doc } = await run(fake, { preflightOnly: true });
    expect(doc.status).toBe('preflight-only');
    expect(writes(fake)).toEqual([]);
  });

  it('stops at the write budget, fails and still cleans up', async () => {
    const fake = fakeGithub();
    const { doc } = await run(fake, { maxMutations: 4 });
    expect(doc.status).toBe('failed');
    expect(doc.cleanup).toMatchObject({ status: 'passed', leftover: [] });
    expect(fake.tracker.snapshot(REPOSITORY).issues.every((i: { state: string }) => i.state === 'closed')).toBe(true);
  });

  describe('allowFor: the scope of every request', () => {
    const allow = allowFor('Owner/Repo-test');
    const call = (who: string, method: string, pathname: string) => () => allow({ who, method, pathname });

    it('permits the app its operations on the named repository, case-insensitively', () => {
      expect(call('app', 'GET', '/user/repos')).not.toThrow();
      expect(call('app', 'GET', '/repos/owner/repo-test/issues')).not.toThrow();
      expect(call('app', 'POST', '/repos/owner/repo-test/issues')).not.toThrow();
      expect(call('app', 'PATCH', '/repos/owner/repo-test/issues/3')).not.toThrow();
      expect(call('app', 'POST', '/repos/owner/repo-test/issues/3/comments')).not.toThrow();
      expect(call('app', 'PATCH', '/repos/owner/repo-test/issues/comments/9')).not.toThrow();
      expect(call('app', 'DELETE', '/repos/owner/repo-test/issues/3/labels/bug')).not.toThrow();
    });

    it('refuses another repository, repository-level writes and comment deletion by the app', () => {
      expect(call('app', 'GET', '/repos/owner/other/issues')).toThrow(/may only touch the repository/);
      expect(call('driver', 'POST', '/repos/other/repo-test/issues')).toThrow(/may only touch/);
      expect(call('driver', 'PATCH', '/repos/owner/repo-test')).toThrow(/repository itself/);
      expect(call('driver', 'DELETE', '/repos/owner/repo-test')).toThrow(/repository itself/);
      expect(call('app', 'DELETE', '/repos/owner/repo-test/issues/comments/9')).toThrow(/not in this check's scope/);
      expect(call('driver', 'DELETE', '/repos/owner/repo-test/issues/comments/9')).not.toThrow();
      expect(call('driver', 'PUT', '/repos/owner/repo-test/issues/3/lock')).toThrow();
      expect(call('app', 'GET', '/orgs/owner')).toThrow(/outside \/repos/);
      expect(call('app', 'GET', '/user')).toThrow();
    });
  });
});
