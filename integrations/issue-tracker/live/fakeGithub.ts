// @wc-ignore-file
/**
 * A `fetch` stand-in for the live check's offline tests: the mock proxy's
 * GitHub fixture (`../fixtures/github-issues/`), reached by real GitHub URLs
 * and a bearer token, plus the few calls the driver makes that the fixture
 * lacks (`GET /user`, `GET /repos/{o}/{r}`, deleting a comment). Test-only;
 * it is evidence about the script, not about GitHub.
 */
import { githubTracker } from '../fixtures/github-issues/scenario.mjs';

export const TOKEN = 'github_pat_11AFAKEFAKEFAKE0_offlineTestTokenValueNotReal0123456789abcdef';
export const REPOSITORY = 'someone/atomic-live-check-test';

export function fakeGithub({
  token = TOKEN,
  repository = REPOSITORY,
  push = true,
  seedForeignIssue = false,
}: { token?: string; repository?: string; push?: boolean; seedForeignIssue?: boolean } = {}) {
  const tracker = githubTracker();
  if (seedForeignIssue) tracker.createIssue(repository, { title: 'Someone else\'s issue', body: '' });
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const deletedComments = new Set<number>();

  const reply = (status: number, body: unknown) => ({
    status,
    headers: { get: () => null },
    text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
  });

  const fetcher = async (href: string, init: Record<string, unknown>) => {
    const url = new URL(href);
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ method, path: url.pathname + url.search, headers });
    if (headers.authorization !== `Bearer ${token}`) return reply(401, { message: 'Bad credentials' });
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    if (url.pathname === '/user') return reply(200, { login: 'mock-user' });
    if (url.pathname.toLowerCase() === `/repos/${repository.toLowerCase()}`)
      return reply(200, {
        name: repository.split('/')[1],
        full_name: repository,
        has_issues: true,
        archived: false,
        permissions: { push },
      });
    const comment = url.pathname.match(/\/issues\/comments\/(\d+)$/);
    if (method === 'DELETE' && comment) {
      deletedComments.add(Number(comment[1]));

      return reply(204, null);
    }
    const res = tracker.request(method, new URL(`/proxy/github-issues${url.pathname}${url.search}`, 'http://fake.test'), body) as {
      status: number;
      body: unknown;
    };

    return reply(res.status, res.body);
  };

  return { fetcher, calls, tracker, deletedComments };
}
