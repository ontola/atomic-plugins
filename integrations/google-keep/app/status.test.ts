// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { statusLines } from '../../sync-status/card.js';
import type { Listed, ViewState } from './controller.js';
import {
  ignoredGroups,
  MODE,
  modeFor,
  NO_RELAY_MODE,
  syncStatusFor,
} from './status.js';
import type { SyncSummary } from './sync.js';

const NOW = Date.parse('2026-03-02T10:00:00.000Z');
const listed: Listed = {
  notes: [
    {
      subject: 'a',
      noteId: 'notes/a',
      title: 'A',
      kind: 'text',
      presence: 'present',
    },
    {
      subject: 'b',
      noteId: 'notes/b',
      title: 'B',
      kind: 'text',
      presence: 'present',
      hold: 'conflict',
    },
    {
      subject: 'c',
      noteId: 'notes/c',
      title: 'C',
      kind: 'text',
      presence: 'present',
      hold: 'It is shared, and a new note would lose its collaborators.',
    },
    {
      subject: 'd',
      noteId: 'notes/d',
      title: 'D',
      kind: 'list',
      presence: 'trashed',
    },
    { subject: 'e', title: 'E', kind: 'text', presence: 'local' },
  ],
  removedHere: [{ id: 'notes/f', title: 'F' }],
};
const summary: SyncSummary = {
  total: 4,
  added: 0,
  updated: 1,
  unchanged: 3,
  created: 0,
  replaced: 1,
  waiting: 0,
  conflicts: 1,
  blocked: [],
  failed: [],
  presence: { present: 3, trashed: 1, deleted: 0, unconfirmed: 0 },
  removedHere: [],
  checked: 0,
  complete: true,
  retiring: 0,
};
const connection = { connectionId: 'c1', platform: 'google-keep' };

describe('syncStatusFor', () => {
  it('counts the rows from Keep and groups what is held back, each row once', () => {
    const groups = ignoredGroups(listed.notes);
    expect(groups.map(g => [g.count, g.items])).toEqual([
      [1, ['B']],
      [1, ['C']],
      [1, ['D']],
    ]);
    const status = syncStatusFor({
      state: {
        kind: 'synced',
        connection,
        at: new Date(NOW),
        summary,
        ...listed,
      },
      now: NOW,
    })!;
    expect(status.rows).toBe(4);
    expect(status.writes).toEqual({ pending: 1 });
    expect(status.ignored?.at(-1)?.items).toEqual(['F']);
    expect(status.problems?.[0].lead).toBe('1 note was sent to Google Keep.');
    expect(statusLines(status, NOW).headline).toBe('Synced just now');
  });

  it('says when another browser syncs, and names the account on a mismatch', () => {
    expect(
      syncStatusFor({ state: { kind: 'elsewhere', connection, ...listed } })!
        .busy,
    ).toMatch(/Another open browser/);
    const state: ViewState = {
      kind: 'error',
      connection,
      message: 'x',
      at: NOW,
      mismatch: true,
      ...listed,
    };
    expect(syncStatusFor({ state })!.last).toMatchObject({
      ok: false,
      nextStep: 'Connect the Google account this table syncs with.',
    });
  });

  it('mentions the Workspace limit before connecting, and has no card on another table', () => {
    expect(
      syncStatusFor({ state: { kind: 'disconnected', ...listed } })!
        .problems?.[0].text,
    ).toMatch(/Workspace/);
    expect(syncStatusFor({ state: { kind: 'other-table' } })).toBeUndefined();
  });

  it('puts the two-way sentence in the mode line, except where nothing can sync', () => {
    expect(modeFor({ kind: 'disconnected', ...listed })).toBe(MODE);
    expect(modeFor({ kind: 'no-relay' })).toBe(NO_RELAY_MODE);
  });
});
