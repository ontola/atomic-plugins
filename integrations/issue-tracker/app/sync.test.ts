// @wc-ignore-file
import { describe as group, expect, it } from 'vitest';
import { SEEDED_REPOSITORY } from '../fixtures/github-issues/scenario.mjs';
import {
  action,
  classify,
  createController,
  describe,
  describeHeld,
  type ViewState,
} from './controller.js';
import { APP, fakeStore, TABLE, type FakeStore } from './fakeStore.js';
import { frameStore } from './frameStore.js';
import {
  ABOUT,
  DESCRIPTION,
  IS_A,
  ISSUE_V1,
  MESSAGE,
  NAME,
  PARENT,
  PROPERTIES,
  SHORTNAME,
  TASK_BODY,
  TASK_STATUS,
  TASK_TAGS,
} from './tracker.js';
import { relayDispatch } from './transport.js';

type Ready = Extract<ViewState, { kind: 'ready' }>;

const ready = (state: ViewState): Ready => {
  if (state.kind !== 'ready')
    throw new Error(`Expected ready, got ${JSON.stringify(state)}`);

  return state;
};

/** Property subject by shortname, from the fake ontology. */
const property = (store: FakeStore, shortname: string) =>
  [...store.resources.entries()].find(
    ([, props]) => props[SHORTNAME] === shortname,
  )![0];

const rows = (store: FakeStore) =>
  [...store.resources.entries()].filter(([, p]) => p[PARENT] === TABLE);

async function bound(store = fakeStore()) {
  const controller = createController(store);
  expect((await controller.load()).kind).toBe('choose-repository');
  const state = ready(await controller.choose(SEEDED_REPOSITORY));
  if (state.problem) throw new Error(state.problem.message);

  return { store, controller, state };
}

group('GitHub issues drive app', () => {
  it('says so and fetches nothing without the host relay', async () => {
    const store = fakeStore({ relay: false });
    const state = await createController(store).load();
    expect(state.kind).toBe('no-proxy');
    expect(action(state)).toBeUndefined();
  });

  it('asks to connect, then for a repository, and refuses a malformed one', async () => {
    expect(
      (await createController(fakeStore({ connected: false })).load()).kind,
    ).toBe('not-connected');
    const controller = createController(fakeStore());
    await controller.load();
    const state = await controller.choose('not a repository');
    expect(state).toMatchObject({ kind: 'choose-repository' });
    expect(describe(state)).toMatch(/owner\/name/);
  });

  it('imports issues and comments into the app’s table without writing to GitHub', async () => {
    const { store, state } = await bound();
    const before = store.github.snapshot(SEEDED_REPOSITORY);
    expect(state.last?.result).toMatchObject({
      issues: 2,
      comments: 1,
      sentToGitHub: 0,
      held: [],
    });
    expect(describe(state)).toMatch(
      /2 issues and 1 comment in sync with atomic-fixture\/tracker/,
    );

    const number = property(store, 'github-issue-number');
    const imported = rows(store)
      .map(([, p]) => ({
        isA: p[IS_A],
        title: p[NAME],
        body: p[TASK_BODY],
        number: p[number],
        status: p[TASK_STATUS],
      }))
      .sort((a, b) => Number(a.number) - Number(b.number));
    expect(imported).toEqual([
      {
        isA: [ISSUE_V1],
        title: 'Keep the selected calendar after refresh',
        body: 'Refreshing the page resets the selection to **All calendars**.',
        number: 1,
        status: [TASK_TAGS.Todo],
      },
      {
        isA: [ISSUE_V1],
        title: 'Export the board as CSV',
        body: '',
        number: 2,
        status: [TASK_TAGS.Doing],
      },
    ]);
    // The baseline is on each row, not in the sync state (#177 decision 7).
    const baseline = property(store, 'github-sync-baseline');
    for (const [, p] of rows(store))
      expect(JSON.parse(String(p[baseline]))).toEqual({
        title: p[NAME],
        body: p[TASK_BODY],
        status: p[number] === 1 ? 'Todo' : 'Doing',
      });
    const syncState = JSON.parse(
      String(
        [...store.resources.values()].find(
          p => p[property(store, 'github-sync-state')],
        )![property(store, 'github-sync-state')],
      ),
    );
    expect(
      Object.values(
        syncState.snapshot.records as Record<string, { baseline?: unknown }>,
      ).filter(r => r.baseline !== undefined),
    ).toEqual([]);

    const [issue] = rows(store).find(([, p]) => p[number] === 1)!;
    const messages = [...store.resources.values()].filter(p =>
      (p[IS_A] as string[] | undefined)?.includes(MESSAGE),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      [DESCRIPTION]: 'I can reproduce this in Firefox.',
      [ABOUT]: issue,
    });
    const source = JSON.parse(
      String(messages[0][property(store, 'github-source')]),
    );
    expect(source).toMatchObject({ author: 'alice' });

    // Everything the app wrote is inside its own subtree.
    const inApp = (subject: string): boolean => {
      if (subject === APP) return true;
      const parent = store.resources.get(subject)?.[PARENT];

      return typeof parent === 'string' && inApp(parent);
    };

    for (const { subject } of store.writes) expect(inApp(subject)).toBe(true);
    expect(store.github.snapshot(SEEDED_REPOSITORY)).toEqual(before);
    expect(state.last?.result.rows.map(r => [r.number, r.status])).toEqual(
      expect.arrayContaining([
        [1, 'Todo'],
        [2, 'Doing'],
      ]),
    );
  });

  it('changes nothing on an unchanged refresh, also after a reload', async () => {
    const { store, controller } = await bound();
    const again = ready(await controller.sync());
    expect(again.last?.result).toMatchObject({
      addedHere: 0,
      updatedHere: 0,
      sentToGitHub: 0,
      issues: 2,
      comments: 1,
    });

    // A reload: a new view over the same drive resumes from the saved state.
    const reloaded = createController(store);
    expect(ready(await reloaded.load()).repository).toBe(SEEDED_REPOSITORY);
    const after = ready(await reloaded.sync());
    expect(after.problem).toBeUndefined();
    expect(after.last?.result).toMatchObject({
      addedHere: 0,
      updatedHere: 0,
      sentToGitHub: 0,
    });
    // Binding the same app to another repository is refused.
    expect((await createController(store).load()).kind === 'ready').toBe(true);
  });

  it('holds a local change for review and sends exactly that once approved', async () => {
    const { store, controller } = await bound();
    const number = property(store, 'github-issue-number');
    const [issue] = rows(store).find(([, p]) => p[number] === 1)!;
    store.edit(issue, { [TASK_STATUS]: [TASK_TAGS.Done] });

    const held = ready(await controller.sync());
    expect(held.last?.result.held).toHaveLength(1);
    expect(describeHeld(held.last!.result.held[0])).toBe(
      'Update #1: status Todo → Done (close it)',
    );
    expect(describe(held)).toMatch(/1 change waiting for your review/);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );
    expect(store.calls.every(c => (c.method ?? 'GET') === 'GET')).toBe(true);

    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    expect(sent.last?.result).toMatchObject({ sentToGitHub: 1, held: [] });
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );

    // GitHub moved the issue's updated_at, so the row's GitHub source is
    // refreshed once; after that a pass changes nothing.
    await controller.sync();
    const settled = ready(await controller.sync());
    expect(settled.last?.result).toMatchObject({
      sentToGitHub: 0,
      updatedHere: 0,
      addedHere: 0,
      held: [],
    });
  });

  it('shows a row missing its Name as incomplete and sends nothing for it, without failing the pass (#177)', async () => {
    const { store, controller } = await bound();
    const number = property(store, 'github-issue-number');
    const [issue] = rows(store).find(([, p]) => p[number] === 1)!;
    // The Name column cleared in the host table, with a status edit.
    store.edit(issue, { [NAME]: '', [TASK_STATUS]: [TASK_TAGS.Done] });
    // A row made in the table without a name, asked to publish.
    const local = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: { [TASK_STATUS]: [TASK_TAGS.Todo] },
    });
    const state = ready(await controller.publish(local.subject));
    expect(state.problem).toBeUndefined();
    expect(state.last!.result.held).toEqual([]);
    const byRow = new Map(state.last!.result.rows.map(r => [r.subject, r]));
    expect(byRow.size).toBe(3);
    expect(byRow.get(issue)).toMatchObject({
      number: 1,
      title: '',
      status: 'Todo',
      incomplete: 'Incomplete: missing Name',
    });
    expect(byRow.get(local.subject)).toMatchObject({
      title: '',
      incomplete: 'Incomplete: missing Name',
    });
    expect(byRow.get(local.subject)!.number).toBeUndefined();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );
    expect(store.calls.every(c => (c.method ?? 'GET') === 'GET')).toBe(true);

    // Completed in the table: the edits are held for review as usual, and
    // the publish asked for earlier goes ahead.
    store.edit(issue, { [NAME]: 'Keep the selected calendar after refresh' });
    store.edit(local.subject, { [NAME]: 'Named now' });
    const held = ready(await controller.sync());
    expect(held.last!.result.rows.some(r => r.incomplete)).toBe(false);
    expect(held.last!.result.held.map(describeHeld).sort()).toEqual([
      'Create issue “Named now” (Todo)',
      'Update #1: status Todo → Done (close it)',
    ]);
  });

  it('settles into unchanged passes when the host never shows the app’s own saves', async () => {
    const store = fakeStore();
    store.lagReads = 1_000_000;
    const { controller } = await bound(store);
    const number = property(store, 'github-issue-number');
    const [issue] = rows(store).find(([, p]) => p[number] === 2)!;
    store.edit(issue, { [NAME]: 'Renamed here' });
    await controller.sync();
    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    store.github.updateIssue(SEEDED_REPOSITORY, 2, {
      body: 'Edited on GitHub',
    });
    const imported = ready(await controller.sync());
    expect(imported.problem).toBeUndefined();
    expect(store.resources.get(issue)?.[TASK_BODY]).toBe('Edited on GitHub');
    const last = ready(await controller.sync());
    expect(last.problem).toBeUndefined();
    expect(last.last?.result).toMatchObject({
      addedHere: 0,
      updatedHere: 0,
      sentToGitHub: 0,
      held: [],
    });
  });

  it('pauses on a same-field conflict and settles it for either side', async () => {
    const { store, controller } = await bound();
    const number = property(store, 'github-issue-number');
    const [issue] = rows(store).find(([, p]) => p[number] === 2)!;
    store.edit(issue, { [NAME]: 'Export as CSV (here)' });
    store.github.updateIssue(SEEDED_REPOSITORY, 2, {
      title: 'Export as CSV (GitHub)',
    });

    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({
      kind: 'conflict',
      fields: ['title'],
    });
    expect(describe(paused)).toMatch(/title changed both here and on GitHub/);

    const kept = ready(await controller.keep('remote'));
    expect(kept.problem).toBeUndefined();
    expect(store.resources.get(issue)?.[NAME]).toBe('Export as CSV (GitHub)');
    expect(kept.last?.result.sentToGitHub).toBe(0);

    // Keeping this table's side becomes a write that waits for review.
    store.edit(issue, { [NAME]: 'Mine' });
    store.github.updateIssue(SEEDED_REPOSITORY, 2, { title: 'Theirs' });
    await controller.sync();
    const mine = ready(await controller.keep('local'));
    expect(mine.last?.result.held.map(describeHeld)).toEqual([
      'Update #2: title “Theirs” → “Mine”',
    ]);
    await controller.send();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[1].title).toBe(
      'Mine',
    );
  });

  it('asks to reconnect when GitHub refuses the connection', async () => {
    const { store, controller } = await bound();
    store.status = 401;
    const state = ready(await controller.sync());
    expect(state.problem?.kind).toBe('reconnect');
    expect(action(state)).toBe('Reconnect GitHub');
  });

  it('does not leave a write uncertain when the host refused it before sending', async () => {
    const { store, controller } = await bound();
    const number = property(store, 'github-issue-number');
    const [issue] = rows(store).find(([, p]) => p[number] === 1)!;
    store.edit(issue, { [NAME]: 'Renamed' });
    await controller.sync();
    store.fail =
      'No github-issues connection c1 is delegated to this app. Connect again.';
    const refused = ready(await controller.send());
    expect(refused.problem?.kind).toBe('reconnect');

    store.fail = undefined;
    await controller.sync();
    const sent = ready(await controller.send());
    expect(sent.problem).toBeUndefined();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].title).toBe(
      'Renamed',
    );
  });

  it.each([
    [false, 'asks again, saying so'],
    [true, 'reads it back and completes'],
  ])(
    'after an update whose response was lost (landed: %s) it %s',
    async landed => {
      const { store, controller } = await bound();
      const number = property(store, 'github-issue-number');
      const [issue] = rows(store).find(([, p]) => p[number] === 1)!;
      store.edit(issue, { [NAME]: 'Maybe sent' });
      await controller.sync();
      store.fail = 'The host did not answer proxy in time.';
      store.failWritesOnly = true;
      store.lostWriteLands = landed;
      const lost = ready(await controller.send());
      expect(lost.problem?.kind).toBe('paused');
      expect(lost.problem?.message).toMatch(/Proxy request failed/);
      store.fail = undefined;
      const patches = () =>
        store.calls.filter(c => c.method === 'PATCH').length;
      const sent = patches();

      // The saved operation resumes first, without review, and sends nothing.
      const next = ready(await controller.sync());
      expect(patches()).toBe(sent);
      expect(next.problem).toBeUndefined();

      if (landed) {
        // GitHub already shows the change, so the operation just completes.
        expect(next.last?.result.held).toEqual([]);
      } else {
        // An update is safe to repeat, but only after a person looked.
        const [held] = next.last!.result.held;
        expect(held.unconfirmed).toBe(true);
        expect(describeHeld(held)).toMatch(/did not confirm the last attempt/);
        await controller.send();
        expect(patches()).toBe(sent + 1);
      }

      expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].title).toBe(
        'Maybe sent',
      );
    },
  );

  /** A new row's create, approved and sent, whose answer is lost. */
  async function lostCreate(lands: boolean) {
    const { store, controller } = await bound();
    const { subject } = await store.newResource({
      parent: TABLE,
      isA: [ISSUE_V1],
      propVals: {
        [NAME]: 'Written here first',
        [TASK_STATUS]: [TASK_TAGS.Doing],
      },
    });
    // Local only until a person publishes it (#177 Q6).
    const quiet = ready(await controller.sync());
    expect(quiet.last?.result.held).toEqual([]);
    expect(
      quiet.last?.result.rows.find(r => r.subject === subject),
    ).toMatchObject({ localOnly: true, title: 'Written here first' });
    const proposed = ready(await controller.publish(subject));
    expect(proposed.last?.result.held.map(describeHeld)).toEqual([
      'Create issue “Written here first” (Doing)',
    ]);
    store.fail = 'The host did not answer proxy in time.';
    store.failWritesOnly = true;
    store.lostWriteLands = lands;
    const lost = ready(await controller.send());
    expect(lost.problem?.message).toMatch(/Proxy request failed/);
    store.fail = undefined;
    // Issue creates only; adding the atomic:doing label is a POST too.
    const posts = () =>
      store.calls.filter(c => c.method === 'POST' && /\/issues$/.test(c.path))
        .length;

    return { store, controller, subject, posts, sent: posts() };
  }

  it('never sends a create twice after its response was lost', async () => {
    const { store, controller, subject, posts, sent } = await lostCreate(true);
    const next = ready(await controller.sync());
    expect(next.problem).toBeUndefined();
    // Reported as uncertain, not as a write to approve: "Send" sends nothing.
    expect(next.last?.result.held).toEqual([]);
    expect(next.last?.result.uncertain).toMatchObject([
      {
        local: subject,
        entity: 'issue',
        sent: { title: 'Written here first' },
      },
    ]);
    const again = ready(await controller.send());
    expect(again.problem).toBeUndefined();
    expect(posts()).toBe(sent);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues).toHaveLength(3);
  });

  it('links a lost create to the issue it became, without importing it twice', async () => {
    const { store, controller, subject, posts, sent } = await lostCreate(true);
    const number = property(store, 'github-issue-number');
    const next = ready(await controller.sync());
    const [uncertain] = next.last!.result.uncertain;
    expect(uncertain.candidates).toMatchObject([
      { id: 3, title: 'Written here first' },
    ]);
    // GitHub's #3 is offered, not imported as a second row.
    expect(rows(store)).toHaveLength(3);
    expect(next.last?.result.rows.map(r => r.title).sort()).toEqual([
      'Export the board as CSV',
      'Keep the selected calendar after refresh',
      'Written here first',
    ]);

    const linked = ready(await controller.landed(uncertain.subject, 3));
    expect(linked.problem).toBeUndefined();
    expect(linked.last?.result.uncertain).toEqual([]);
    expect(rows(store)).toHaveLength(3);
    expect(store.resources.get(subject)![number]).toBe(3);
    expect(posts()).toBe(sent);
    // GitHub created it as Todo; the row's Doing is proposed as an update.
    expect(linked.last?.result.held.map(describeHeld)).toEqual([
      'Update #3: status Todo → Doing (add the atomic:doing label)',
    ]);
    await controller.send();
    expect(
      store.github.snapshot(SEEDED_REPOSITORY).issues.map(i => i.title),
    ).toEqual([
      'Keep the selected calendar after refresh',
      'Export the board as CSV',
      'Written here first',
    ]);
    expect(ready(await controller.sync()).last?.result.held).toEqual([]);
  });

  it('sends a lost create again only once a person says it did not arrive', async () => {
    const { store, controller, subject, posts, sent } = await lostCreate(false);
    const next = ready(await controller.sync());
    const [uncertain] = next.last!.result.uncertain;
    expect(uncertain).toMatchObject({ local: subject, candidates: [] });

    const asked = ready(await controller.sendAgain(uncertain.subject));
    expect(asked.problem).toBeUndefined();
    expect(asked.last?.result.uncertain).toEqual([]);
    // Held for review like any new issue; nothing went yet.
    expect(asked.last?.result.held.map(describeHeld)).toEqual([
      'Create issue “Written here first” (Doing)',
    ]);
    expect(posts()).toBe(sent);
    const done = ready(await controller.send());
    expect(done.problem).toBeUndefined();
    expect(posts()).toBe(sent + 1);
    const issues = store.github.snapshot(SEEDED_REPOSITORY).issues;
    expect(issues.filter(i => i.title === 'Written here first')).toHaveLength(
      1,
    );
    await controller.sync();
    expect(
      store.resources.get(subject)![property(store, 'github-issue-number')],
    ).toBe(3);
  });

  it('refuses to send a lost create again while GitHub shows a match', async () => {
    const { store, controller, sent, posts } = await lostCreate(false);
    const [uncertain] = ready(await controller.sync()).last!.result.uncertain;
    // It turns up after all (or someone made the same one meanwhile).
    store.github.createIssue(SEEDED_REPOSITORY, {
      title: 'Written here first',
      body: '',
    });
    const refused = ready(await controller.sendAgain(uncertain.subject));
    expect(refused.problem?.message).toMatch(/may have landed: #3/);
    expect(posts()).toBe(sent);
    const next = ready(await controller.sync());
    expect(next.last?.result.uncertain[0].candidates).toMatchObject([
      { id: 3 },
    ]);
    expect(rows(store)).toHaveLength(3);
  });

  it('classifies failures into what the view can offer', () => {
    expect(classify(new Error('GitHub list_issues returned 401')).kind).toBe(
      'reconnect',
    );
    expect(classify(new Error('Missing local record: x')).kind).toBe('paused');
    expect(classify(new Error('GitHub list_issues returned 502')).kind).toBe(
      'failed',
    );
  });
});

group('frame store adapter', () => {
  it('reads its own writes when the host lags, and finds what a query missed', async () => {
    const store = fakeStore();
    store.lagReads = 100;
    store.hideFromQuery = 1;
    const known = {};
    const overlay = new Map();
    const frame = frameStore(store, { known, indexed: [PARENT], overlay });
    const created = await frame.newResource({
      parent: TABLE,
      propVals: { [NAME]: 'Row' },
    });
    const listed = await frame.queryLocalDb({
      drive: APP,
      property: PARENT,
      value: TABLE,
    });
    expect(listed.subjects).toContain(created.subject);

    const row = await frame.getResource(created.subject);
    row.set(NAME, 'Renamed');
    expect(frame.getSaveState(row).kind).toBe('pending');
    await row.save();
    expect(frame.getSaveState(row).kind).toBe('idle');
    // The host still answers 'Row'; the adapter answers what it saved.
    expect((await store.getResource(created.subject)).get(NAME)).toBe('Row');
    expect((await frame.getResource(created.subject)).get(NAME)).toBe(
      'Renamed',
    );
    // Also on a later pass, with the same overlay.
    const later = frameStore(store, { overlay });
    const again = await later.getResource(created.subject);
    expect(again.get(NAME)).toBe('Renamed');
    again.set(NAME, 'Renamed twice');
    await again.save();
    expect((await later.getResource(created.subject)).get(NAME)).toBe(
      'Renamed twice',
    );
  });

  it('believes a newer value from someone else over its own save', async () => {
    const store = fakeStore();
    store.lagReads = 100;
    const frame = frameStore(store);
    const row = await frame.getResource(TABLE);
    row.set(NAME, 'Mine');
    await row.save();
    store.edit(TABLE, { [NAME]: 'Theirs' });
    expect((await frame.getResource(TABLE)).get(NAME)).toBe('Theirs');
  });

  it('relays GitHub paths only, and marks host refusals as not sent', async () => {
    const store = fakeStore();
    const dispatch = relayDispatch(store.proxy!, 'c1');
    await dispatch(`/repos/${SEEDED_REPOSITORY}/issues?page=1&per_page=100`, {
      method: 'GET',
    });
    expect(store.calls[0]).toMatchObject({
      platform: 'github-issues',
      connectionId: 'c1',
      path: `/repos/${SEEDED_REPOSITORY}/issues`,
      query: { page: '1', per_page: '100' },
    });
    await expect(
      dispatch('/user/repos', { method: 'GET' }),
    ).rejects.toMatchObject({
      notSent: true,
    });
    store.fail =
      'This browser cannot make an Ed25519 key (WebCrypto Ed25519 is missing)';
    await expect(
      dispatch('/repos/a/b/issues', { method: 'GET' }),
    ).rejects.toMatchObject({
      notSent: true,
    });
    store.fail = undefined;
    // The proxy's own refusal comes back as a response, not a throw: it
    // never reached GitHub, and a lost delegation means connect again.
    store.refusal = 'not_delegated';
    await expect(
      dispatch('/repos/a/b/issues', { method: 'POST', body: '{}' }),
    ).rejects.toMatchObject({
      notSent: true,
      message: expect.stringMatching(/not_delegated.*Connect again\.$/),
    });
    store.refusal = 'stale_timestamp';
    await expect(
      dispatch('/repos/a/b/issues', { method: 'GET' }),
    ).rejects.toMatchObject({
      notSent: true,
      message: expect.not.stringMatching(/Connect again/),
    });
    store.refusal = undefined;
    store.fail = 'The host did not answer proxy in time.';
    await expect(
      dispatch('/repos/a/b/issues', { method: 'GET' }),
    ).rejects.toMatchObject({
      notSent: false,
    });
  });

  it('keeps the ontology tidy: one property per shortname, listed on the ontology', async () => {
    const { store } = await bound();
    const shortnames = [...store.resources.values()]
      .map(p => p[SHORTNAME])
      .filter(Boolean);
    expect(new Set(shortnames).size).toBe(shortnames.length);
    const listed = store.resources.get('did:ad:ontology')?.[
      PROPERTIES
    ] as string[];
    // Number, source, baseline, repository, sync state, synced table.
    expect(listed.length).toBe(6);
  });
});

group('baselines on the rows (#177 decision 7)', () => {
  it('writes a missing row baseline back once both sides agree, and nothing on an unchanged pass', async () => {
    const { store } = await bound();
    const baseline = property(store, 'github-sync-baseline');

    for (const [subject] of rows(store)) {
      const { [baseline]: _gone, ...rest } = store.resources.get(subject)!;
      store.resources.set(subject, rest);
    }

    const reopened = createController(store);
    const healed = ready(await reopened.start());
    expect(healed.problem).toBeUndefined();
    expect(healed.last?.result.held).toEqual([]);
    for (const [, p] of rows(store))
      expect(JSON.parse(String(p[baseline]))).toMatchObject({ title: p[NAME] });

    const writes = store.writes.length;
    const again = ready(await reopened.sync());
    expect(again.last?.result).toMatchObject({ addedHere: 0, updatedHere: 0 });
    const rowSubjects = rows(store).map(([s]) => s);
    expect(
      store.writes.slice(writes).filter(w => rowSubjects.includes(w.subject)),
    ).toEqual([]);
  });
});
