// @wc-ignore-file
/**
 * record.mjs against a local fake Todoist (node:http on 127.0.0.1, port 0):
 * no network, no token. Covers the --deleted-task and --inaccessible-task
 * lookups, a cursor cut off by --max-pages (truncated in meta.json, never a
 * fabricated end), the response-header allowlist, and a non-200 page that is
 * recorded and stops the recording. Run with the AGENTS.md atomic-server
 * layout:
 *
 *   browser/node_modules/.bin/vitest run \
 *     --config integrations/issue-tracker/vitest.config.ts fixtures/todoist/record
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { keptHeaders, recordApi } from './record.mjs';
import { source } from './scenario.mjs';

const TOKEN = 'test-token-not-real';
/** A cursor shaped like Todoist's example: base64 JSON with an id in it. */
const RAW_CURSOR = 'eyJpZCI6MTIzfQ';

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}

type Route = (url: URL) => Answer;

const project = (n: number) => ({
  id: `p${n}raw`,
  name: `Secret project ${n}`,
  inbox_project: n === 1,
  color: 'blue',
});
const task = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `t${n}raw`,
  project_id: 'p1raw',
  content: `Secret task ${n}`,
  description: '',
  checked: false,
  is_deleted: false,
  priority: 1,
  ...extra,
});

const NOISY_HEADERS = {
  'content-type': 'application/json',
  'x-ratelimit-remaining': '449',
  'set-cookie': 'session=secret',
  'x-request-id': 'req-secret',
};

let server: Server;
let base: string;
let route: Route = () => ({ status: 500, body: {} });
const seen: { path: string; authorization?: string }[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    seen.push({
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
    });
    const answer = route(url);
    res.writeHead(answer.status, {
      'content-type': 'application/json',
      ...answer.headers,
    });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});

afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

afterEach(() => {
  seen.length = 0;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function tempDir(): URL {
  const dir = mkdtempSync(join(tmpdir(), 'todoist-record-'));
  dirs.push(dir);

  return pathToFileURL(`${dir}/`);
}

const read = (dir: URL, file: string) =>
  JSON.parse(readFileSync(new URL(`api/${file}`, dir), 'utf8'));

const everything = (dir: URL) =>
  readdirSync(new URL('api/', dir))
    .map(file => readFileSync(new URL(`api/${file}`, dir), 'utf8'))
    .join('\n');

/** Lists that page by `limit`, each page's next_cursor RAW_CURSOR + n. */
function lists(projects: unknown[], tasks: unknown[]): Route {
  return url => {
    const rows = url.pathname.endsWith('/projects') ? projects : tasks;
    const limit = Number(url.searchParams.get('limit'));
    const cursor = url.searchParams.get('cursor');
    const n = cursor ? Number(cursor.slice(RAW_CURSOR.length)) : 0;
    const results = rows.slice(n * limit, (n + 1) * limit);
    const more = (n + 1) * limit < rows.length;

    return {
      status: 200,
      headers: NOISY_HEADERS,
      body: { results, next_cursor: more ? `${RAW_CURSOR}${n + 1}` : null },
    };
  };
}

describe('record.mjs against a fake Todoist', () => {
  it('records every page to the real end, with a page-<n> token and allowlisted headers', async () => {
    route = lists([project(1)], [task(1), task(2), task(3)]);
    const dir = tempDir();
    const { meta, stopped } = await recordApi({
      dir,
      api: base,
      token: TOKEN,
      limit: 2,
      maxPages: 3,
    });

    expect(stopped).toBeNull();
    expect(meta.pages).toEqual({ '/projects': 1, '/tasks': 2 });
    expect(meta.truncated).toBe(false);
    expect(meta.truncated_collections).toEqual([]);
    const first = read(dir, 'GET__api__v1__tasks__page-1.json');
    const last = read(dir, 'GET__api__v1__tasks__page-2.json');
    expect(first.body.next_cursor).toBe('page-2');
    expect(last.body.next_cursor).toBeNull();
    expect(first.headers).toEqual({
      'content-type': 'application/json',
      'x-ratelimit-remaining': '449',
    });
    // The token was sent, and is written nowhere; nor are the raw cursor,
    // the cookie, the request id or the user's text.
    expect(seen.every(r => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
    const files = everything(dir);
    for (const secret of [
      TOKEN,
      RAW_CURSOR,
      'session=secret',
      'req-secret',
      'Secret task',
      't1raw',
    ])
      expect(files).not.toContain(secret);
    // The fixture replays it: three tasks, the page size the recording used.
    const replayed = source({ apiDir: new URL('api/', dir) });
    expect(replayed.tasks).toHaveLength(3);
    expect(replayed.pageSize).toBe(2);
  });

  it('says truncated when --max-pages cuts a list off, and does not show an end Todoist never sent', async () => {
    route = lists([project(1)], [task(1), task(2), task(3), task(4), task(5)]);
    const dir = tempDir();
    const { meta } = await recordApi({
      dir,
      api: base,
      token: TOKEN,
      limit: 2,
      maxPages: 2,
    });

    expect(meta.truncated).toBe(true);
    expect(meta.truncated_collections).toEqual(['/tasks']);
    expect(meta.pages['/tasks']).toBe(2);
    expect(read(dir, 'GET__api__v1__tasks__page-2.json').body.next_cursor).toBe(
      'page-3',
    );
    expect(seen.filter(r => r.path.startsWith('/api/v1/tasks?'))).toHaveLength(
      2,
    );
    expect(everything(dir)).not.toContain(RAW_CURSOR);
  });

  it('records a non-200 page as answered and stops: nothing more is requested', async () => {
    const ok = lists([project(1)], [task(1), task(2), task(3)]);
    route = url =>
      url.pathname.endsWith('/tasks') && url.searchParams.get('cursor')
        ? {
            status: 429,
            headers: { 'retry-after': '5', 'set-cookie': 'session=secret' },
            body: {
              error: 'Too many requests',
              error_tag: 'LIMITS_REACHED',
              retry_after: 5,
            },
          }
        : ok(url);
    const dir = tempDir();
    const { meta, stopped } = await recordApi({
      dir,
      api: base,
      token: TOKEN,
      limit: 2,
      maxPages: 3,
      lookups: { completed: ['t9raw'], deleted: ['t8raw'] },
    });

    expect(stopped).toEqual({ path: '/tasks', page: 2, status: 429 });
    expect(meta.stopped).toEqual(stopped);
    const page = read(dir, 'GET__api__v1__tasks__page-2.json');
    expect(page.status).toBe(429);
    expect(page.headers).toEqual({
      'content-type': 'application/json',
      'retry-after': '5',
    });
    expect(page.body).toEqual({
      error: 'redacted',
      error_tag: 'redacted',
      retry_after: 5,
    });
    // No lookup was requested after the stop.
    expect(seen.some(r => r.path.startsWith('/api/v1/tasks/'))).toBe(false);
    expect(meta.completed_task_statuses).toEqual([]);
    // The fixture replays the rows before the error page.
    expect(source({ apiDir: new URL('api/', dir) }).tasks).toHaveLength(2);
  });

  it('records completed, deleted and inaccessible tasks by id, whatever their status', async () => {
    const ok = lists([project(1)], [task(1)]);

    route = url => {
      const id = /\/tasks\/([^/]+)$/.exec(url.pathname)?.[1];
      if (id === 'done')
        return { status: 200, body: task(7, { id: 'done', checked: true }) };
      if (id === 'gone')
        return {
          status: 404,
          body: { error: 'Task not found', http_code: 404 },
        };
      if (id === 'hidden')
        return {
          status: 403,
          headers: { 'x-ratelimit-limit': '450' },
          body: { error: 'Forbidden' },
        };

      return ok(url);
    };

    const dir = tempDir();
    const { meta } = await recordApi({
      dir,
      api: base,
      token: TOKEN,
      limit: 2,
      maxPages: 3,
      lookups: {
        completed: ['done'],
        deleted: ['gone'],
        inaccessible: ['hidden'],
      },
    });

    expect(meta.completed_task_statuses).toEqual([200]);
    expect(meta.deleted_task_statuses).toEqual([404]);
    expect(meta.inaccessible_task_statuses).toEqual([403]);
    const completed = read(dir, 'GET__api__v1__tasks__completed-1.json');
    expect(completed.status).toBe(200);
    expect(completed.body.checked).toBe(true);
    expect(completed.body.content).toMatch(/^Redacted task \d+$/);
    expect(read(dir, 'GET__api__v1__tasks__deleted-1.json')).toEqual({
      status: 404,
      headers: { 'content-type': 'application/json' },
      body: { error: 'redacted', http_code: 404 },
    });
    expect(read(dir, 'GET__api__v1__tasks__inaccessible-1.json')).toEqual({
      status: 403,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '450',
      },
      body: { error: 'redacted' },
    });
  });
});

describe('keptHeaders', () => {
  it('keeps content-type, retry-after and x-ratelimit-* only, lower-cased and sorted', () => {
    const headers = new Headers({
      'Content-Type': 'application/json',
      'Retry-After': '3',
      'X-RateLimit-Reset': '1700000000',
      Authorization: 'Bearer secret',
      'Set-Cookie': 'a=b',
      Cookie: 'c=d',
      'WWW-Authenticate': 'Bearer',
      'X-Request-Id': 'abc',
    });
    expect(keptHeaders(headers)).toEqual({
      'content-type': 'application/json',
      'retry-after': '3',
      'x-ratelimit-reset': '1700000000',
    });
  });
});
