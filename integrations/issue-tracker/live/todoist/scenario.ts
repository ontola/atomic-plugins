// @wc-ignore-file
/**
 * The Todoist live check (integrations/LIVE_TESTING.md, "The live-check
 * kit"): the read-only Todoist drive app's own controller and sync code, run
 * from Node against one real, disposable Todoist project through a relay
 * stand-in. The app only reads, so the kit's driver does the seeding, the
 * remote edits and the cleanup, under the same guard rails as the apps that
 * write.
 *
 * The app imports every active task of the account (`GET /api/v1/tasks`
 * takes no project filter), so the run refuses unless the whole account has
 * no active task: use a dedicated test account. The project named by
 * `--i-understand-this-writes-to <project id>` is where the driver creates
 * its tasks; its name must look disposable. `allow` lets the app `GET` the
 * project and task lists and, by id, tasks this run created; the driver may
 * create tasks and edit, close, reopen and delete only the ones it created.
 *
 * It settles #46's open question as an observation, not an assertion: what
 * `GET /api/v1/tasks/{id}` answers for a completed task (`checked: true` or
 * 404), and what the app makes of it. The assertion is only that the app's
 * presence agrees with the answer.
 */
import {
  createController,
  type ViewState,
} from '../../todoist-app/controller.js';
import { APP, fakeStore } from '../../todoist-app/fakeStore.js';
import type { HostProxy } from '../../todoist-app/store.js';
import {
  GuardError,
  createBudget,
  createLogger,
  createProvider,
  createRecorder,
  createRedactor,
  defaultEvidenceDir,
  describeCandidate,
  relayStandIn,
  requireDisposableName,
  writeEvidence,
  type EvidenceDocument,
  type Provider,
} from '../../../tooling/live-kit.mjs';

export const TODOIST = 'https://api.todoist.com';
const API = '/api/v1';

export interface TodoistCheckOptions {
  project: string;
  token: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

export function allowFor(
  project: string,
  isCreated: (taskId: string) => boolean,
) {
  return ({
    who,
    method,
    pathname,
  }: {
    who: string;
    method: string;
    pathname: string;
  }) => {
    const refuse = (why: string): never => {
      throw new GuardError(`Refusing ${who} ${method} ${pathname}: ${why}`);
    };

    const scope = 'not in this check’s scope.';

    if (!pathname.startsWith(`${API}/`))
      return refuse(`a Todoist path must start with ${API}/.`);
    const path = pathname.slice(API.length);

    if (method === 'GET' && (path === '/projects' || path === '/tasks')) return;

    const oneProject = path.match(/^\/projects\/([^/]+)$/);

    if (oneProject) {
      if (decodeURIComponent(oneProject[1]!) !== project)
        return refuse(
          'this run may only touch the project named by --i-understand-this-writes-to.',
        );

      return method === 'GET' && who === 'driver' ? undefined : refuse(scope);
    }

    if (who === 'driver' && method === 'POST' && path === '/tasks') return;

    const task = path.match(/^\/tasks\/([^/]+)(\/close|\/reopen)?$/);
    if (!task) return refuse(scope);
    if (!isCreated(decodeURIComponent(task[1]!)))
      return refuse('that task was not created by this run.');
    if (method === 'GET' && !task[2]) return;
    if (who === 'app')
      return refuse('the app only reads; it never writes to Todoist.');
    if (method === 'POST' || (method === 'DELETE' && !task[2])) return;

    return refuse(scope);
  };
}

export const NOT_COVERED = [
  'Recurring tasks, sub-tasks, sections, labels, deadlines, durations, assignees and comments (the app reads content, description, priority, a due day, the project and the checked flag).',
  'More than one page of tasks (200 per page): the cursor path is exercised only by the offline fake, never against Todoist.',
  'A task deleted in Todoist: `GET /tasks/{id}` for it is not driven here (the run deletes only in cleanup); the app’s "deleted" and "unavailable" presences are covered offline only.',
  'A lost response, a revoked token (401/403) and rate limits (429).',
  'Archived and shared projects, and the Inbox: the app lists every project to name each task’s project, but the run seeds one project.',
  'The consent bar, Todoist’s OAuth and the integration proxy: this run uses a personal API token and a relay stand-in.',
  'The host, the frame and the table: the controller ran against an in-memory store.',
];

interface Task {
  id: string;
  project_id?: string;
  checked?: boolean;
  is_deleted?: boolean;
}

export async function runTodoistCheck(options: TodoistCheckOptions): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { project, token } = options;
  const redact = createRedactor(
    { TODOIST_API_TOKEN: token },
    { keep: [project] },
  );
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined
      ? {}
      : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  const tasks = new Set<string>();
  const provider: Provider = createProvider({
    baseUrl: TODOIST,
    authHeaders: () => ({
      authorization: `Bearer ${token}`,
      'user-agent': 'atomic-plugins-live-check',
    }),
    allow: allowFor(project, id => tasks.has(id)),
    budget,
    redact,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const target: { kind: string; id: string; name?: string } = {
    kind: 'project',
    id: project,
  };
  const recorder = createRecorder({
    app: 'todoist',
    provider: 'Todoist',
    apiVersion: 'Todoist API v1',
    candidate: describeCandidate('todoist', {
      packageFile: 'integrations/issue-tracker/todoist-app/package.json',
      folder: 'integrations/issue-tracker',
    }),
    target,
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const prefix = recorder.prefix;

  const driver = {
    get: (path: string, query?: Record<string, string>) =>
      provider.request({
        who: 'driver',
        path: `${API}${path}`,
        ...(query ? { query } : {}),
      }),
    send: (method: string, path: string, body?: unknown) =>
      provider.request({
        who: 'driver',
        method,
        path: `${API}${path}`,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
  };

  const store = fakeStore({ relay: false });
  (store as { proxy?: HostProxy }).proxy = relayStandIn(
    provider,
    'todoist',
  ) as unknown as HostProxy;
  const controller = createController(store, () => {});
  const appRequests = () => provider.requests.filter(r => r.who === 'app');
  const rowWrites = () => store.writes.filter(w => w.subject !== APP).length;

  const synced = (state: ViewState = controller.state()) => {
    if (state.kind !== 'synced')
      throw new Error(
        `Expected a synced view, got ${state.kind}${'message' in state ? `: ${state.message}` : ''}`,
      );

    return state;
  };

  const taskRows = () => {
    const state = controller.state();

    return 'tasks' in state ? state.tasks : [];
  };

  const rowOf = (id: string) => taskRows().find(t => t.taskId === id);

  const N: Record<string, string> = {};

  const seed = async (key: string, input: Record<string, unknown>) => {
    const r = await driver.send('POST', '/tasks', {
      project_id: project,
      ...input,
    });
    if (r.status >= 300)
      throw new Error(`POST task ${key} answered ${r.status}`);
    const made = r.body as Task;
    // Receipt first: cleanup removes it even when the next check fails.
    tasks.add(String(made.id));
    N[key] = String(made.id);
    if (made.project_id !== project)
      throw new GuardError(
        'Todoist created a task outside the named project; it is in the cleanup list.',
      );
  };

  await recorder.step(
    'S0',
    'Preflight: the project is disposable and the account has no active task',
    async ({ check, equal, note, observe }) => {
      const found = await driver.get(
        `/projects/${encodeURIComponent(project)}`,
      );
      if (found.status !== 200)
        throw new GuardError(
          `The project is not reachable with this token (GET answered ${found.status}).`,
        );
      const info = found.body as {
        id: string;
        name: string;
        inbox_project?: boolean;
        is_archived?: boolean;
      };
      target.name = info.name;
      check('the token works and it is the named project', info.id === project);
      requireDisposableName('project', info.name);
      check('its name looks disposable', true);
      check(
        'it is not the Inbox and not archived',
        info.inbox_project !== true && info.is_archived !== true,
      );
      const projects = await driver.get('/projects');
      observe(
        'how many projects the token reaches (the app lists them all)',
        (projects.body as { results?: unknown[] })?.results?.length,
      );
      const active = await driver.get('/tasks');
      if (active.status !== 200)
        throw new Error(`GET /tasks answered ${active.status}`);
      const existing = (active.body as { results: Task[] }).results;
      equal(
        'the account has no active task (the app imports every one)',
        existing.length,
        0,
      );
      if (existing.length)
        throw new GuardError(
          'The account has active tasks, and the app would import them all. Use a dedicated, empty test account.',
        );
      note(`Run prefix ${prefix}.`);
    },
  );

  if (!options.preflightOnly) {
    await recorder.step(
      'S1',
      'Seed three tasks in the project through the Todoist API',
      async ({ equal }) => {
        await seed('one', {
          content: `${prefix} one`,
          description: 'Invented description',
          priority: 4,
          due_date: '2027-01-15',
        });
        await seed('two', { content: `${prefix} two`, priority: 1 });
        await seed('three', { content: `${prefix} three`, priority: 2 });
        equal('three tasks seeded', Object.keys(N).sort(), [
          'one',
          'three',
          'two',
        ]);
      },
    );

    await recorder.step(
      'S2',
      'Import: connect, read the project list and the active tasks',
      async ({ check, equal, observe }) => {
        const { syncing } = await controller.load();
        await syncing;
        const state = synced();
        equal(
          'three tasks added, all active, the read was complete, no lookup',
          [
            state.summary.total,
            state.summary.added,
            state.summary.presence.active,
            state.summary.complete,
            state.summary.checked,
          ],
          [3, 3, 3, true, 0],
        );
        const one = rowOf(N.one);
        equal(
          'task one: text, due day, project, not done, active',
          [one?.name, one?.dueDay, one?.project, one?.done, one?.presence],
          [`${prefix} one`, '2027-01-15', target.name, false, 'active'],
        );
        check(
          'priority labels differ between the urgent and the normal task',
          Boolean(one?.priority) && one?.priority !== rowOf(N.two)?.priority,
          [one?.priority, rowOf(N.two)?.priority],
        );
        const asked = appRequests();
        equal(
          'the app only sent GETs under /api/v1, all answered 200',
          [
            asked.length > 0,
            asked.every(r => r.method === 'GET'),
            asked.every(r => r.path.startsWith(`${API}/`) && r.status === 200),
          ],
          [true, true, true],
        );
        observe('the app’s priority labels for priority 4, 1 and 2', [
          one?.priority,
          rowOf(N.two)?.priority,
          rowOf(N.three)?.priority,
        ]);
      },
    );

    await recorder.step(
      'S3',
      'A second sync writes nothing',
      async ({ equal }) => {
        const before = rowWrites();
        await controller.sync();
        const state = synced();
        equal(
          'added, updated, unchanged',
          [state.summary.added, state.summary.updated, state.summary.unchanged],
          [0, 0, 3],
        );
        equal('no row was written', rowWrites(), before);
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S4',
      'A Todoist-side edit is pulled in',
      async ({ equal }) => {
        const r = await driver.send('POST', `/tasks/${N.two}`, {
          content: `${prefix} two (changed in Todoist)`,
          priority: 3,
        });
        if (r.status >= 300) throw new Error(`update answered ${r.status}`);
        await controller.sync();
        const state = synced();
        equal(
          'one task updated, two unchanged',
          [state.summary.added, state.summary.updated, state.summary.unchanged],
          [0, 1, 2],
        );
        equal(
          "the row has Todoist's text",
          rowOf(N.two)?.name,
          `${prefix} two (changed in Todoist)`,
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S5',
      'A task completed in Todoist: what GET /tasks/{id} answers (#46), and what the app does with it',
      async ({ check, equal, observe }) => {
        const r = await driver.send('POST', `/tasks/${N.three}/close`);
        if (r.status >= 300) throw new Error(`close answered ${r.status}`);
        const direct = await driver.get(`/tasks/${N.three}`);
        const body = direct.body as { checked?: boolean; is_deleted?: boolean };
        // The answer to #46, recorded as seen.
        observe('GET /tasks/{id} after the task was completed', {
          status: direct.status,
          checked: body?.checked,
          is_deleted: body?.is_deleted,
        });
        const lookups = appRequests().length;
        await controller.sync();
        const state = synced();
        const row = rowOf(N.three);
        const lookup = appRequests()
          .slice(lookups)
          .find(q => new RegExp(`/tasks/${N.three}$`).test(q.path));
        equal(
          'the app looked the missing task up by id, once, with a GET',
          [lookup?.method, state.summary.checked],
          ['GET', 1],
        );
        observe('the lookup the app made, and what it made of it', {
          lookupStatus: lookup?.status,
          presence: row?.presence,
          done: row?.done,
          summary: state.summary.presence,
        });
        check('the row is kept, not removed', row !== undefined);
        check(
          'the row is no longer shown as active',
          row?.presence !== 'active',
          row?.presence,
        );
        const expected =
          direct.status === 404
            ? 'unavailable'
            : direct.status === 200 && body?.checked === true
              ? 'completed'
              : undefined;
        if (expected)
          equal(
            'the presence agrees with the answer (404: unavailable; checked: completed, done)',
            [row?.presence, row?.done],
            [expected, expected === 'completed'],
          );
        else
          check(
            'the answer was neither 404 nor checked: true; see the observation',
            false,
            { status: direct.status, checked: body?.checked },
          );
        equal(
          'the other two rows are unchanged and nothing was sent to Todoist',
          [
            rowOf(N.one)?.presence,
            rowOf(N.two)?.presence,
            appRequests().every(q => q.method === 'GET'),
          ],
          ['active', 'active', true],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S6',
      'The task is reopened in Todoist: it is active again',
      async ({ equal }) => {
        const r = await driver.send('POST', `/tasks/${N.three}/reopen`);
        if (r.status >= 300) throw new Error(`reopen answered ${r.status}`);
        await controller.sync();
        const state = synced();
        equal(
          'active again, one reappeared',
          [
            rowOf(N.three)?.presence,
            rowOf(N.three)?.done,
            state.summary.reappeared,
          ],
          ['active', false, 1],
        );
      },
      { continueOnFailure: true },
    );
  }

  // Cleanup: delete the tasks this run created.
  const created = [...tasks].map(id => `task:${id}`);
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created,
    deleted: [] as string[],
    leftover: [] as string[],
    note: undefined as string | undefined,
  };
  if (created.length) {
    budget.extendForCleanup(created.length);

    for (const id of tasks) {
      const key = `task:${id}`;

      try {
        const r = await driver.send('DELETE', `/tasks/${id}`);
        (r.status < 300 || r.status === 404
          ? (cleanup.deleted as string[])
          : (cleanup.leftover as string[])
        ).push(key);
      } catch (error) {
        (cleanup.leftover as string[]).push(key);
        cleanup.note = redact(
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if ((cleanup.leftover as string[]).length) {
      cleanup.status = 'failed';
      cleanup.note =
        `${cleanup.note ?? ''} Delete these tasks by hand: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    } else cleanup.note = 'Every task the run created was deleted.';
  } else cleanup.note = 'Nothing was created.';

  const doc = recorder.document({
    cleanup,
    notCovered: NOT_COVERED,
    preflightOnly: options.preflightOnly === true,
    requests: provider.requests,
  });
  doc.target = redact.deep({ ...doc.target, ...target });
  const files = writeEvidence(
    doc,
    options.outDir ?? defaultEvidenceDir('todoist'),
    redact,
  );

  return { doc, files };
}
