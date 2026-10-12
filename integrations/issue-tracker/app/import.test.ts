// @wc-ignore-file
/**
 * First import of a repository shaped like ontola/atomic-plugins on
 * 2026-09-29 (#206): 65 issues (bodies about 4 KB, 106 comments) and 141
 * pull requests, numbered together. Counts the proxy calls and host writes
 * the import makes, and the bytes of sync state it writes, which is where
 * #206's time went. Synthetic data only.
 */
import { describe as group, expect, it } from 'vitest';
import { createController, type ViewState } from './controller.js';
import { fakeStore, type FakeStore } from './fakeStore.js';

const REPOSITORY = 'atomic-fixture/large';
const ISSUES = 65;
const PULL_REQUESTS = 141;
const COMMENTS = 106;

function seed(store: FakeStore) {
  const body = (n: number) =>
    `Synthetic issue ${n}.\n\n${'Lorem ipsum dolor sit amet. '.repeat(145)}`;
  const issues: number[] = [];

  for (let i = 0; i < ISSUES + PULL_REQUESTS; i++) {
    // Pull requests interleave with issues, as on GitHub.
    if (i % 3 === 0 && issues.length < ISSUES) {
      issues.push(
        store.github.createIssue(REPOSITORY, {
          title: `Issue ${i + 1}`,
          body: body(i + 1),
        }).number,
      );
      continue;
    }

    const pr = store.github.createPullRequest(REPOSITORY, {
      title: `Pull request ${i + 1}`,
      body: body(i + 1),
    });
    store.github.createComment(REPOSITORY, pr.number, {
      body: 'A review comment on a pull request.',
    });
  }

  while (issues.length < ISSUES)
    issues.push(
      store.github.createIssue(REPOSITORY, { title: 'Late', body: '' }).number,
    );

  for (let c = 0; c < COMMENTS; c++)
    store.github.createComment(REPOSITORY, issues[c % issues.length], {
      body: `Comment ${c + 1}: ${'Some discussion. '.repeat(30)}`,
    });
}

/** Counts every host write and its size, by what it wrote. */
function measure(store: FakeStore) {
  const stats = {
    stateWrites: 0,
    stateBytes: 0,
    maxStateBytes: 0,
    rowWrites: 0,
  };

  const push = store.writes.push.bind(store.writes);

  // The fake logs each write after storing it, so its size is readable here.
  store.writes.push = (...entries) => {
    for (const { subject } of entries) {
      const text = Object.values(store.resources.get(subject) ?? {}).find(
        isState,
      );

      if (text === undefined) {
        stats.rowWrites++;
        continue;
      }

      stats.stateWrites++;
      stats.stateBytes += text.length;
      stats.maxStateBytes = Math.max(stats.maxStateBytes, text.length);
    }

    return push(...entries);
  };

  return stats;
}

function calls(store: FakeStore) {
  const by: Record<string, number> = {};

  for (const call of store.calls) {
    const path = call.path.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const kind =
      path === '/issues'
        ? 'list issues'
        : /^\/issues\/\d+$/.test(path)
          ? 'get issue'
          : /^\/issues\/\d+\/comments$/.test(path)
            ? 'list comments'
            : /^\/issues\/comments\/\d+$/.test(path)
              ? 'get comment'
              : `${call.method ?? 'GET'} ${path}`;
    by[kind] = (by[kind] ?? 0) + 1;
  }

  return by;
}

const pullRequestNumbers = (store: FakeStore) =>
  new Set(
    store.github
      .snapshot(REPOSITORY)
      .issues.filter((i: { pull_request?: unknown }) => i.pull_request)
      .map((i: { number: number }) => i.number),
  );

const MESSAGE = 'https://atomicdata.dev/classes/Message';
const IS_A = 'https://atomicdata.dev/properties/isA';
const isState = (v: unknown): v is string =>
  typeof v === 'string' && v.startsWith('{"version":1');

async function importInto(
  store: FakeStore,
  onChange?: (state: ViewState) => void,
) {
  const controller = createController(store, onChange);
  // After a reload the table is bound already: the view syncs at once.
  const loaded = await controller.load();

  return (
    loaded.kind === 'ready'
      ? await controller.sync()
      : await controller.choose(REPOSITORY)
  ) as Extract<ViewState, { kind: 'ready' }>;
}

/**
 * The tab closing mid-import: from the `after`-th table create on, host
 * writes never answer and nothing more of that pass runs, so the sync state
 * holds only what was flushed before. `closed` resolves once that pass has
 * hung there; `reopen` restores the host. Waiting on `closed` rather than a
 * fixed time keeps a slow machine from reopening before the cut, which let
 * the first pass go on beside the second and import twice.
 */
function closeTabAfter(store: FakeStore, after: number) {
  const newResource = store.newResource.bind(store);
  let creates = 0;
  let hung!: () => void;
  const closed = new Promise<void>(resolve => (hung = resolve));

  store.newResource = async args => {
    // Counts imported rows (they carry an issue number) and Messages only.
    const imported =
      args?.isA?.includes(MESSAGE) ||
      Object.values(args?.propVals ?? {}).some(v => typeof v === 'number');

    if (imported && ++creates > after) {
      hung();

      return new Promise(() => {});
    }

    return newResource(args);
  };

  return {
    closed,
    reopen: () => {
      store.newResource = newResource;
    },
  };
}

group('first import of a large repository (#206)', () => {
  it('imports from the list pages alone, never pull requests', async () => {
    const store = fakeStore();
    seed(store);
    const stats = measure(store);
    const state = await importInto(store);

    expect(state.problem).toBeUndefined();
    expect(state.last?.result).toMatchObject({
      issues: ISSUES,
      comments: COMMENTS,
      sentToGitHub: 0,
      held: [],
    });

    const prs = pullRequestNumbers(store);
    const touched = store.calls
      .map(c => /\/issues\/(\d+)/.exec(c.path)?.[1])
      .filter(Boolean)
      .map(Number);
    expect(touched.filter(n => prs.has(n))).toEqual([]);
    expect(store.calls.every(c => (c.method ?? 'GET') === 'GET')).toBe(true);

    // Before #206's fix: 3 issue pages, 195 issue GETs (3 per issue), 65
    // comment pages and 318 comment GETs (3 per comment); 343 writes of the
    // whole sync state, 280,004,627 bytes in all, the largest 1,258,468.
    expect(calls(store)).toEqual({
      'list issues': 3,
      'list comments': ISSUES,
    });
    expect(stats.stateWrites).toBeLessThanOrEqual(
      Math.ceil((ISSUES + COMMENTS) / 25) + 2,
    );
    expect(stats.stateBytes).toBeLessThan(10_000_000);
    if (process.env.IMPORT_STATS)
      console.info(JSON.stringify({ calls: calls(store), ...stats }, null, 2));
  }, 120_000);

  it('keeps an edit held for review while importing, without a state write per record', async () => {
    const store = fakeStore();
    store.github.createIssue(REPOSITORY, { title: 'First', body: '' });
    const controller = createController(store);
    await controller.load();
    const first = (await controller.choose(REPOSITORY)) as Extract<
      ViewState,
      { kind: 'ready' }
    >;
    const edited = await controller.edit(first.last!.result.rows[0].subject, {
      title: 'First, edited here',
    });
    expect(edited.kind === 'ready' && edited.last?.result.held).toHaveLength(1);

    seed(store);
    const stats = measure(store);
    const state = (await controller.sync()) as Extract<
      ViewState,
      { kind: 'ready' }
    >;

    expect(state.problem).toBeUndefined();
    expect(state.last?.result).toMatchObject({
      issues: ISSUES + 1,
      comments: COMMENTS,
      sentToGitHub: 0,
    });
    expect(state.last?.result.held.map(h => h.after.title)).toEqual([
      'First, edited here',
    ]);
    expect(store.calls.every(c => (c.method ?? 'GET') === 'GET')).toBe(true);
    expect(stats.stateWrites).toBeLessThanOrEqual(
      Math.ceil((ISSUES + COMMENTS) / 25) + 3,
    );
  }, 120_000);

  it('shows rows while the import runs', async () => {
    const store = fakeStore();
    seed(store);
    const seen: number[] = [];
    await importInto(store, state => {
      if (state.kind === 'ready' && state.busy && state.importing)
        seen.push(state.last?.result.rows.length ?? 0);
    });

    expect(seen.some(n => n > 0 && n < ISSUES)).toBe(true);
  }, 120_000);

  for (const stale of [false, true])
    it(`resumes after a reload instead of starting over${stale ? ', even from an older sync state' : ''}`, async () => {
      const store = fakeStore();
      seed(store);
      // Every issue and 30 comments; the state was last flushed at 75.
      const tab = closeTabAfter(store, ISSUES + 30);
      void importInto(store);
      await tab.closed;
      // Writes already under way when the pass hung (a state flush) finish.
      await new Promise(resolve => setTimeout(resolve, 0));
      tab.reopen();

      // The host may still read the sync resource as it was earlier.
      if (stale)
        for (const props of store.resources.values())
          for (const [property, value] of Object.entries(props))
            if (isState(value))
              props[property] = JSON.stringify({
                ...JSON.parse(value),
                snapshot: undefined,
              });

      const creates = () => store.writes.filter(w => w.op === 'create').length;
      const before = creates();
      const called = store.calls.length;
      const state = await importInto(store);

      expect(state.problem).toBeUndefined();
      expect(state.last?.result).toMatchObject({
        issues: ISSUES,
        comments: COMMENTS,
        held: [],
      });
      expect(state.last?.result.rows).toHaveLength(ISSUES);
      // Nothing imported twice, nothing fetched one by one.
      expect(creates() - before).toBe(COMMENTS - 30);
      const messages = [...store.resources.values()].filter(p =>
        (p[IS_A] as string[] | undefined)?.includes(MESSAGE),
      );
      expect(messages).toHaveLength(COMMENTS);
      expect(
        store.calls.slice(called).filter(c => /\/\d+$/.test(c.path)),
      ).toEqual([]);
    }, 120_000);
});
