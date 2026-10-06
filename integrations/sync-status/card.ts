// @wc-ignore-file
/**
 * The shared sync-status card (Decision Inbox Q-084, status-only): one
 * region a drive app puts above its data that says, in plain words, when the
 * last sync ran and how it went, what it read, whether edits made here go
 * back to the provider, what waits in the write queue or failed there, which
 * rows are left out and why, and what to do about a problem. Modelled on the
 * Notion app's status view (#177 Q9); adopted by Clockify first, because its
 * user testers could not tell what had synced or whether the app writes back
 * (usertest-findings #6, #7, #14).
 *
 * App-agnostic by construction: an app maps its own state onto a
 * `SyncStatus` and calls `renderSyncStatus`. Plain DOM, no framework, no
 * host access; `card.css` styles it from the `--pl-*` tokens the #89 plugin
 * CSS defines, with light fallbacks for an app that defines none. Pure text
 * helpers (`statusLines`) are exported so an app can test its mapping, or
 * announce the same words to a screen reader, without a DOM.
 *
 * Mapping a syncables client (`syncables/browser`'s `pendingWrites()`) onto
 * `writes`: `pending` is the number of entries with `state: 'pending'` or
 * `'blocked'` (`held` those with `awaitingRefresh: true`, which wait for a
 * refresh), `failed` the `state: 'failed'` entries (`title` from the record,
 * `reason` from `lastError`), and `uncertain` the `state: 'uncertain'`
 * ones. An app with its own client (Clockify) counts its review list and
 * send outcomes instead; see `integrations/timesheets/app/ui/status.ts`.
 */
import css from './card.css?raw';

/** The card's stylesheet, for the app's one `<style>` element. */
export const syncStatusCss: string = css;

export interface Action {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** `data-k`, for an app that restores focus by key after a re-render. */
  key?: string;
}

/** What the last successful sync did to the rows. */
export interface SyncCounts {
  added: number;
  updated: number;
  unchanged: number;
  /** Rows removed because the provider no longer has them. */
  removed?: number;
}

export type LastSync =
  | { ok: true; at: number; counts?: SyncCounts }
  | {
      ok: false;
      at: number;
      /** The error, as the app would show it. */
      error: string;
      /** The plain next step: "Reconnect Clockify.", "Try again." */
      nextStep?: string;
      /** When a sync last succeeded, so a long gap is named with the failure. */
      lastGood?: number;
    };

export interface WriteFailure {
  /** The row, as the person knows it. */
  title: string;
  reason: string;
  /**
   * The provider write itself succeeded and what failed came after it (a
   * verification read, saving the row), so "nothing was written" would be
   * wrong; the next sync reads it back.
   */
  written?: boolean;
}

/** The app's write queue towards the provider. */
export interface WriteQueue {
  /** Changes waiting to be sent (after review, or retrying). */
  pending: number;
  /** Of `pending`: changes that cannot be sent as they are. */
  held?: number;
  /** Changes the provider refused or that errored; nothing was written. */
  failed?: WriteFailure[];
  /** Sends with no answer: may or may not have been applied. */
  uncertain?: number;
  /**
   * Sends that wrote nothing for another reason (the provider changed the
   * same field, the row changed after the review, the record is gone), so
   * a clean "Synced" headline does not hide them; the app's own review
   * lists each with its reason.
   */
  notWritten?: number;
  /** Where the pending changes are reviewed, when that is elsewhere. */
  review?: Action;
}

/**
 * Rows the sync leaves out or cannot write, grouped by reason. `reason`
 * completes "<count> <rows> …", so it reads "2 rows are incomplete (missing
 * Start): not counted and not sent".
 */
export interface IgnoredGroup {
  count: number;
  reason: string;
  /** The rows concerned, by name, listed under "Which rows". */
  items?: string[];
  action?: Action;
}

/** A problem with a plain next step. */
export interface Problem {
  lead: string;
  text?: string;
  action?: Action;
  tone?: 'warn' | 'neg';
}

export interface SyncStatus {
  /** As shown: "Clockify". */
  provider: string;
  /**
   * Whether edits made in Atomic reach the provider: after a review in the
   * app (`after-review`), or never (`read-only`).
   */
  writeBack: 'after-review' | 'read-only';
  /** Appended to the write-back sentence: why it is paused, say. */
  writeBackNote?: string;
  /** Singular and plural of a row: `['entry', 'entries']`. Default row(s). */
  rowNoun?: [string, string];
  /** Rows from the provider the table has now. */
  rows?: number;
  /** Completes "<rows> entries …": "in the last 7 days". */
  rowsScope?: string;
  last?: LastSync;
  /** Running now: "Syncing…", "Sending 1 of 2…". Replaces the headline. */
  busy?: string;
  writes?: WriteQueue;
  ignored?: IgnoredGroup[];
  problems?: Problem[];
}

export type Tone = 'idle' | 'busy' | 'ok' | 'warn' | 'neg';

export interface RenderOptions {
  now: number;
  locale?: string;
  /** The region's accessible name and visually hidden heading. */
  heading?: string;
  /** Class for the card's buttons, so they look like the app's own. */
  buttonClass?: string;
}

const MINUTE = 60_000;

/** "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago". */
export function ago(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return 'just now';
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < 24 * 60 * MINUTE)
    return `${Math.floor(diff / (60 * MINUTE))} h ago`;
  const days = Math.floor(diff / (24 * 60 * MINUTE));

  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`;

const CHANGE: [string, string] = ['change', 'changes'];

export interface StatusLines {
  tone: Tone;
  /** "Synced 4 min ago", "Sync failed just now", "Not synced yet", or `busy`. */
  headline: string;
  /** "Last sync: 1 added, 2 updated, 5 unchanged", or undefined. */
  counts?: string;
  /** "8 entries in the last 7 days", or undefined. */
  rows?: string;
  /** The write-back sentence. */
  mode: string;
}

/** The card's words, as data: the headline, counts, rows and mode lines. */
export function statusLines(status: SyncStatus, now: number): StatusLines {
  const noun = status.rowNoun ?? ['row', 'rows'];
  const { last } = status;
  const trouble =
    (status.writes?.failed?.length ?? 0) > 0 ||
    (status.problems ?? []).some(p => p.tone === 'neg');
  const notes =
    (status.writes?.held ?? 0) > 0 ||
    (status.writes?.uncertain ?? 0) > 0 ||
    (status.writes?.notWritten ?? 0) > 0 ||
    (status.ignored ?? []).some(g => g.count > 0) ||
    (status.problems?.length ?? 0) > 0;

  let tone: Tone;
  let headline: string;

  if (status.busy) {
    tone = 'busy';
    headline = status.busy;
  } else if (!last) {
    tone = 'idle';
    headline = 'Not synced yet';
  } else if (last.ok) {
    tone = trouble ? 'neg' : notes ? 'warn' : 'ok';
    headline = `Synced ${ago(last.at, now)}`;
  } else {
    tone = 'neg';
    headline = `Sync failed ${ago(last.at, now)}`;
  }

  let counts: string | undefined;

  if (last?.ok && last.counts) {
    const c = last.counts;
    const parts = [
      `${c.added} added`,
      `${c.updated} updated`,
      `${c.unchanged} unchanged`,
    ];
    if (c.removed) parts.push(`${c.removed} removed`);
    counts =
      c.added || c.updated || c.unchanged || c.removed
        ? `Last sync: ${parts.join(', ')}`
        : 'Last sync: nothing to read';
  }

  const rows =
    status.rows === undefined
      ? undefined
      : `${plural(status.rows, noun)}${status.rowsScope ? ` ${status.rowsScope}` : ''}`;

  const mode =
    (status.writeBack === 'after-review'
      ? `Edits here are sent to ${status.provider} after you review them.`
      : `Read-only: edits here stay in Atomic.`) +
    (status.writeBackNote ? ` ${status.writeBackNote}` : '');

  return {
    tone,
    headline,
    ...(counts ? { counts } : {}),
    ...(rows ? { rows } : {}),
    mode,
  };
}

// ------------------------------------------------------------------ DOM

type Child = Node | string | false | null | undefined;

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs))
    if (value !== undefined) node.setAttribute(name, value);

  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(
      typeof child === 'string' ? doc.createTextNode(child) : child,
    );
  }

  return node;
}

function actionButton(
  doc: Document,
  action: Action,
  buttonClass: string,
): HTMLButtonElement {
  const button = el(
    doc,
    'button',
    {
      type: 'button',
      class: buttonClass,
      'data-k': action.key,
      ...(action.disabled ? { disabled: '' } : {}),
    },
    action.label,
  );
  button.addEventListener('click', () => action.onClick());

  return button;
}

/**
 * The card: a `region` named `heading` (default "Sync status"), never a
 * live region, so an app's one `role="status"` stays the only one. Buttons
 * are `type="button"` with `data-k` from their action's `key`.
 */
export function renderSyncStatus(
  doc: Document,
  status: SyncStatus,
  options: RenderOptions,
): HTMLElement {
  const lines = statusLines(status, options.now);
  const noun = status.rowNoun ?? ['row', 'rows'];
  const heading = options.heading ?? 'Sync status';
  const buttonClass = options.buttonClass ?? 'ss-btn';
  const button = (action: Action) => actionButton(doc, action, buttonClass);
  const items: HTMLElement[] = [];
  const { last, writes } = status;

  if (last && !last.ok)
    items.push(
      el(
        doc,
        'li',
        { class: 'ss-problem', 'data-tone': 'neg' },
        el(doc, 'span', {}, last.error),
        last.nextStep ? el(doc, 'b', {}, last.nextStep) : null,
        last.lastGood !== undefined
          ? el(
              doc,
              'span',
              { class: 'ss-muted', 'data-key': 'last-good' },
              `Last good sync ${ago(last.lastGood, options.now)}.`,
            )
          : null,
      ),
    );

  if (writes) {
    if (writes.pending > 0)
      items.push(
        el(
          doc,
          'li',
          { 'data-key': 'pending' },
          el(
            doc,
            'span',
            {},
            el(doc, 'b', {}, plural(writes.pending, CHANGE)),
            ` waiting to send to ${status.provider}`,
            writes.held
              ? `; ${writes.held} held back until ${writes.held === 1 ? 'it is' : 'they are'} fixed.`
              : '.',
          ),
          writes.review ? button(writes.review) : null,
        ),
      );

    const failedList = (failures: WriteFailure[]) =>
      el(
        doc,
        'ul',
        { class: 'ss-items' },
        failures.map(f =>
          el(doc, 'li', {}, el(doc, 'b', {}, f.title), `: ${f.reason}`),
        ),
      );
    const unwritten = (writes.failed ?? []).filter(f => !f.written);
    const written = (writes.failed ?? []).filter(f => f.written);

    if (unwritten.length)
      items.push(
        el(
          doc,
          'li',
          { class: 'ss-problem', 'data-tone': 'neg', 'data-key': 'failed' },
          el(
            doc,
            'span',
            {},
            el(doc, 'b', {}, plural(unwritten.length, CHANGE)),
            ` could not be sent to ${status.provider}; nothing was written.`,
          ),
          failedList(unwritten),
        ),
      );

    if (written.length)
      items.push(
        el(
          doc,
          'li',
          {
            class: 'ss-problem',
            'data-tone': 'neg',
            'data-key': 'failed-written',
          },
          el(
            doc,
            'span',
            {},
            el(doc, 'b', {}, plural(written.length, CHANGE)),
            ` ${written.length === 1 ? 'was' : 'were'} written to ${status.provider}, but could not be finished here; the next sync reads ${written.length === 1 ? 'it' : 'them'} back.`,
          ),
          failedList(written),
        ),
      );

    if (writes.uncertain)
      items.push(
        el(
          doc,
          'li',
          { 'data-key': 'uncertain' },
          el(doc, 'b', {}, plural(writes.uncertain, CHANGE)),
          ` sent without an answer from ${status.provider}: checked on the next sync.`,
        ),
      );

    if (writes.notWritten)
      items.push(
        el(
          doc,
          'li',
          { 'data-key': 'not-written' },
          el(doc, 'b', {}, plural(writes.notWritten, CHANGE)),
          ` not written to ${status.provider}: see Changes to send for why.`,
        ),
      );
  }

  for (const group of status.ignored ?? []) {
    if (!group.count) continue;
    items.push(
      el(
        doc,
        'li',
        { 'data-key': 'ignored' },
        el(
          doc,
          'span',
          {},
          el(doc, 'b', {}, plural(group.count, noun)),
          ` ${group.reason}`,
        ),
        group.action ? button(group.action) : null,
        group.items?.length
          ? el(
              doc,
              'details',
              {},
              el(doc, 'summary', {}, 'Which'),
              el(
                doc,
                'ul',
                { class: 'ss-items' },
                group.items.map(name => el(doc, 'li', {}, name)),
              ),
            )
          : null,
      ),
    );
  }

  for (const problem of status.problems ?? [])
    items.push(
      el(
        doc,
        'li',
        { class: 'ss-problem', 'data-tone': problem.tone ?? 'warn' },
        el(
          doc,
          'span',
          {},
          el(doc, 'b', {}, problem.lead),
          problem.text ? ` ${problem.text}` : '',
        ),
        problem.action ? button(problem.action) : null,
      ),
    );

  return el(
    doc,
    'section',
    { class: 'ss', 'data-tone': lines.tone, 'aria-label': heading },
    el(doc, 'h2', { class: 'ss-sr' }, heading),
    el(
      doc,
      'p',
      { class: 'ss-head' },
      el(doc, 'span', { class: 'ss-dot', 'aria-hidden': 'true' }),
      el(doc, 'b', { 'data-key': 'headline' }, lines.headline),
      lines.rows
        ? el(doc, 'span', { class: 'ss-muted', 'data-key': 'rows' }, lines.rows)
        : null,
      lines.counts
        ? el(
            doc,
            'span',
            { class: 'ss-muted', 'data-key': 'counts' },
            lines.counts,
          )
        : null,
    ),
    el(doc, 'p', { class: 'ss-mode', 'data-key': 'mode' }, lines.mode),
    items.length ? el(doc, 'ul', { class: 'ss-list' }, items) : null,
  );
}
