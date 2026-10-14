// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import * as synthetic from '../fixtures/google-keep/synthetic.mjs';
import { createController, type ViewState } from './controller.js';
import {
  CLASSTYPE,
  DESCRIPTION,
  NAME,
  PARENT,
  provision,
  type Drive,
} from './drive.js';
import { fakeStore, OTHER_TABLE, TABLE, type FakeStore } from './fakeStore.js';
import { acquire, LEASE_MS } from './lease.js';
import {
  AccountMismatch,
  CONFLICT,
  keepMine,
  keepTheirs,
  listNotes,
  relayCall,
  restoreRemoved,
  syncNotes,
  type SyncOptions,
} from './sync.js';

const NOW = '2026-03-02T10:00:00.000Z';
const options: SyncOptions = {
  now: () => NOW,
  rateLimit: { sleep: async () => {}, now: () => Date.parse(NOW) },
};

async function setup(args: Parameters<typeof fakeStore>[0] = {}) {
  const store = fakeStore(args);
  const drive = await provision(store);
  const call = relayCall(store.proxy!, {
    platform: 'google-keep',
    connectionId: 'c1',
  });
  const sync = (more: SyncOptions = {}) =>
    syncNotes(store, call, drive, { ...options, ...more });

  return { store, drive, call, sync };
}

const rowFor = (store: FakeStore, drive: Drive, id: string) => {
  for (const [subject, props] of store.resources)
    if (props[drive.properties.noteId] === id) return { subject, props };
  throw new Error(`no row for ${id}`);
};

const edit = async (
  store: FakeStore,
  subject: string,
  values: Record<string, string>,
) => {
  const row = await store.getResource(subject);
  for (const [k, v] of Object.entries(values)) row.set(k, v);
  await row.save();
};

describe('provision', () => {
  it('makes its own note class and types its table once', async () => {
    const { store, drive } = await setup();
    expect(store.resources.get(TABLE)?.[CLASSTYPE]).toBe(drive.rowClass);
    const writes = store.writes.length;
    await provision(store);
    expect(store.writes.length).toBe(writes);
  });

  it('refuses another app’s table', async () => {
    await expect(provision(fakeStore({ table: OTHER_TABLE }))).rejects.toThrow(
      /another table/,
    );
  });
});

describe('syncNotes', () => {
  it('imports every note, then writes nothing when nothing changed', async () => {
    const { store, drive, sync } = await setup();
    const first = await sync();
    expect(first).toMatchObject({
      added: 5,
      total: 5,
      complete: true,
      account: synthetic.OWNER,
    });
    const list = rowFor(store, drive, 'notes/synthetic-note-2').props;
    expect(list[NAME]).toBe('Synthetic packing list');
    expect(list[DESCRIPTION]).toBe(
      '- [x] Imaginary passport\n- [ ] Made-up charger\n  - [ ] Fictional adapter',
    );
    expect(list[drive.properties.kind]).toBe('list');

    const before = store.writes.length;
    const second = await sync();
    expect(second).toMatchObject({
      added: 0,
      updated: 0,
      unchanged: 5,
      created: 0,
      replaced: 0,
    });
    expect(store.writes.length).toBe(before);
    expect(store.calls.every(c => c.method === 'GET')).toBe(true);
  });

  it('takes an edit made in Keep', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    store.google.editNote('synthetic-note-1', 'Renamed in Keep', 'New text');
    expect(await sync()).toMatchObject({ updated: 1 });
    expect(
      rowFor(store, drive, 'notes/synthetic-note-1').props[DESCRIPTION],
    ).toBe('New text');
  });

  it('sends an edit made here as a replacement note and deletes the old one', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    const { subject } = rowFor(store, drive, 'notes/synthetic-note-2');
    await edit(store, subject, {
      [DESCRIPTION]: '- [x] Imaginary passport\n- [x] Made-up charger',
    });
    const summary = await sync();
    expect(summary).toMatchObject({ replaced: 1, retiring: 0 });
    const row = store.resources.get(subject)!;
    expect(row[drive.properties.noteId]).toBe('notes/synthetic-new-1');
    const keep = store.google.snapshot();
    expect(keep.deleted).toContain('notes/synthetic-note-2');
    expect(
      keep.notes.find(n => n.name === 'notes/synthetic-new-1')?.body,
    ).toEqual({
      list: {
        listItems: [
          { text: { text: 'Imaginary passport' }, checked: true },
          { text: { text: 'Made-up charger' }, checked: true },
        ],
      },
    });
    // The next pass sees both sides agree.
    expect(await sync()).toMatchObject({
      replaced: 0,
      created: 0,
      unchanged: 5,
    });
  });

  it('holds back an edit to a shared note or a note with an attachment', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    for (const id of ['notes/synthetic-note-4', 'notes/synthetic-note-5'])
      await edit(store, rowFor(store, drive, id).subject, {
        [NAME]: 'Edited here',
      });
    const summary = await sync();
    expect(summary.blocked.map(b => b.reason)).toEqual([
      expect.stringMatching(/shared/),
      expect.stringMatching(/attachment/),
    ]);
    expect(summary.replaced).toBe(0);
    expect(store.calls.some(c => c.method === 'DELETE')).toBe(false);
  });

  it('marks a conflict, and sends this row’s version once chosen', async () => {
    const { store, drive, call, sync } = await setup();
    await sync();
    const { subject } = rowFor(store, drive, 'notes/synthetic-note-1');
    await edit(store, subject, { [NAME]: 'Mine' });
    store.google.editNote(
      'synthetic-note-1',
      'Theirs',
      'Invented cheese\nPretend bread',
    );
    expect(await sync()).toMatchObject({ conflicts: 1, replaced: 0 });
    expect(store.resources.get(subject)![drive.properties.hold]).toBe(CONFLICT);
    expect(store.resources.get(subject)![NAME]).toBe('Mine');

    await keepMine(store, call, drive, subject);
    expect(await sync()).toMatchObject({ replaced: 1, conflicts: 0 });
    const keep = store.google.snapshot();
    expect(
      keep.notes.find(
        n => n.name === store.resources.get(subject)![drive.properties.noteId],
      )?.title,
    ).toBe('Mine');
    expect(
      store.resources.get(subject)![drive.properties.hold],
    ).toBeUndefined();
  });

  it('takes Keep’s version of a conflict when chosen', async () => {
    const { store, drive, call, sync } = await setup();
    await sync();
    const { subject } = rowFor(store, drive, 'notes/synthetic-note-1');
    await edit(store, subject, { [NAME]: 'Mine' });
    store.google.editNote('synthetic-note-1', 'Theirs', 'x');
    await sync();
    await keepTheirs(store, call, drive, subject);
    expect(store.resources.get(subject)![NAME]).toBe('Theirs');
    expect(await sync()).toMatchObject({ replaced: 0, conflicts: 0 });
  });

  it('creates a note for a row made here, once', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    const row = await store.newResource({
      parent: TABLE,
      isA: [drive.rowClass],
      propVals: { [NAME]: 'Made here', [DESCRIPTION]: '- [ ] One\n- [ ] Two' },
    });
    expect(await sync()).toMatchObject({ created: 1, total: 6 });
    expect(store.resources.get(row.subject)![drive.properties.kind]).toBe(
      'list',
    );
    expect(await sync()).toMatchObject({ created: 0, unchanged: 6 });
  });

  it('marks trashed and deleted notes, keeps their rows, and brings a restored one back', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    store.google.trashNote('synthetic-note-1');
    store.google.removeNote('synthetic-note-3');
    const summary = await sync();
    expect(summary.presence).toMatchObject({
      present: 3,
      trashed: 1,
      deleted: 1,
    });
    expect(
      rowFor(store, drive, 'notes/synthetic-note-1').props[
        drive.properties.lastSeen
      ],
    ).toBe(NOW);
    store.google.restoreNote('synthetic-note-1');
    expect((await sync()).presence).toMatchObject({
      present: 4,
      trashed: 0,
      deleted: 1,
    });
  });

  it('neither imports again nor deletes a note whose row was deleted here, until brought back', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    const { subject } = rowFor(store, drive, 'notes/synthetic-note-3');
    await (await store.getResource(subject)).destroy();
    const summary = await sync();
    expect(summary.removedHere).toEqual([
      {
        id: 'notes/synthetic-note-3',
        title: 'A synthetic note Keep sent without a title.',
      },
    ]);
    expect(summary.added).toBe(0);
    expect(store.calls.some(c => c.method === 'DELETE')).toBe(false);
    await restoreRemoved(store, drive, 'notes/synthetic-note-3');
    expect(await sync()).toMatchObject({ added: 1, removedHere: [] });
  });

  it('refuses another Google account than the table’s, writing nothing', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    const app = await store.getResource(drive.app);
    await app.set(drive.properties.account, 'someone-else@example.com').save();
    const before = store.writes.length;
    await expect(sync()).rejects.toBeInstanceOf(AccountMismatch);
    expect(store.writes.length).toBe(before);
  });

  it('sends at most maxWrites notes per pass; the rest wait', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    for (const n of [1, 2, 3])
      await store.newResource({
        parent: TABLE,
        isA: [drive.rowClass],
        propVals: { [NAME]: `New ${n}` },
      });
    expect(await sync({ maxWrites: 2 })).toMatchObject({
      created: 2,
      waiting: 1,
    });
    expect(await sync({ maxWrites: 2 })).toMatchObject({
      created: 1,
      waiting: 0,
    });
  });

  it('writes nothing when the read fails', async () => {
    const { store, sync } = await setup();
    store.google.failNext(1, 503, 'list');
    const before = store.writes.length;
    await expect(sync()).rejects.toThrow(/503/);
    expect(store.writes.length).toBe(before);
  });

  it('retries the delete of a replaced note that could not be deleted', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    await edit(store, rowFor(store, drive, 'notes/synthetic-note-1').subject, {
      [NAME]: 'Mine',
    });
    store.google.failNext(1, 503, 'delete');
    expect(await sync()).toMatchObject({ replaced: 1, retiring: 1, added: 0 });
    expect(await sync()).toMatchObject({ retiring: 0, added: 0 });
    expect(store.google.snapshot().deleted).toContain('notes/synthetic-note-1');
  });
});

describe('listNotes', () => {
  it('lists rows with their presence, a row made here as local', async () => {
    const { store, drive, sync } = await setup();
    await sync();
    await store.newResource({
      parent: TABLE,
      isA: [drive.rowClass],
      propVals: { [NAME]: 'Draft', [PARENT]: TABLE },
    });
    const rows = await listNotes(store, drive);
    expect(rows).toHaveLength(6);
    expect(rows.find(r => r.title === 'Draft')?.presence).toBe('local');
  });
});

describe('lease and controller', () => {
  const quick = { sleep: async () => {} };

  it('lets one browser sync while another holds a live lease', async () => {
    const { store, drive } = await setup();
    const t = Date.parse(NOW);
    expect(await acquire(store, drive, 'a', { now: () => t, ...quick })).toBe(
      true,
    );
    expect(
      await acquire(store, drive, 'b', { now: () => t + 1000, ...quick }),
    ).toBe(false);
    expect(
      await acquire(store, drive, 'b', {
        now: () => t + LEASE_MS + 1,
        ...quick,
      }),
    ).toBe(true);
  });

  it('syncs on load, says so when another browser holds the lease, and ticks', async () => {
    const store = fakeStore();
    const drive = await provision(store);
    const states: ViewState[] = [];
    let tick: (() => void) | undefined;
    const controller = createController(store, s => states.push(s), {
      ...options,
      clock: () => Date.parse(NOW),
      lease: quick,
      holder: 'me',
      timer: { every: run => ((tick = run), 1), clear: () => {} },
    });
    await (
      await controller.load()
    ).syncing;
    expect(controller.state()).toMatchObject({
      kind: 'synced',
      summary: { added: 5 },
    });
    expect(tick).toBeDefined();

    const app = await store.getResource(drive.app);
    await app
      .set(
        drive.properties.lease,
        `other ${new Date(Date.parse(NOW) + 60_000).toISOString()}`,
      )
      .save();
    tick!();
    await new Promise(r => setTimeout(r, 0));
    await controller.sync();
    expect(controller.state().kind).toBe('elsewhere');
    controller.dispose();
  });
});
