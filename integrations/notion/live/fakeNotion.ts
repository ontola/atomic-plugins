// @wc-ignore-file
/**
 * A `fetch` stand-in for the live check's offline tests: the mock proxy's
 * Notion fixture (`../fixtures/notion/`), reached by real Notion URLs, a
 * bearer token and the `Notion-Version` header, plus the few calls the driver
 * makes that the fixture's HTTP surface lacks (`GET /v1/users/me`, creating a
 * page, moving one to the trash). Test-only; it is evidence about the
 * script, not about Notion.
 */
import { DATA_SOURCE, notionFixture } from '../fixtures/notion/scenario.mjs';

export const TOKEN =
  'ntn_offlineTestTokenValueNotReal0123456789abcdefABCDEFghij';
export const DATA_SOURCE_ID = DATA_SOURCE;
export const API_VERSION = '2026-03-11';

export function fakeNotion({
  token = TOKEN,
  scenario = 'default',
  // Whether the data source starts without pages (a fresh test data source).
  blank = true,
  title = 'Atomic live-check test',
}: {
  token?: string;
  scenario?: string;
  blank?: boolean;
  title?: string;
} = {}) {
  const api = notionFixture({ scenario, blank });
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: unknown;
  }> = [];

  const reply = (status: number, body: unknown) => ({
    status,
    headers: { get: () => null },
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
    const body =
      typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({
      method,
      path: url.pathname + url.search,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    if (headers.authorization !== `Bearer ${token}`)
      return reply(401, {
        object: 'error',
        status: 401,
        code: 'unauthorized',
        message: 'API token is invalid.',
      });
    if (headers['notion-version'] !== API_VERSION)
      return reply(400, {
        object: 'error',
        status: 400,
        code: 'invalid_request',
        message: 'Unsupported Notion-Version.',
      });

    const path = url.pathname;
    if (method === 'GET' && path === '/v1/users/me')
      return reply(200, { object: 'user', type: 'bot', id: 'bot-1' });

    const one = path.match(/^\/v1\/pages\/([^/]+)$/);

    if (method === 'POST' && path === '/v1/pages') {
      const parent = body?.parent?.data_source_id;
      if (parent !== DATA_SOURCE)
        return reply(404, { object: 'error', code: 'object_not_found' });
      const made = api.createPage(body.properties);

      return reply(made.status, made.body);
    }

    if (method === 'PATCH' && one && body?.in_trash === true) {
      try {
        api.archivePage(one[1]!);
      } catch {
        return reply(404, { object: 'error', code: 'object_not_found' });
      }

      return reply(200, api.getPage(one[1]!));
    }

    const res = api.request(
      method,
      new URL(`/proxy/notion${path}${url.search}`, 'http://fake.test'),
      body,
    ) as { status: number; body: Record<string, unknown> };

    // The data source answers with the disposable name this fake is given.
    if (
      method === 'GET' &&
      path === `/v1/data_sources/${DATA_SOURCE}` &&
      res.status === 200
    )
      res.body = {
        ...res.body,
        title: [{ type: 'text', plain_text: title, text: { content: title } }],
      };

    return reply(res.status, res.body);
  };

  return { fetcher, calls, api };
}
