import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GitAtomicStore } from '../../../src/daemon/git-store.js';
const directories: string[] = [];
const subject = 'urn:example:item:1';
const resource = (value: string): Map<string, string> =>
  new Map([[subject, `{"@id":"${subject}","urn:example:value":${value}}`]]);
const setup = async (): Promise<GitAtomicStore> => {
  const directory = await mkdtemp(join(tmpdir(), 'syncables-git-'));
  directories.push(directory);
  const store = new GitAtomicStore(join(directory, 'data.git'));
  await store.initialize();
  return store;
};
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe('local versioned Atomic Data snapshots', () => {
  it('pins resources and schemas to the commit resolved from a tag', async () => {
    const store = await setup();
    const schema = 'urn:example:schema';
    const base = {
      scope: 'versioned',
      context: {},
      resources: new Map([
        [subject, `{"@id":"${subject}","urn:example:schema":"${schema}"}`],
        [schema, `{"@id":"${schema}","urn:example:version":1}`],
      ]),
    };
    const first = await store.commit(base);
    await store.tag(base.scope, 'v1');
    const pin = await store.resolve(base.scope, subject, 'tag:v1');
    const updated = new Map(base.resources);
    updated.set(schema, `{"@id":"${schema}","urn:example:version":2}`);
    await store.commit({ ...base, resources: updated }, first);
    expect(pin.commit).toBe(first);
    expect(
      (await store.resolve(base.scope, schema, pin.commit)).resource,
    ).toContain(':1}');
    expect((await store.resolve(base.scope, schema)).resource).toContain(':2}');
    await expect(store.tag(base.scope, 'v1')).rejects.toThrow('Git');
    await expect(
      store.resolveRevision(base.scope, 'tag:../wrong'),
    ).rejects.toThrow('Invalid data tag');
    expect(await store.resolveRevision(base.scope, 'tag:v1')).toBe(first);
  });
  it('preserves JSON-AD, large numbers and A to B to A history after reopening', async () => {
    const store = await setup();
    const snapshot = {
      scope: 'owner/account/collection/v1',
      context: { definition: 1 },
      resources: resource('9007199254740993'),
    };
    const a = await store.commit(snapshot);
    expect(await store.commit(snapshot, a)).toBe(a);
    const b = await store.commit({ ...snapshot, resources: resource('2') }, a);
    const c = await store.commit(snapshot, b);
    expect(a).not.toBe(c);
    const reopened = new GitAtomicStore(store.directory);
    await reopened.initialize();
    expect(await reopened.history(snapshot.scope, subject)).toEqual([c, b, a]);
    expect(await reopened.resource(snapshot.scope, subject, b)).toContain(
      ':2}',
    );
    expect(await reopened.resource(snapshot.scope, subject, c)).toContain(
      '9007199254740993',
    );
    expect(await reopened.list(snapshot.scope)).toHaveLength(1);
  });
  it('publishes with compare-and-swap and rejects cross-scope revisions', async () => {
    const store = await setup();
    const base = { scope: 'one', context: {}, resources: resource('1') };
    const a = await store.commit(base);
    const next = await store.commit({ ...base, resources: resource('2') }, a);
    await expect(
      store.commit({ ...base, resources: resource('3') }, a),
    ).rejects.toThrow('changed');
    expect(await store.head('one')).toBe(next);
    const other = await store.commit({ ...base, scope: 'two' });
    await expect(store.list('one', other)).rejects.toThrow('does not belong');
  });
  it('records removal without losing the old resource', async () => {
    const store = await setup();
    const base = { scope: 'one', context: {}, resources: resource('1') };
    const a = await store.commit(base);
    await store.commit({ ...base, resources: new Map() }, a);
    expect(await store.resource('one', subject)).toBeUndefined();
    expect(await store.resource('one', subject, a)).toBeDefined();
  });
  it('refuses unrelated existing directories and invalid Atomic subjects/properties', async () => {
    const store = await setup();
    await expect(
      new GitAtomicStore(join(store.directory, '..')).initialize(),
    ).rejects.toThrow('existing repository');
    await expect(
      store.commit({
        scope: 'one',
        context: {},
        resources: new Map([['relative', '{}']]),
      }),
    ).rejects.toThrow('absolute IRI');
    await expect(
      store.commit({
        scope: 'one',
        context: {},
        resources: new Map([[subject, `{"@id":"${subject}","wrong":1}`]]),
      }),
    ).rejects.toThrow('property');
    expect(await store.head('one')).toBeUndefined();
  });
});
