// @wc-ignore-file
/**
 * `status.ts`: every `ViewState` mapped onto the shared sync-status card's
 * model, without a DOM. The write-back sentence must be right in each.
 */
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import {
  OTHER_NOTE,
  PAUSED_NOTE,
  type Problem,
  type ViewState,
} from './controller.js';
import type { Held, IssueRow, PassResult } from './sync.js';
import {
  NO_PROXY_NOTE,
  rateLimitLead,
  SETUP_NOTE,
  syncStatusFor,
} from './status.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;
const READ_ONLY = 'Read-only: edits here stay in Atomic.';
const AFTER_REVIEW = 'Edits here are sent to GitHub after you review them.';

const row = (over: Partial<IssueRow> & { subject: string }): IssueRow => ({
  title: over.subject,
  status: 'Todo',
  body: '',
  labels: [],
  assignees: [],
  comments: [],
  number: 1,
  ...over,
});

const result = (over: Partial<PassResult> = {}): PassResult => ({
  issues: 2,
  comments: 1,
  addedHere: 1,
  updatedHere: 0,
  sentToGitHub: 0,
  held: [],
  uncertain: [],
  rows: [row({ subject: 's1', number: 1 }), row({ subject: 's2', number: 2 })],
  ...over,
});

const held = (key: string, over: Partial<Held> = {}): Held =>
  ({
    key,
    subject: `s-${key}`,
    entity: 'issue',
    summary: `Update #1: ${key}`,
    ...over,
  }) as Held;

const ready = (
  over: Partial<Extract<ViewState, { kind: 'ready' }>> = {},
): ViewState => ({
  kind: 'ready',
  connectionId: 'c1',
  repository: 'octo/repo',
  last: { at: NOW - 4 * MIN, result: result() },
  ...over,
});

const lines = (state: ViewState, extra = {}) =>
  statusLines(syncStatusFor({ state, now: NOW, ...extra }), NOW);

describe('read-only states: nothing is sent', () => {
  it('without the host relay', () => {
    const status = syncStatusFor({ state: { kind: 'no-proxy' }, now: NOW });
    expect(status.writeBack).toBe('read-only');
    expect(status.writeBackNote).toBe(NO_PROXY_NOTE);
    expect(lines({ kind: 'no-proxy' })).toMatchObject({
      tone: 'idle',
      headline: 'Not synced yet',
      mode: `${READ_ONLY} ${NO_PROXY_NOTE}`,
    });
  });

  it('while loading, not connected, connecting, and choosing a repository', () => {
    for (const kind of ['loading', 'not-connected'] as const) {
      const l = lines({ kind });
      expect(l.mode).toBe(`${READ_ONLY} ${SETUP_NOTE[kind]}`);
      expect(l.headline).toBe('Not synced yet');
    }

    expect(lines({ kind: 'connecting' })).toMatchObject({
      tone: 'busy',
      headline: 'Waiting for you to confirm the connection…',
      mode: `${READ_ONLY} ${SETUP_NOTE.connecting}`,
    });
    const choose: ViewState = { kind: 'choose-repository', connectionId: 'c1' };
    expect(lines(choose).mode).toBe(
      `${READ_ONLY} ${SETUP_NOTE['choose-repository']}`,
    );
    expect(lines({ ...choose, settingUp: 'octo/repo' }).headline).toBe(
      'Setting up this table for octo/repo…',
    );
  });

  it('on a table the app didn’t make: not synced, with the reason it stopped', () => {
    const plain = syncStatusFor({
      state: { kind: 'other-table', canSync: true },
      now: NOW,
    });
    expect(plain.writeBack).toBe('read-only');
    expect(plain.writeBackNote).toBe(OTHER_NOTE);
    expect(plain.problems).toBeUndefined();

    const refused = syncStatusFor({
      state: {
        kind: 'other-table',
        canSync: true,
        reason: 'Not synced: The person said no.',
      },
      now: NOW,
    });
    expect(refused.problems).toEqual([
      { lead: 'Not synced.', text: 'The person said no.' },
    ]);

    const asking = syncStatusFor({
      state: { kind: 'other-table', canSync: true, asking: true },
      now: NOW,
    });
    expect(asking.busy).toBe('Waiting for you to allow editing…');
  });

  it('on a table whose grant lapsed: paused, read-only, nothing hidden', () => {
    const status = syncStatusFor({
      state: { kind: 'other-table', canSync: true, reason: PAUSED_NOTE },
      now: NOW,
    });
    expect(status.writeBack).toBe('read-only');
    expect(status.writeBackNote).toMatch(/^Syncing with GitHub is paused/);
    expect(status.problems).toBeUndefined();
  });
});

describe('the ready state: edits are sent after review', () => {
  it('names the last sync, what it did and the rows', () => {
    const status = syncStatusFor({ state: ready(), now: NOW });
    expect(status.writeBack).toBe('after-review');
    expect(status.writeBackNote).toBeUndefined();
    expect(status.last).toEqual({
      ok: true,
      at: NOW - 4 * MIN,
      counts: { added: 1, updated: 0, unchanged: 2 },
    });
    expect(status.writes).toEqual({ pending: 0 });
    expect(lines(ready())).toEqual({
      tone: 'ok',
      headline: 'Synced 4 min ago',
      counts: 'Last sync: 1 added, 0 updated, 2 unchanged',
      rows: '2 issues in this table, 2 synced with octo/repo',
      mode: AFTER_REVIEW,
    });
  });

  it('before the first pass completes: not synced yet, then importing', () => {
    const fresh = ready({ last: undefined });
    expect(syncStatusFor({ state: fresh, now: NOW }).last).toBeUndefined();
    expect(lines(fresh).headline).toBe('Not synced yet');
    expect(lines(fresh).rows).toBe('0 issues in this table');
    expect(lines(ready({ last: undefined, busy: 'syncing' })).headline).toBe(
      'Importing…',
    );
    expect(
      lines(
        ready({
          last: { at: 0, result: result() },
          busy: 'syncing',
          importing: { issues: 40, comments: 3 },
        }),
      ).headline,
    ).toBe('Importing… 40 issues so far');
    // A reload into rows read without a pass (`at: 0`): no "Synced", and
    // no "synced with" count from the empty seed result.
    const reloaded = ready({ last: { at: 0, result: result() } });
    expect(lines(reloaded).headline).toBe('Not synced yet');
    expect(lines(reloaded).rows).toBe('2 issues in this table');
  });

  it('names the last pass a reload read back from github-last-sync, without counts', () => {
    const state = ready({
      last: { at: 0, result: result() },
      syncedAt: NOW - 2 * 24 * 60 * MIN,
    });
    const status = syncStatusFor({ state, now: NOW });
    expect(status.last).toEqual({ ok: true, at: NOW - 2 * 24 * 60 * MIN });
    expect(lines(state).headline).toBe('Synced 2 days ago');
    expect(lines(state).counts).toBeUndefined();

    // Its first failed pass keeps that as the last good sync.
    const failed = ready({
      last: { at: 0, result: result() },
      syncedAt: NOW - 2 * 24 * 60 * MIN,
      problem: { kind: 'failed', message: '502' },
      failedAt: NOW,
    });
    expect(syncStatusFor({ state: failed, now: NOW }).last).toMatchObject({
      ok: false,
      at: NOW,
      lastGood: NOW - 2 * 24 * 60 * MIN,
    });
  });

  it('says what runs now', () => {
    expect(lines(ready({ busy: 'syncing' })).headline).toBe('Syncing…');
    expect(lines(ready({ busy: 'sending' })).headline).toBe(
      'Sending to GitHub…',
    );
    expect(lines(ready({ busy: 'resolving' })).headline).toBe(
      'Settling the conflict…',
    );
  });

  it('counts the write queue: held for review, edits a pass has not seen, and what may have landed', () => {
    const opened: string[] = [];
    const status = syncStatusFor({
      state: ready({
        last: {
          at: NOW - MIN,
          result: result({
            held: [held('a'), held('b', { unconfirmed: true })],
            uncertain: [
              {
                subject: 's9',
                entity: 'issue',
                sent: { title: 'New', body: '' },
                candidates: [],
              },
            ],
          }),
        },
        touched: ['s1'],
      }),
      now: NOW,
      onReview: () => opened.push('review'),
    });
    // 1 held for review + 1 touched; the unconfirmed held write and the
    // unanswered create may have been applied, so they are uncertain, and
    // counted once.
    expect(status.writes).toMatchObject({ pending: 2, uncertain: 2 });
    expect(status.writes?.review?.label).toBe('Review and send');
    status.writes?.review?.onClick();
    expect(opened).toEqual(['review']);
    expect(lines(status.writes ? ready() : ready()).tone).toBe('ok');
  });

  it('offers no review for writes that only wait for an answer', () => {
    const status = syncStatusFor({
      state: ready({
        last: {
          at: NOW,
          result: result({ held: [held('b', { unconfirmed: true })] }),
        },
      }),
      now: NOW,
      onReview: () => {},
    });
    expect(status.writes).toEqual({ pending: 0, uncertain: 1 });
  });

  it('groups the rows the sync leaves out, by reason, and names them', () => {
    const opened: string[] = [];
    const status = syncStatusFor({
      state: ready({
        last: {
          at: NOW,
          result: result({
            rows: [
              row({ subject: 'l1', title: 'Only here', localOnly: true }),
              row({ subject: 'l2', title: 'Also here', localOnly: true }),
              row({ subject: 'a1', title: 'Odd', statusAsIs: ['Later'] }),
              row({
                subject: 'i1',
                title: '',
                incomplete: 'Incomplete: missing Name',
              }),
            ],
          }),
        },
      }),
      now: NOW,
      onOpenRow: subject => opened.push(subject),
    });
    expect(status.ignored).toHaveLength(3);
    expect(status.ignored![0]).toMatchObject({
      count: 2,
      reason:
        'are local only: not sent to GitHub until you choose Publish to GitHub.',
      items: ['Only here', 'Also here'],
    });
    expect(status.ignored![1]).toMatchObject({
      count: 1,
      reason:
        'has a status outside Todo, Doing, Blocked and Done: shown as it is, status not synced.',
      items: ['Odd'],
    });
    expect(status.ignored![2]).toMatchObject({
      count: 1,
      reason:
        'is incomplete (missing Name): shown, nothing of it is sent. Fill the column in the table.',
      items: ['(no title)'],
    });
    status.ignored![2].action!.onClick();
    expect(opened).toEqual(['i1']);
    expect(lines(status.ignored ? ready() : ready()).tone).toBe('ok');
  });
});

describe('problems keep the gap visible', () => {
  const failed = (problem: Problem, over = {}) =>
    ready({
      problem,
      failedAt: NOW - 2 * MIN,
      last: { at: NOW - 3 * 24 * 60 * MIN, result: result() },
      ...over,
    });

  it('a transient failure: when, what, the last good sync, and the retry', () => {
    const status = syncStatusFor({
      state: failed({
        kind: 'failed',
        message: 'GitHub list_issues returned 502',
      }),
      now: NOW,
      retryAt: NOW + 4 * MIN,
    });
    expect(status.last).toMatchObject({
      ok: false,
      at: NOW - 2 * MIN,
      error: 'GitHub list_issues returned 502',
      lastGood: NOW - 3 * 24 * 60 * MIN,
    });
    expect((status.last as { nextStep: string }).nextStep).toMatch(
      /^It retries at \d{1,2}:\d\d( [AP]M)?; Sync now to retry at once\.$/,
    );
    expect(status.problems).toBeUndefined();
    expect(lines(failed({ kind: 'failed', message: 'x' })).headline).toBe(
      'Sync failed 2 min ago',
    );
  });

  it('a conflict, a lost connection, a pause: each with its next step', () => {
    const conflict = syncStatusFor({
      state: failed({
        kind: 'conflict',
        message: 'Conflict',
        subject: 's2',
        fields: ['title'],
      }),
      now: NOW,
    });
    expect(conflict.last).toMatchObject({
      error:
        'Sync paused: title changed both here and on GitHub since the last sync.',
      nextStep: 'Review the conflict below.',
    });
    // Still after review, but not now: the note says so.
    expect(conflict.writeBack).toBe('after-review');
    expect(conflict.writeBackNote).toBe(
      'Sending is paused until the conflict below is settled.',
    );

    const reconnect = syncStatusFor({
      state: failed({ kind: 'reconnect', message: '401' }),
      now: NOW,
    });
    expect(reconnect.writeBack).toBe('after-review');
    expect(reconnect.writeBackNote).toMatch(
      /nothing is read or sent until you reconnect/,
    );
    expect(reconnect.last).toMatchObject({ nextStep: 'Reconnect GitHub.' });

    const uncertain = syncStatusFor({
      state: failed({
        kind: 'paused',
        message: 'Uncertain GitHub write (update_issue).',
        reason: 'uncertain',
      }),
      now: NOW,
    });
    expect(uncertain.last).toMatchObject({
      error:
        'Sync paused: a change was sent to GitHub, but no answer came back.',
      nextStep: 'Check GitHub, then sync again; nothing is resent on its own.',
    });
    expect(uncertain.writeBackNote).toMatch(/^Sending is paused until/);

    const rejected = syncStatusFor({
      state: failed({
        kind: 'paused',
        message: 'Atomic write rejected',
        reason: 'rejected',
      }),
      now: NOW,
    });
    expect(rejected.last).toMatchObject({
      error: 'Atomic Server refused to save a change.',
      nextStep: 'Ask the drive owner for access, then try again.',
    });
  });

  it('a rate limit: a problem that names the retry time, and keeps the writes', () => {
    const until = NOW + 35 * MIN;
    const synced: string[] = [];
    const status = syncStatusFor({
      state: failed(
        {
          kind: 'rate-limited',
          message: `GitHub is rate-limiting requests (HTTP 403); try again at 12:35.`,
          until,
        },
        {
          last: {
            at: NOW - 10 * MIN,
            result: result({ held: [held('a')] }),
          },
        },
      ),
      now: NOW,
      onSync: () => synced.push('sync'),
    });
    expect(status.problems).toHaveLength(1);
    expect(status.problems![0].lead).toBe(rateLimitLead(until));
    expect(status.problems![0].lead).toMatch(
      /^GitHub is rate-limiting; retrying at \d{1,2}:\d\d( [AP]M)?\.$/,
    );
    expect(status.problems![0].text).toMatch(/wrote nothing.*kept/);
    status.problems![0].action!.onClick();
    expect(synced).toEqual(['sync']);
    expect(status.last).toMatchObject({
      ok: false,
      error: 'GitHub is rate-limiting requests (HTTP 403).',
      lastGood: NOW - 10 * MIN,
    });
    expect(status.writes).toMatchObject({ pending: 1 });
    expect(status.writes?.uncertain).toBeUndefined();

    // The timer's own time wins once `main.ts` has scheduled the retry.
    const scheduled = syncStatusFor({
      state: failed({ kind: 'rate-limited', message: 'x', until }),
      now: NOW,
      retryAt: NOW + 60 * MIN,
    });
    expect(scheduled.problems![0].lead).toBe(rateLimitLead(NOW + 60 * MIN));
  });

  it('a refused write (#357): GitHub’s words, nothing applied, and the way out', () => {
    const detail =
      'Validation Failed; title is too long (maximum is 256 characters)';
    const status = syncStatusFor({
      state: failed(
        {
          kind: 'refused',
          message: `GitHub refused update_issue (HTTP 422: ${detail}). Nothing was applied.`,
          status: 422,
          detail,
        },
        {
          last: {
            at: NOW - 10 * MIN,
            result: result({ held: [held('a')] }),
          },
        },
      ),
      now: NOW,
      retryAt: NOW + 4 * MIN,
    });
    expect(status.last).toEqual({
      ok: false,
      at: NOW - 2 * MIN,
      error: `GitHub refused a change and applied nothing (HTTP 422: ${detail}).`,
      nextStep:
        'Edit the change here, then Review and send it again; nothing is resent on its own.',
      lastGood: NOW - 10 * MIN,
    });
    // No retry time is promised: the same request would be refused again.
    expect(status.problems).toBeUndefined();
    expect(status.writeBackNote).toBeUndefined();
    // The change waits as pending; nothing may have landed.
    expect(status.writes).toMatchObject({ pending: 1 });
    expect(status.writes?.uncertain).toBeUndefined();
    expect(
      lines(failed({ kind: 'refused', message: 'x', status: 410, detail: '' }))
        .headline,
    ).toBe('Sync failed 2 min ago');
  });

  it('a short limit a running pass waits out', () => {
    const status = syncStatusFor({
      state: ready({ busy: 'sending', limited: { until: NOW + 15_000 } }),
      now: NOW,
    });
    expect(status.busy).toBe('Sending to GitHub…');
    expect(status.problems).toEqual([
      {
        lead: rateLimitLead(NOW + 15_000),
        text: 'The pass waits, then goes on. Nothing is lost.',
      },
    ]);
    // Not once the pass has ended.
    expect(
      syncStatusFor({
        state: ready({ limited: { until: NOW + 15_000 } }),
        now: NOW,
      }).problems,
    ).toBeUndefined();
  });

  it('a problem without a time (raised before this view) still shows the last sync', () => {
    const status = syncStatusFor({
      state: ready({ problem: { kind: 'failed', message: 'x' } }),
      now: NOW,
    });
    expect(status.last).toMatchObject({ ok: true, at: NOW - 4 * MIN });
  });
});
