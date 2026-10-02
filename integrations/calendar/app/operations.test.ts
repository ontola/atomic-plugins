// @wc-ignore-file
// @vitest-environment jsdom
/**
 * The app's declared scope (`operations.ts`) against three things: what the
 * relay accepts, what the composed proxy catalog permits, and what the app
 * actually does across its whole flow against the fake store (which answers
 * from the same fixture the mock proxy serves). The calendar lane's e2e
 * (`../e2e/calendar.spec.ts`) checks the same declaration against the mock
 * proxy's record of what the real plugin frame sent.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PRIMARY } from '../fixtures/google-calendar/scenario.mjs';
import { createController } from './controller.js';
import { fakeStore, type FakeStore } from './fakeStore.js';
import { view } from './main.js';
import {
  HOST_OPERATIONS,
  OPERATIONS,
  operationFor,
  PLATFORM,
  SCOPES,
  type RelayRequest,
} from './operations.js';
import type { HostProxyRequest } from './store.js';

// Paths, not URLs: under jsdom `URL` is the DOM's, which node:fs refuses.
const here = dirname(fileURLToPath(import.meta.url));
const COMPOSED = resolve(
  here,
  '../../../integration-proxy/tests/identity-catalog/google-calendar-composed.yaml',
);
const AUTH_OVERLAY = resolve(
  here,
  '../../../overlays/APIs/googleapis.com/calendar/v3/auth-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml',
);
const AUTH = 'https://www.googleapis.com/auth/';

const events = (id = 'primary') => `/calendar/v3/calendars/${id}/events`;
const list = (extra: Record<string, string> = {}): RelayRequest => ({
  method: 'GET',
  path: events(),
  query: {
    singleEvents: 'false',
    showDeleted: 'true',
    maxResults: '250',
    ...extra,
  },
});
const patch = (extra: Partial<RelayRequest> = {}): RelayRequest => ({
  method: 'PATCH',
  path: `${events()}/timed`,
  query: { sendUpdates: 'none' },
  ifMatch: '"v1"',
  ...extra,
});

describe('operationFor: the relay accepts the declared scope and nothing else', () => {
  it('accepts the three operations, with their fixed and varying query parameters', () => {
    expect(
      operationFor({
        method: 'GET',
        path: '/calendar/v3/users/me/calendarList',
        query: { maxResults: '250' },
      }).id,
    ).toBe('calendarList.list');
    expect(
      operationFor({
        method: 'get',
        path: '/calendar/v3/users/me/calendarList',
        query: { maxResults: '250', pageToken: 'next' },
      }).id,
    ).toBe('calendarList.list');
    expect(operationFor(list()).id).toBe('events.list');
    expect(operationFor(list({ pageToken: '250' })).id).toBe('events.list');
    expect(
      operationFor({ ...list(), path: events('team%40example.com') }).id,
    ).toBe('events.list');
    expect(operationFor(patch()).id).toBe('events.patch');
    expect(OPERATIONS.map(o => o.id)).toEqual([
      'calendarList.list',
      'events.list',
      'events.patch',
    ]);
    expect(SCOPES).toEqual([
      'calendar.calendarlist.readonly',
      'calendar.events',
    ]);
  });

  it('refuses other methods and paths: no create, delete, single read, or other resource', () => {
    const refused = (request: RelayRequest) =>
      expect(() => operationFor(request)).toThrow(/does not send/);
    refused({ method: 'POST', path: events(), query: {} });
    refused({ method: 'DELETE', path: `${events()}/timed`, ifMatch: '"v1"' });
    refused({ method: 'PUT', path: `${events()}/timed`, ifMatch: '"v1"' });
    refused({ method: 'GET', path: `${events()}/timed` });
    refused({ method: 'GET', path: `${events()}/timed/instances` });
    refused({ method: 'GET', path: '/calendar/v3/colors' });
    refused({ method: 'GET', path: '/calendar/v3/calendars/primary' });
    refused({ method: 'PATCH', path: '/calendar/v3/calendars/primary' });
    refused({ method: 'GET', path: '/users/me/calendarList' });
    refused({ method: 'GET', path: '/calendar/v3/users/me/calendarList/x' });
    // A calendar id is one path segment: the adapter encodes it.
    refused({ ...list(), path: events('a/b') });
  });

  it('refuses query parameters it does not declare, and other values for the fixed ones', () => {
    expect(() =>
      operationFor(list({ timeMin: '2026-01-01T00:00:00Z' })),
    ).toThrow(/does not send events.list with timeMin/);
    expect(() => operationFor(list({ singleEvents: 'true' }))).toThrow(
      /singleEvents=false, not singleEvents=true/,
    );
    expect(() => operationFor(list({ maxResults: '2500' }))).toThrow(
      /maxResults=250/,
    );
    expect(() =>
      operationFor({ ...list(), query: { maxResults: '250' } }),
    ).toThrow(/only with singleEvents=false/);
    expect(() =>
      operationFor(patch({ query: { sendUpdates: 'all' } })),
    ).toThrow(/sendUpdates=none, not sendUpdates=all/);
    expect(() => operationFor(patch({ query: {} }))).toThrow(
      /only with sendUpdates=none/,
    );
    expect(() =>
      operationFor(patch({ query: { sendUpdates: 'none', alt: 'json' } })),
    ).toThrow(/does not send events.patch with alt/);
  });

  it('refuses a write without If-Match', () => {
    expect(() => operationFor(patch({ ifMatch: undefined }))).toThrow(
      /without If-Match/,
    );
  });
});

/**
 * One operation of the composed proxy catalog, read from the checked-in
 * composition. The file is a YAML dumper's output (two-space indentation, one
 * key per line), which is what this line reader relies on; it is not a YAML
 * parser. A reshaped composition fails these tests loudly, by finding no
 * operation.
 */
function composedOperation(template: string, method: string) {
  const lines = readFileSync(COMPOSED, 'utf8').split('\n');
  const pathAt = lines.indexOf(`  ${template}:`);
  if (pathAt < 0) throw new Error(`composed catalog has no path ${template}`);
  let methodAt = -1;

  for (let i = pathAt + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i++)
    if (lines[i] === `    ${method.toLowerCase()}:`) {
      methodAt = i;
      break;
    }

  if (methodAt < 0)
    throw new Error(`composed catalog has no ${method} ${template}`);
  const block: string[] = [];

  for (
    let i = methodAt + 1;
    i < lines.length && !/^ {0,4}\S/.test(lines[i]);
    i++
  )
    block.push(lines[i]);

  const operationId = block
    .find(l => l.startsWith('      operationId: '))
    ?.slice('      operationId: '.length);
  const parameters: Record<string, { enum?: string[] }> = {};
  let current: { enum?: string[] } | undefined;
  let inEnum = false;
  const scopes: Record<string, string[]> = {};
  let scheme: string | undefined;
  let section: string | undefined;
  const responses: string[] = [];
  let requestBodyJson = false;

  for (const line of block) {
    const top = line.match(/^ {6}(\w+):/);

    if (top) {
      section = top[1];
      current = undefined;
      scheme = undefined;
      continue;
    }

    if (section === 'parameters') {
      if (/^ {6}- /.test(line)) {
        current = {};
        inEnum = false;
      }

      const name = line.match(/^ {8}name: (\w+)$/);
      if (name && current) parameters[name[1]] = current;

      if (/^ {10}enum:$/.test(line) && current) {
        current.enum = [];
        inEnum = true;
      } else if (inEnum) {
        const value = line.match(/^ {10}- (\S+)$/);
        if (value) current!.enum!.push(value[1]);
        else inEnum = false;
      }
    } else if (section === 'security') {
      const named = line.match(/^ {6}- (\w+):$/);

      if (named) {
        scheme = named[1];
        scopes[scheme] = [];
      } else if (scheme) {
        const scope = line.match(/^ {8}- (\S+)$/);
        if (scope) scopes[scheme].push(scope[1]);
      }
    } else if (section === 'responses') {
      const status = line.match(/^ {8}'(\d{3})':/);
      if (status) responses.push(status[1]);
    } else if (section === 'requestBody') {
      if (/^ {10}application\/json:$/.test(line)) requestBodyJson = true;
    }
  }

  return { operationId, parameters, scopes, responses, requestBodyJson };
}

describe('the composed proxy catalog permits every declared operation', () => {
  it('serves the operations under the relay base', () => {
    const text = readFileSync(COMPOSED, 'utf8');
    expect(text).toMatch(
      /^servers:\n- url: https:\/\/www\.googleapis\.com\/calendar\/v3$/m,
    );
  });

  for (const op of OPERATIONS)
    it(`${op.method} ${op.template} is calendar.${op.id}, scope ${op.scope}, with the parameters the app sends`, () => {
      const found = composedOperation(op.template, op.method);
      expect(found.operationId).toBe(`calendar.${op.id}`);
      // The proxy authorises against `googleOffline` (its catalog config);
      // both schemes name the one scope the operation needs.
      expect(found.scopes).toEqual({
        googleOnline: [`${AUTH}${op.scope}`],
        googleOffline: [`${AUTH}${op.scope}`],
      });

      for (const name of [...Object.keys(op.fixedQuery), ...op.query])
        expect(
          Object.keys(found.parameters),
          `${op.id} declares ${name}`,
        ).toContain(name);

      for (const [name, value] of Object.entries(op.fixedQuery)) {
        const allowed = found.parameters[name]?.enum;
        if (allowed) expect(allowed, `${op.id} ${name}`).toContain(value);
      }

      if (op.effect === 'write') {
        expect(found.requestBodyJson).toBe(true);
        expect(found.responses, 'a 412 for a failed If-Match').toContain('412');
      }
    });

  it('the auth overlay asks Google for exactly the declared scopes', () => {
    const text = readFileSync(AUTH_OVERLAY, 'utf8');
    const asked = [
      ...new Set(
        [
          ...text.matchAll(
            /^ {12}(https:\/\/www\.googleapis\.com\/auth\/[\w.]+):/gm,
          ),
        ].map(m => m[1].slice(AUTH.length)),
      ),
    ].sort();
    expect(asked).toEqual([...SCOPES]);
  });
});

/** Records which members of the host's store (and its proxy) the app touched. */
function recording(store: FakeStore) {
  const touched = { store: new Set<string>(), proxy: new Set<string>() };
  const proxy = new Proxy(store.proxy!, {
    get(target, key) {
      if (typeof key === 'string') touched.proxy.add(key);

      return Reflect.get(target, key);
    },
  });
  const wrapped = new Proxy(store, {
    get(target, key) {
      if (key === 'proxy') {
        touched.store.add('proxy');

        return proxy;
      }

      if (typeof key === 'string') touched.store.add(key);

      return Reflect.get(target, key);
    },
  }) as FakeStore;

  return { store: wrapped, touched };
}

const tick = () => new Promise(r => setTimeout(r, 0));

/** The members of a FakeStore that exist only for tests, never on a host. */
const TEST_ONLY = new Set([
  'resources',
  'writes',
  'calls',
  'google',
  'opened',
  'loseNextWriteResponse',
  'reconnect',
  'revoke',
  'answerNext',
  'throwNext',
  'setTheme',
]);

describe('the app uses every declared operation and nothing undeclared', () => {
  afterEach(() => document.body.replaceChildren());

  it('provider: one whole flow (list calendars, import, refresh, review, send) is exactly the three operations', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {});
    await controller.load();
    await controller.choose(PRIMARY);
    store.google.editRemote('timed', { location: 'Room 2' });
    await controller.refresh();
    const timed = controller
      .snapshot()
      .events.find(e => e.title === 'Calendar timed fixture')!;
    await controller.saveEvent(timed.subject, { ...timed, title: 'Renamed' });
    await controller.prepareReview();
    await controller.send();
    expect(store.google.writes).toEqual([
      expect.objectContaining({ id: 'timed', patch: { summary: 'Renamed' } }),
    ]);

    const used = new Set<string>();

    for (const call of store.calls) {
      expect(call.platform).toBe(PLATFORM);
      // The frame's request carries a connection reference and the fields
      // below; no header, no credential (`HostProxyRequest` in store.ts).
      expect(
        Object.keys(call).every(key =>
          [
            'platform',
            'connectionId',
            'path',
            'method',
            'query',
            'body',
            'ifMatch',
          ].includes(key),
        ),
        JSON.stringify(call),
      ).toBe(true);
      used.add(operationFor(asRelayRequest(call)).id);
    }

    expect([...used].sort()).toEqual(OPERATIONS.map(o => o.id).sort());
    expect(store.calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('host: the controller and the view touch exactly the declared store and proxy members', async () => {
    // The controller's part: connect state, calendars, import, review, send,
    // the host hand-offs and Disconnect.
    const flow = recording(fakeStore());
    const controller = createController(flow.store, () => {});
    await controller.load();
    await controller.choose(PRIMARY);
    await controller.refresh();
    const timed = controller
      .snapshot()
      .events.find(e => e.title === 'Calendar timed fixture')!;
    await controller.saveEvent(timed.subject, { ...timed, title: 'Renamed' });
    await controller.prepareReview();
    await controller.send();
    expect(await controller.openLink(timed)).toBe('opened');
    expect(await controller.openInHost()).toBe(true);
    await controller.disconnect();
    // Connect shows the host's consent bar; in the fake it never settles.
    void controller.connect();
    controller.cancelConnect();

    // The view's part: the theme, read at mount and followed afterwards.
    const mounted = recording(fakeStore());
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    await view({ root, store: mounted.store });
    for (let i = 0; i < 4; i++) await tick();

    const declared = {
      store: [
        ...HOST_OPERATIONS.store,
        ...HOST_OPERATIONS.optional.store,
        'proxy',
      ].sort(),
      proxy: [
        ...HOST_OPERATIONS.proxy,
        ...HOST_OPERATIONS.optional.proxy,
      ].sort(),
    };
    const touched = {
      store: [...new Set([...flow.touched.store, ...mounted.touched.store])]
        .filter(key => !TEST_ONLY.has(key))
        .sort(),
      proxy: [
        ...new Set([...flow.touched.proxy, ...mounted.touched.proxy]),
      ].sort(),
    };
    expect(touched).toEqual(declared);
  });
});

function asRelayRequest(call: HostProxyRequest): RelayRequest {
  return {
    method: call.method ?? 'GET',
    path: call.path,
    ...(call.query ? { query: call.query } : {}),
    ...(call.ifMatch ? { ifMatch: call.ifMatch } : {}),
  };
}
