// @wc-ignore-file
/**
 * The card's render states, in jsdom (from the atomic-server checkout's
 * data-browser workspace; no dependency of our own): never synced, synced,
 * busy, failed, pending and failed writes, ignored rows, read-only against
 * write-back, and a problem with its next step.
 */
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  ago,
  renderSyncStatus,
  statusLines,
  syncStatusCss,
  type SyncStatus,
} from './card.js';

const { JSDOM } = createRequire(
  new URL('../../browser/data-browser/package.json', import.meta.url),
)('jsdom') as typeof import('jsdom');

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const MIN = 60_000;

/** The node's text, its direct children separated by one space. */
const text = (node: Element | null | undefined) =>
  [...(node?.childNodes ?? [])]
    .map(n => n.textContent ?? '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

function render(status: SyncStatus, buttonClass?: string) {
  const doc = new JSDOM('<!doctype html><body></body>').window.document;
  const card = renderSyncStatus(doc, status, {
    now: NOW,
    ...(buttonClass ? { buttonClass } : {}),
  });
  doc.body.append(card);

  return {
    doc,
    card,
    key: (k: string) => card.querySelector(`[data-key="${k}"]`),
  };
}

const base: SyncStatus = {
  provider: 'Clockify',
  writeBack: 'after-review',
  rowNoun: ['entry', 'entries'],
};

describe('statusLines', () => {
  it('never synced: idle, with the write-back sentence', () => {
    expect(statusLines(base, NOW)).toEqual({
      tone: 'idle',
      headline: 'Not synced yet',
      mode: 'Edits here are sent to Clockify after you review them.',
    });
  });

  it('synced: the time, the rows and the counts', () => {
    expect(
      statusLines(
        {
          ...base,
          rows: 8,
          rowsScope: 'in the last 7 days',
          last: {
            ok: true,
            at: NOW - 4 * MIN,
            counts: { added: 1, updated: 2, unchanged: 5 },
          },
        },
        NOW,
      ),
    ).toEqual({
      tone: 'ok',
      headline: 'Synced 4 min ago',
      counts: 'Last sync: 1 added, 2 updated, 5 unchanged',
      rows: '8 entries in the last 7 days',
      mode: 'Edits here are sent to Clockify after you review them.',
    });
  });

  it('a sync that read nothing says so, and a removal is listed', () => {
    const zero = statusLines(
      {
        ...base,
        last: {
          ok: true,
          at: NOW,
          counts: { added: 0, updated: 0, unchanged: 0 },
        },
      },
      NOW,
    );
    expect(zero.counts).toBe('Last sync: nothing to read');
    const removed = statusLines(
      {
        ...base,
        last: {
          ok: true,
          at: NOW,
          counts: { added: 0, updated: 0, unchanged: 3, removed: 1 },
        },
      },
      NOW,
    );
    expect(removed.counts).toBe(
      'Last sync: 0 added, 0 updated, 3 unchanged, 1 removed',
    );
  });

  it('read-only, with a note; and the rows noun defaults to row(s)', () => {
    const lines = statusLines(
      {
        provider: 'Clockify',
        writeBack: 'read-only',
        writeBackNote: 'Sync this table to change that.',
        rows: 1,
      },
      NOW,
    );
    expect(lines.mode).toBe(
      'Read-only: edits here stay in Atomic. Sync this table to change that.',
    );
    expect(lines.rows).toBe('1 row');
  });

  it('tone: busy wins, then a failed sync, failed writes, then notes', () => {
    const ok = { ok: true as const, at: NOW };
    expect(
      statusLines({ ...base, last: ok, busy: 'Syncing…' }, NOW),
    ).toMatchObject({
      tone: 'busy',
      headline: 'Syncing…',
    });
    expect(
      statusLines(
        { ...base, last: { ok: false, at: NOW - MIN, error: 'x' } },
        NOW,
      ),
    ).toMatchObject({ tone: 'neg', headline: 'Sync failed 1 min ago' });
    expect(
      statusLines(
        {
          ...base,
          last: ok,
          writes: { pending: 1, failed: [{ title: 'a', reason: 'b' }] },
        },
        NOW,
      ).tone,
    ).toBe('neg');
    expect(
      statusLines({ ...base, last: ok, writes: { pending: 2 } }, NOW).tone,
    ).toBe('ok');
    expect(
      statusLines({ ...base, last: ok, writes: { pending: 2, held: 1 } }, NOW)
        .tone,
    ).toBe('warn');
    expect(
      statusLines(
        { ...base, last: ok, ignored: [{ count: 1, reason: 'r' }] },
        NOW,
      ).tone,
    ).toBe('warn');
    expect(
      statusLines(
        { ...base, last: ok, ignored: [{ count: 0, reason: 'r' }] },
        NOW,
      ).tone,
    ).toBe('ok');
    expect(
      statusLines(
        { ...base, last: ok, problems: [{ lead: 'p', tone: 'neg' }] },
        NOW,
      ).tone,
    ).toBe('neg');
  });

  it('ago', () => {
    expect(ago(NOW, NOW)).toBe('just now');
    expect(ago(NOW - 3 * MIN, NOW)).toBe('3 min ago');
    expect(ago(NOW - 5 * 60 * MIN, NOW)).toBe('5 h ago');
    expect(ago(NOW - 30 * 60 * MIN, NOW)).toBe('yesterday');
    expect(ago(NOW - 72 * 60 * MIN, NOW)).toBe('3 days ago');
    expect(ago(NOW + MIN, NOW)).toBe('just now');
  });
});

describe('renderSyncStatus', () => {
  it('is a named region with a hidden heading, not a live region', () => {
    const { card } = render(base);
    expect(card.tagName).toBe('SECTION');
    expect(card.getAttribute('aria-label')).toBe('Sync status');
    expect(card.getAttribute('data-tone')).toBe('idle');
    expect(card.querySelector('[role="status"]')).toBeNull();
    expect(text(card.querySelector('h2'))).toBe('Sync status');
    expect(card.querySelector('h2')!.className).toBe('ss-sr');
    expect(text(card)).toBe(
      'Sync status Not synced yet Edits here are sent to Clockify after you review them.',
    );
    expect(card.querySelector('.ss-list')).toBeNull();
  });

  it('synced: headline, rows and counts in the head line', () => {
    const { card, key } = render({
      ...base,
      rows: 8,
      rowsScope: 'in the last 7 days',
      last: {
        ok: true,
        at: NOW - 2 * MIN,
        counts: { added: 2, updated: 0, unchanged: 6 },
      },
    });
    expect(card.getAttribute('data-tone')).toBe('ok');
    expect(text(key('headline'))).toBe('Synced 2 min ago');
    expect(text(key('rows'))).toBe('8 entries in the last 7 days');
    expect(text(key('counts'))).toBe(
      'Last sync: 2 added, 0 updated, 6 unchanged',
    );
  });

  it('failed: the error and the next step as the first item', () => {
    const { card } = render({
      ...base,
      last: {
        ok: false,
        at: NOW,
        error: 'Clockify no longer accepts this connection.',
        nextStep: 'Reconnect Clockify.',
      },
    });
    expect(card.getAttribute('data-tone')).toBe('neg');
    const item = card.querySelector('.ss-list > li')!;
    expect(item.className).toBe('ss-problem');
    expect(item.getAttribute('data-tone')).toBe('neg');
    expect(text(item)).toBe(
      'Clockify no longer accepts this connection. Reconnect Clockify.',
    );
  });

  it('failed after a gap: the last good sync is named with the failure', () => {
    const { card, key } = render({
      ...base,
      last: {
        ok: false,
        at: NOW,
        error: 'HTTP 503',
        nextStep: 'Try again.',
        lastGood: NOW - 3 * 24 * 60 * MIN,
      },
    });
    expect(text(key('last-good'))).toBe('Last good sync 3 days ago.');
    expect(text(card.querySelector('.ss-list > li'))).toBe(
      'HTTP 503 Try again. Last good sync 3 days ago.',
    );
    expect(
      render({ ...base, last: { ok: false, at: NOW, error: 'x' } }).key(
        'last-good',
      ),
    ).toBeNull();
  });

  it('sends that wrote nothing are one line pointing at the review, and a note', () => {
    const { card, key } = render({
      ...base,
      last: { ok: true, at: NOW },
      writes: { pending: 0, notWritten: 2 },
    });
    expect(text(key('not-written'))).toBe(
      '2 changes not written to Clockify: see Changes to send for why.',
    );
    expect(key('pending')).toBeNull();
    expect(card.getAttribute('data-tone')).toBe('warn');
  });

  it('busy replaces the headline and pulses', () => {
    const { card, key } = render({
      ...base,
      last: { ok: true, at: NOW },
      busy: 'Sending 1 of 2…',
    });
    expect(card.getAttribute('data-tone')).toBe('busy');
    expect(text(key('headline'))).toBe('Sending 1 of 2…');
  });

  it('pending writes, held ones, a review action, failures and uncertain sends', () => {
    const review = vi.fn();
    const { card, key } = render(
      {
        ...base,
        last: { ok: true, at: NOW },
        writes: {
          pending: 3,
          held: 1,
          review: { label: 'Review changes', onClick: review, key: 'review' },
          failed: [
            { title: 'Weekly sync', reason: 'It is locked in Clockify.' },
          ],
          uncertain: 2,
        },
      },
      'btn sec',
    );
    expect(text(key('pending'))).toBe(
      '3 changes waiting to send to Clockify; 1 held back until it is fixed. Review changes',
    );
    const button = key('pending')!.querySelector('button')!;
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toBe('btn sec');
    expect(button.getAttribute('data-k')).toBe('review');
    button.click();
    expect(review).toHaveBeenCalledTimes(1);
    expect(text(key('failed'))).toBe(
      '1 change could not be sent to Clockify; nothing was written. Weekly sync: It is locked in Clockify.',
    );
    expect(key('failed')!.getAttribute('data-tone')).toBe('neg');
    expect(text(key('uncertain'))).toBe(
      '2 changes sent without an answer from Clockify: checked on the next sync.',
    );
    expect(card.getAttribute('data-tone')).toBe('neg');
  });

  it('one pending change, nothing held: a plain sentence and no button', () => {
    const { key } = render({
      ...base,
      last: { ok: true, at: NOW },
      writes: { pending: 1 },
    });
    expect(text(key('pending'))).toBe('1 change waiting to send to Clockify.');
    expect(key('pending')!.querySelector('button')).toBeNull();
    expect(key('failed')).toBeNull();
    expect(key('uncertain')).toBeNull();
  });

  it('ignored rows: count, reason, which, an action; empty groups are skipped', () => {
    const open = vi.fn();
    const { card } = render({
      ...base,
      last: { ok: true, at: NOW },
      ignored: [
        {
          count: 2,
          reason: 'are incomplete (missing Start): not counted and not sent.',
          items: ['Weekly sync', '(no description)'],
          action: { label: 'Open rows', onClick: open, disabled: true },
        },
        { count: 1, reason: 'is a running timer, counted once it stops.' },
        { count: 0, reason: 'never shown' },
      ],
    });
    const groups = card.querySelectorAll('[data-key="ignored"]');
    expect(groups).toHaveLength(2);
    expect(text(groups[0])).toContain(
      '2 entries are incomplete (missing Start): not counted and not sent. Open rows',
    );
    expect(groups[0].querySelector('button')!.disabled).toBe(true);
    expect(
      [...groups[0].querySelectorAll('details li')].map(n => text(n)),
    ).toEqual(['Weekly sync', '(no description)']);
    expect(text(groups[1])).toBe(
      '1 entry is a running timer, counted once it stops.',
    );
    expect(groups[1].querySelector('details')).toBeNull();
    expect(card.getAttribute('data-tone')).toBe('warn');
  });

  it('a problem with its next step, and its action', () => {
    const sync = vi.fn();
    const { card } = render({
      ...base,
      last: { ok: true, at: NOW },
      problems: [
        {
          lead: 'Some time is not loaded yet.',
          text: 'Sync now to load it.',
          action: { label: 'Sync now', onClick: sync, key: 'ss-sync' },
        },
      ],
    });
    const item = card.querySelector('.ss-problem')!;
    expect(item.getAttribute('data-tone')).toBe('warn');
    expect(text(item)).toBe(
      'Some time is not loaded yet. Sync now to load it. Sync now',
    );
    item.querySelector('button')!.click();
    expect(sync).toHaveBeenCalledTimes(1);
    expect(item.querySelector('button')!.className).toBe('ss-btn');
  });

  it('read-only against write-back', () => {
    expect(text(render({ ...base, writeBack: 'read-only' }).key('mode'))).toBe(
      'Read-only: edits here stay in Atomic.',
    );
    expect(text(render(base).key('mode'))).toBe(
      'Edits here are sent to Clockify after you review them.',
    );
  });

  it('a custom heading names the region', () => {
    const doc = new JSDOM('<!doctype html><body></body>').window.document;
    const card = renderSyncStatus(doc, base, {
      now: NOW,
      heading: 'Notion sync',
    });
    expect(card.getAttribute('aria-label')).toBe('Notion sync');
    expect(text(card.querySelector('h2'))).toBe('Notion sync');
  });
});

describe('card.css', () => {
  it('styles from the --pl-* tokens with fallbacks, loads nothing, respects reduced motion', () => {
    expect(syncStatusCss).toMatch(/\.ss\s*\{/);
    for (const token of ['surface', 'text', 'muted', 'pos', 'warn', 'neg'])
      expect(syncStatusCss).toMatch(
        new RegExp(`var\\(--pl-${token}, #[0-9a-f]{6}\\)`),
      );
    expect(syncStatusCss).not.toMatch(/@import|url\(/);
    expect(syncStatusCss).toMatch(/prefers-reduced-motion: reduce/);
  });
});
