// @wc-ignore-file
/**
 * Checks the todoist mock-proxy fixture (fixtures/todoist/) against the
 * adapter that consumes it, ./todoist.ts. Per PARALLEL_LANES.md §4 a source
 * that drops a field the adapter reads must fail here, not in e2e.
 *
 * The fixture serves the recorded api/ when fixtures/todoist/record.mjs has
 * been run against a live account (#46), and the SYNTHETIC rows of
 * synthetic.mjs until then. Most checks run against either source; the
 * recorded-only and synthetic-only ones say so. Run with the AGENTS.md
 * atomic-server layout:
 *
 *   browser/node_modules/.bin/vitest run \
 *     --config integrations/issue-tracker/vitest.config.ts todoist-fixture
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { Datatype } from '../../browser/lib/src/index';
import type { JSONValue } from '../../browser/lib/src/value';
import { fixtures } from '../localthought/fixtures/index.mjs';
import {
  arg,
  args,
  checkArgv,
  positiveInteger,
  redactor,
  scrub,
  valueless,
} from './fixtures/todoist/record.mjs';
import scenario, {
  completedAnswer,
  loadCompleted,
  recorded,
  source,
  todoistFixture,
} from './fixtures/todoist/scenario.mjs';
import { SYNTHETIC } from './fixtures/todoist/synthetic.mjs';
import type { FetchedPlatform, FetchedRecord } from '../localthought/schema';
import { todoistFields as fields, todoistProjection } from './todoist';

type Row = Record<string, JSONValue>;
type Page = {
  status: number;
  body: { results: Row[]; next_cursor: string | null };
};
const isRecorded: boolean = recorded();
const DAY = /^\d{4}-\d{2}-\d{2}/;

const api = () => {
  const fixture = todoistFixture();
  const get = (path: string, method = 'GET') =>
    fixture.request(
      method,
      new URL(`http://mock/proxy/todoist/api/v1${path}`),
    ) as Page & { body: Row & { results: Row[] } };

  return { fixture, get };
};

/** Every row the fixture pages out for a collection, following cursors. */
function paged(
  get: ReturnType<typeof api>['get'],
  collection: 'projects' | 'tasks',
): Row[] {
  const seen: Row[] = [];
  let res = get(`/${collection}?limit=3`);

  for (;;) {
    expect(res.status).toBe(200);
    seen.push(...res.body.results);
    if (!res.body.next_cursor) break;
    res = get(`/${collection}?cursor=${res.body.next_cursor}`);
  }

  return seen;
}

describe('todoist fixture: always-on checks', () => {
  it('has the catalog document recorded from the real proxy', () => {
    const document = readFileSync(scenario.documentFile, 'utf8');
    expect(document).toMatch(/- url: https:\/\/api\.todoist\.com\/api\/v1\n/);
    expect(document).toMatch(/^ {2}\/tasks:$/m);
    expect(document).toMatch(/^ {2}\/projects:$/m);
    // Read-only, like the real catalog: no write operations are declared.
    expect(document).not.toMatch(/^ {4}(post|put|patch|delete):$/m);
  });

  it('is registered with the mock proxy, with its drivers', () => {
    expect(fixtures.todoist).toBe(scenario);
    expect(scenario.drivers).toEqual([
      'completeTask',
      'reopenTask',
      'deleteTask',
      'removeTask',
      'failNext',
      'snapshot',
    ]);
  });

  it('redacts every string it does not know to be safe, consistently', () => {
    const redact = redactor();
    const project: Row = redact.row('project', {
      id: '2200',
      name: 'Taxes',
      description: 'private',
      creator_uid: '999',
      color: 'red',
      is_favorite: true,
    });
    const task: Row = redact.row('task', {
      id: '6X1',
      project_id: '2200',
      parent_id: null,
      user_id: '999',
      content: 'Call my doctor',
      description: '',
      labels: ['health'],
      checked: false,
      priority: 4,
      due: { date: '2026-09-20', string: 'every friday', is_recurring: true },
      url: 'https://app.todoist.com/app/task/6X1',
      new_field: 'leak',
    });
    const text = JSON.stringify([project, task]);

    for (const secret of [
      '2200',
      'Taxes',
      'private',
      '999',
      '6X1',
      'doctor',
      'health',
      'friday',
      'leak',
    ])
      expect(text).not.toContain(secret);
    expect(task.project_id).toBe(project.id);
    expect(task.user_id).toBe(project.creator_uid);
    expect(task).toMatchObject({
      checked: false,
      priority: 4,
      description: '',
      due: { date: '2026-09-20', is_recurring: true },
    });
    expect(project.color).toBe('red');
    expect(redact.unknown()).toEqual(['task.new_field']);
  });

  it('redacts a completed task and a 404 body the same way (--completed-task)', () => {
    const redact = redactor();
    const done: Row = redact.row('task', {
      id: '6X2',
      project_id: '2200',
      content: 'Pay the dentist',
      checked: true,
      completed_at: '2026-09-21T10:00:00.000000Z',
      is_deleted: false,
    });
    expect(done).toMatchObject({
      checked: true,
      completed_at: '2026-09-21T10:00:00.000000Z',
      is_deleted: false,
    });
    expect(JSON.stringify(done)).not.toContain('dentist');
    // A 404 body is scrubbed whole: every string goes, and none of its
    // fields is reported as a task field to add to KEEP.
    const missing = scrub({
      error: 'Task not found: 6X2',
      error_code: 404,
      http_code: 404,
      details: ['6X2', { task: '6X2', retry: false }],
    });
    expect(missing).toEqual({
      error: 'redacted',
      error_code: 404,
      http_code: 404,
      details: ['redacted', { task: 'redacted', retry: false }],
    });
    expect(redact.unknown()).toEqual([]);
  });

  it('reads a repeatable option without taking the next flag as its value', () => {
    expect(
      args('completed-task', [
        'node',
        'record.mjs',
        '--completed-task',
        '--limit',
        '3',
        '--completed-task',
        'abc',
        '--completed-task',
      ]),
    ).toEqual(['abc']);
    expect(args('completed-task', ['node', 'record.mjs'])).toEqual([]);
  });

  it('takes --limit and --max-pages only as integers of at least 1', () => {
    expect(positiveInteger('limit', '3')).toBe(3);
    expect(positiveInteger('max-pages', '200')).toBe(200);
    for (const bad of ['0', '-1', '1.5', '2e1', 'abc', '', ' 3', '0x10'])
      expect(() => positiveInteger('limit', bad), bad).toThrow(
        `--limit must be an integer of at least 1, not ${bad}`,
      );
  });

  it('refuses the --name=value form', () => {
    expect(() =>
      checkArgv([
        'node',
        'record.mjs',
        '--limit',
        '5',
        '--completed-task',
        'a',
      ]),
    ).not.toThrow();
    expect(() => checkArgv(['node', 'record.mjs', '--limit=5'])).toThrow(
      'write --limit 5 instead of --limit=5',
    );
  });

  it('counts a repeatable option given without a value, so the recorder can warn', () => {
    const argv = ['node', 'record.mjs', '--completed-task', 'abc'];
    expect(valueless('completed-task', argv)).toBe(0);
    // Trailing, and followed by another option.
    expect(valueless('completed-task', [...argv, '--completed-task'])).toBe(1);
    expect(
      valueless('completed-task', [
        'node',
        'record.mjs',
        '--completed-task',
        '--limit',
        '3',
        '--completed-task',
      ]),
    ).toBe(2);
  });

  it('reads a single option without taking the next flag as its value', () => {
    const argv = ['node', 'record.mjs', '--limit', '5', '--proxy', 'x'];
    expect(arg('limit', '3', argv)).toBe('5');
    expect(arg('proxy', 'default', argv)).toBe('x');
    expect(arg('max-pages', '3', argv)).toBe('3');
    expect(() =>
      arg('limit', '3', ['node', 'record.mjs', '--limit', '--proxy', 'x']),
    ).toThrow('--limit needs a value');
    expect(() => arg('limit', '3', ['node', 'record.mjs', '--limit'])).toThrow(
      '--limit needs a value',
    );
  });
});

/**
 * An invented api/ in the recording's layout, so the recorded code path is
 * proven here without a recording: two pages of two tasks, one project, and
 * one `tasks__completed-1.json` with the given answer. Nothing in it is
 * from a real account.
 */
type Answer = { status: number; body: Record<string, JSONValue> };
const invented: string[] = [];
afterAll(() => {
  for (const dir of invented) rmSync(dir, { recursive: true, force: true });
});

function inventedRecording(completed: Answer, more: Answer[] = []): URL {
  const dir = mkdtempSync(join(tmpdir(), 'todoist-fixture-'));
  invented.push(dir);
  const task = (n: number): Row => ({
    id: `task-${n}`,
    project_id: 'project-1',
    content: `Redacted task ${n}`,
    description: '',
    checked: false,
    is_deleted: false,
    priority: 1,
    due: null,
    labels: [],
    url: `https://app.todoist.com/app/task/task-${n}`,
  });
  const page = (results: Row[], next: string | null) => ({
    status: 200,
    headers: {},
    body: { results, next_cursor: next },
  });
  const files: Record<string, unknown> = {
    'meta.json': { recorded_at: '2026-10-08', limit: 2 },
    'GET__api__v1__projects__page-1.json': page(
      [{ id: 'project-1', name: 'Inbox', inbox_project: true }],
      null,
    ),
    'GET__api__v1__tasks__page-1.json': page([task(1), task(2)], 'page-2'),
    'GET__api__v1__tasks__page-2.json': page([task(3), task(4)], null),
    'GET__api__v1__tasks__completed-1.json': { ...completed, headers: {} },
  };
  for (const [i, answer] of more.entries())
    files[`GET__api__v1__tasks__completed-${i + 2}.json`] = {
      ...answer,
      headers: {},
    };
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(dir, name), JSON.stringify(content));

  return pathToFileURL(`${dir}/`);
}

describe('todoist fixture: a recording settles what a completed task answers (#46)', () => {
  const get = (fixture: ReturnType<typeof todoistFixture>, path: string) =>
    fixture.request('GET', new URL(`http://mock/proxy/todoist/api/v1${path}`));

  it('assumes checked: true until something is recorded', () => {
    const rows = source();
    if (!isRecorded)
      expect(rows.completed).toEqual({
        recorded: false,
        status: 200,
        checked: true,
      });
    const fixture = todoistFixture();
    const id = rows.tasks[0].id as string;
    fixture.completeTask(id);
    if (rows.completed.status !== 404)
      expect(get(fixture, `/tasks/${id}`)).toMatchObject({
        status: 200,
        body: { id, checked: true },
      });
  });

  it('answers 404 by id for a completed task when the recording did', () => {
    const apiDir = inventedRecording({
      status: 404,
      body: { error: 'redacted', http_code: 404 },
    });
    expect(recorded(apiDir)).toBe(true);
    expect(loadCompleted(apiDir)).toEqual([
      { status: 404, checked: undefined },
    ]);
    const rows = source({ apiDir });
    expect(rows.synthetic).toBe(false);
    expect(rows.pageSize).toBe(2);
    expect(rows.tasks.map((t: Row) => t.id)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
    ]);
    expect(rows.completed).toEqual({
      recorded: true,
      status: 404,
      checked: undefined,
    });

    const fixture = todoistFixture({ apiDir });
    expect(fixture.completed.status).toBe(404);
    expect(get(fixture, '/tasks/task-1').status).toBe(200);
    fixture.completeTask('task-1');
    expect(paged(path => get(fixture, path) as never, 'tasks')).toHaveLength(3);
    expect(get(fixture, '/tasks/task-1').status).toBe(404);
    // Deleted and removed tasks are unchanged by the recording's answer.
    fixture.deleteTask('task-2');
    expect(get(fixture, '/tasks/task-2')).toMatchObject({
      status: 200,
      body: { is_deleted: true },
    });
    // Reopened, the task is reachable again.
    fixture.reopenTask('task-1');
    expect(get(fixture, '/tasks/task-1')).toMatchObject({
      status: 200,
      body: { checked: false },
    });
    expect(fixture.snapshot().tasks.map((t: Row) => t.id)).toHaveLength(4);
  });

  it('takes several recorded answers only when they agree', () => {
    const notFound = { status: 404, body: { error: 'redacted' } };
    const checked = {
      status: 200,
      body: { id: 'task-9', content: 'Redacted task 9', checked: true },
    };
    // Two 404s, or two checked rows, agree.
    expect(
      source({ apiDir: inventedRecording(notFound, [notFound]) }).completed,
    ).toMatchObject({ recorded: true, status: 404 });
    expect(
      source({ apiDir: inventedRecording(checked, [checked]) }).completed,
    ).toMatchObject({ recorded: true, status: 200, checked: true });
    // A 404 beside a checked row, or a checked row beside an unchecked one,
    // is refused rather than settled by whichever came first.
    expect(() =>
      source({ apiDir: inventedRecording(notFound, [checked]) }),
    ).toThrow(/completed-task answers disagree \(404, 200 checked: true\)/);
    expect(() =>
      todoistFixture({
        apiDir: inventedRecording(checked, [
          { status: 200, body: { ...checked.body, checked: false } },
        ]),
      }),
    ).toThrow(/disagree \(200 checked: true, 200 checked: false\)/);
    expect(completedAnswer([])).toBeUndefined();
  });

  it('answers the checked row by id when the recording did', () => {
    const apiDir = inventedRecording({
      status: 200,
      body: {
        id: 'task-9',
        project_id: 'project-1',
        content: 'Redacted task 9',
        checked: true,
        completed_at: '2026-10-01T12:00:00.000000Z',
      },
    });
    expect(source({ apiDir }).completed).toEqual({
      recorded: true,
      status: 200,
      checked: true,
    });
    const fixture = todoistFixture({ apiDir });
    fixture.completeTask('task-3');
    expect(get(fixture, '/tasks/task-3')).toMatchObject({
      status: 200,
      body: { id: 'task-3', checked: true },
    });
  });
});

describe(`todoist fixture: the ${isRecorded ? 'recorded' : 'synthetic'} source`, () => {
  const rows = source();

  it('has every field todoist.ts reads, with the type it expects', () => {
    expect(rows.tasks.length).toBeGreaterThan(0);

    for (const task of rows.tasks as Row[]) {
      expect(typeof task.id).toBe('string');
      expect(typeof task.content).toBe('string');
      expect(String(task.content).trim()).not.toBe('');
      expect(typeof task.checked).toBe('boolean');
      expect(typeof task.description).toBe('string');
      expect([1, 2, 3, 4]).toContain(task.priority);

      if (task.due !== null) {
        const due = task.due as Record<string, JSONValue>;
        expect(typeof due).toBe('object');
        expect(due.date ?? due.datetime).toMatch(DAY);
      }
    }

    expect(rows.tasks.some((t: Row) => t.due !== null)).toBe(true);
    expect(rows.tasks.some((t: Row) => t.due === null)).toBe(true);
  });

  it('keeps project references intact', () => {
    const projectIds = new Set(rows.projects.map((p: Row) => p.id));
    for (const t of rows.tasks as Row[])
      expect(projectIds).toContain(t.project_id);
  });

  it('projects through todoistProjection', () => {
    const term = (
      shortname: string,
      kind: 'class' | 'property',
      datatype = Datatype.STRING,
    ) => ({
      path: shortname,
      kind,
      shortname,
      description: '',
      datatype,
      requires: [],
      recommends: [],
    });
    const record = (resource: string, row: Row): FetchedRecord => ({
      resource,
      namespace: 'todoist',
      id: String(row.id),
      name: String(row.id),
      values: row,
    });
    const fetched: FetchedPlatform = {
      platform: 'todoist',
      ontology: {
        description: '',
        terms: [term('task', 'class'), term('project', 'class')],
      },
      records: [
        ...(rows.tasks as Row[]).map(r => record('task', r)),
        ...(rows.projects as Row[]).map(r => record('project', r)),
      ],
    };
    const projected = todoistProjection(fetched).records.filter(
      r => r.resource === 'task',
    );

    for (const task of projected) {
      expect(task.name).toBe(task.values.content);
      expect(task.values[fields.done]).toBe(task.values.checked);
      expect(typeof task.values[fields.priorityLabel]).toBe('string');
      if (task.values.due !== null)
        expect(task.values[fields.dueDay]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('replays pages by cursor, reads by id, and refuses writes', () => {
    const { fixture, get } = api();

    for (const collection of ['projects', 'tasks'] as const)
      expect(paged(get, collection)).toEqual(rows[collection]);

    // At least one collection spans two pages, so cursor paging is exercised.
    const pages = fixture.pages as Record<string, Page[]>;
    expect(pages.projects.length + pages.tasks.length).toBeGreaterThan(2);
    expect(get('/tasks?cursor=page-99').status).toBe(400);

    const task = rows.tasks[0] as Row;
    expect(get(`/tasks/${task.id}`).body).toEqual(task);
    expect(get('/tasks/no-such-task').status).toBe(404);
    expect(get('/tasks', 'POST').status).toBe(403);
    expect(get('/access_tokens').status).toBe(404);
  });

  it('shows the app what someone did in Todoist, and only by id once gone', () => {
    const { fixture, get } = api();
    const [first, second, third] = rows.tasks as Row[];
    const ids = () => paged(get, 'tasks').map(t => t.id);

    fixture.completeTask(first.id as string);
    expect(ids()).not.toContain(first.id);
    expect(get(`/tasks/${first.id}`).body).toMatchObject({
      id: first.id,
      checked: true,
    });

    fixture.deleteTask(second.id as string);
    expect(ids()).not.toContain(second.id);
    expect(get(`/tasks/${second.id}`).body).toMatchObject({
      is_deleted: true,
    });

    fixture.removeTask(third.id as string);
    expect(ids()).not.toContain(third.id);
    expect(get(`/tasks/${third.id}`).status).toBe(404);

    fixture.reopenTask(first.id as string);
    expect(ids()).toContain(first.id);
    expect(get(`/tasks/${first.id}`).body).toMatchObject({ checked: false });

    expect(fixture.snapshot()).toMatchObject({ unreachable: [third.id] });

    // Failures: the next matching request only.
    fixture.failNext(1, 503, 'lookup');
    expect(get('/tasks').status).toBe(200);
    expect(get(`/tasks/${first.id}`).status).toBe(503);
    expect(get(`/tasks/${first.id}`).status).toBe(200);
    fixture.failNext(1, 401);
    expect(get('/projects').status).toBe(401);
    expect(get('/projects').status).toBe(200);
    expect(() => fixture.failNext(1, 503, 'sometimes')).toThrow();
  });
});

describe.skipIf(isRecorded)('todoist fixture: synthetic only', () => {
  it('says it is synthetic, in its flag and its ids', () => {
    expect(SYNTHETIC).toBe(true);
    const rows = source();
    expect(rows.synthetic).toBe(true);
    for (const t of rows.tasks as Row[]) expect(t.id).toMatch(/^synthetic-/);
    for (const p of rows.projects as Row[]) expect(p.id).toMatch(/^synthetic-/);
    // Five tasks at three per page: two pages.
    expect(rows.tasks).toHaveLength(5);
    expect(rows.pageSize).toBe(3);
  });
});

describe.skipIf(!isRecorded)('todoist fixture: recorded only', () => {
  it('keeps ids redacted', () => {
    const rows = source();
    for (const p of rows.projects as Row[])
      expect(p.id).toMatch(/^project-\d+$/);
    for (const t of rows.tasks as Row[]) expect(t.id).toMatch(/^task-\d+$/);
  });

  it('recorded a completed task by id as either 404 or a checked row (#46)', () => {
    // record.mjs warns when --completed-task was not given; this test then
    // fails on purpose, so the question stays visible until it is recorded.
    const answers = loadCompleted();
    expect(answers.length).toBeGreaterThan(0);
    // Every recorded task answered the same way; source() refuses otherwise.
    expect(() => completedAnswer(answers)).not.toThrow();
    for (const answer of answers)
      expect(
        answer.status === 404 ||
          (answer.status === 200 && answer.checked === true),
        `GET /tasks/{id} for a completed task answered ${answer.status} with checked: ${answer.checked}; see fixtures/todoist/api/`,
      ).toBe(true);
  });
});
