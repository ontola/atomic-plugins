// @wc-ignore-file
/**
 * The app's state as the shared sync-status card shows it
 * (`integrations/sync-status/card.ts`, Q-084): the controller's `ViewState`
 * mapped onto one `SyncStatus`. Pure, so `status.test.ts` checks every
 * state without a DOM; `views.ts` renders the result first in the board,
 * the list, the "other table" screen and the no-proxy screen.
 *
 * Write-back: this app sends reviewed edits ("Review and send"), so the
 * card says "Edits here are sent to GitHub after you review them." only in
 * the `ready` state, where that is true. Everywhere else nothing is sent
 * (no host relay, a table that isn't synced or whose sync is paused, no
 * connection or repository yet), so the card says "Read-only: edits here
 * stay in Atomic." with the reason, as Clockify's `paused` and `no-proxy`
 * do.
 *
 * What counts as what (review lessons of #336 and #339):
 * - `uncertain` is only what really may have been applied: a held write
 *   that was let through once and got no answer (`Held.unconfirmed`), and a
 *   create GitHub never answered (`PassResult.uncertain`);
 * - a problem keeps the last successful sync as `lastGood`, so a days-long
 *   gap is named next to the failure, never hidden behind "Synced";
 * - a rate limit is a problem with its retry time, not a failure that
 *   leaves the person guessing ("GitHub is rate-limiting; retrying at
 *   14:05").
 */
import type {
  IgnoredGroup,
  Problem,
  SyncStatus,
} from '../../sync-status/card.js';
import { OTHER_NOTE, PAUSED_NOTE, type ViewState } from './controller.js';
import { clock } from './rateLimit.js';
import type { IssueRow } from './sync.js';

export interface StatusInput {
  state: ViewState;
  now: number;
  /** When `main.ts` will retry a failed or rate-limited sync, if scheduled. */
  retryAt?: number;
  /** "Review and send" for the changes waiting. */
  onReview?: () => void;
  /** "Sync now", when the app can sync right now. */
  onSync?: () => void;
  /** "Open row" for one incomplete row (`store.openResource`). */
  onOpenRow?: (subject: string) => void;
}

export const PROVIDER = 'GitHub';

/** The `no-proxy` state's write-back note. */
export const NO_PROXY_NOTE =
  'This Atomic Server cannot connect apps to GitHub, so nothing is read or sent until it can.';

/** The write-back note before a connection and a repository are chosen. */
export const SETUP_NOTE: Record<
  'not-connected' | 'connecting' | 'choose-repository' | 'loading',
  string
> = {
  loading: 'Nothing is read or sent while the app loads.',
  'not-connected':
    'Nothing is read or sent until a GitHub account is connected.',
  connecting: 'Nothing is read or sent until a GitHub account is connected.',
  'choose-repository': 'Nothing is read or sent until a repository is chosen.',
};

const titleOf = (row: IssueRow) => row.title || '(no title)';
const are = (n: number) => (n === 1 ? 'is' : 'are');

/** "GitHub is rate-limiting; retrying at 14:05." */
export const rateLimitLead = (at: number) =>
  `GitHub is rate-limiting; retrying at ${clock(at)}.`;

export function syncStatusFor(input: StatusInput): SyncStatus {
  const { state } = input;

  if (state.kind === 'no-proxy')
    return {
      provider: PROVIDER,
      writeBack: 'read-only',
      writeBackNote: NO_PROXY_NOTE,
      rowNoun: ['issue', 'issues'],
    };

  if (state.kind === 'other-table') {
    const paused = state.reason === PAUSED_NOTE;
    const status: SyncStatus = {
      provider: PROVIDER,
      writeBack: 'read-only',
      writeBackNote: paused
        ? 'Syncing with GitHub is paused: nothing is read or sent until you allow editing again.'
        : OTHER_NOTE,
      rowNoun: ['issue', 'issues'],
    };
    if (state.asking) status.busy = 'Waiting for you to allow editing…';
    else if (state.reason && !paused)
      // "Not synced: <why the last Sync this table stopped>."
      status.problems = [
        {
          lead: state.reason.split(/:\s*/, 1)[0] + '.',
          text: state.reason.replace(/^[^:]*:\s*/, ''),
        },
      ];

    return status;
  }

  if (state.kind !== 'ready')
    return {
      provider: PROVIDER,
      writeBack: 'read-only',
      writeBackNote: SETUP_NOTE[state.kind],
      rowNoun: ['issue', 'issues'],
      ...(state.kind === 'connecting'
        ? { busy: 'Waiting for you to confirm the connection…' }
        : state.kind === 'choose-repository' && state.settingUp
          ? { busy: `Setting up this table for ${state.settingUp}…` }
          : {}),
    };

  const result = state.last?.result;
  const rows = result?.rows ?? [];
  const synced = state.last?.at ? state.last.at : undefined;
  const status: SyncStatus = {
    provider: PROVIDER,
    writeBack: 'after-review',
    rowNoun: ['issue', 'issues'],
    rows: rows.length,
    rowsScope: `in this table, ${result?.issues ?? 0} synced with ${state.repository}`,
  };

  if (state.problem?.kind === 'reconnect')
    status.writeBackNote =
      'GitHub no longer accepts this connection, so nothing is read or sent until you reconnect.';

  // The last sync: the problem that stopped it, or the pass that completed.
  const p = state.problem;

  if (p && state.failedAt !== undefined) {
    status.last = {
      ok: false,
      at: state.failedAt,
      error: failureText(p),
      nextStep: nextStep(p, input),
      ...(synced ? { lastGood: synced } : {}),
    };
  } else if (synced && result) {
    const { addedHere, updatedHere, issues, comments } = result;

    status.last = {
      ok: true,
      at: synced,
      counts: {
        added: addedHere,
        updated: updatedHere,
        // Bound records the pass left as they were. `addedHere` and
        // `updatedHere` count row and Message writes, so this is the
        // table's side of the pass, clamped: never negative.
        unchanged: Math.max(0, issues + comments - addedHere - updatedHere),
      },
    };
  }

  if (state.busy === 'syncing')
    status.busy = state.importing
      ? `Importing… ${state.importing.issues} ${state.importing.issues === 1 ? 'issue' : 'issues'} so far`
      : state.last
        ? 'Syncing…'
        : 'Importing…';
  else if (state.busy === 'sending') status.busy = 'Sending to GitHub…';
  else if (state.busy === 'resolving') status.busy = 'Settling the conflict…';

  // The write queue: changes held for review, edits a pass has not seen
  // yet, and what really may have reached GitHub.
  const held = result?.held ?? [];
  const unconfirmed = held.filter(h => h.unconfirmed).length;
  const pending = held.length + (state.touched?.length ?? 0);
  const uncertain = unconfirmed + (result?.uncertain.length ?? 0);
  status.writes = {
    pending,
    ...(uncertain ? { uncertain } : {}),
    ...(input.onReview && held.length > unconfirmed
      ? {
          review: {
            label: 'Review and send',
            key: 'ss-review',
            onClick: input.onReview,
            disabled: !!state.busy,
          },
        }
      : {}),
  };

  const ignored: IgnoredGroup[] = [];
  const local = rows.filter(r => r.localOnly);
  const asIs = rows.filter(r => r.statusAsIs);
  const incomplete = rows.filter(r => r.incomplete);

  if (local.length)
    ignored.push({
      count: local.length,
      reason: `${are(local.length)} local only: not sent to GitHub until you choose Publish to GitHub.`,
      items: local.map(titleOf),
    });
  if (asIs.length)
    ignored.push({
      count: asIs.length,
      reason: `${asIs.length === 1 ? 'has' : 'have'} a status outside Todo, Doing, Blocked and Done: shown as ${asIs.length === 1 ? 'it is' : 'they are'}, status not synced.`,
      items: asIs.map(titleOf),
    });
  if (incomplete.length)
    ignored.push({
      count: incomplete.length,
      reason: `${are(incomplete.length)} incomplete (${[...new Set(incomplete.map(r => r.incomplete!.replace(/^Incomplete:\s*/i, '')))].join('; ')}): shown, nothing of ${incomplete.length === 1 ? 'it' : 'them'} is sent. Fill the column in the table.`,
      items: incomplete.map(titleOf),
      ...(input.onOpenRow && incomplete.length === 1
        ? {
            action: {
              label: 'Open row',
              key: `ss-open-row:${incomplete[0].subject}`,
              onClick: () => input.onOpenRow!(incomplete[0].subject),
            },
          }
        : {}),
    });
  if (ignored.length) status.ignored = ignored;

  const problems: Problem[] = [];

  // A pass waiting out a short limit, or stopped by a long one.
  if (state.limited && state.busy)
    problems.push({
      lead: rateLimitLead(state.limited.until),
      text: 'The pass waits, then goes on. Nothing is lost.',
    });
  else if (p?.kind === 'rate-limited')
    problems.push({
      lead: rateLimitLead(input.retryAt ?? p.until),
      text: 'The request GitHub refused wrote nothing. Changes waiting to send are kept, approved ones included, and go out then.',
      ...(input.onSync
        ? {
            action: {
              label: 'Sync now',
              key: 'ss-sync',
              onClick: input.onSync,
              disabled: !!state.busy,
            },
          }
        : {}),
    });

  if (problems.length) status.problems = problems;

  return status;
}

type Trouble = NonNullable<Extract<ViewState, { kind: 'ready' }>['problem']>;

/** The failed headline's reason, in the banner's words where it has one. */
function failureText(p: Trouble): string {
  switch (p.kind) {
    case 'conflict':
      return `Sync paused: ${p.fields.join(', ')} changed both here and on GitHub since the last sync.`;
    case 'reconnect':
      return 'GitHub no longer accepts this connection.';
    case 'paused':
      return p.reason === 'uncertain'
        ? 'Sync paused: a change was sent to GitHub, but no answer came back.'
        : p.reason === 'missing'
          ? 'Sync paused: a synced record is gone from one side.'
          : p.reason === 'rejected'
            ? 'Atomic Server refused to save a change.'
            : `Sync paused: ${p.message}`;
    case 'rate-limited':
      return `GitHub is rate-limiting requests (${p.message.replace(/^GitHub is rate-limiting requests \(|\);.*$/g, '')}).`;
    case 'failed':
      return p.message;
  }
}

/** The plain next step after a failed sync (#89 frame J). */
function nextStep(p: Trouble, input: StatusInput): string {
  switch (p.kind) {
    case 'conflict':
      return 'Review the conflict below.';
    case 'reconnect':
      return 'Reconnect GitHub.';
    case 'paused':
      return p.reason === 'rejected'
        ? 'Ask the drive owner for access, then try again.'
        : 'Check GitHub, then sync again; nothing is resent on its own.';
    case 'rate-limited':
      return `Wait; it retries at ${clock(input.retryAt ?? p.until)}.`;
    case 'failed':
      return input.retryAt
        ? `It retries at ${clock(input.retryAt)}; Sync now to retry at once.`
        : 'Try again.';
  }
}
