// @wc-ignore-file
/**
 * The Timesheets live check (integrations/LIVE_TESTING.md, "The live-check
 * kit"): the drive app's own controller, sync and write-back code, run from
 * Node against one real, dedicated Clockify test workspace through a relay
 * stand-in. It covers the mock e2e's scenarios (import, a reviewed edit,
 * a change on both sides, deletes) and the open #123 checks: POST, the
 * copies of a split, and `billable`.
 *
 * Steps stop at the first failed critical step (S0 to S2); later scenario
 * steps run independently, so one unexpected Clockify answer does not hide
 * the others. Cleanup always runs and removes only ids this run created
 * (seeds, and the creation receipts of the app's own POSTs).
 *
 * `allow` refuses any request outside the one workspace, and any app
 * request the proxy's Clockify catalog (`../fixtures/clockify/`) would not
 * forward. The driver may additionally create and delete one tag.
 */
import { createController } from '../app/controller.js';
import { fakeStore } from '../app/fakeStore.js';
import type { HostProxy } from '../app/store.js';
import { clockifyDocument } from '../fixtures/clockify/scenario.mjs';
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
} from '../../tooling/live-kit.mjs';

export const CLOCKIFY_API = 'https://api.clockify.me';
const V1 = '/api/v1';
const MIN = 60_000;
const HOUR = 60 * MIN;

export interface TimesheetsCheckOptions {
  workspaceId: string;
  apiKey: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

/** Whether the proxy catalog declares `method` on `path` (below `/api`). */
function declared(method: string, path: string): boolean {
  const segments = path.split('/');
  const paths = (
    clockifyDocument as { paths: Record<string, Record<string, unknown>> }
  ).paths;

  return Object.entries(paths).some(([template, item]) => {
    const parts = template.split('/');

    return (
      parts.length === segments.length &&
      parts.every(
        (part, i) =>
          (part.startsWith('{') && segments[i] !== '') || part === segments[i],
      ) &&
      typeof item[method.toLowerCase()] === 'object'
    );
  });
}

export function allowFor(workspaceId: string) {
  const ws = `${V1}/workspaces/${workspaceId}`;

  return ({
    who,
    method,
    pathname,
  }: {
    who: string;
    method: string;
    pathname: string;
  }) => {
    if (!pathname.startsWith(`${V1}/`))
      throw new GuardError(`Refusing a request outside ${V1}: ${pathname}`);

    // The app may only do what the proxy's catalog forwards.
    if (who === 'app' && !declared(method, pathname.slice('/api'.length)))
      throw new GuardError(
        `Refusing app ${method} ${pathname}: the proxy catalog does not declare it.`,
      );

    if (pathname === `${V1}/user` || pathname === `${V1}/workspaces`) {
      if (method !== 'GET')
        throw new GuardError(`Refusing ${method} ${pathname}: read only.`);

      return;
    }

    if (pathname !== ws && !pathname.startsWith(`${ws}/`)) {
      const m = pathname.match(/^\/api\/v1\/workspaces\/([^/]+)/);
      throw new GuardError(
        `Refusing ${method} on workspace ${JSON.stringify(m?.[1] ?? pathname)}: this run may only touch the workspace named by --i-understand-this-writes-to.`,
      );
    }

    if (method === 'GET') return;

    const rest = pathname.slice(ws.length);
    const entries = /^\/time-entries(\/[^/]+)?$/.test(rest);
    const tags = /^\/tags(\/[^/]+)?$/.test(rest);
    const one = /^\/(time-entries|tags)\/[^/]+$/.test(rest);
    const permitted =
      who === 'app'
        ? entries &&
          ((!one && method === 'POST') ||
            (one && (method === 'PUT' || method === 'DELETE')))
        : (entries &&
            ((!one && method === 'POST') ||
              (one && (method === 'PUT' || method === 'DELETE')))) ||
          (tags &&
            ((!one && method === 'POST') || (one && method === 'DELETE')));
    if (!permitted)
      throw new GuardError(
        `Refusing ${who} ${method} ${rest}: not in this check's scope.`,
      );
  };
}

export const NOT_COVERED = [
  'Tasks: seeded entries carry a tag but no task, so task carry-over in a split copy is not exercised.',
  'Custom fields and locked entries (the plan or workspace settings needed were not touched).',
  'A lost write response and a running timer: neither can be forced against Clockify.',
  'The consent bar, the integration proxy and its credential handling: this run uses an API key and a relay stand-in.',
  'The host, the frame and the table: the controller ran against an in-memory store.',
  'DST edges and workspaces with forceProjects switched on.',
];

interface RawEntry {
  id: string;
  description?: string;
  billable?: boolean;
  projectId?: string | null;
  tagIds?: string[] | null;
  timeInterval: { start: string; end: string | null };
}

export async function runTimesheetsCheck(
  options: TimesheetsCheckOptions,
): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { workspaceId, apiKey } = options;
  const redact = createRedactor(
    { CLOCKIFY_API_KEY: apiKey },
    { keep: [workspaceId] },
  );
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined
      ? {}
      : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  const provider: Provider = createProvider({
    baseUrl: CLOCKIFY_API,
    authHeaders: () => ({ 'x-api-key': apiKey }),
    allow: allowFor(workspaceId),
    budget,
    redact,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const target: { kind: string; id: string; name?: string } = {
    kind: 'workspace',
    id: workspaceId,
  };
  const recorder = createRecorder({
    app: 'timesheets',
    provider: 'Clockify',
    apiVersion: 'Clockify API v1',
    candidate: describeCandidate('timesheets'),
    target,
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const title = (name: string) => `${recorder.prefix} ${name}`;
  const ws = `${V1}/workspaces/${workspaceId}`;

  const driver = {
    async get(path: string, query?: Record<string, string>) {
      return provider.request({
        who: 'driver',
        path,
        ...(query ? { query } : {}),
      });
    },
    async entry(id: string) {
      return driver.get(`${ws}/time-entries/${id}`);
    },
    async send(method: string, path: string, body?: unknown) {
      return provider.request({
        who: 'driver',
        method,
        path,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    },
    /**
     * Entries of the user whose start is in `[from, to)`, newest first. Clockify
     * reads the list's bounds as wall-clock time in the profile zone (#123), so
     * the request is a day wider each way and the result is filtered here.
     */
    async entries(userId: string, from: number, to: number) {
      const r = await driver.get(`${ws}/user/${userId}/time-entries`, {
        start: new Date(from - 86_400_000)
          .toISOString()
          .replace(/\.\d+Z$/, 'Z'),
        end: new Date(to + 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z'),
        'page-size': '200',
      });
      if (r.status !== 200)
        throw new Error(`time-entries list answered ${r.status}`);

      return (r.body as RawEntry[]).filter(e => {
        const start = Date.parse(e.timeInterval.start);

        return start >= from && start < to;
      });
    },
  };
  /** Entries and tags this run created: the creation receipts. */
  const receipts: Array<{ kind: 'entry' | 'tag'; id: string }> = [];
  const gone = new Set<string>();
  const seededIds: Record<string, string> = {};
  let userId = '';
  let projects: Array<{ id: string; name: string }> = [];
  let tagId = '';

  const standIn = relayStandIn(provider, 'clockify');
  const proxy = {
    ...standIn,
    async request(req: Parameters<typeof standIn.request>[0]) {
      const res = await standIn.request(req);
      const body = res.body as { id?: unknown } | null;
      if (
        req.method === 'POST' &&
        res.status < 300 &&
        typeof body?.id === 'string'
      )
        receipts.push({ kind: 'entry', id: body.id });

      return res;
    },
  };
  const store = fakeStore({
    proxy: proxy.request as unknown as NonNullable<HostProxy['request']>,
    connections: [{ platform: 'clockify', connectionId: 'live-check' }],
  });
  const makeController = () =>
    createController(
      store,
      () => {},
      () => Date.now(),
    );
  let controller = makeController();
  const appWrites = () =>
    provider.requests.filter(r => r.who === 'app' && r.method !== 'GET');

  const sync = async () => {
    const state = await controller.sync();
    if (state.kind !== 'ready' || !state.last?.ok)
      throw new Error(
        `The sync did not finish: ${state.kind}${state.kind === 'ready' && state.last && !state.last.ok ? `: ${state.last.error}` : ''}`,
      );

    return state.last.result;
  };

  const sheetEntry = (id: string) =>
    controller.sheet()?.entries.find(e => e.id === id);
  const ms = (s: string | null | undefined) => (s ? Date.parse(s) : NaN);
  const body = (e: RawEntry, patch: Record<string, unknown>) => ({
    start: e.timeInterval.start,
    end: e.timeInterval.end,
    description: e.description ?? '',
    billable: e.billable === true,
    ...(e.projectId ? { projectId: e.projectId } : {}),
    ...(e.tagIds ? { tagIds: e.tagIds } : {}),
    ...patch,
  });
  const gotEntry = async (id: string) =>
    (await driver.entry(id)).body as RawEntry;

  // Yesterday (UTC), inside the 7-day look-back whatever the profile zone.
  const dayStart = Date.parse(
    `${new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`,
  );
  const at = (h: number) => dayStart + h * HOUR;
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d+Z$/, 'Z');

  await recorder.step(
    'S0',
    'Preflight: the workspace is disposable, has two projects and no recent entries',
    async ({ check, equal, note }) => {
      const user = await driver.get(`${V1}/user`);
      if (user.status !== 200)
        throw new Error(`GET /user answered ${user.status}`);
      userId = (user.body as { id: string }).id;
      check('the credential works (GET /user)', Boolean(userId));
      const list = await driver.get(`${V1}/workspaces`);
      const found = (list.body as Array<{ id: string; name: string }>).find(
        w => w.id === workspaceId,
      );
      if (!found)
        throw new GuardError(
          'The workspace named by --i-understand-this-writes-to is not one this API key can see.',
        );
      target.name = found.name;
      check("the workspace is in the key's workspace list", true);
      requireDisposableName('workspace', found.name);
      check('its name looks disposable', true);
      const all = await driver.get(`${ws}/projects`, {
        'page-size': '200',
        archived: 'false',
      });
      projects = (
        all.body as Array<{ id: string; name: string; archived?: boolean }>
      ).filter(p => p.archived !== true);
      check('it has at least two active projects', projects.length >= 2, {
        count: projects.length,
      });
      if (projects.length < 2)
        throw new GuardError(
          'Create two active projects in the test workspace first.',
        );
      const running = await driver.get(`${ws}/user/${userId}/time-entries`, {
        'in-progress': 'true',
      });
      equal('no timer is running', (running.body as unknown[]).length, 0);
      const recent = await driver.entries(
        userId,
        Date.now() - 30 * 86_400_000,
        Date.now() + 2 * 86_400_000,
      );
      equal('no entries in the last 30 days or the next 2', recent.length, 0);
      if (recent.length || (running.body as unknown[]).length)
        throw new GuardError(
          'The workspace is not empty; use a dedicated, empty test workspace.',
        );
      note(
        `Run prefix ${recorder.prefix}; entries are seeded on ${new Date(dayStart).toISOString().slice(0, 10)} (UTC).`,
      );
    },
  );

  if (!options.preflightOnly) {
    const [P1, P2] = projects.length
      ? [projects[0].id, projects[1].id]
      : ['', ''];

    await recorder.step(
      'S1',
      'Seed a tag and four entries through the Clockify API',
      async ({ check, equal, observe }) => {
        const tag = await driver.send('POST', `${ws}/tags`, {
          name: title('tag'),
        });
        if (tag.status >= 300)
          throw new Error(`POST tags answered ${tag.status}`);
        tagId = (tag.body as { id: string }).id;
        receipts.push({ kind: 'tag', id: tagId });

        const seed = async (
          key: string,
          from: number,
          to: number,
          projectId: string,
          extra: Record<string, unknown>,
        ) => {
          const r = await driver.send('POST', `${ws}/time-entries`, {
            start: iso(from),
            end: iso(to),
            description: title(key),
            projectId,
            ...extra,
          });
          if (r.status >= 300)
            throw new Error(`POST time-entries ${key} answered ${r.status}`);
          const id = (r.body as RawEntry).id;
          receipts.push({ kind: 'entry', id });
          seededIds[key] = id;
          observe(
            `POST ${key}: status and the billable Clockify stored for billable=${String(extra.billable)}`,
            {
              status: r.status,
              billable: (r.body as RawEntry).billable,
            },
          );
        };

        await seed('A', at(8), at(9), P1, { billable: false, tagIds: [tagId] });
        await seed('B', at(10), at(11), P1, { billable: false });
        await seed('C', at(12), at(14), P2, {
          billable: true,
          tagIds: [tagId],
        });
        await seed('D', at(15), at(16), P2, { billable: false });
        equal('four entries seeded', Object.keys(seededIds).sort(), [
          'A',
          'B',
          'C',
          'D',
        ]);
        check(
          'the seeded entries read back with the right intervals',
          (await gotEntry(seededIds.C)).timeInterval.end === iso(at(14)),
        );
      },
    );

    await recorder.step(
      'S2',
      'Import: choose the workspace, read the last 7 days',
      async ({ check, equal }) => {
        await controller.load();
        const state = controller.state();
        if (state.kind !== 'setup')
          throw new Error(`Expected the setup form, got ${state.kind}`);
        check(
          'setup offers the test workspace',
          Boolean(state.options?.workspaces.some(w => w.id === workspaceId)),
        );
        const done = await controller.saveSettings({
          workspaceId,
          lookbackDays: 7,
        });
        if (done.kind !== 'ready' || !done.last?.ok)
          throw new Error(`The first sync did not finish: ${done.kind}`);
        equal(
          'four rows created',
          [done.last.result.created, done.last.result.updated],
          [4, 0],
        );

        for (const key of ['A', 'B', 'C', 'D']) {
          const remote = await gotEntry(seededIds[key]);
          const row = sheetEntry(seededIds[key]);
          equal(
            `${key}: description, interval, project and billable match Clockify's`,
            [
              row?.description,
              row?.start,
              row?.end,
              row?.project?.id,
              row?.billable,
            ],
            [
              remote.description,
              ms(remote.timeInterval.start),
              ms(remote.timeInterval.end),
              remote.projectId,
              remote.billable === true,
            ],
          );
        }

        equal('the app wrote nothing', appWrites().length, 0);
      },
    );

    await recorder.step(
      'S3',
      'A second sync changes nothing',
      async ({ equal }) => {
        const r = await sync();
        equal(
          'unchanged, no review',
          [r.created, r.updated, r.unchanged, r.removed, r.review.length],
          [0, 0, 4, 0, 0],
        );
      },
    );

    await recorder.step(
      'S4',
      'A Clockify-side edit is pulled in',
      async ({ equal }) => {
        const b = await gotEntry(seededIds.B);
        const put = await driver.send(
          'PUT',
          `${ws}/time-entries/${seededIds.B}`,
          body(b, { description: title('B (changed in Clockify)') }),
        );
        if (put.status !== 200) throw new Error(`PUT answered ${put.status}`);
        const r = await sync();
        equal('one row updated', r.updated, 1);
        equal(
          'the row has the new description',
          sheetEntry(seededIds.B)?.description,
          title('B (changed in Clockify)'),
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S5',
      'A reviewed edit is sent: a full-replacement PUT that keeps every other field',
      async ({ check, equal, observe }) => {
        const before = await gotEntry(seededIds.A);
        await controller.editEntry(seededIds.A, { name: title('A (edited)') });
        equal('nothing is sent before review', appWrites().length, 0);
        const [change] = controller.changes().review;
        equal(
          'the review lists one update of the name',
          [change?.kind, change?.fields],
          ['update', ['name']],
        );
        await controller.send();
        const results = controller.changes().outcomes?.results ?? [];
        equal(
          'the outcome is sent',
          results.map(r => r.status),
          ['sent'],
        );
        const put = provider.requests
          .filter(r => r.who === 'app' && r.method === 'PUT')
          .at(-1);
        observe("the app's PUT body keys", put?.bodyKeys);
        const after = await gotEntry(seededIds.A);
        equal(
          'Clockify has the new description',
          after.description,
          title('A (edited)'),
        );
        equal(
          'start, end, project, billable and tags are unchanged',
          [after.timeInterval, after.projectId, after.billable, after.tagIds],
          [
            before.timeInterval,
            before.projectId,
            before.billable,
            before.tagIds,
          ],
        );
        check(
          'the PUT went to the one entry',
          Boolean(put?.path.endsWith(`/time-entries/${seededIds.A}`)),
        );
        equal('the next sync agrees', (await sync()).review.length, 0);
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S6',
      'Billable and project edits are confirmed by Clockify (#123)',
      async ({ check, equal, observe }) => {
        const before = await gotEntry(seededIds.B);
        const flipped = before.billable !== true;
        await controller.editEntry(seededIds.B, {
          billable: flipped,
          projectId: P2,
        });
        await controller.send();
        const [outcome] = controller.changes().outcomes?.results ?? [];
        observe('send outcome', {
          status: outcome?.status,
          message: outcome?.message,
          fields: outcome?.fields,
        });
        const after = await gotEntry(seededIds.B);
        observe('billable before and after', {
          before: before.billable,
          requested: flipped,
          after: after.billable,
        });
        equal('the project moved', after.projectId, P2);
        check(
          'Clockify applied the billable change (outcome sent, not adjusted)',
          outcome?.status === 'sent' && after.billable === flipped,
          {
            status: outcome?.status,
            requested: flipped,
            stored: after.billable,
          },
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S7',
      'Changed on both sides: Clockify wins, nothing is overwritten',
      async ({ check, equal }) => {
        const b = await gotEntry(seededIds.B);
        await controller.editEntry(seededIds.B, { name: title('B (mine)') });
        const put = await driver.send(
          'PUT',
          `${ws}/time-entries/${seededIds.B}`,
          body(b, { description: title('B (theirs)') }),
        );
        if (put.status !== 200) throw new Error(`PUT answered ${put.status}`);
        const writesBefore = appWrites().length;
        const r = await sync();
        check(
          'the sync lists the name as a provider win',
          r.providerWon.some(
            p =>
              p.entryId === seededIds.B &&
              p.fields.some(f => f.field === 'name'),
          ),
          r.providerWon,
        );
        equal(
          "the row shows Clockify's value",
          sheetEntry(seededIds.B)?.description,
          title('B (theirs)'),
        );
        equal(
          'the app wrote nothing to Clockify',
          appWrites().length,
          writesBefore,
        );
        equal(
          'Clockify keeps its own value',
          (await gotEntry(seededIds.B)).description,
          title('B (theirs)'),
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S8',
      'Deletes: one sent from the app, one made in Clockify',
      async ({ check, equal, observe }) => {
        await controller.deleteEntry(seededIds.A);
        equal(
          'the review lists the delete',
          controller.changes().review.map(c => c.kind),
          ['delete'],
        );
        await controller.send();
        equal(
          'the outcome is sent',
          (controller.changes().outcomes?.results ?? []).map(r => r.status),
          ['sent'],
        );
        const a = await driver.entry(seededIds.A);
        check(
          'Clockify no longer has A (a 400 or 404 on GET by id)',
          a.status === 400 || a.status === 404,
          { status: a.status, body: a.body },
        );
        gone.add(seededIds.A);
        let r = await sync();
        equal("A's row is gone", sheetEntry(seededIds.A), undefined);
        const del = await driver.send(
          'DELETE',
          `${ws}/time-entries/${seededIds.D}`,
        );
        check('Clockify deleted D', del.status < 300, { status: del.status });
        gone.add(seededIds.D);
        r = await sync();
        observe(
          'the first sync after a Clockify-side delete: removed, row still shown',
          [r.removed, sheetEntry(seededIds.D) !== undefined],
        );
        // A list read alone never deletes a row: the next sync re-checks the entry by id.
        r = await sync();
        equal(
          'the second sync confirmed the deletion (GET by id) and removed the row',
          [r.removed, sheetEntry(seededIds.D)],
          [1, undefined],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S9',
      'A range edit inside one entry: a PUT trims it, POSTs create the middle and a copy of the rest (#123)',
      async ({ check, equal, observe }) => {
        const c0 = await gotEntry(seededIds.C);
        const from = at(12) + 30 * MIN;
        const to = at(13);
        check(
          'the range edit was accepted',
          await controller.editRange({
            from,
            to,
            target: { kind: 'worked', projectId: P1 },
            exact: true,
          }),
          controller.changes().error,
        );
        equal(
          'the review lists one update and two creates',
          controller
            .changes()
            .review.map(c => c.kind)
            .sort(),
          ['create', 'create', 'update'],
        );
        await controller.send();
        equal(
          'every outcome is sent',
          (controller.changes().outcomes?.results ?? []).map(r => r.status),
          ['sent', 'sent', 'sent'],
        );
        const now = await driver.entries(userId, at(12), at(14));
        const tiles = now
          .map(e => [e.timeInterval.start, e.timeInterval.end, e.projectId])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
        equal('three entries tile the original span', tiles, [
          [iso(at(12)), iso(from), P2],
          [iso(from), iso(to), P1],
          [iso(to), iso(at(14)), P2],
        ]);
        const copy = now.find(e => e.timeInterval.start === iso(to));
        equal(
          'the copy carries the description and the tag',
          [copy?.description, copy?.tagIds],
          [c0.description, [tagId]],
        );
        observe('billable of the original, the middle entry and the copy', {
          original: c0.billable,
          middle: now.find(e => e.projectId === P1)?.billable,
          copy: copy?.billable,
        });
        const r = await sync();
        equal(
          'the next sync shows no review and no conflict',
          [r.review.length, (controller.sheet()?.conflicts ?? []).length],
          [0, 0],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S10',
      'Did not work over exactly one entry deletes it',
      async ({ check, equal }) => {
        // B was edited in S6 and S7 by plain edits, so no range intent holds its row.
        // (A range edit over a row an earlier, sent range edit created is refused
        // as "two range edits disagree" at the mock too; see the report.)
        const accepted = await controller.editRange({
          from: at(10),
          to: at(11),
          target: { kind: 'didNotWork' },
          exact: true,
        });
        check(
          'the range edit was accepted',
          accepted,
          controller.changes().error,
        );
        equal(
          'the review lists one delete',
          controller.changes().review.map(c => c.kind),
          ['delete'],
        );
        await controller.send();
        equal(
          'the outcome is sent',
          (controller.changes().outcomes?.results ?? []).map(r => r.status),
          ['sent'],
        );
        equal(
          'Clockify has no entry starting in that hour',
          (await driver.entries(userId, at(10), at(11))).length,
          0,
        );
        gone.add(seededIds.B);
      },
      { continueOnFailure: true },
    );
  }

  // Cleanup: exactly the ids this run created, entries before the tag.
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created: receipts.map(r => `${r.kind}:${r.id}`),
    deleted: [] as string[],
    leftover: [] as string[],
  };
  if (receipts.length) {
    budget.extendForCleanup(receipts.length);
    const ordered = [
      ...receipts.filter(r => r.kind === 'entry'),
      ...receipts.filter(r => r.kind === 'tag'),
    ];

    for (const r of ordered) {
      const key = `${r.kind}:${r.id}`;
      const path =
        r.kind === 'entry'
          ? `${ws}/time-entries/${r.id}`
          : `${ws}/tags/${r.id}`;

      try {
        const res = await driver.send('DELETE', path);
        if (
          res.status < 300 ||
          res.status === 404 ||
          (r.kind === 'entry' && res.status === 400)
        )
          (cleanup.deleted as string[]).push(key);
        else (cleanup.leftover as string[]).push(key);
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
        `${cleanup.note ?? ''} Delete these by hand in the test workspace: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    }
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
    options.outDir ?? defaultEvidenceDir('timesheets'),
    redact,
  );
  void gone;

  return { doc, files };
}
