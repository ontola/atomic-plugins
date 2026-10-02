// @wc-ignore-file
/**
 * The GitHub issues live check (integrations/LIVE_TESTING.md, "The live-check
 * kit"): the drive app's own controller and sync code, run from Node against
 * one real, disposable GitHub repository through a relay stand-in. It covers
 * the mock e2e's scenarios (import, a reviewed edit sent, a conflict, what
 * GitHub does with a close) and records evidence.
 *
 * GitHub's REST API cannot delete an issue, so the run closes the issues it
 * created (as `not_planned`) and deletes the comments it created; it records
 * their numbers and ids in the evidence. A repository may therefore hold
 * closed issues from earlier runs, which the preflight accepts only when
 * every one is closed and titled `livecheck-...`.
 *
 * `allow` refuses any request outside the one repository, and anything the
 * app's own transport does not use. The repository name is named by
 * `--i-understand-this-writes-to owner/name` and must look disposable.
 */
import {
  createController,
  describeHeld,
  type ViewState,
} from '../app/controller.js';
import { fakeStore } from '../app/fakeStore.js';
import type { HostProxy } from '../app/store.js';
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

export const GITHUB_API = 'https://api.github.com';

export interface GithubCheckOptions {
  repository: string;
  token: string;
  fetcher?: Parameters<typeof createProvider>[0]['fetcher'];
  outDir?: string;
  maxMutations?: number;
  maxMs?: number;
  preflightOnly?: boolean;
  log?: (line: string) => unknown;
  now?: () => Date;
}

export function allowFor(repository: string) {
  const base = `/repos/${repository.toLowerCase()}`;

  return ({
    who,
    method,
    pathname,
  }: {
    who: string;
    method: string;
    pathname: string;
  }) => {
    if (pathname === '/user' || pathname === '/user/repos') {
      if (method !== 'GET' || (pathname === '/user' && who !== 'driver'))
        throw new GuardError(`Refusing ${who} ${method} ${pathname}.`);

      return;
    }

    const lower = pathname.toLowerCase();
    if (!lower.startsWith('/repos/'))
      throw new GuardError(`Refusing a request outside /repos/: ${pathname}`);
    if (lower !== base && !lower.startsWith(`${base}/`))
      throw new GuardError(
        `Refusing ${method} ${pathname.split('/').slice(0, 4).join('/')}: this run may only touch the repository named by --i-understand-this-writes-to.`,
      );
    const rest = lower.slice(base.length);

    if (rest === '') {
      if (method !== 'GET' || who !== 'driver')
        throw new GuardError(
          `Refusing ${who} ${method} on the repository itself.`,
        );

      return;
    }

    if (method === 'GET' && rest.startsWith('/issues')) return;

    const shapes: Array<[string, RegExp]> = [
      ['POST', /^\/issues$/],
      ['POST', /^\/issues\/\d+\/comments$/],
      ['POST', /^\/issues\/\d+\/labels$/],
      ['PATCH', /^\/issues\/\d+$/],
      ['PATCH', /^\/issues\/comments\/\d+$/],
      ['DELETE', /^\/issues\/\d+\/labels\/[^/]+$/],
      // Only the kit removes comments it created (cleanup).
      ...(who === 'driver'
        ? ([['DELETE', /^\/issues\/comments\/\d+$/]] as Array<[string, RegExp]>)
        : []),
    ];
    if (!shapes.some(([m, re]) => m === method && re.test(rest)))
      throw new GuardError(
        `Refusing ${who} ${method} ${rest}: not in this check's scope.`,
      );
  };
}

export const NOT_COVERED = [
  'An issue deleted or transferred away on GitHub (the "missing" state): the REST API cannot delete an issue, so it cannot be driven with a repository-scoped token.',
  'Assignees, milestones, issue types and pull requests (the app imports issues and comments only).',
  'Repositories with more than a handful of issues (paging at 500) and rate limits (403/429).',
  'A lost write response, and an expired or revoked token (401).',
  'The consent bar, the integration proxy and its GitHub App or OAuth credential: this run uses a bearer token and a relay stand-in.',
  'The host, the frame and the table: the controller ran against an in-memory store.',
];

interface Issue {
  number: number;
  title: string;
  body?: string | null;
  state: string;
  labels: Array<{ name: string } | string>;
  pull_request?: unknown;
}

export async function runGithubCheck(options: GithubCheckOptions): Promise<{
  doc: EvidenceDocument;
  files: { json: string; markdown: string };
}> {
  const { repository, token } = options;
  const redact = createRedactor(
    { GITHUB_TOKEN: token },
    { keep: [repository] },
  );
  const log = createLogger(redact, options.log);
  const budget = createBudget({
    ...(options.maxMutations === undefined
      ? {}
      : { maxMutations: options.maxMutations }),
    ...(options.maxMs === undefined ? {} : { maxMs: options.maxMs }),
  });
  const provider: Provider = createProvider({
    baseUrl: GITHUB_API,
    authHeaders: () => ({
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'atomic-plugins-live-check',
    }),
    allow: allowFor(repository),
    budget,
    redact,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
  const target: { kind: string; id: string; name?: string } = {
    kind: 'repository',
    id: repository,
  };
  const recorder = createRecorder({
    app: 'issue-tracker',
    provider: 'GitHub',
    apiVersion: 'GitHub REST API 2022-11-28',
    candidate: describeCandidate('issue-tracker'),
    target,
    redact,
    log,
    limits: budget,
    ...(options.now ? { now: options.now } : {}),
  });
  const prefix = recorder.prefix;
  const repoPath = `/repos/${repository}`;

  const driver = {
    get: (path: string, query?: Record<string, string>) =>
      provider.request({
        who: 'driver',
        path: `${repoPath}${path}`,
        ...(query ? { query } : {}),
      }),
    send: (method: string, path: string, body?: unknown) =>
      provider.request({
        who: 'driver',
        method,
        path: `${repoPath}${path}`,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    async issue(n: number) {
      return (await driver.get(`/issues/${n}`)).body as Issue;
    },
    async comments(n: number) {
      return (await driver.get(`/issues/${n}/comments`, { per_page: '100' }))
        .body as Array<{ id: number; body: string; user?: { login?: string } }>;
    },
  };

  /** Creation receipts: what this run made, for cleanup and the evidence. */
  const issues = new Set<number>();
  const commentIds = new Set<number>();
  const standIn = relayStandIn(provider, 'github-issues');
  const proxy = {
    ...standIn,
    async request(req: Parameters<typeof standIn.request>[0]) {
      const res = await standIn.request(req);
      const body = res.body as { number?: unknown; id?: unknown } | null;

      if (req.method === 'POST' && res.status < 300) {
        if (/\/issues$/.test(req.path) && typeof body?.number === 'number')
          issues.add(body.number);
        if (/\/comments$/.test(req.path) && typeof body?.id === 'number')
          commentIds.add(body.id);
      }

      return res;
    },
  };
  const store = fakeStore({ relay: false });
  (store as { proxy?: HostProxy }).proxy = proxy as unknown as HostProxy;
  const controller = createController(store, () => {});
  const appWrites = () =>
    provider.requests.filter(r => r.who === 'app' && r.method !== 'GET');

  const ready = (state: ViewState) => {
    if (state.kind !== 'ready')
      throw new Error(`Expected a bound view, got ${state.kind}`);

    return state;
  };

  const rows = () => {
    const state = controller.state();

    return state.kind === 'ready' ? (state.last?.result.rows ?? []) : [];
  };

  const rowOf = (n: number) => rows().find(r => r.number === n);

  const held = () => {
    const state = controller.state();

    return state.kind === 'ready' ? (state.last?.result.held ?? []) : [];
  };

  let login = '';
  const N: Record<string, number> = {};

  await recorder.step(
    'S0',
    "Preflight: the repository is disposable and holds no one else's issues",
    async ({ check, equal, note }) => {
      const me = await provider.request({ who: 'driver', path: '/user' });
      if (me.status !== 200) throw new Error(`GET /user answered ${me.status}`);
      login = (me.body as { login: string }).login;
      check('the credential works (GET /user)', Boolean(login));
      const repo = await driver.get('');
      if (repo.status !== 200)
        throw new GuardError(
          `The repository is not reachable with this token (GET answered ${repo.status}).`,
        );
      const info = repo.body as {
        name: string;
        full_name: string;
        has_issues?: boolean;
        archived?: boolean;
        permissions?: { push?: boolean };
      };
      target.name = info.name;
      check(
        'it is the named repository',
        info.full_name.toLowerCase() === repository.toLowerCase(),
        { fullName: info.full_name },
      );
      requireDisposableName('repository', info.name);
      check('its name looks disposable', true);
      check(
        'issues are enabled and it is not archived',
        info.has_issues !== false && info.archived !== true,
      );
      check(
        'the token may write to it (permissions.push)',
        info.permissions?.push !== false,
      );
      const existing = (
        await driver.get('/issues', { state: 'all', per_page: '100' })
      ).body as Issue[];
      const foreign = existing.filter(
        i => !(i.state === 'closed' && /^livecheck-/.test(i.title)),
      );
      equal(
        'it holds no issue or pull request that is not a closed livecheck-... leftover',
        foreign.length,
        0,
      );
      if (foreign.length)
        throw new GuardError(
          'The repository has issues that are not leftovers of this kit; use a new, empty repository.',
        );
      note(
        `Run prefix ${prefix}; ${existing.length} closed leftover issue(s) from earlier runs.`,
      );
    },
  );

  if (!options.preflightOnly) {
    await recorder.step(
      'S1',
      'Seed two issues, labels and a comment through the GitHub API',
      async ({ equal }) => {
        const make = async (
          key: string,
          title: string,
          body: string,
          label: string,
        ) => {
          const r = await driver.send('POST', '/issues', { title, body });
          if (r.status !== 201)
            throw new Error(`POST issue ${key} answered ${r.status}`);
          const n = (r.body as Issue).number;
          issues.add(n);
          N[key] = n;
          const l = await driver.send('POST', `/issues/${n}/labels`, {
            labels: [label],
          });
          if (l.status !== 200)
            throw new Error(`POST labels ${key} answered ${l.status}`);
        };

        await make(
          'one',
          `${prefix} one`,
          'Invented body with **bold** text.',
          'bug',
        );
        await make('two', `${prefix} two`, '', 'atomic:doing');
        const c = await driver.send('POST', `/issues/${N.one}/comments`, {
          body: `${prefix} first comment`,
        });
        if (c.status !== 201)
          throw new Error(`POST comment answered ${c.status}`);
        commentIds.add((c.body as { id: number }).id);
        equal('two issues seeded', Object.keys(N).sort(), ['one', 'two']);
      },
    );

    await recorder.step(
      'S2',
      'Import: connect, choose the repository, read its issues and comments',
      async ({ check, equal, observe }) => {
        await controller.load();
        const state = ready(await controller.choose(repository));
        if (state.problem)
          throw new Error(
            `The first sync stopped: ${state.problem.kind}: ${state.problem.message}`,
          );
        const one = rowOf(N.one);
        const two = rowOf(N.two);
        equal(
          'issue one: title, status, body, labels',
          [one?.title, one?.status, one?.body, one?.labels.map(l => l.name)],
          [
            `${prefix} one`,
            'Todo',
            'Invented body with **bold** text.',
            ['bug'],
          ],
        );
        equal(
          'issue one: its comment',
          one?.comments.map(c => c.body),
          [`${prefix} first comment`],
        );
        check('the comment has an author', Boolean(one?.comments[0]?.author));
        equal(
          'issue two: Doing from the atomic:doing label, which is not a chip',
          [two?.status, two?.labels.length],
          ['Doing', 0],
        );
        equal(
          'both have GitHub URLs',
          [one?.url, two?.url],
          [
            `https://github.com/${repository}/issues/${N.one}`,
            `https://github.com/${repository}/issues/${N.two}`,
          ],
        );
        equal(
          'nothing is held and the app wrote nothing',
          [held().length, appWrites().length],
          [0, 0],
        );
        observe('comment author and the token owner', {
          author: one?.comments[0]?.author,
          login,
        });
      },
    );

    await recorder.step(
      'S3',
      'A second sync changes nothing',
      async ({ equal }) => {
        const state = ready(await controller.sync());
        equal(
          'no problem, nothing held, nothing written',
          [state.problem, held().length, appWrites().length],
          [undefined, 0, 0],
        );
      },
    );

    await recorder.step(
      'S4',
      'A GitHub-side edit is pulled in',
      async ({ equal }) => {
        const r = await driver.send('PATCH', `/issues/${N.two}`, {
          title: `${prefix} two (changed on GitHub)`,
          body: 'Changed on GitHub',
        });
        if (r.status !== 200) throw new Error(`PATCH answered ${r.status}`);
        const state = ready(await controller.sync());
        equal('no problem', state.problem, undefined);
        equal(
          "the row has GitHub's title and body",
          [rowOf(N.two)?.title, rowOf(N.two)?.body],
          [`${prefix} two (changed on GitHub)`, 'Changed on GitHub'],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S5',
      'A reviewed edit is held, then sent: only the title',
      async ({ check, equal, observe }) => {
        const subject = rowOf(N.one)!.subject;
        const state = ready(
          await controller.edit(subject, { title: `${prefix} one (edited)` }),
        );
        equal(
          'the edit is held for review',
          held().map(describeHeld).length,
          1,
        );
        check(
          'the held line names the issue and the new title',
          describeHeld(held()[0]).includes(`#${N.one}`) &&
            describeHeld(held()[0]).includes('(edited)'),
          describeHeld(held()[0]),
        );
        equal(
          'nothing was sent yet',
          [appWrites().length, (await driver.issue(N.one)).title],
          [0, `${prefix} one`],
        );
        void state;
        ready(await controller.send());
        equal(
          'GitHub has the new title',
          (await driver.issue(N.one)).title,
          `${prefix} one (edited)`,
        );
        const patches = appWrites().filter(r => r.method === 'PATCH');
        observe(
          'the PATCH body keys the app sends for a title edit',
          patches.map(p => p.bodyKeys),
        );
        const after = await driver.issue(N.one);
        equal(
          'GitHub still has the same body, state and labels',
          [
            after.body,
            after.state,
            after.labels.map(l => (typeof l === 'string' ? l : l.name)),
          ],
          ['Invented body with **bold** text.', 'open', ['bug']],
        );
        equal('exactly one PATCH', patches.length, 1);
        equal(
          'the next sync holds nothing',
          [ready(await controller.sync()).problem, held().length],
          [undefined, 0],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S6',
      'A status move closes the issue and a comment is added, both after review',
      async ({ check, equal, observe }) => {
        ready(await controller.edit(rowOf(N.two)!.subject, { status: 'Done' }));
        check(
          'the close is held ("close it")',
          held().some(h => describeHeld(h).includes('close it')),
          held().map(describeHeld),
        );
        equal(
          'GitHub still has it open',
          (await driver.issue(N.two)).state,
          'open',
        );
        ready(
          await controller.comment(
            rowOf(N.one)!.subject,
            `${prefix} comment from the app`,
          ),
        );
        check(
          'the comment is held too',
          held().some(h => h.entity !== 'issue'),
          held().map(describeHeld),
        );
        ready(await controller.send());
        const two = await driver.issue(N.two);
        equal('GitHub closed issue two', two.state, 'closed');
        observe(
          'labels on issue two after Done',
          two.labels.map(l => (typeof l === 'string' ? l : l.name)),
        );
        const comments = await driver.comments(N.one);
        equal(
          'GitHub has both comments on issue one',
          comments.map(c => c.body).sort(),
          [`${prefix} comment from the app`, `${prefix} first comment`].sort(),
        );
        for (const c of comments) commentIds.add(c.id);
        equal(
          'the next sync holds nothing',
          [ready(await controller.sync()).problem, held().length],
          [undefined, 0],
        );
        equal('the row shows Done', rowOf(N.two)?.status, 'Done');
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S7',
      'A new issue made in the table is created on GitHub after review',
      async ({ check, equal }) => {
        const made = await controller.create({
          title: `${prefix} three`,
          body: 'Created in the table',
          status: 'Todo',
        });
        check(
          'the create is held',
          held().some(h => h.remoteId === undefined && h.entity === 'issue'),
          held().map(describeHeld),
        );
        equal('nothing is created on GitHub before review', issues.size, 2);
        ready(await controller.send());
        ready(await controller.sync());
        const row = rows().find(r => r.subject === made.subject);
        check(
          'the row is bound to a new issue number',
          typeof row?.number === 'number',
          row?.number,
        );
        N.three = row!.number!;
        issues.add(N.three);
        const at = await driver.issue(N.three);
        equal(
          'GitHub has the issue',
          [at.title, at.body, at.state],
          [`${prefix} three`, 'Created in the table', 'open'],
        );
        equal(
          'the next sync holds nothing and creates no second copy',
          [
            ready(await controller.sync()).problem,
            held().length,
            rows().filter(r => r.title === `${prefix} three`).length,
          ],
          [undefined, 0, 1],
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S8',
      'The same field changed on both sides pauses the sync; both resolutions work',
      async ({ check, equal }) => {
        // Resolve to GitHub's side.
        const one = rowOf(N.one)!;
        await controller.edit(one.subject, { title: `${prefix} one (mine)` });
        await driver.send('PATCH', `/issues/${N.one}`, {
          title: `${prefix} one (theirs)`,
        });
        let state = ready(await controller.sync());
        equal(
          'the sync is paused on the title',
          [
            state.problem?.kind,
            state.problem?.kind === 'conflict'
              ? state.problem.fields
              : undefined,
          ],
          ['conflict', ['title']],
        );
        const writes = appWrites().length;
        equal(
          'the conflict shows base, mine and theirs',
          (await controller.conflict())?.map(f => [f.field, f.local, f.remote]),
          [['title', `${prefix} one (mine)`, `${prefix} one (theirs)`]],
        );
        state = ready(await controller.resolve({ title: 'remote' }));
        equal(
          "resolved to GitHub's value, nothing held",
          [state.problem, held().length, rowOf(N.one)?.title],
          [undefined, 0, `${prefix} one (theirs)`],
        );
        equal('nothing was sent', appWrites().length, writes);

        // Resolve to this side: the kept value is held, then sent.
        const three = rowOf(N.three)!;
        await controller.edit(three.subject, {
          title: `${prefix} three (mine)`,
        });
        await driver.send('PATCH', `/issues/${N.three}`, {
          title: `${prefix} three (theirs)`,
        });
        state = ready(await controller.sync());
        equal('paused again', state.problem?.kind, 'conflict');
        const before = appWrites().length;
        state = ready(await controller.resolve({ title: 'local' }));
        equal(
          'keeping mine only holds the write',
          [state.problem, held().length, appWrites().length],
          [undefined, 1, before],
        );
        ready(await controller.send());
        check(
          'GitHub has the kept value',
          (await driver.issue(N.three)).title === `${prefix} three (mine)`,
        );
      },
      { continueOnFailure: true },
    );

    await recorder.step(
      'S9',
      'An issue closed on GitHub shows as Done',
      async ({ equal }) => {
        await driver.send('PATCH', `/issues/${N.three}`, {
          state: 'closed',
          state_reason: 'not_planned',
        });
        const state = ready(await controller.sync());
        equal(
          'no problem; the row is Done; nothing held',
          [state.problem, rowOf(N.three)?.status, held().length],
          [undefined, 'Done', 0],
        );
      },
      { continueOnFailure: true },
    );
  }

  // Cleanup: close the issues and delete the comments this run created.
  const created = [
    ...[...issues].map(n => `issue:${n}`),
    ...[...commentIds].map(id => `comment:${id}`),
  ];
  const cleanup: EvidenceDocument['cleanup'] = {
    status: 'passed',
    created,
    deleted: [] as string[],
    leftover: [] as string[],
    note: undefined as string | undefined,
  };
  if (created.length) {
    budget.extendForCleanup(created.length);

    for (const id of commentIds) {
      const key = `comment:${id}`;

      try {
        const r = await driver.send('DELETE', `/issues/comments/${id}`);
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

    for (const n of issues) {
      const key = `issue:${n} (closed)`;

      try {
        const r = await driver.send('PATCH', `/issues/${n}`, {
          state: 'closed',
          state_reason: 'not_planned',
        });
        (r.status < 300
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
        `${cleanup.note ?? ''} Close or delete these by hand: ${(cleanup.leftover as string[]).join(', ')}`.trim();
    } else
      cleanup.note =
        'GitHub cannot delete issues over REST: they were closed as not_planned and stay in the repository; comments were deleted.';
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
    options.outDir ?? defaultEvidenceDir('issue-tracker'),
    redact,
  );

  return { doc, files };
}
