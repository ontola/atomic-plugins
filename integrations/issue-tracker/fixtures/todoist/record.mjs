/**
 * Records the todoist mock-proxy fixture from live sources. Never hand-edit
 * what it writes; re-run it instead (PARALLEL_LANES.md §4: "realistic" is
 * enforced by recording, not asserted).
 *
 * Writes, next to this file:
 *   document.yaml   the catalog document the real integration-proxy serves at
 *                   /catalog/todoist.yaml. Public; needs no token.
 *   api/GET__api__v1__projects__page-<n>.json
 *   api/GET__api__v1__tasks__page-<n>.json
 *                   { status, headers, body } per page of Todoist API v1,
 *                   body redacted per REDACTIONS below, headers kept only
 *                   on an allowlist (content-type, retry-after,
 *                   x-ratelimit-*; never authorization or cookies). A page
 *                   that is not a 200 with a results array is recorded as
 *                   answered (status, headers, every string scrubbed) and
 *                   ends the recording: nothing more is requested, meta.json
 *                   says where (`stopped`), and the script exits non-zero.
 *   api/GET__api__v1__tasks__completed-<n>.json
 *                   { status, headers, body } of `GET /tasks/{id}` for each
 *                   `--completed-task <id>`: a task the account's owner
 *                   completed by hand before recording. This is #46's open
 *                   question (does Todoist answer a completed task with
 *                   `checked: true`, or 404?), recorded as seen; scenario.mjs
 *                   then models its `completeTask` driver on the answer.
 *                   Redacted like the lists; a 404 body keeps its status and
 *                   has every string redacted.
 *   api/GET__api__v1__tasks__deleted-<n>.json
 *   api/GET__api__v1__tasks__inaccessible-<n>.json
 *                   the same for each `--deleted-task <id>` (deleted by
 *                   hand) and `--inaccessible-task <id>` (in a project a
 *                   second account shared and the test account then left),
 *                   whatever the status. No test expects an answer yet.
 *   api/meta.json   when and how the recording was made, every field the
 *                   redactor did not recognise (redacted to "redacted"),
 *                   each looked-up task's status, and `truncated: true` with
 *                   `truncated_collections` when --max-pages cut a list off
 *                   while Todoist still sent a next_cursor.
 *
 * Commands, from the repo root:
 *
 *   # catalog document only (no credentials):
 *   node integrations/issue-tracker/fixtures/todoist/record.mjs --document-only
 *
 *   # document and API bodies, against a dedicated test account:
 *   TODOIST_TOKEN=<personal API token> \
 *     node integrations/issue-tracker/fixtures/todoist/record.mjs
 *
 * TODOIST_TOKEN is a Todoist personal API token (Settings > Integrations >
 * Developer). It is sent only to https://api.todoist.com as a Bearer header
 * and is never written to disk. Only GET requests are made, and only on the
 * two collections the proxy's read-only catalog allows (/projects, /tasks).
 *
 * Options (all optional):
 *   --proxy <url>      real integration-proxy to take document.yaml from
 *                      (default https://localthought.io)
 *   --limit <n>        page size sent as `limit` (default 3)
 *   --max-pages <n>    stop after this many pages per collection (default 3)
 *   --completed-task <id>
 *                      record `GET /tasks/<id>` for a task completed by hand
 *                      in the account (repeatable). Without it the script
 *                      warns: the recording then leaves #46's completed-task
 *                      question open and scenario.mjs keeps its assumption.
 *                      The id is the one Todoist shows in the task's URL.
 *                      Given without a value (last, or before another
 *                      --option) it is ignored, with a warning.
 *   --deleted-task <id>
 *   --inaccessible-task <id>
 *                      record `GET /tasks/<id>` for a task deleted by hand,
 *                      or one the account can no longer read (repeatable).
 *                      Without them the script warns that the question stays
 *                      unrecorded. Given without a value they are ignored,
 *                      with a warning, as --completed-task.
 *
 * Every task id given must match ^[A-Za-z0-9_-]+$; anything else (`..`, a
 * slash) stops the script before anything is fetched. A lookup that answers
 * 401, 429, a 5xx or anything but a 2xx, 403, 404 or 410 says nothing about
 * the task: it is recorded, and stops the recording as an error page does.
 *
 * --proxy, --limit and --max-pages without a value (last, or before another
 * --option), a --limit or --max-pages that is not an integer of at least 1,
 * and the --name=value form stop the script before anything is fetched.
 *
 * Use an account with at least limit+1 active tasks, so the recording has a
 * second page (next_cursor) to exercise pagination; the script warns if not.
 * For todoist.ts coverage, include a task with `due.date`, one with
 * `due.datetime`, one with no due date, and several priorities. Complete one
 * more task by hand first and pass its id as --completed-task.
 *
 * The fixture (scenario.mjs) is already registered in
 * integrations/localthought/fixtures/index.mjs. Until api/ exists it serves
 * the SYNTHETIC rows of synthetic.mjs; once this script has written api/, it
 * replays the recording instead, and synthetic.mjs can be deleted. After
 * recording, run integrations/issue-tracker/todoist-fixture.test.ts (its
 * header has the command): the recorded-only tests stop skipping, and the
 * app's unit tests and the lane's e2e (todoist.spec.ts) then run against the
 * recorded rows, so their expected names and counts need updating to match.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.todoist.com/api/v1';

/**
 * The redaction list. Every string in a recorded body is either kept
 * verbatim because its field is in KEEP, mapped to a stable fake,
 * or replaced. Numbers, booleans and null are kept (priority, child_order,
 * is_* flags). A string field listed nowhere is replaced with "redacted" and
 * reported in api/meta.json, so an API change fails closed.
 */
export const REDACTIONS = [
  {
    field: 'id, *_id, *_uid, v2_id, v2_*_id (any string or number)',
    replace: '<kind>-<n>, e.g. task-1, project-2, user-1',
    reason:
      'Account-identifying. Mapped consistently across all files, so ' +
      'task.project_id still points at a recorded project.',
  },
  {
    field: 'task.content',
    replace: 'Redacted task <n>',
    reason: 'User-written text. Kept non-empty: todoist.ts names rows by it.',
  },
  {
    field: 'project.name',
    replace: 'Redacted project <n>; "Inbox" when inbox_project is true',
    reason: 'User-written text.',
  },
  {
    field: 'description (task and project)',
    replace: '"" when empty, otherwise "Redacted description"',
    reason: 'User-written text.',
  },
  {
    field: 'labels[]',
    replace: 'label-<n>',
    reason: 'User-chosen names.',
  },
  {
    field: 'due.timezone',
    replace: 'redacted (null kept)',
    reason: "The user's time zone; todoist.ts does not read it.",
  },
  {
    field: 'error bodies (anything but a 200 row)',
    replace:
      'every string, and every number under an id field, "redacted"; under ' +
      'error_extra, keys other than the documented ones become key-<n>',
    reason:
      'Not task fields; error_extra keys can name user data. Kept keys: ' +
      "the reference's common error_extra fields.",
  },
  {
    field: 'due.string, deadline.string',
    replace: 'redacted',
    reason:
      'The natural-language date the user typed. due.date and due.datetime, ' +
      'which todoist.ts reads, are kept.',
  },
  {
    field: 'url',
    replace: 'https://app.todoist.com/app/<kind>/<fake id>',
    reason: 'Embeds the real id.',
  },
  {
    field: 'next_cursor',
    replace:
      'page-<n+1> when Todoist sent a cursor, null only when it sent null',
    reason:
      "Opaque server state, and it can carry ids: Todoist's Workspace " +
      'Users example eyJpZCI6MTIzfQ is base64 for {"id":123} (the ' +
      "pagination guide's own example carries a page and a limit); the " +
      'mock only needs a ' +
      'stable token. A cut-off at --max-pages keeps page-<n+1>, and ' +
      'meta.json says truncated.',
  },
  {
    field: 'response headers',
    replace: 'kept only if content-type, retry-after or x-ratelimit-*',
    reason: 'Allowlist: authorization, cookies and unknown headers never land.',
  },
  {
    field: 'any other string field',
    replace: 'redacted (reported in api/meta.json)',
    reason: 'Fail closed on fields this list does not know about.',
  },
];

/** String fields kept verbatim: timestamps, dates and enum-like values. */
const KEEP = new Set([
  'added_at',
  'updated_at',
  'completed_at',
  'created_at',
  'color',
  'view_style',
  'role',
  'due.date',
  'due.datetime',
  'due.lang',
  'deadline.date',
  'deadline.lang',
  'duration.unit',
]);

const ID = /(^id$|_id$|_uid$|^v2_id$)/;
const ID_KIND = {
  project_id: 'project',
  v2_project_id: 'project',
  section_id: 'section',
  v2_section_id: 'section',
  workspace_id: 'workspace',
  folder_id: 'folder',
};

export function redactor() {
  const ids = new Map();
  const counters = {};
  const unknown = new Set();
  const next = kind => (counters[kind] = (counters[kind] ?? 0) + 1);

  const fake = (kind, raw) => {
    const key = `${kind}:${raw}`;
    if (!ids.has(key)) ids.set(key, `${kind}-${next(`id:${kind}`)}`);

    return ids.get(key);
  };

  const idKind = (field, resource) => {
    if (field === 'id' || field === 'v2_id') return resource;
    if (field === 'parent_id' || field === 'v2_parent_id') return resource;
    if (ID_KIND[field]) return ID_KIND[field];
    if (field.endsWith('_uid') || field === 'user_id') return 'user';

    return 'id';
  };

  const value = (v, path, resource, row) => {
    const field = path.split('.').pop();
    // An id field holding a number is mapped like a string one.
    if (typeof v === 'number' && !path.includes('.') && ID.test(field))
      return fake(idKind(field, resource), String(v));
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v))
      return field === 'labels'
        ? v.map(label => fake('label', label))
        : v.map(item => value(item, path, resource, row));
    if (typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [
          k,
          value(inner, `${path}.${k}`, resource, row),
        ]),
      );
    if (KEEP.has(path)) return v;
    if (!path.includes('.') && ID.test(field))
      return fake(idKind(field, resource), v);
    if (path === 'content' && resource === 'task')
      return `Redacted task ${next('content')}`;
    if (path === 'name' && resource === 'project')
      return row.inbox_project === true
        ? 'Inbox'
        : `Redacted project ${next('name')}`;
    if (path === 'description') return v === '' ? '' : 'Redacted description';
    if (
      path === 'due.string' ||
      path === 'deadline.string' ||
      path === 'due.timezone'
    )
      return 'redacted';
    if (path === 'url')
      return `https://app.todoist.com/app/${resource}/${fake(resource, row.id)}`;
    unknown.add(`${resource}.${path}`);

    return 'redacted';
  };

  return {
    row: (resource, row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, value(v, k, resource, row)]),
      ),
    unknown: () => [...unknown].sort(),
  };
}

/** Whether `argv[i + 1]` is no value for the option at `argv[i]`. */
const noValue = (argv, i) =>
  argv[i + 1] === undefined || argv[i + 1].startsWith('--');

/**
 * Refuses the `--<name>=<value>` form, which `arg` and `args` would not see
 * (the option would silently keep its default).
 */
export function checkArgv(argv = process.argv) {
  const joined = argv.find(a => /^--[^=]+=/.test(a));
  if (joined)
    throw new Error(
      `write ${joined.replace('=', ' ')} instead of ${joined}: options take their value as the next argument`,
    );
}

/** `value` of option `--<name>` as an integer of at least 1, or a throw. */
export function positiveInteger(name, value) {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1)
    throw new Error(`--${name} must be an integer of at least 1, not ${value}`);

  return n;
}

/**
 * The value of a single `--<name> <value>` option, or `fallback` when it is
 * not given. A flag right after the option (`--limit --proxy x`), or
 * nothing at all, is no value: that throws, rather than recording with
 * `limit` "--proxy".
 */
export const arg = (name, fallback, argv = process.argv) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (noValue(argv, i)) throw new Error(`--${name} needs a value`);

  return argv[i + 1];
};

/**
 * Every value of a repeatable `--<name> <value>` option, in order. A flag
 * right after the option (`--completed-task --limit 3`) is not its value,
 * and neither is the end of the line; `valueless` counts those.
 */
export const args = (name, argv = process.argv) =>
  argv.flatMap((a, i) =>
    a === `--${name}` && !noValue(argv, i) ? [argv[i + 1]] : [],
  );

/** How many times a `--<name>` option is given without a value. */
export const valueless = (name, argv = process.argv) =>
  argv.filter((a, i) => a === `--${name}` && noValue(argv, i)).length;

/**
 * The keys the API v1 reference documents as common in an error body's
 * `error_extra`; any other key there is replaced, since it can name data.
 */
const ERROR_EXTRA_KEYS = new Set([
  'argument',
  'explanation',
  'retry_after',
  'workspace_id',
  'max_count',
  'event_id',
  'project_id',
  'section_id',
  'bad_item',
]);

/**
 * Every string in `body` replaced with "redacted", and every number under
 * an id field (`workspace_id`, say); other numbers, booleans and null kept.
 * Under `error_extra`, a key the reference does not document becomes
 * `key-<n>`. For an error answer (404), whose fields are no task fields.
 * Nothing in it is reported as unrecognised, so an error body never lands
 * in meta.json's "add to KEEP" list.
 */
export function scrub(body, field = '') {
  if (Array.isArray(body)) return body.map(item => scrub(item, field));

  if (body !== null && typeof body === 'object') {
    let n = 0;

    return Object.fromEntries(
      Object.entries(body).map(([k, v]) => [
        field === 'error_extra' && !ERROR_EXTRA_KEYS.has(k) ? `key-${++n}` : k,
        scrub(v, k),
      ]),
    );
  }

  if (typeof body === 'string') return 'redacted';
  if (typeof body === 'number' && ID.test(field)) return 'redacted';

  return body;
}

/**
 * The response headers a recording keeps, by an allowlist: the content type
 * and the rate-limit ones (`retry-after`, `x-ratelimit-*`). Everything else
 * is dropped, so an `authorization`, `set-cookie` or `cookie` header, or
 * any header Todoist adds later, never reaches the fixture.
 */
export function keptHeaders(headers) {
  const kept = {};

  for (const [name, value] of headers.entries()) {
    const lower = name.toLowerCase();
    if (
      lower === 'content-type' ||
      lower === 'retry-after' ||
      lower.startsWith('x-ratelimit-')
    )
      kept[lower] = value;
  }

  return Object.fromEntries(Object.entries(kept).sort());
}

/** The JSON body of `res`, or `{}` when it is no JSON object. */
async function jsonObject(res) {
  let body;

  try {
    body = await res.json();
  } catch {
    return {};
  }

  return body === null || typeof body !== 'object' || Array.isArray(body)
    ? {}
    : body;
}

/**
 * The tasks looked up by id: each kind's option, the file name it writes
 * (`GET__api__v1__tasks__<kind>-<n>.json`) and what the task is.
 */
export const LOOKUPS = [
  {
    kind: 'completed',
    option: 'completed-task',
    what: 'a task completed by hand before recording',
  },
  {
    kind: 'deleted',
    option: 'deleted-task',
    what: 'a task deleted by hand before recording',
  },
  {
    kind: 'inaccessible',
    option: 'inaccessible-task',
    what: 'a task in a project the account has left (shared by another account)',
  },
];

/**
 * Records `GET /tasks/{id}` for one looked-up task (#46): whatever Todoist
 * answered, its status kept, a 404 or any other status included. A 200 body
 * is redacted as a task row; any other body is scrubbed whole, its fields
 * being no task fields to learn from. For a completed task, scenario.mjs
 * reads the status and `checked` of these files to model its completeTask
 * driver, and todoist-fixture.test.ts fails when the answer is neither 404
 * nor a row with `checked: true`, so an unexpected shape is noticed, not
 * assumed away. Deleted and inaccessible tasks are recorded as seen; no test
 * expects an answer for them yet.
 */
/** Whether a lookup's status answers about the task (2xx, 403, 404, 410). */
export const answersAboutTask = status =>
  (status >= 200 && status < 300) || [403, 404, 410].includes(status);

/** Task ids look like Todoist's (letters, digits, `_`, `-`); anything else throws. */
export function checkTaskIds(lookups) {
  for (const { kind, option } of LOOKUPS)
    for (const id of lookups[kind] ?? [])
      if (!/^[A-Za-z0-9_-]+$/.test(id))
        throw new Error(
          `--${option} ${JSON.stringify(id)} is no Todoist task id (letters, digits, _ and - only)`,
        );
}

export async function recordLookup({ dir, api, token, redact, kind, id, n }) {
  const url = new URL(`${api}/tasks/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await jsonObject(res);
  writeFileSync(
    new URL(`api/GET__api__v1__tasks__${kind}-${n}.json`, dir),
    `${JSON.stringify(
      {
        status: res.status,
        headers: keptHeaders(res.headers),
        body: res.status === 200 ? redact.row('task', body) : scrub(body),
      },
      null,
      2,
    )}\n`,
  );
  if (!answersAboutTask(res.status))
    console.warn(
      `record: ${kind} task ${n}: ${res.status} says nothing about the task; recorded, and the recording stops there.`,
    );
  else if (kind !== 'completed')
    console.info(`record: ${kind} task ${n}: ${res.status}`);
  else if (res.status === 200 && body.checked === true)
    console.info(`record: completed task ${n}: 200 with checked: true`);
  else if (res.status === 404) console.info(`record: completed task ${n}: 404`);
  else
    console.warn(
      `record: completed task ${n}: ${res.status} with checked: ${body.checked}; neither 404 nor checked: true. Is the task really completed? todoist-fixture.test.ts will fail on it.`,
    );

  return res.status;
}

async function recordDocument(dir, proxy) {
  const res = await fetch(new URL('/catalog/todoist.yaml', proxy));
  if (!res.ok)
    throw new Error(`${proxy}/catalog/todoist.yaml returned ${res.status}`);
  writeFileSync(new URL('document.yaml', dir), await res.text());
}

/**
 * Records the pages of one collection, at most `maxPages`. Each page file
 * keeps the status and the allowlisted headers. Its `next_cursor` is
 * `page-<n+1>` when Todoist sent a cursor and null only when Todoist sent
 * null, so a recording cut off by `maxPages` does not show an end Todoist
 * never sent. The raw cursor is not written anywhere: it is opaque server
 * state, and Todoist's Workspace Users example (`eyJpZCI6MTIzfQ`) is base64
 * for `{"id":123}`. A page that is not a 200 with a `results` array is
 * recorded as answered (status, headers, scrubbed body) and ends the read.
 *
 * Returns `{ pages, truncated, stopped }`: the page count, whether a cursor
 * was cut off by `maxPages`, and `{ status, reason }` of a page that ended
 * the read (null when none did).
 */
export async function recordCollection({
  dir,
  api,
  token,
  redact,
  resource,
  path,
  limit,
  maxPages,
}) {
  let cursor;
  let page = 1;
  let truncated = false;
  let stopped = null;

  for (; page <= maxPages; page++) {
    const url = new URL(`${api}${path}`);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await jsonObject(res);
    const file = new URL(
      `api/GET__api__v1__${path.slice(1)}__page-${page}.json`,
      dir,
    );

    if (res.status !== 200 || !Array.isArray(body.results)) {
      writeFileSync(
        file,
        `${JSON.stringify(
          {
            status: res.status,
            headers: keptHeaders(res.headers),
            body: scrub(body),
          },
          null,
          2,
        )}\n`,
      );
      stopped = {
        status: res.status,
        reason: res.status === 200 ? 'no results array' : 'an error status',
      };
      console.warn(
        `record: GET ${url.pathname} page ${page} answered ${res.status}${
          res.status === 200 ? ', which lacked a results array' : ''
        }; recorded, and the read stops there.`,
      );
      break;
    }

    cursor = typeof body.next_cursor === 'string' ? body.next_cursor : null;
    truncated = Boolean(cursor) && page === maxPages;
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          status: 200,
          headers: keptHeaders(res.headers),
          body: {
            results: body.results.map(row => redact.row(resource, row)),
            next_cursor: cursor ? `page-${page + 1}` : null,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (!cursor) break;
  }

  const pages = Math.min(page, maxPages);

  if (truncated)
    console.warn(
      `record: ${path} still had a next_cursor after --max-pages ${maxPages}; the recording does not reach its end (meta.json says truncated).`,
    );
  else if (pages === 1 && stopped === null)
    console.warn(
      `record: ${path} fit on one page at limit=${limit}; its cursor paging is not exercised.`,
    );

  return { pages, truncated, stopped };
}

/** `url` as a string, without any user name or password in it. */
function withoutUserinfo(url) {
  const clean = new URL(url);
  clean.username = '';
  clean.password = '';

  return clean.href;
}

/**
 * Records the API side of the fixture into `dir`/api/: both collections,
 * then each looked-up task, then meta.json. `api` is Todoist's API base
 * (main passes API; tests pass a local fake server). `lookups` maps each
 * LOOKUPS kind to its ids, checked before anything is fetched. A
 * collection page that ends a read, or a lookup whose status says nothing
 * about the task, stops the recording: nothing more is requested,
 * meta.json says where (`stopped`), and the result's `stopped` is set.
 */
export async function recordApi({
  dir,
  api,
  token,
  limit,
  maxPages,
  lookups = {},
  proxy = 'https://localthought.io',
}) {
  checkTaskIds(lookups);
  const apiDir = new URL('api/', dir);
  rmSync(apiDir, { recursive: true, force: true });
  mkdirSync(apiDir);
  const redact = redactor();
  const pages = {};
  const truncated = {};
  let stopped = null;

  // Projects first, so project ids are numbered before tasks refer to them.
  for (const [resource, path] of [
    ['project', '/projects'],
    ['task', '/tasks'],
  ]) {
    const result = await recordCollection({
      dir,
      api,
      token,
      redact,
      resource,
      path,
      limit,
      maxPages,
    });
    pages[path] = result.pages;
    truncated[path] = result.truncated;

    if (result.stopped !== null) {
      stopped = { path, page: result.pages, ...result.stopped };
      break;
    }
  }

  const statuses = {};

  for (const { kind } of LOOKUPS) {
    statuses[kind] = [];

    for (const [i, id] of (lookups[kind] ?? []).entries()) {
      if (stopped) break;
      const status = await recordLookup({
        dir,
        api,
        token,
        redact,
        kind,
        id,
        n: i + 1,
      });
      statuses[kind].push(status);
      if (!answersAboutTask(status))
        stopped = {
          path: '/tasks/{id}',
          lookup: `${kind}-${i + 1}`,
          status,
          reason: 'not an answer about the task',
        };
    }
  }

  const meta = {
    recorded_at: new Date().toISOString().slice(0, 10),
    source: api,
    document_source: withoutUserinfo(new URL('/catalog/todoist.yaml', proxy)),
    limit,
    max_pages: maxPages,
    pages,
    // A collection that still had a next_cursor at --max-pages: its
    // recording does not reach the end. The last page file's next_cursor
    // then names the page after it (redacted), as Todoist sent one.
    truncated: Object.values(truncated).some(Boolean),
    truncated_collections: Object.keys(truncated).filter(p => truncated[p]),
    ...(stopped ? { stopped } : {}),
    completed_tasks: statuses.completed?.length ?? 0,
    completed_task_statuses: statuses.completed ?? [],
    deleted_task_statuses: statuses.deleted ?? [],
    inaccessible_task_statuses: statuses.inaccessible ?? [],
    unrecognised_fields_redacted: redact.unknown(),
  };
  writeFileSync(
    new URL('meta.json', apiDir),
    `${JSON.stringify(meta, null, 2)}\n`,
  );

  return { meta, stopped };
}

/**
 * Formats what was written with the repo's oxfmt, so CI's `oxfmt --check
 * integrations` passes. Only whitespace and YAML list indentation change;
 * the parsed content is what the source returned (after redaction).
 */
function format(dir) {
  const root = new URL('../../../../', dir);
  const bin = new URL('browser/node_modules/.bin/oxfmt', root);

  if (!existsSync(bin)) {
    console.warn(
      'record: browser/node_modules/.bin/oxfmt not found (see AGENTS.md for the atomic-server layout); format before committing.',
    );

    return;
  }

  const result = spawnSync(
    fileURLToPath(bin),
    [
      '-c',
      fileURLToPath(new URL('browser/.oxfmtrc.json', root)),
      fileURLToPath(dir),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('oxfmt failed');
}

async function main() {
  const dir = new URL('./', import.meta.url);
  // Every option is read before anything is fetched, so one without a
  // value stops the script first.
  checkArgv();
  const proxy = arg('proxy', 'https://localthought.io');
  const limit = positiveInteger('limit', arg('limit', '3'));
  const maxPages = positiveInteger('max-pages', arg('max-pages', '3'));
  const lookups = {};

  for (const { kind, option } of LOOKUPS) {
    lookups[kind] = args(option);
    const skipped = valueless(option);
    if (skipped)
      console.warn(
        `record: ${skipped} --${option} option(s) without a value (at the end, or followed by another --option) ignored.`,
      );
  }

  checkTaskIds(lookups);
  await recordDocument(dir, proxy);
  console.info(`record: wrote document.yaml from ${withoutUserinfo(proxy)}`);
  if (process.argv.includes('--document-only')) return format(dir);

  const token = process.env.TODOIST_TOKEN;
  if (!token)
    throw new Error('TODOIST_TOKEN must be set (or pass --document-only)');
  for (const { kind, option, what } of LOOKUPS)
    if (lookups[kind].length === 0)
      console.warn(
        `record: no --${option} given; what GET /tasks/{id} answers for ${what} stays unrecorded${
          kind === 'completed'
            ? ', and scenario.mjs keeps assuming checked: true'
            : ''
        }.`,
      );

  const { meta, stopped } = await recordApi({
    dir,
    api: API,
    token,
    limit,
    maxPages,
    lookups,
    proxy,
  });
  if (meta.unrecognised_fields_redacted.length)
    console.warn(
      `record: redacted unrecognised fields ${meta.unrecognised_fields_redacted.join(', ')}; review, and add safe ones to KEEP.`,
    );
  const api = new URL('api/', dir);
  console.info(`record: wrote ${readdirSync(api).length} files to api/`);
  format(dir);
  if (stopped)
    throw new Error(
      `GET ${stopped.path} ${
        stopped.lookup ? `(${stopped.lookup})` : `page ${stopped.page}`
      } answered ${stopped.status} (${stopped.reason}); recorded in api/ and meta.json, but the recording is not complete and scenario.mjs refuses it`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(`record: ${error.message}`);
    process.exit(1);
  });
