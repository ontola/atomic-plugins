// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import fixture, { githubTracker } from './scenario.mjs';

const url = (path: string) =>
  new URL(`http://mock.test/proxy/github-issues${path}`);

const WEBSITE = 'acme-studio/website';

describe('github-issues fixture, user-testing scenario', () => {
  it('lists the synthetic repositories instead of the default ones', () => {
    const repos = githubTracker({ scenario: 'user-testing' }).request(
      'GET',
      url('/user/repos'),
    ).body as { full_name: string; has_issues: boolean }[];

    expect(repos.map(r => [r.full_name, r.has_issues])).toEqual([
      ['acme-studio/website', true],
      ['acme-studio/brand-guide', true],
      ['acme-studio/old-site', false],
    ]);
  });

  it('seeds issues with GitHub-shaped labels, authors, a null body and comments', () => {
    const { issues, comments } = githubTracker({
      scenario: 'user-testing',
    }).snapshot(WEBSITE);

    expect(issues).toHaveLength(16);
    expect(issues.filter(i => i.state === 'closed')).toHaveLength(4);
    expect(issues[1].labels).toEqual([
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'design', color: 'f9d0c4' },
      'atomic:doing',
    ]);
    expect(issues[6].body).toBeNull();
    expect(comments).toHaveLength(7);
    expect(new Set(comments.map(c => c.user.login))).toEqual(
      new Set(['priya-dev', 'tomas-k', 'noor-design', 'jules-w']),
    );
  });

  it('adds and removes the Doing label next to label objects', () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    const labels = `/repos/${WEBSITE}/issues/1/labels`;

    expect(
      tracker.request('POST', url(labels), { labels: ['atomic:doing'] }).body,
    ).toEqual([{ name: 'bug', color: 'd73a4a' }, 'atomic:doing']);
    expect(
      tracker.request('DELETE', url(`${labels}/atomic%3Adoing`)).body,
    ).toEqual([{ name: 'bug', color: 'd73a4a' }]);
    expect(
      tracker.request('DELETE', url(`${labels}/atomic%3Adoing`)).status,
    ).toBe(404);
  });

  it('leaves the default scenario as CI asserts it', () => {
    const tracker = githubTracker();
    const repos = tracker.request('GET', url('/user/repos')).body as {
      full_name: string;
    }[];

    expect(repos.map(r => r.full_name)).toEqual([
      'atomic-fixture/tracker',
      'atomic-fixture/no-issues',
    ]);
    expect(tracker.snapshot('atomic-fixture/tracker').issues).toHaveLength(2);
  });
});

describe('github-issues fixture drivers', () => {
  it('exposes the drivers a moderator uses mid-session', () => {
    expect(fixture.drivers).toEqual(
      expect.arrayContaining([
        'createIssue',
        'createComment',
        'commentAs',
        'failNext',
      ]),
    );
  });

  it('commentAs posts a comment by someone else', () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    tracker.commentAs(WEBSITE, 1, 'priya-dev', 'Thanks!');
    const last = tracker.snapshot(WEBSITE).comments.at(-1);

    expect(last).toMatchObject({
      body: 'Thanks!',
      user: { login: 'priya-dev' },
    });
  });

  it("reset forgets a repository's edits, so the seeded one reseeds", () => {
    const tracker = githubTracker();
    const repository = 'atomic-fixture/tracker';
    const before = tracker.snapshot(repository);
    tracker.createIssue(repository, { title: 'Extra' });
    tracker.createComment(repository, 1, { body: 'Extra' });
    tracker.reset(repository);
    const after = tracker.snapshot(repository);

    expect(after.issues.map(i => i.title)).toEqual(
      before.issues.map(i => i.title),
    );
    expect(after.comments).toHaveLength(before.comments.length);
    tracker.createIssue('atomic-fixture/other', { title: 'One' });
    tracker.reset('atomic-fixture/other');
    expect(tracker.snapshot('atomic-fixture/other').issues).toEqual([]);
  });

  it('reset also drops the failures failNext left pending', () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    tracker.failNext(503, 2);
    tracker.reset('atomic-fixture/other');

    expect(tracker.request('GET', url(`/repos/${WEBSITE}/issues`)).status).toBe(
      200,
    );
  });

  it('failNext can fail only writes, and only one repository', () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    tracker.failNext(422, 1, { writes: true, repository: WEBSITE });
    const other = 'atomic-fixture/tracker';
    const patch = (name: string) =>
      tracker.request('PATCH', url(`/repos/${name}/issues/1`), {
        title: 'Edited',
      });

    // Reads, and another repository's writes, go through.
    expect(tracker.request('GET', url(`/repos/${WEBSITE}/issues`)).status).toBe(
      200,
    );
    expect(patch(other).status).toBe(200);
    // Then the first write to the repository is refused, as GitHub does.
    expect(patch(WEBSITE)).toMatchObject({
      status: 422,
      body: { message: 'Validation Failed', errors: [{ field: 'title' }] },
    });
    expect(patch(WEBSITE).status).toBe(200);
  });

  it("reset keeps another repository's pending failures", () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    tracker.failNext(503, 1, { repository: WEBSITE });
    tracker.reset('atomic-fixture/other');

    expect(tracker.request('GET', url(`/repos/${WEBSITE}/issues`)).status).toBe(
      503,
    );
  });

  it('failNext answers the next requests with an error, then recovers', () => {
    const tracker = githubTracker({ scenario: 'user-testing' });
    tracker.failNext(503, 2);
    const list = () =>
      tracker.request('GET', url(`/repos/${WEBSITE}/issues`)).status;

    expect([list(), list(), list()]).toEqual([503, 503, 200]);
  });
});
