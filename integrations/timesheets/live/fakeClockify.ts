// @wc-ignore-file
/**
 * A `fetch` stand-in for the live check's offline tests: the mock proxy's
 * Clockify fixture (`../fixtures/clockify/`), reached by real Clockify URLs
 * and the `X-Api-Key` header, plus the tag calls the driver makes (the
 * fixture has none). Test-only; it is evidence about the script, not Clockify.
 */
import { WORKSPACE, clockifyFixture } from '../fixtures/clockify/scenario.mjs';

export const API_KEY = 'ZmFrZS1jbG9ja2lmeS1rZXktZm9yLW9mZmxpbmUtdGVzdHM0OA';
export { WORKSPACE };

export function fakeClockify({
  apiKey = API_KEY,
  existingEntries = false,
  workspaceName,
}: {
  apiKey?: string;
  existingEntries?: boolean;
  workspaceName?: string;
} = {}) {
  const fixture = clockifyFixture();
  if (!existingEntries) fixture.state.entries = [];
  if (workspaceName) WORKSPACE.name = workspaceName;
  const tags = new Map<string, string>();
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
  }> = [];

  const reply = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () =>
      body === null || body === undefined ? '' : JSON.stringify(body),
  });

  const fetcher = async (href: string, init: Record<string, unknown>) => {
    const url = new URL(href);
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(
        ([k, v]) => [k.toLowerCase(), v],
      ),
    );
    calls.push({ method, path: url.pathname + url.search, headers });
    if (headers['x-api-key'] !== apiKey)
      return reply(401, { message: 'Unauthorized' });
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;

    const tag = url.pathname.match(
      /^\/api\/v1\/workspaces\/[^/]+\/tags(?:\/([^/]+))?$/,
    );

    if (tag) {
      if (method === 'POST') {
        const id = `tag${String(tags.size + 1).padStart(21, '0')}`;
        tags.set(id, body.name);

        return reply(201, { id, name: body.name });
      }

      if (method === 'DELETE' && tag[1])
        return reply(tags.delete(tag[1]) ? 200 : 404, {});

      return reply(405, {});
    }

    const proxied = new URL(
      `/proxy/clockify${url.pathname}${url.search}`,
      'http://fake.test',
    );
    const res = (await fixture.request(method, proxied, body)) as {
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };

    return reply(
      res.status,
      res.body,
      Object.fromEntries(
        Object.entries(res.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          String(v),
        ]),
      ),
    );
  };

  return { fetcher, calls, fixture, tags };
}
