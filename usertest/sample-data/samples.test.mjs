// The sample accounts (proxy.mjs and the four providers) against an
// in-memory stand-in for the host's store: connecting, reading, and writes
// that survive the frame being remounted. No browser, no atomic-server:
//
//   node --test usertest/sample-data/samples.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import calendar from './calendar.mjs';
import issueTracker from './issue-tracker.mjs';
import notion from './notion.mjs';
import { sampleAccount, withSampleProxy } from './proxy.mjs';
import timesheets from './timesheets.mjs';

const NAME = 'https://atomicdata.dev/properties/name';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const PARENT = 'https://atomicdata.dev/properties/parent';
const APP = 'https://drive.test/app';

/** What `view-client.js` offers, as far as proxy.mjs uses it. */
function hostStore() {
  const resources = new Map();
  let next = 0;
  const wrap = subject => {
    const props = resources.get(subject);

    return {
      subject,
      props,
      get: p => props[p],
      set(p, v) {
        props[p] = v;
        return this;
      },
      async save() {
        resources.set(subject, { ...props });
        return this;
      },
    };
  };

  return {
    resources,
    async getApp() {
      return APP;
    },
    async query({ property, value }) {
      return [...resources]
        .filter(([, props]) => props[property] === value)
        .map(([s]) => s);
    },
    async getResource(subject) {
      return wrap(subject);
    },
    async newResource({ parent, propVals = {} } = {}) {
      const subject = `https://drive.test/r${++next}`;
      resources.set(subject, { ...propVals, [PARENT]: parent ?? APP });
      return wrap(subject);
    },
  };
}

const json = text => JSON.stringify(text);

async function connected(store, provider) {
  const { proxy } = sampleAccount(store, provider);
  const [first] = await proxy.connections({ platform: provider.platform });
  assert.equal(first?.platform, provider.platform, 'starts connected');
  await proxy.disconnect({ platform: provider.platform });
  assert.deepEqual(
    await proxy.connections({ platform: provider.platform }),
    [],
    'disconnects',
  );
  const result = await proxy.connect({ platform: provider.platform });
  assert.equal(result.status, 'connected');
  assert.deepEqual(await proxy.connections({ platform: provider.platform }), [
    { platform: provider.platform, connectionId: result.connectionId },
  ]);

  return { proxy, connectionId: result.connectionId };
}

/** A second mount of the app, as after leaving it and coming back. */
const remount = (store, provider) => sampleAccount(store, provider).proxy;

test('calendar: invented events, a PATCH kept across a remount', async () => {
  const store = hostStore();
  const { proxy, connectionId } = await connected(store, calendar);
  const ask = (p, req) =>
    p.request({ platform: 'google-calendar', connectionId, ...req });

  const list = await ask(proxy, { path: '/calendar/v3/users/me/calendarList' });
  assert.deepEqual(
    list.body.items.map(c => c.summary),
    ['Acme Studio', 'Acme team'],
  );
  const day = new Date().toISOString().slice(0, 10);
  const query = {
    singleEvents: 'true',
    showDeleted: 'true',
    timeMin: `${day}T00:00:00Z`,
    timeMax: '2100-01-01T00:00:00Z',
    maxResults: '250',
  };
  const titles = [];
  let pageToken;
  do {
    const page = await ask(proxy, {
      path: '/calendar/v3/calendars/primary/events',
      query: { ...query, ...(pageToken ? { pageToken } : {}) },
    });
    assert.equal(page.status, 200);
    titles.push(...page.body.items.map(e => e.summary));
    pageToken = page.body.nextPageToken;
  } while (pageToken);
  assert.ok(titles.includes('Design review: Bakkerij Zonnig packaging'));
  assert.ok(!titles.some(t => /fixture/i.test(t ?? '')), titles.join());

  const path = '/calendar/v3/calendars/primary/events/review-zonnig';
  const before = await ask(proxy, { path });
  const patched = await ask(proxy, {
    method: 'PATCH',
    path,
    ifMatch: before.headers.etag,
    body: json({ summary: 'Design review: labels' }),
  });
  assert.equal(patched.status, 200);

  const again = remount(store, calendar);
  assert.equal(
    (await again.connections({ platform: 'google-calendar' })).length,
    1,
    'still connected',
  );
  const after = await ask(again, { path });
  assert.equal(after.body.summary, 'Design review: labels');
  assert.equal(after.headers.etag, patched.headers.etag);
  // A stale If-Match is still refused after the replay.
  const stale = await ask(again, {
    method: 'PATCH',
    path,
    ifMatch: before.headers.etag,
    body: json({ summary: 'x' }),
  });
  assert.equal(stale.status, 412);
});

test('issue-tracker: acme-studio repositories, writes replayed with their dates', async () => {
  const store = hostStore();
  const { proxy, connectionId } = await connected(store, issueTracker);
  const ask = (p, req) =>
    p.request({ platform: 'github-issues', connectionId, ...req });

  const repos = await ask(proxy, { path: '/user/repos' });
  assert.deepEqual(
    repos.body.map(r => r.full_name),
    ['acme-studio/website', 'acme-studio/brand-guide', 'acme-studio/old-site'],
  );
  const issues = '/repos/acme-studio/website/issues';
  const created = await ask(proxy, {
    method: 'POST',
    path: issues,
    body: json({ title: 'Footer logo is blurry', body: 'On retina screens.' }),
  });
  assert.equal(created.status, 201);
  const closed = await ask(proxy, {
    method: 'PATCH',
    path: `${issues}/1`,
    body: json({ state: 'closed' }),
  });
  assert.equal(closed.status, 200);
  const list = await ask(proxy, { path: issues, query: { state: 'all' } });

  await new Promise(resolve => setTimeout(resolve, 5));
  const again = remount(store, issueTracker);
  const replayed = await ask(again, { path: issues, query: { state: 'all' } });
  assert.deepEqual(replayed.body, list.body);
});

test('timesheets: an invented fortnight, an edit kept across a remount', async () => {
  const store = hostStore();
  const { proxy, connectionId } = await connected(store, timesheets);
  const ask = (p, req) =>
    p.request({ platform: 'clockify', connectionId, ...req });

  const user = await ask(proxy, { path: '/api/v1/user' });
  assert.equal(user.body.name, 'Alex Sample');
  const ws = user.body.activeWorkspace;
  const entries = `/api/v1/workspaces/${ws}/user/${user.body.id}/time-entries`;
  const window = {
    start: new Date(Date.now() - 14 * 86_400_000).toISOString(),
    end: new Date().toISOString(),
  };
  const list = await ask(proxy, { path: entries, query: window });
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.ok(list.body.length >= 10, `${list.body.length} entries`);
  const first = list.body.find(e => e.id === 'sample-01');
  const put = await ask(proxy, {
    method: 'PUT',
    path: `/api/v1/workspaces/${ws}/time-entries/sample-01`,
    body: json({
      start: first.timeInterval.start,
      end: first.timeInterval.end,
      description: 'Product page layout and copy',
      projectId: first.projectId,
      billable: true,
    }),
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  const again = remount(store, timesheets);
  const after = await ask(again, { path: entries, query: window });
  assert.equal(
    after.body.find(e => e.id === 'sample-01').description,
    'Product page layout and copy',
  );
});

test('notion: reads both databases, keeps no write log', async () => {
  const store = hostStore();
  const { proxy, connectionId } = await connected(store, notion);
  const search = await proxy.request({
    platform: 'notion',
    connectionId,
    method: 'POST',
    path: '/v1/search',
    body: json({ filter: { property: 'object', value: 'data_source' } }),
  });
  assert.equal(search.status, 200);
  assert.equal(search.body.results.length, 2);
  const [saved] = [...store.resources.values()];
  assert.deepEqual(JSON.parse(saved[DESCRIPTION]).writes, []);
});

test('notion: a page PATCH is kept across a remount', async () => {
  const store = hostStore();
  const { proxy, connectionId } = await connected(store, notion);
  const ask = (p, req) =>
    p.request({ platform: 'notion', connectionId, ...req });
  const path = '/v1/pages/1a2b3c4d-0000-4000-8000-000000000001';
  const patched = await ask(proxy, {
    method: 'PATCH',
    path,
    body: json({ properties: { 'n%3D1': { number: 8 } } }),
  });
  assert.equal(patched.status, 200);

  const again = remount(store, notion);
  const page = await ask(again, { path });
  assert.equal(page.body.properties.Points.number, 8);
  assert.equal(page.body.last_edited_time, patched.body.last_edited_time);
});

test('the state lives in one resource under the app; a wrong connection gets nothing', async () => {
  const store = hostStore();
  const { proxy } = await connected(store, calendar);
  const res = await proxy.request({
    platform: 'google-calendar',
    connectionId: 'someone-else',
    path: '/calendar/v3/users/me/calendarList',
  });
  assert.equal(res.status, 404);
  await proxy.disconnect({ platform: 'google-calendar' });
  assert.equal(store.resources.size, 1);
  const [props] = [...store.resources.values()];
  assert.equal(props[PARENT], APP);
  assert.equal(props[NAME], 'Sample Google Calendar account (user testing)');
  assert.equal(JSON.parse(props[DESCRIPTION]).connected, false);
});

test('withSampleProxy keeps the host store and replaces only proxy', async () => {
  const host = { proxy: 'real', getApp: async () => APP };
  const store = withSampleProxy(host, 'sample');
  assert.equal(store.proxy, 'sample');
  assert.equal(await store.getApp(), APP);
  assert.ok('proxy' in store);
});
