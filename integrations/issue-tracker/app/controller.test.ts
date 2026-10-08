// @wc-ignore-file
import { describe as group, expect, it } from 'vitest';
import { SEEDED_REPOSITORY } from '../fixtures/github-issues/scenario.mjs';
import {
  classify,
  createController,
  describe,
  describeHeld,
  type ViewState,
} from './controller.js';
import {
  APP,
  ONTOLOGY,
  RENDERS,
  ROW_CLASS,
  ROW_EXTRAS,
  fakeStore,
  TABLE,
  type FakeStore,
} from './fakeStore.js';
import {
  ABOUT,
  ALLOWS_ONLY,
  CLASSTYPE,
  DESCRIPTION,
  IS_A,
  ISSUE_V1,
  LOCAL_ID,
  NAME,
  PARENT,
  PROPERTIES,
  SHORTNAME,
  TASK_BODY,
  TASK_STATUS,
  TASK_TAGS,
} from './tracker.js';

type Ready = Extract<ViewState, { kind: 'ready' }>;

const ready = (state: ViewState): Ready => {
  if (state.kind !== 'ready')
    throw new Error(`Expected ready, got ${JSON.stringify(state)}`);

  return state;
};

const property = (store: FakeStore, shortname: string) =>
  [...store.resources.entries()].find(
    ([, props]) => props[SHORTNAME] === shortname,
  )![0];

async function bound(store = fakeStore()) {
  const states: ViewState[] = [];
  const controller = createController(store, s => states.push(s));
  await controller.load();
  const state = ready(await controller.choose(SEEDED_REPOSITORY));
  if (state.problem) throw new Error(state.problem.message);

  return { store, controller, state, states };
}

const rowByNumber = (state: Ready, n: number) =>
  state.last!.result.rows.find(r => r.number === n)!;

group('issue-tracker controller: rows for the board', () => {
  it('returns each issue with its body, labels and comments', async () => {
    const { state } = await bound();
    const first = rowByNumber(state, 1);
    expect(first).toMatchObject({
      title: 'Keep the selected calendar after refresh',
      status: 'Todo',
      body: 'Refreshing the page resets the selection to **All calendars**.',
      labels: [{ name: 'bug' }],
      url: `https://github.com/${SEEDED_REPOSITORY}/issues/1`,
    });
    expect(first.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(first.comments).toEqual([
      expect.objectContaining({
        body: 'I can reproduce this in Firefox.',
        author: 'alice',
      }),
    ]);
    // atomic:doing is the Doing status, not a label chip.
    expect(rowByNumber(state, 2)).toMatchObject({
      status: 'Doing',
      labels: [],
    });
  });
});

group('issue-tracker controller: moving and editing', () => {
  it('moves a card at once, then holds the close for review', async () => {
    const { store, controller, states } = await bound();
    const before = states.length;
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    const done = controller.edit(subject, { status: 'Done' });

    // Optimistic: the next state already shows it in Done, marked touched.
    const shown = ready(states[before]);
    expect(rowByNumber(shown, 1).status).toBe('Done');
    expect(shown.touched).toEqual([subject]);

    const after = ready(await done);
    expect(after.touched).toBeUndefined();
    expect(rowByNumber(after, 1).status).toBe('Done');
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: status Todo → Done (close it)',
    ]);
    expect(after.last!.result.held[0].local).toBe(subject);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );

    await controller.send();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
  });

  it('keeps an edit made during a pass on screen until a pass has seen it', async () => {
    const { controller, states } = await bound();
    const subject = rowByNumber(ready(controller.state()), 2).subject;
    const syncing = controller.sync();
    // Let the pass start before the edit comes in.
    while (ready(controller.state()).busy !== 'syncing')
      await Promise.resolve();
    const editing = controller.edit(subject, { title: 'Renamed mid-pass' });
    await syncing;
    // The pass that was already running did not see it; still shown.
    const between = ready(controller.state());
    expect(rowByNumber(between, 2).title).toBe('Renamed mid-pass');
    expect(between.touched).toEqual([subject]);
    const after = ready(await editing);
    expect(after.touched).toBeUndefined();
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Update #2: title “Export the board as CSV” → “Renamed mid-pass”',
    ]);
    // It never snapped back while waiting.
    const later = states.slice(states.findIndex(s => s === between));
    for (const s of later)
      expect(rowByNumber(ready(s), 2).title).toBe('Renamed mid-pass');
  });

  it('adds a comment as a Message and holds it for review', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    const after = ready(await controller.comment(subject, 'Fixed on main.'));
    const comments = rowByNumber(after, 1).comments;
    expect(comments.map(c => c.body)).toEqual([
      'I can reproduce this in Firefox.',
      'Fixed on main.',
    ]);
    expect(comments[1].author).toBeUndefined();
    const message = store.resources.get(comments[1].subject)!;
    expect(message).toMatchObject({
      [DESCRIPTION]: 'Fixed on main.',
      [ABOUT]: subject,
    });
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Add a comment on #1: “Fixed on main.”',
    ]);
    expect(after.last!.result.held[0].local).toBe(comments[1].subject);
    await controller.send();
    expect(store.github.snapshot(SEEDED_REPOSITORY).comments).toHaveLength(2);
  });

  it('creates an issue in the table and holds its create for review', async () => {
    const { store, controller } = await bound();
    const { state, subject } = await controller.create({
      title: 'Written in the app',
      body: 'Details',
      status: 'Doing',
    });
    const after = ready(state);
    expect(subject).toBeTruthy();
    expect(store.resources.get(subject!)).toMatchObject({
      [NAME]: 'Written in the app',
      [PARENT]: TABLE,
    });
    const row = after.last!.result.rows.find(r => r.subject === subject)!;
    expect(row).toMatchObject({ status: 'Doing', title: 'Written in the app' });
    expect(row.number).toBeUndefined();
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Create issue “Written in the app” (Doing)',
    ]);
  });
});

group('issue-tracker controller: conflict review', () => {
  it('describes each field and applies one side per field', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 2).subject;
    store.edit(subject, { [NAME]: 'Here', [TASK_STATUS]: [TASK_TAGS.Done] });
    store.github.updateIssue(SEEDED_REPOSITORY, 2, {
      title: 'There',
      state: 'closed',
    });
    // Status agrees (both Done), so only the title conflicts.
    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({
      kind: 'conflict',
      fields: ['title'],
    });
    expect(await controller.conflict()).toEqual([
      {
        field: 'title',
        base: 'Export the board as CSV',
        local: 'Here',
        remote: 'There',
      },
    ]);
    const before = store.calls.filter(c => c.method !== 'GET').length;
    const resolved = ready(await controller.resolve({ title: 'local' }));
    expect(resolved.problem).toBeUndefined();
    expect(await controller.conflict()).toBeUndefined();
    // Keeping this side becomes a held write; nothing was sent.
    expect(store.calls.filter(c => c.method !== 'GET').length).toBe(before);
    expect(resolved.last!.result.held.map(describeHeld)).toEqual([
      'Update #2: title “There” → “Here”',
    ]);
  });
});

group('issue-tracker controller: repository picker', () => {
  it('lists repositories, marks those without issues, and binds the choice', async () => {
    const store = fakeStore();
    const controller = createController(store);
    await controller.load();
    const listed = await controller.listRepositories();
    expect(listed).toMatchObject({
      kind: 'choose-repository',
      listing: {
        kind: 'listed',
        repositories: [
          { fullName: SEEDED_REPOSITORY, hasIssues: true, openIssues: 2 },
          {
            fullName: 'atomic-fixture/no-issues',
            hasIssues: false,
            openIssues: 0,
          },
        ],
      },
    });
    expect(store.calls.at(-1)).toMatchObject({
      path: '/user/repos',
      method: 'GET',
      query: { per_page: '100', page: '1', sort: 'updated' },
    });
    const state = ready(await controller.choose(SEEDED_REPOSITORY));
    expect(state.repository).toBe(SEEDED_REPOSITORY);
    // Stored on the app, found again by a fresh view.
    expect(ready(await createController(store).load()).repository).toBe(
      SEEDED_REPOSITORY,
    );
  });

  it('pages through more than 100 repositories', async () => {
    const store = fakeStore();
    for (let i = 0; i < 120; i++) store.github.snapshot(`many/repo-${i}`);
    const controller = createController(store);
    await controller.load();
    const listed = await controller.listRepositories();
    if (
      listed.kind !== 'choose-repository' ||
      listed.listing?.kind !== 'listed'
    )
      throw new Error('not listed');
    expect(listed.listing.repositories).toHaveLength(122);
    expect(store.calls.filter(c => c.path === '/user/repos')).toHaveLength(2);
  });

  it('falls back to typing owner/name when the proxy will not list', async () => {
    const store = fakeStore();
    const controller = createController(store);
    await controller.load();
    store.status = 404;
    const state = await controller.listRepositories();
    expect(state).toMatchObject({
      kind: 'choose-repository',
      listing: {
        kind: 'unavailable',
        message: 'GitHub list_repositories returned 404',
      },
    });
    store.status = undefined;
    expect(ready(await controller.choose(SEEDED_REPOSITORY)).problem).toBe(
      undefined,
    );
  });
});

group('issue-tracker controller: connecting with no reload', () => {
  // The host's "Use existing connection" resolves proxy.connect with no
  // reload (#196 user test): what view() does on open must follow here.
  it('lists repositories after picking an existing connection', async () => {
    const store = fakeStore({ connected: false, existing: true });
    const controller = createController(store);
    expect((await controller.start()).kind).toBe('not-connected');
    const state = await controller.connect();
    expect(state).toMatchObject({
      kind: 'choose-repository',
      connectionId: 'c1',
      listing: { kind: 'listed' },
    });
    expect(store.calls.at(-1)).toMatchObject({ path: '/user/repos' });
  });

  it('runs the first sync when a repository is already bound', async () => {
    const { store, controller } = await bound(fakeStore({ existing: true }));
    expect((await controller.disconnect()).kind).toBe('not-connected');
    const calls = store.calls.length;
    const state = ready(await controller.connect());
    expect(state.repository).toBe(SEEDED_REPOSITORY);
    expect(state.busy).toBeFalsy();
    expect(state.problem).toBeUndefined();
    expect(state.last?.result.rows).toHaveLength(2);
    expect(store.calls.length).toBeGreaterThan(calls);
  });

  it('opens the same way: lists, or syncs once bound', async () => {
    const store = fakeStore();
    const first = createController(store);
    expect((await first.start()).kind).toBe('choose-repository');
    await first.choose(SEEDED_REPOSITORY);
    const state = ready(await createController(store).start());
    expect(state.last?.result.rows).toHaveLength(2);
  });
});

group('issue-tracker controller: view preferences', () => {
  it('keeps the layout and filters on the app, across views', async () => {
    const { store, controller } = await bound();
    expect(controller.prefs()).toEqual({});
    await controller.savePrefs({ layout: 'list', search: 'csv', label: 'bug' });
    const again = createController(store);
    await again.load();
    expect(again.prefs()).toEqual({
      layout: 'list',
      search: 'csv',
      label: 'bug',
    });
    // And the sync state next to them is intact.
    expect(ready(await again.sync()).problem).toBeUndefined();
  });
});

group('issue-tracker controller: problems', () => {
  it('names the reason a pass paused, for the banner', () => {
    expect(
      classify(new Error('Uncertain GitHub write (create_issue).')),
    ).toMatchObject({
      kind: 'paused',
      reason: 'uncertain',
    });
    expect(classify(new Error('Missing remote record: s'))).toMatchObject({
      reason: 'missing',
    });
    expect(
      classify(new Error('Atomic write rejected: did:ad:x')),
    ).toMatchObject({ reason: 'rejected' });
    expect(classify(new Error('Duplicate external identity'))).toMatchObject({
      reason: 'other',
    });
  });
});

group('issue-tracker controller: host calls from pin 007869464', () => {
  it('disconnects this app from GitHub and keeps the table', async () => {
    const { store, controller } = await bound();
    const rows = [...store.resources.values()].filter(
      p => p[PARENT] === TABLE,
    ).length;
    expect((await controller.disconnect()).kind).toBe('not-connected');
    expect(store.disconnected).toEqual(['github-issues']);
    expect(
      [...store.resources.values()].filter(p => p[PARENT] === TABLE),
    ).toHaveLength(rows);
  });

  it('does nothing on a host without proxy.disconnect', async () => {
    const { controller } = await bound(fakeStore({ hostApis: false }));
    expect((await controller.disconnect()).kind).toBe('ready');
  });

  it('reads listed rows in batches with getMany, and one by one without it', async () => {
    const batched = await bound();
    const before = { ...batched.store.counts };
    await batched.controller.sync();
    const withMany = {
      getMany: (batched.store.counts.getMany ?? 0) - (before.getMany ?? 0),
      getResource: batched.store.counts.getResource - before.getResource,
    };

    const single = await bound(fakeStore({ hostApis: false }));
    const start = single.store.counts.getResource;
    await single.controller.sync();
    const oneByOne = single.store.counts.getResource - start;

    expect(withMany.getMany).toBeGreaterThan(0);
    expect(withMany.getResource).toBeLessThan(oneByOne);
    const shape = (c: typeof batched.controller) =>
      ready(c.state())
        .last!.result.rows.map(r => [
          r.number,
          r.title,
          r.status,
          r.comments.map(x => x.body),
        ])
        .sort();
    expect(shape(batched.controller)).toEqual(shape(single.controller));
  });
});

group('issue-tracker controller: an issue gone from GitHub (state 13)', () => {
  /** GitHub stops returning issue `n` (deleted or transferred) until `back()`. */
  function hide(store: FakeStore, n: number) {
    const request = store.proxy!.request.bind(store.proxy);
    let hidden = true;

    store.proxy!.request = async r => {
      const own = new RegExp(`/issues/${n}(/|$)`);
      if (hidden && own.test(r.path))
        return { status: 404, headers: {}, body: {} };
      const response = await request(r);
      if (hidden && /\/issues$/.test(r.path) && Array.isArray(response.body))
        return {
          ...response,
          body: (response.body as { number: number }[]).filter(
            i => i.number !== n,
          ),
        };

      return response;
    };

    return { back: () => (hidden = false) };
  }

  const writes = (store: FakeStore) =>
    store.calls.filter(c => (c.method ?? 'GET') !== 'GET').length;

  it('keeps it here only, never recreates it, and binds it back when it returns', async () => {
    const { store, controller } = await bound();
    const row = rowByNumber(ready(controller.state()), 1).subject;
    const gh = hide(store, 1);
    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({
      kind: 'paused',
      reason: 'missing',
      missing: { side: 'remote', entity: 'issue', local: row },
    });
    const sent = writes(store);

    const kept = ready(await controller.keepHereOnly());
    expect(kept.problem).toBeUndefined();
    expect(kept.last!.result.held).toEqual([]);
    const here = kept.last!.result.rows.find(r => r.subject === row)!;
    expect(here.number).toBeUndefined();
    expect(
      store.resources.get(row)?.[property(store, 'github-issue-number')],
    ).toBeUndefined();
    expect(ready(await controller.sync()).last!.result.held).toEqual([]);
    expect(writes(store)).toBe(sent);

    // The same issue shows up on GitHub again: bound back to the same row.
    gh.back();
    const again = ready(await controller.sync());
    expect(again.problem).toBeUndefined();
    const rows = again.last!.result.rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.subject === row)?.number).toBe(1);
    expect(writes(store)).toBe(sent);
  });

  it('removes it from the board without touching GitHub, and imports it again if it returns', async () => {
    const { store, controller } = await bound();
    const first = rowByNumber(ready(controller.state()), 1);
    const gh = hide(store, 1);
    await controller.sync();
    const sent = writes(store);

    const removed = ready(await controller.removeFromBoard());
    expect(removed.problem).toBeUndefined();
    expect(store.resources.has(first.subject)).toBe(false);
    expect(store.resources.has(first.comments[0].subject)).toBe(false);
    expect(removed.last!.result.rows.map(r => r.number)).toEqual([2]);
    expect(writes(store)).toBe(sent);
    expect(ready(await controller.sync()).problem).toBeUndefined();

    gh.back();
    const again = ready(await controller.sync());
    expect(again.problem).toBeUndefined();
    const back = again.last!.result.rows.find(r => r.number === 1)!;
    expect(back.title).toBe(first.title);
    expect(back.comments.map(c => c.body)).toEqual([
      'I can reproduce this in Firefox.',
    ]);
    expect(again.last!.result.rows).toHaveLength(2);
    expect(writes(store)).toBe(sent);
  });
});

group('issue-tracker controller: the Doing label on GitHub', () => {
  it('adds atomic:doing for Doing and removes it again for Todo, other labels kept', async () => {
    const { store, controller } = await bound();
    const labels = () =>
      (
        store.github.snapshot(SEEDED_REPOSITORY).issues[0].labels as (
          | string
          | { name: string }
        )[]
      ).map(l => (typeof l === 'string' ? l : l.name));
    const subject = rowByNumber(ready(controller.state()), 1).subject;

    await controller.edit(subject, { status: 'Doing' });
    expect(ready(await controller.send()).problem).toBeUndefined();
    expect(labels()).toEqual(['bug', 'atomic:doing']);

    await controller.edit(subject, { status: 'Todo' });
    expect(ready(await controller.send()).problem).toBeUndefined();
    expect(labels()).toEqual(['bug']);
    expect(ready(await controller.sync()).last!.result.held).toEqual([]);
  });

  it('follows the Link header when listing repositories', async () => {
    const store = fakeStore();
    for (let i = 0; i < 120; i++) store.github.snapshot(`many/repo-${i}`);
    const controller = createController(store);
    await controller.load();
    await controller.listRepositories();
    const pages = store.calls.filter(c => c.path === '/user/repos');
    expect(pages.map(c => c.query?.page)).toEqual(['1', '2']);
  });
});

group(
  'issue-tracker controller: the shared issue-v1 class (#177 item 6)',
  () => {
    it('makes itself a view of issue-v1 and declares its row extras', async () => {
      const { store } = await bound();
      const app = store.resources.get(APP)!;
      expect(app[RENDERS]).toEqual([ROW_CLASS, ISSUE_V1]);
      expect(app[ROW_EXTRAS]).toEqual([
        property(store, 'github-issue-number'),
        property(store, 'github-source'),
        property(store, 'github-sync-baseline'),
        // The Bridge's create-recovery key on imported rows (since 0.3.0).
        LOCAL_ID,
      ]);
      expect(store.resources.get(TABLE)![CLASSTYPE]).toBe(ISSUE_V1);
      // Idempotent: a second open writes neither again.
      const writes = store.writes.length;
      await createController(store).start();
      expect(
        store.writes
          .slice(writes)
          .filter(w => w.subject === APP || w.subject === TABLE),
      ).toEqual([]);
    });

    it('syncs Blocked as the atomic:blocked label, both ways (#177 Q8)', async () => {
      const { store, controller } = await bound();
      const first = rowByNumber(ready(controller.state()), 1).subject;
      await controller.edit(first, { status: 'Blocked' });
      const held = ready(controller.state());
      expect(held.last!.result.held.map(describeHeld)).toEqual([
        'Update #1: status Todo → Blocked (add the atomic:blocked label)',
      ]);
      await controller.send();
      const issue = store.github.snapshot(SEEDED_REPOSITORY).issues[0];
      expect(issue.state).toBe('open');
      expect(
        issue.labels.map((l: { name?: string } | string) =>
          typeof l === 'string' ? l : l.name,
        ),
      ).toContain('atomic:blocked');
      expect(store.resources.get(first)![TASK_STATUS]).toEqual([
        TASK_TAGS.Blocked,
      ]);

      // #2 is Doing; GitHub adds atomic:blocked: Blocked wins.
      store.github.updateIssue(SEEDED_REPOSITORY, 2, {
        labels: ['atomic:doing', 'atomic:blocked'],
      });
      const synced = ready(await controller.sync());
      expect(rowByNumber(synced, 2).status).toBe('Blocked');
      expect(rowByNumber(synced, 2).labels).toEqual([]);
    });

    it('shows a status outside the four tags as it is, and does not fail or send it', async () => {
      const { store, controller } = await bound();
      const subject = rowByNumber(ready(controller.state()), 1).subject;
      store.edit(subject, {
        [TASK_STATUS]: [TASK_TAGS.Doing, TASK_TAGS.Blocked],
      });
      const state = ready(await controller.sync());
      expect(state.problem).toBeUndefined();
      expect(state.last!.result.held).toEqual([]);
      expect(rowByNumber(state, 1)).toMatchObject({
        status: 'Todo',
        statusAsIs: ['Doing', 'Blocked'],
      });
      // A title change on GitHub comes in; the status here stays as it is.
      store.github.updateIssue(SEEDED_REPOSITORY, 1, {
        title: 'Renamed there',
      });
      const after = ready(await controller.sync());
      expect(after.problem).toBeUndefined();
      expect(store.resources.get(subject)![NAME]).toBe('Renamed there');
      expect(store.resources.get(subject)![TASK_STATUS]).toEqual([
        TASK_TAGS.Doing,
        TASK_TAGS.Blocked,
      ]);
    });

    it('rewrites a 0.1.x table in place and keeps an edit not yet sent', async () => {
      // A 0.1.x install: its own Status column, tags and rows, synced.
      const store = fakeStore();
      const status = 'did:ad:prop-issue-status';
      const tags = {
        todo: 'did:ad:tag-todo',
        doing: 'did:ad:tag-doing',
        done: 'did:ad:tag-done',
      };
      store.resources.set(status, {
        [PARENT]: ONTOLOGY,
        [SHORTNAME]: 'issue-status',
        [ALLOWS_ONLY]: Object.values(tags),
      });
      for (const [shortname, tag] of Object.entries(tags))
        store.resources.set(tag, { [PARENT]: status, [SHORTNAME]: shortname });
      store.resources.get(ONTOLOGY)![PROPERTIES] = [status];
      const { controller } = await bound(store);

      // Turn the rows back into 0.1.x rows, as 0.1.3 wrote them.
      for (const [subject, p] of store.resources) {
        if (p[PARENT] !== TABLE) continue;
        const done = (p[TASK_STATUS] as string[])[0] === TASK_TAGS.Doing;
        const { [TASK_STATUS]: _s, [TASK_BODY]: body, ...rest } = p;
        store.resources.set(subject, {
          ...rest,
          [IS_A]: [ROW_CLASS],
          [status]: [done ? tags.doing : tags.todo],
          [DESCRIPTION]: body,
        });
      }

      store.resources.get(TABLE)![CLASSTYPE] = ROW_CLASS;
      // 0.1.x never set the marker.
      const syncState = property(store, 'github-sync-state');

      for (const p of store.resources.values())
        if (typeof p[syncState] === 'string') {
          const { migrated: _m, ...old } = JSON.parse(p[syncState] as string);
          p[syncState] = JSON.stringify(old);
        }

      const first = rowByNumber(ready(controller.state()), 1).subject;
      // An edit made under 0.1.x, not sent yet.
      store.edit(first, { [NAME]: 'Edited before the update' });

      const updated = createController(store);
      await updated.load();
      const state = ready(await updated.sync());
      expect(state.problem).toBeUndefined();
      expect(store.resources.get(first)).toMatchObject({
        [IS_A]: [ISSUE_V1],
        [TASK_STATUS]: [TASK_TAGS.Todo],
        [TASK_BODY]:
          'Refreshing the page resets the selection to **All calendars**.',
      });
      expect(store.resources.get(first)![status]).toBeUndefined();
      expect(store.resources.get(first)![DESCRIPTION]).toBeUndefined();
      expect(state.last!.result.held.map(describeHeld)).toEqual([
        'Update #1: title “Keep the selected calendar after refresh” → “Edited before the update”',
      ]);
    });

    it('writes nothing on an Issue table it did not make before it is asked to sync it', async () => {
      const store = fakeStore({ table: 'did:ad:someone-elses-table' });
      store.resources.set('did:ad:someone-elses-table', {
        [PARENT]: 'did:ad:drive',
        [CLASSTYPE]: ISSUE_V1,
      });
      const state = await createController(store).start();
      expect(state).toEqual({ kind: 'other-table', canSync: true });
      expect(store.writes).toEqual([]);
    });
  },
);

group('issue-tracker controller: GitHub rate limits', () => {
  const limit = (store: FakeStore, remaining = 1) => {
    store.rateLimit = {
      status: 403,
      headers: { 'retry-after': '3600' },
      remaining,
      writesOnly: true,
      message: 'You have exceeded a secondary rate limit.',
    };
  };

  it('classifies a limit the relay gave up on, with its retry time', () => {
    const until = Date.now() + 3_600_000;
    const error = Object.assign(new Error('GitHub is rate-limiting requests'), {
      notSent: true,
      rateLimit: { status: 429, until, source: 'retry-after', secondary: true },
    });
    expect(classify(error)).toEqual({
      kind: 'rate-limited',
      message: 'GitHub is rate-limiting requests',
      until,
    });
  });

  it('a rate-limited send keeps the approved change and sends it on the next sync, without a second review', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    const before = store.calls.length;
    await controller.edit(subject, { status: 'Done' });
    limit(store);

    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({ kind: 'rate-limited' });
    const until = (failed.problem as { until: number }).until;
    expect(until).toBeGreaterThan(Date.now() + 3_500_000);
    expect(failed.failedAt).toBeGreaterThan(0);
    // One refused write, no repeat: a 3600 s wait is not slept out.
    expect(
      store.calls.slice(before).filter(c => (c.method ?? 'GET') !== 'GET'),
    ).toHaveLength(1);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );
    // The change is still listed as waiting; nothing is uncertain.
    expect(failed.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: status Todo → Done (close it)',
    ]);
    expect(failed.last!.result.held[0].unconfirmed).toBeUndefined();

    // The retry (the timer's `sync`, or Sync now) sends it as approved.
    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.held).toEqual([]);
    expect(after.last!.result.sentToGitHub).toBe(1);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
  });

  it('a short limit on a write is waited out inside the pass, once', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { status: 'Done' });
    store.rateLimit = {
      status: 429,
      headers: { 'retry-after': '0' },
      remaining: 1,
      writesOnly: true,
    };
    const limits: unknown[] = [];
    const seen = createController(store, s => {
      if (s.kind === 'ready' && s.limited) limits.push(s.limited.until);
    });
    await seen.load();
    // The second controller shares the store; it finds the held change.
    await seen.sync();
    const sent = ready(await seen.send());
    expect(sent.problem).toBeUndefined();
    expect(sent.limited).toBeUndefined();
    expect(limits.length).toBeGreaterThan(0);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
  });

  it('any other outcome drops the carried approval: the change is held again, not sent', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { status: 'Done' });
    limit(store);
    ready(await controller.send());
    store.status = 502;
    expect(ready(await controller.sync()).problem).toMatchObject({
      kind: 'failed',
    });
    store.status = undefined;
    const held = ready(await controller.sync());
    expect(held.problem).toBeUndefined();
    // Held for review again, as a plain pending change: the refused write
    // left no saved operation behind, and the 502 stopped the next pass
    // before it planned one. Nothing was sent.
    expect(held.last!.result.held).toHaveLength(1);
    expect(describeHeld(held.last!.result.held[0])).toBe(
      'Update #1: status Todo → Done (close it)',
    );
    expect(held.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );
  });

  it('a carried approval is for its row only: a second row with the same content is held, not sent', async () => {
    const { store, controller } = await bound();
    const before = store.github.snapshot(SEEDED_REPOSITORY).issues.length;
    const input = { title: 'Dup', body: 'same words', status: 'Todo' as const };
    await controller.create(input);
    limit(store);
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({ kind: 'rate-limited' });
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues).toHaveLength(
      before,
    );

    // Another row, same title and body, made while the limit lasts: its
    // create has the same proposal key, but nobody reviewed it.
    const { subject: second } = await controller.create(input);
    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    const issues = store.github.snapshot(SEEDED_REPOSITORY).issues;
    expect(
      issues.filter((i: { title: string }) => i.title === 'Dup'),
    ).toHaveLength(1);
    expect(after.last!.result.held).toHaveLength(1);
    // `local` is the row; `subject` is the Bridge's own record id.
    expect(after.last!.result.held[0].local).toBe(second);
    expect(after.last!.result.held[0].unconfirmed).toBeUndefined();
  });

  it('after a reload, a write GitHub refused is held again as plain pending, never as uncertain, and nothing is sent unreviewed', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { status: 'Done' });
    limit(store);
    ready(await controller.send());
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );

    // A reload: the carried approval is gone with the view.
    const again = createController(store);
    const loaded = ready(await again.load());
    // The last completed pass is read back from github-last-sync.
    expect(loaded.syncedAt).toBeGreaterThan(0);
    const synced = ready(await again.sync());
    expect(synced.problem).toBeUndefined();
    expect(synced.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: status Todo → Done (close it)',
    ]);
    expect(synced.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(synced.last!.result.uncertain).toEqual([]);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );

    // Reviewed again, it goes.
    ready(await again.send());
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
  });

  it('an edit made while GitHub rate-limits is held for review, not stuck on a saved operation', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { status: 'Done' });
    limit(store);
    ready(await controller.send());
    // The edit's own sync runs while the limit lasts; a plain sync follows.
    store.rateLimit = undefined;
    const edited = ready(await controller.edit(subject, { title: 'Renamed' }));
    expect(edited.problem).toBeUndefined();
    expect(edited.last!.result.held).toHaveLength(1);
    expect(edited.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(describeHeld(edited.last!.result.held[0])).toMatch(/Renamed|Done/);
  });

  /** The next `skip` writes pass; the one after is refused for an hour. */
  const limitAfter = (store: FakeStore, skip: number) => {
    store.rateLimit = {
      status: 403,
      headers: { 'retry-after': '3600' },
      remaining: 1,
      writesOnly: true,
      skip,
      message: 'You have exceeded a secondary rate limit.',
    };
  };

  const issues = (store: FakeStore) =>
    store.github.snapshot(SEEDED_REPOSITORY).issues as {
      number: number;
      title: string;
      labels: (string | { name: string })[];
    }[];
  const labelsOf = (issue: { labels: (string | { name: string })[] }) =>
    issue.labels.map(l => (typeof l === 'string' ? l : l.name));

  it('a create applied in part (issue made, status label refused) completes on the next sync: one issue, one row, nothing held', async () => {
    const { store, controller } = await bound();
    const rowsBefore = ready(controller.state()).last!.result.rows.length;
    const { subject } = await controller.create({
      title: 'Half-made',
      body: 'kept',
      status: 'Doing',
    });
    limitAfter(store, 1);
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({ kind: 'rate-limited' });
    const made = issues(store).filter(i => i.title === 'Half-made');
    expect(made).toHaveLength(1);
    expect(labelsOf(made[0])).toEqual([]);

    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.held).toEqual([]);
    expect(after.last!.result.uncertain).toEqual([]);
    expect(issues(store).filter(i => i.title === 'Half-made')).toHaveLength(1);
    expect(labelsOf(issues(store).find(i => i.title === 'Half-made')!)).toEqual(
      ['atomic:doing'],
    );
    expect(after.last!.result.rows).toHaveLength(rowsBefore + 1);
    const row = after.last!.result.rows.find(r => r.subject === subject)!;
    expect(row.number).toBe(made[0].number);
    expect(row.status).toBe('Doing');
    expect(row.localOnly).toBeUndefined();
    // And the pass after that has nothing left to do.
    const settled = ready(await controller.sync());
    expect(settled.last!.result.held).toEqual([]);
    expect(settled.last!.result.rows).toHaveLength(rowsBefore + 1);
  });

  it('the same across a reload: the row is bound to the issue it made, the label change is held for review, nothing is duplicated', async () => {
    const { store, controller } = await bound();
    const rowsBefore = ready(controller.state()).last!.result.rows.length;
    const { subject } = await controller.create({
      title: 'Half-made',
      body: 'kept',
      status: 'Blocked',
    });
    limitAfter(store, 1);
    ready(await controller.send());
    const made = issues(store).find(i => i.title === 'Half-made')!;

    const again = createController(store);
    await again.load();
    const synced = ready(await again.sync());
    expect(synced.problem).toBeUndefined();
    expect(synced.last!.result.rows).toHaveLength(rowsBefore + 1);
    expect(issues(store).filter(i => i.title === 'Half-made')).toHaveLength(1);
    // The rest of the create, as a plain change to review: not uncertain.
    expect(synced.last!.result.uncertain).toEqual([]);
    expect(synced.last!.result.held.map(describeHeld)).toEqual([
      `Update #${made.number}: status Todo → Blocked (add the atomic:blocked label)`,
    ]);
    expect(synced.last!.result.held[0].unconfirmed).toBeUndefined();

    ready(await again.send());
    expect(labelsOf(issues(store).find(i => i.title === 'Half-made')!)).toEqual(
      ['atomic:blocked'],
    );
    const settled = ready(await again.sync());
    expect(settled.last!.result.held).toEqual([]);
    expect(settled.last!.result.rows).toHaveLength(rowsBefore + 1);
    // The issue number reaches the row's column with the completed update.
    const row = settled.last!.result.rows.find(r => r.subject === subject)!;
    expect(row.number).toBe(made.number);
    expect(row.status).toBe('Blocked');
  });

  it('an update whose fields PATCH applied before its label POST was refused still recovers', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { status: 'Doing' });
    limitAfter(store, 1);
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({ kind: 'rate-limited' });
    expect(labelsOf(issues(store)[0])).toEqual(['bug']);

    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.held).toEqual([]);
    expect(after.last!.result.uncertain).toEqual([]);
    expect(labelsOf(issues(store)[0])).toEqual(['bug', 'atomic:doing']);
    expect(rowByNumber(after, 1).status).toBe('Doing');
  });

  it('describes the rate limit with its retry time', () => {
    const until = Date.UTC(2026, 9, 6, 14, 5);
    expect(
      describe({
        kind: 'ready',
        connectionId: 'c1',
        repository: 'o/r',
        problem: { kind: 'rate-limited', message: 'HTTP 429', until },
      }),
    ).toMatch(
      /^GitHub is rate-limiting; retrying at \d{1,2}:\d\d( [AP]M)?\. Changes waiting to send are kept and go out then\. \(HTTP 429\)$/,
    );
  });
});

group('issue-tracker controller: writes GitHub refused (#357)', () => {
  /** The next write answers 422 with a GitHub-shaped validation body. */
  const refuse = (
    store: FakeStore,
    over: Partial<NonNullable<FakeStore['refuse']>> = {},
  ) => {
    store.refuse = {
      status: 422,
      remaining: 1,
      message: 'Validation Failed',
      errors: [
        {
          resource: 'Issue',
          field: 'title',
          code: 'custom',
          message: 'title is too long (maximum is 256 characters)',
        },
      ],
      ...over,
    };
  };

  const DETAIL =
    'Validation Failed; title is too long (maximum is 256 characters)';
  const writes = (store: FakeStore) =>
    store.calls.filter(c => (c.method ?? 'GET') !== 'GET').length;
  const issues = (store: FakeStore) =>
    store.github.snapshot(SEEDED_REPOSITORY).issues as {
      number: number;
      title: string;
      labels: (string | { name: string })[];
    }[];

  it('a 422 on an update applies nothing; the change is held again, not uncertain, and its approval is not carried', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { title: 'Renamed here' });
    refuse(store);
    const before = writes(store);

    const failed = ready(await controller.send());
    expect(failed.problem).toEqual({
      kind: 'refused',
      message: `GitHub refused update_issue (HTTP 422: ${DETAIL}). Nothing was applied.`,
      status: 422,
      detail: DETAIL,
    });
    expect(failed.failedAt).toBeGreaterThan(0);
    expect(writes(store)).toBe(before + 1);
    expect(issues(store)[0].title).toBe(
      'Keep the selected calendar after refresh',
    );

    // The next pass holds it for review again, as a plain pending change:
    // nothing is sent on its own, nothing is uncertain.
    const sentBefore = writes(store);
    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.uncertain).toEqual([]);
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: title “Keep the selected calendar after refresh” → “Renamed here”',
    ]);
    expect(after.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(writes(store)).toBe(sentBefore);

    // Edited and approved, it goes through.
    await controller.edit(subject, { title: 'Shorter' });
    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    expect(sent.last!.result.held).toEqual([]);
    expect(issues(store)[0].title).toBe('Shorter');
  });

  it('the same across a reload: never "Uncertain GitHub write", never "may already be there"', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { title: 'Renamed here' });
    refuse(store);
    expect(ready(await controller.send()).problem).toMatchObject({
      kind: 'refused',
    });

    const reloaded = createController(store);
    await reloaded.load();
    const state = ready(await reloaded.sync());
    expect(state.problem).toBeUndefined();
    expect(state.last!.result.uncertain).toEqual([]);
    expect(state.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: title “Keep the selected calendar after refresh” → “Renamed here”',
    ]);
    expect(state.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(issues(store)[0].title).toBe(
      'Keep the selected calendar after refresh',
    );
  });

  it('a refused create stays a local row and is held as a create again', async () => {
    const { store, controller } = await bound();
    const rowsBefore = ready(controller.state()).last!.result.rows.length;
    const { subject } = await controller.create({
      title: 'Too long',
      body: '',
      status: 'Todo',
    });
    refuse(store);
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({ kind: 'refused', status: 422 });
    expect(issues(store).filter(i => i.title === 'Too long')).toEqual([]);

    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.uncertain).toEqual([]);
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Create issue “Too long” (Todo)',
    ]);
    expect(after.last!.result.held[0].unconfirmed).toBeUndefined();
    expect(after.last!.result.rows).toHaveLength(rowsBefore + 1);
    // Still unbound: no issue number, nothing on GitHub.
    expect(
      after.last!.result.rows.find(r => r.subject === subject)!.number,
    ).toBeUndefined();
    expect(issues(store).filter(i => i.title === 'Too long')).toEqual([]);
  });

  it('a create applied in part (issue made, its label refused) binds the row to the issue it made and holds the label as a plain update', async () => {
    const { store, controller } = await bound();
    const rowsBefore = ready(controller.state()).last!.result.rows.length;
    const { subject } = await controller.create({
      title: 'Half-made',
      body: 'kept',
      status: 'Doing',
    });
    refuse(store, {
      skip: 1,
      errors: [{ resource: 'Label', code: 'invalid', field: 'labels' }],
    });
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({
      kind: 'refused',
      status: 422,
      detail: 'Validation Failed; labels invalid',
    });
    const made = issues(store).filter(i => i.title === 'Half-made');
    expect(made).toHaveLength(1);

    const after = ready(await controller.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last!.result.uncertain).toEqual([]);
    expect(issues(store).filter(i => i.title === 'Half-made')).toHaveLength(1);
    expect(after.last!.result.rows).toHaveLength(rowsBefore + 1);
    // Bound to the issue it made: the rest is a plain update to review.
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      `Update #${made[0].number}: status Todo → Doing (add the atomic:doing label)`,
    ]);
    expect(after.last!.result.held[0].unconfirmed).toBeUndefined();

    // Approved, it completes: one issue, one row, with its number.
    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    expect(
      issues(store)
        .find(i => i.title === 'Half-made')!
        .labels.map(l => (typeof l === 'string' ? l : l.name)),
    ).toEqual(['atomic:doing']);
    const settled = ready(await controller.sync());
    expect(settled.last!.result.held).toEqual([]);
    expect(settled.last!.result.rows).toHaveLength(rowsBefore + 1);
    const row = settled.last!.result.rows.find(r => r.subject === subject)!;
    expect(row.number).toBe(made[0].number);
    expect(row.status).toBe('Doing');
  });

  it('a 403 that is not a rate limit keeps the write uncertain, as before: the boundary of NOT_APPLIED', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    await controller.edit(subject, { title: 'Renamed here' });
    refuse(store, {
      status: 403,
      message: 'Resource not accessible by personal access token',
      errors: undefined,
    });
    const failed = ready(await controller.send());
    expect(failed.problem).toMatchObject({
      kind: 'failed',
      message: 'GitHub update_issue returned 403',
    });
    // The saved operation resumes next pass and is flagged for a person.
    const after = ready(await controller.sync());
    expect(after.last!.result.held).toHaveLength(1);
    expect(after.last!.result.held[0].unconfirmed).toBe(true);
  });

  it('describes the refusal with GitHub’s words and the way out', () => {
    const problem = classify(
      Object.assign(
        new Error(
          'GitHub refused update_issue (HTTP 404: Not Found). Nothing was applied.',
        ),
        { notSent: true, refused: true, status: 404, detail: 'Not Found' },
      ),
    );
    expect(problem).toEqual({
      kind: 'refused',
      message:
        'GitHub refused update_issue (HTTP 404: Not Found). Nothing was applied.',
      status: 404,
      detail: 'Not Found',
    });
    expect(
      describe({
        kind: 'ready',
        connectionId: 'c1',
        repository: 'o/r',
        problem,
      }),
    ).toBe(
      'GitHub refused a change and applied nothing (HTTP 404: Not Found). The change is held for review again: edit it here, then Review and send. Nothing is resent on its own.',
    );
    expect(
      describe({
        kind: 'ready',
        connectionId: 'c1',
        repository: 'o/r',
        problem: { kind: 'refused', message: 'm', status: 410, detail: '' },
      }),
    ).toMatch(/^GitHub refused a change and applied nothing \(HTTP 410\)\./);
  });
});
