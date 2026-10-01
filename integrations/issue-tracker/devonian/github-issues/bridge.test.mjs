import { expect, it } from 'vitest';
import * as devonian from 'devonian';
import { Bridge } from './bridge.mjs';
import { reviewGate } from './review.mjs';

function fixture(snapshot) {
  let saved = snapshot;
  const makePort = scope => ({
    scope,
    rows: new Map(),
    receipts: new Map(),
    writes: 0,
    lose: false,
    async list(entity) {
      return [...this.rows.values()].filter(r => r.entity === entity);
    },
    async get(entity, id) {
      const row = this.rows.get(id);
      if (!row || row.entity !== entity) throw new Error('Missing record');

      return structuredClone(row);
    },
    async create(entity, value, key, metadata) {
      if (this.receipts.has(key)) return this.receipts.get(key);
      const id = this.rows.size + 1;
      const row = { id, entity, value: structuredClone(value), metadata };
      this.rows.set(id, row);
      this.receipts.set(key, row);
      this.writes++;

      if (this.lose) {
        this.lose = false;
        throw new Error('Lost response');
      }

      return row;
    },
    async update(entity, id, value) {
      const row = await this.get(entity, id);
      this.rows.set(id, { ...row, value: structuredClone(value) });
      this.writes++;
    },
  });
  const local = makePort('https://atomic.example/bridge');
  const remote = makePort('https://github.com/acme/repo');
  const open = (options = {}) =>
    new Bridge({
      devonian,
      local,
      remote,
      snapshot: saved,
      base: 'https://bridge.example/sync',
      save: async s => {
        saved = structuredClone(s);
      },
      ...options,
    });

  return {
    local,
    remote,
    open,
    saved: () => saved,
    setSaved: s => {
      saved = structuredClone(s);
    },
  };
}

const issue = (id, title = 'Same title') => ({
  id,
  entity: 'issue',
  value: { title, body: '', status: 'Todo' },
});

it('syncs creation both ways without deduplicating equal content, then no-ops after restart', async () => {
  const f = fixture();
  f.local.rows.set(1, issue(1));
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  expect(f.local.rows.size).toBe(2);
  expect(f.remote.rows.size).toBe(2);
  const writes = f.local.writes + f.remote.writes;
  await f.open().sync();
  expect(f.local.writes + f.remote.writes).toBe(writes);
});

it('merges independent title/body edits and propagates close/reopen', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  f.local.rows.get(1).value.title = 'Local title';
  f.remote.rows.get(1).value.body = 'Remote body';
  f.local.rows.get(1).value.status = 'Done';
  await f.open().sync();
  expect(f.remote.rows.get(1).value).toEqual({
    title: 'Local title',
    body: 'Remote body',
    status: 'Done',
  });
  f.remote.rows.get(1).value.status = 'Todo';
  await f.open().sync();
  expect(f.local.rows.get(1).value.status).toBe('Todo');
});

it('syncs comments and edits both ways, preserving source metadata', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  const parent = Object.keys(f.saved().records)[0];
  const entity = `comment:${parent}`;
  f.remote.rows.set(2, {
    id: 2,
    entity,
    value: { body: 'GitHub comment' },
    metadata: { author: 'octocat' },
  });
  f.local.rows.set(2, { id: 2, entity, value: { body: 'Atomic comment' } });
  await f.open().sync();
  expect(f.local.rows.get(3).metadata).toEqual({ author: 'octocat' });
  expect(f.remote.rows.get(3).value.body).toBe('Atomic comment');
  f.local.rows.get(3).value.body = 'Edited';
  await f.open().sync();
  expect(f.remote.rows.get(2).value.body).toBe('Edited');
});

it('stops on same-field conflicts and missing records without deleting either side', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  f.local.rows.get(1).value.title = 'A';
  f.remote.rows.get(1).value.title = 'B';
  await expect(f.open().sync()).rejects.toThrow('Conflict');
  expect(f.local.rows.get(1).value.title).toBe('A');
  f.remote.rows.delete(1);
  await expect(f.open().sync()).rejects.toThrow('Missing');
  expect(f.local.rows.size).toBe(1);
});

it('reuses the same create identity after a lost receipt and restart', async () => {
  const f = fixture();
  f.local.rows.set(1, issue(1));
  f.remote.lose = true;
  await expect(f.open().sync()).rejects.toThrow('Lost response');
  await f.open().sync();
  expect(f.remote.rows.size).toBe(1);
  expect(f.remote.writes).toBe(1);
});

const gatedBridge = (f, approved) =>
  new Bridge({
    devonian,
    local: f.local,
    remote: reviewGate(f.remote, approved),
    snapshot: f.saved(),
    base: 'https://bridge.example/sync',
    save: async s => f.setSaved(s),
  });

it('holds gated writes for review, keeps syncing the rest, and sends exactly what was approved', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1, 'First'));
  f.remote.rows.set(2, issue(2, 'Second'));
  const approved = new Set();
  // Imports into the local side are never held.
  let bridge = gatedBridge(f, approved);
  await bridge.sync();
  expect(f.local.rows.size).toBe(2);
  expect(bridge.held.size).toBe(0);

  f.local.rows.get(1).value.status = 'Done';
  f.local.rows.set(3, issue(3, 'New here'));
  f.remote.rows.get(2).value.body = 'Remote edit';
  const remoteWrites = f.remote.writes;
  bridge = gatedBridge(f, approved);
  await bridge.sync();
  // Nothing reached the remote side, but the remote edit was still imported.
  expect(f.remote.writes).toBe(remoteWrites);
  expect(f.local.rows.get(2).value.body).toBe('Remote edit');
  const held = [...bridge.held.values()];
  expect(held.map(h => [h.remoteId, h.after.title, h.after.status])).toEqual([
    [1, 'First', 'Done'],
    [undefined, 'New here', 'Todo'],
  ]);
  expect(held[0].before.status).toBe('Todo');

  // Another pass without approval re-proposes the same content.
  bridge = gatedBridge(f, approved);
  await bridge.sync();
  expect([...bridge.held.values()].map(h => h.key)).toEqual(
    held.map(h => h.key),
  );

  // Approve only the close; the create stays held.
  approved.add(held[0].key);
  bridge = gatedBridge(f, approved);
  await bridge.sync();
  expect(f.remote.rows.get(1).value.status).toBe('Done');
  expect([...bridge.held.values()].map(h => h.after.title)).toEqual([
    'New here',
  ]);

  // Content changed after review: the old approval does not cover it.
  approved.add([...bridge.held.values()][0].key);
  f.local.rows.get(3).value.title = 'Renamed after review';
  bridge = gatedBridge(f, approved);
  await bridge.sync();
  const titles = () => [...f.remote.rows.values()].map(r => r.value.title);
  expect(titles()).not.toContain('Renamed after review');
  expect(titles()).not.toContain('New here');
  approved.add([...bridge.held.values()][0].key);
  bridge = gatedBridge(f, approved);
  await bridge.sync();
  expect(bridge.held.size).toBe(0);
  expect(titles()).toContain('Renamed after review');
});

it('drops a held write once both sides agree without it', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1, 'Title'));
  await f.open().sync();
  f.local.rows.get(1).value.status = 'Done';
  const bridge = gatedBridge(f, new Set());
  await bridge.sync();
  expect(bridge.held.size).toBe(1);
  // Someone closes it on GitHub instead.
  f.remote.rows.get(1).value.status = 'Done';
  await f.open().sync();
  expect(Object.values(f.saved().records).some(r => r.pending)).toBe(false);
});

it('resolves a same-field conflict in favour of either side and keeps other edits', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1, 'Base'));
  await f.open().sync();
  f.local.rows.get(1).value.title = 'Local';
  f.remote.rows.get(1).value.title = 'Remote';
  f.local.rows.get(1).value.body = 'Local body';
  const error = await f
    .open()
    .sync()
    .catch(e => e);
  expect(error.fields).toEqual(['title']);
  expect(error.entity).toBe('issue');

  await expect(
    f.open().resolveConflict(error.subject, 'remote'),
  ).resolves.toEqual(['title']);
  await f.open().sync();
  expect(f.local.rows.get(1).value).toEqual({
    title: 'Remote',
    body: 'Local body',
    status: 'Todo',
  });
  expect(f.remote.rows.get(1).value.body).toBe('Local body');

  f.local.rows.get(1).value.title = 'Mine';
  f.remote.rows.get(1).value.title = 'Theirs';
  const again = await f
    .open()
    .sync()
    .catch(e => e);
  await f.open().resolveConflict(again.subject, 'local');
  await f.open().sync();
  expect(f.remote.rows.get(1).value.title).toBe('Mine');
  await expect(f.open().resolveConflict(again.subject, 'both')).rejects.toThrow(
    'Keep either',
  );
});

it('describes a conflict per field and settles each field for its own side', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  f.local.rows.get(1).value.title = 'Local title';
  f.remote.rows.get(1).value.title = 'Remote title';
  f.local.rows.get(1).value.status = 'Done';
  f.remote.rows.get(1).value.status = 'Doing';
  const error = await f
    .open()
    .sync()
    .catch(e => e);
  expect(error.fields).toEqual(['title', 'status']);
  const writes = f.local.writes + f.remote.writes;

  expect(await f.open().describeConflict(error.subject)).toEqual([
    {
      field: 'title',
      base: 'Same title',
      local: 'Local title',
      remote: 'Remote title',
    },
    { field: 'status', base: 'Todo', local: 'Done', remote: 'Doing' },
  ]);
  // A partial choice is refused, and nothing is sent before Apply.
  await expect(
    f.open().resolveConflict(error.subject, { title: 'local' }),
  ).rejects.toThrow('Choose a side for status');
  await expect(
    f.open().resolveConflict(error.subject, { title: 'local', status: 'x' }),
  ).rejects.toThrow('Keep either');
  expect(f.local.writes + f.remote.writes).toBe(writes);

  await expect(
    f.open().resolveConflict(error.subject, {
      title: 'local',
      status: 'remote',
    }),
  ).resolves.toEqual(['title', 'status']);
  expect(f.local.writes + f.remote.writes).toBe(writes);
  await f.open().sync();
  expect(f.local.rows.get(1).value).toEqual(f.remote.rows.get(1).value);
  expect(f.remote.rows.get(1).value).toEqual({
    title: 'Local title',
    body: '',
    status: 'Doing',
  });
});

it('keeps a record gone from GitHub local-only, then binds it back to the same subject', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  const removed = f.remote.rows.get(1);
  f.remote.rows.delete(1);
  const error = await f
    .open()
    .sync()
    .catch(e => e);
  expect(error.message).toMatch(/^Missing remote record: /);
  const subject = error.message.slice('Missing remote record: '.length);

  expect(await f.open().keepLocalOnly(subject)).toBe(1);
  const writes = f.local.writes + f.remote.writes;
  await f.open().sync();
  expect(f.local.writes + f.remote.writes).toBe(writes);
  expect(f.remote.rows.size).toBe(0);

  f.remote.rows.set(1, removed);
  const bridge = f.open();
  await bridge.sync();
  expect(bridge.id('remote', 'issue', subject)).toBe(1);
  expect(bridge.records[subject].localOnly).toBeUndefined();
  expect(f.local.rows.size).toBe(1);
});

it('forgets a record gone from GitHub on both sides', async () => {
  const f = fixture();
  f.remote.rows.set(1, issue(1));
  await f.open().sync();
  f.remote.rows.delete(1);
  const error = await f
    .open()
    .sync()
    .catch(e => e);
  const subject = error.message.slice('Missing remote record: '.length);
  expect(await f.open().forget(subject)).toEqual([1]);
  f.local.rows.delete(1);
  const writes = f.local.writes + f.remote.writes;
  await f.open().sync();
  expect(f.local.writes + f.remote.writes).toBe(writes);
  expect(f.open().records[subject]).toBeUndefined();
});

/**
 * A create whose answer was lost, behind the review gate as in the app: the
 * gate holds its resumption, as the GitHub transport's journal would refuse
 * it. `journal` stands in for that journal: what each create sent.
 */
async function uncertainCreate({ lands }) {
  const f = fixture();
  f.local.rows.set(1, issue(1, 'Written here'));
  const journal = new Map();
  const uncertain = {
    sent: async (_entity, subject) => journal.get(subject),
    forget: async (_entity, subject) => {
      journal.delete(subject);
    },
  };
  const approved = new Set();
  const open = () =>
    f.open({ remote: reviewGate(f.remote, approved), uncertain });
  const bridge = open();
  await bridge.sync();
  const [proposal] = bridge.held.values();
  approved.add(proposal.key);
  const subject = proposal.subject;
  const create = f.remote.create;

  if (lands) f.remote.lose = true;
  else
    f.remote.create = async () => {
      throw new Error('Lost response');
    };

  journal.set(subject, { title: 'Written here', body: '' });
  await expect(open().sync()).rejects.toThrow('Lost response');
  f.remote.create = create;
  approved.clear();

  return { f, open, subject, approved, journal };
}

it('offers the issue an uncertain create became, without importing it, and binds it on request', async () => {
  const { f, open, subject } = await uncertainCreate({ lands: true });
  f.remote.rows.set(2, issue(2, 'Someone else’s'));
  const bridge = open();
  await bridge.sync();

  // Not imported as a second row, not offered for sending again.
  expect([...f.local.rows.values()].map(r => r.value.title).sort()).toEqual([
    'Someone else’s',
    'Written here',
  ]);
  expect(bridge.held.size).toBe(0);
  const [unsettled] = bridge.unsettled.values();
  expect(unsettled).toMatchObject({
    subject,
    entity: 'issue',
    sent: { title: 'Written here', body: '' },
  });
  expect(unsettled.candidates.map(c => c.id)).toEqual([1]);

  await expect(bridge.landed(subject, 2)).rejects.toThrow(/Already bound: #2/);
  await bridge.landed(subject, 1);
  expect(bridge.id('remote', 'issue', subject)).toBe(1);
  await expect(bridge.landed(subject, 1)).rejects.toThrow(/No uncertain/);

  const writes = f.remote.writes;
  const after = open();
  await after.sync();
  expect(after.unsettled.size).toBe(0);
  expect(after.held.size).toBe(0);
  expect(f.local.rows.size).toBe(2);
  expect(f.remote.writes).toBe(writes);

  // Bound like any synced record: a later edit here is proposed as an update.
  f.local.rows.get(1).value.title = 'Renamed here';
  const edited = open();
  await edited.sync();
  expect([...edited.held.values()]).toMatchObject([
    { subject, remoteId: 1, after: { title: 'Renamed here' } },
  ]);
});

it('creates again only after a person says an uncertain create did not arrive', async () => {
  const { f, open, subject, approved, journal } = await uncertainCreate({
    lands: false,
  });
  let bridge = open();
  await bridge.sync();
  expect(bridge.unsettled.get(subject).candidates).toEqual([]);
  expect(bridge.held.size).toBe(0);

  // A matching issue shows up: that is the answer, not a second create.
  f.remote.rows.set(7, issue(7, 'Written here'));
  await expect(bridge.notArrived(subject)).rejects.toThrow(
    /may have landed: #7/,
  );
  expect(journal.has(subject)).toBe(true);
  f.remote.rows.delete(7);

  await bridge.notArrived(subject);
  expect(journal.has(subject)).toBe(false);
  bridge = open();
  await bridge.sync();
  const [proposal] = bridge.held.values();
  expect(proposal).toMatchObject({ subject, after: { title: 'Written here' } });
  expect(proposal.unconfirmed).toBeUndefined();
  approved.add(proposal.key);
  await open().sync();
  expect([...f.remote.rows.values()].map(r => r.value.title)).toEqual([
    'Written here',
  ]);
});
