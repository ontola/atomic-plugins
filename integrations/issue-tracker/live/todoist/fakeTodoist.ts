// @wc-ignore-file
/**
 * A `fetch` stand-in for the Todoist live check's offline tests: the mock
 * proxy's Todoist fixture (`../../fixtures/todoist/`), reached by real
 * Todoist URLs and a bearer token, plus the writes the driver makes that the
 * fixture's HTTP surface lacks (create, update, close, reopen, delete). The
 * fixture is SYNTHETIC, so this is evidence about the script, not about
 * Todoist.
 *
 * `completedLookup` chooses what `GET /tasks/{id}` answers once a task is
 * completed, the question #46 leaves open: `'checked'` (200 with
 * `checked: true`, the fixture's own modelling) or `'404'`.
 */
import { todoistFixture } from '../../fixtures/todoist/scenario.mjs';

export const TOKEN = '0123456789abcdef0123456789abcdef01234567';
/** A project of the fixture, renamed below so that it looks disposable. */
export const PROJECT = 'synthetic-project-2';
export const OTHER_PROJECT = 'synthetic-project-1';

export function fakeTodoist({
  token = TOKEN,
  // The fixture's five synthetic active tasks make the account "not empty".
  blank = true,
  name = 'Atomic live-check test',
  completedLookup = 'checked',
}: {
  token?: string;
  blank?: boolean;
  name?: string;
  completedLookup?: 'checked' | '404';
} = {}) {
  const api = todoistFixture({ blank });
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
  }> = [];

  const reply = (status: number, body: unknown) => ({
    status,
    headers: { get: () => null },
    text: async () =>
      body === null || body === undefined ? '' : JSON.stringify(body),
  });
  type Project = { id: string; name: string };
  const rename = (project: Project) =>
    project.id === PROJECT ? { ...project, name } : project;

  const fetcher = async (href: string, init: Record<string, unknown>) => {
    const url = new URL(href);
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    calls.push({ method, path: url.pathname + url.search, headers });
    if (url.origin !== 'https://api.todoist.com')
      return reply(404, { error: 'not todoist' });
    if (headers.authorization !== `Bearer ${token}`)
      return reply(401, 'Forbidden');
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    const task = path.match(/^\/api\/v1\/tasks\/([^/]+)(?:\/(close|reopen))?$/);

    try {
      if (method === 'POST' && path === '/api/v1/tasks') {
        if (!body?.content || !body?.project_id)
          return reply(400, { error: 'content and project_id are required' });

        return reply(200, api.createTask(body));
      }

      if (task && method === 'POST' && !task[2])
        return reply(200, api.updateTask(task[1]!, body ?? {}));

      if (task && method === 'POST' && task[2] === 'close') {
        if (completedLookup === '404') api.removeTask(task[1]!);
        else api.completeTask(task[1]!);

        return reply(204, null);
      }

      if (task && method === 'POST' && task[2] === 'reopen') {
        api.reopenTask(task[1]!);

        return reply(204, null);
      }

      if (task && method === 'DELETE') {
        api.removeTask(task[1]!);

        return reply(204, null);
      }
    } catch {
      return reply(404, { error: 'task not found' });
    }

    const res = api.request(
      method,
      new URL(`/proxy/todoist${path}${url.search}`, 'http://fake.test'),
    ) as { status: number; body: Project | { results: Project[] } };

    if (res.status === 200 && /^\/api\/v1\/projects(\/[^/]+)?$/.test(path))
      res.body =
        'results' in res.body
          ? { ...res.body, results: res.body.results.map(rename) }
          : rename(res.body);

    return reply(res.status, res.body);
  };

  return { fetcher, calls, api };
}
