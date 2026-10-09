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
 *                   body redacted per REDACTIONS below.
 *   api/GET__api__v1__tasks__completed-<n>.json
 *                   { status, headers, body } of `GET /tasks/{id}` for each
 *                   `--completed-task <id>`: a task the account's owner
 *                   completed by hand before recording. This is #46's open
 *                   question (does Todoist answer a completed task with
 *                   `checked: true`, or 404?), recorded as seen; scenario.mjs
 *                   then models its `completeTask` driver on the answer.
 *                   Redacted like the lists; a 404 body keeps its status and
 *                   has every string redacted.
 *   api/meta.json   when and how the recording was made, and every field the
 *                   redactor did not recognise (redacted to "redacted").
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
    field: 'id, *_id, *_uid, v2_id, v2_*_id (any string)',
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
    replace: 'page-<n+1>, or null on the last page',
    reason: 'Opaque server state; the mock only needs a stable token.',
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
  'due.timezone',
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
    if (path === 'due.string' || path === 'deadline.string') return 'redacted';
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
 * Every string in `body` replaced with "redacted", numbers, booleans and
 * null kept: for an error answer (404), whose fields are no task fields.
 * Nothing in it is reported as unrecognised, so an error body never lands
 * in meta.json's "add to KEEP" list.
 */
export const scrub = body =>
  Array.isArray(body)
    ? body.map(scrub)
    : body !== null && typeof body === 'object'
      ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, scrub(v)]))
      : typeof body === 'string'
        ? 'redacted'
        : body;

/**
 * Records `GET /tasks/{id}` for one task completed by hand (#46). The file
 * holds whatever Todoist answered, 404 included: scenario.mjs reads the
 * status and `checked` of these files to model its completeTask driver, and
 * todoist-fixture.test.ts fails when the answer is neither 404 nor a row with
 * `checked: true`, so an unexpected shape is noticed, not assumed away.
 */
async function recordCompleted({ dir, token, redact, id, n }) {
  const url = new URL(`${API}/tasks/${encodeURIComponent(id)}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body;

  try {
    body = await res.json();
  } catch {
    body = {};
  }

  if (body === null || typeof body !== 'object' || Array.isArray(body))
    body = {};
  const file = `GET__api__v1__tasks__completed-${n}.json`;
  writeFileSync(
    new URL(`api/${file}`, dir),
    `${JSON.stringify(
      {
        status: res.status,
        headers: {},
        // A task row is redacted as one; an error body (404) is scrubbed
        // whole, its fields being no task fields to learn from.
        body: res.status === 200 ? redact.row('task', body) : scrub(body),
      },
      null,
      2,
    )}\n`,
  );
  if (res.status === 200 && body.checked === true)
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

async function recordCollection({
  dir,
  token,
  redact,
  resource,
  path,
  limit,
  maxPages,
}) {
  let cursor;
  let page = 1;

  for (; page <= maxPages; page++) {
    const url = new URL(`${API}${path}`);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200)
      throw new Error(`GET ${url.pathname} returned ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.results))
      throw new Error(`GET ${url.pathname}: no results array`);
    cursor = body.next_cursor ?? null;
    const last = !cursor || page === maxPages;
    const file = `GET__api__v1__${path.slice(1)}__page-${page}.json`;
    writeFileSync(
      new URL(`api/${file}`, dir),
      `${JSON.stringify(
        {
          status: 200,
          headers: {},
          body: {
            results: body.results.map(row => redact.row(resource, row)),
            next_cursor: last ? null : `page-${page + 1}`,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (last) break;
  }

  if (page === 1)
    console.warn(
      `record: ${path} fit on one page at limit=${limit}; its cursor paging is not exercised.`,
    );

  return page;
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
  await recordDocument(dir, proxy);
  console.info(`record: wrote document.yaml from ${proxy}`);
  if (process.argv.includes('--document-only')) return format(dir);

  const token = process.env.TODOIST_TOKEN;
  if (!token)
    throw new Error('TODOIST_TOKEN must be set (or pass --document-only)');
  const api = new URL('api/', dir);
  rmSync(api, { recursive: true, force: true });
  mkdirSync(api);
  const redact = redactor();
  // Projects first, so project ids are numbered before tasks refer to them.
  const pages = {};
  for (const [resource, path] of [
    ['project', '/projects'],
    ['task', '/tasks'],
  ])
    pages[path] = await recordCollection({
      dir,
      token,
      redact,
      resource,
      path,
      limit,
      maxPages,
    });

  const completedIds = args('completed-task');
  const skipped = valueless('completed-task');
  if (skipped)
    console.warn(
      `record: ${skipped} --completed-task option(s) without a value (at the end, or followed by another --option) ignored.`,
    );
  const completed = [];
  for (const [i, id] of completedIds.entries())
    completed.push(await recordCompleted({ dir, token, redact, id, n: i + 1 }));
  if (completed.length === 0)
    console.warn(
      'record: no --completed-task given; what GET /tasks/{id} answers for a completed task (#46) stays unrecorded, and scenario.mjs keeps assuming checked: true.',
    );

  writeFileSync(
    new URL('meta.json', api),
    `${JSON.stringify(
      {
        recorded_at: new Date().toISOString().slice(0, 10),
        source: API,
        document_source: `${proxy}/catalog/todoist.yaml`,
        limit,
        pages,
        completed_tasks: completed.length,
        completed_task_statuses: completed,
        unrecognised_fields_redacted: redact.unknown(),
      },
      null,
      2,
    )}\n`,
  );
  const unknown = redact.unknown();
  if (unknown.length)
    console.warn(
      `record: redacted unrecognised fields ${unknown.join(', ')}; review, and add safe ones to KEEP.`,
    );
  console.info(`record: wrote ${readdirSync(api).length} files to api/`);
  format(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(`record: ${error.message}`);
    process.exit(1);
  });
