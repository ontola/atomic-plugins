// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  prepareDocument,
  readCollections,
  type ApiClient,
  type ApiClientOptions,
  type MissingRecord,
  type OpenApiDocument,
  type StorageAdapter,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  calendarChangeList,
  completePets,
  completePetsLegacy,
  completePetsOverlay,
  completeProjectTasks,
  deletedItemsEndpoint,
  issuesDocument,
  projectEventLog,
  readTombstoneCalendar,
  readTombstoneOverlay,
  transactionsFeed,
  transactionsFeedOverlay,
  withoutDeclaration,
} from '../../fixtures/deletion-declarations.js';

// The deletion declarations of the draft Deletion Feeds and Collection
// Completeness extensions, run as the specs' own examples
// (`__tests__/fixtures/deletion-declarations.ts`) against invented
// providers: each test names the spec statement it checks. The second half
// runs pending-edit recovery (a write in flight across a restart, a lost
// answer, a refused write) on the same documents. Fixtures only; nothing
// here was checked against a real provider.

const OUTBOX = 'syncables:outbox';

/** An in-memory StorageAdapter whose state can be copied, as a crash leaves it. */
class CrashableStorage implements StorageAdapter {
  data = new Map<string, Map<string, Record<string, unknown>>>();
  private ns(resource: string): Map<string, Record<string, unknown>> {
    let ns = this.data.get(resource);
    if (!ns) this.data.set(resource, (ns = new Map()));
    return ns;
  }
  async list(resource: string): Promise<Record<string, unknown>[]> {
    return [...this.ns(resource).values()].map((v) => structuredClone(v));
  }
  async get(
    resource: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const value = this.ns(resource).get(id);
    return value && structuredClone(value);
  }
  async put(
    resource: string,
    id: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    this.ns(resource).set(id, structuredClone(value));
  }
  async delete(resource: string, id: string): Promise<void> {
    this.ns(resource).delete(id);
  }
  crash(): CrashableStorage {
    const copy = new CrashableStorage();
    for (const [name, records] of this.data)
      copy.data.set(name, new Map(structuredClone([...records])));
    return copy;
  }
  outbox(): Record<string, unknown> | undefined {
    return this.data.get(OUTBOX)?.get('outbox');
  }
}

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

const unavailable = (): TransportResponse =>
  json({ error: 'try later (invented)' }, 503);

type Answer = TransportResponse | 'hang' | undefined;

interface Fake {
  transport: Transport;
  /** Every request as `METHOD /path?query`, the server's base path removed. */
  requests: string[];
}

/**
 * A transport that routes to `handle` with the path relative to the
 * document's server. An unhandled request answers 405, so a test sees it.
 * 'hang' never answers.
 */
function fakeFor(
  doc: OpenApiDocument,
  handle: (r: TransportRequest, path: string, query: URLSearchParams) => Answer,
): Fake {
  const base = new URL(
    (doc.servers as { url: string }[])[0]!.url,
  ).pathname.replace(/\/$/, '');
  const requests: string[] = [];
  const transport: Transport = async (r) => {
    const path = r.url.pathname.startsWith(base)
      ? r.url.pathname.slice(base.length)
      : r.url.pathname;
    const query = r.url.searchParams;
    requests.push(`${r.method} ${path}${query.size ? `?${query}` : ''}`);
    const answer = handle(r, path, query);
    if (answer === 'hang') return new Promise<TransportResponse>(() => {});
    return answer ?? json({ error: `unhandled ${r.method} ${path}` }, 405);
  };
  return { transport, requests };
}

const settle = (ms = 20): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Writes fail with 503 and then wait a minute, so a held update is between retries. */
const slow: ApiClientOptions = { retry: { baseDelayMs: 60_000 } };

/** Queues an update of `id` and waits until its first attempt failed (503). */
async function hold(
  client: ApiClient,
  resource: string,
  id: string,
  context?: Record<string, string>,
): Promise<void> {
  await client.update(resource, id, { name: 'edited offline' }, context);
  await vi.waitFor(() =>
    expect(
      client.pendingWrites().find((w) => w.id === id && w.type === 'update')
        ?.attempts,
    ).toBe(1),
  );
  await settle(5);
}

type Row = Record<string, unknown>;

function outboxOf(storage: CrashableStorage): {
  feedCursors?: { cursor: string; operation: string }[];
  feedTombstones?: { tombstones: string[] }[];
} {
  return (storage.outbox() ?? {}) as ReturnType<typeof outboxOf>;
}

describe('Deletion Feeds §2: a change list whose feed is the collection list itself', () => {
  it('cannot read the list when its items are at a dot-path envelope (gap: the collection read does not use the Collection Object envelope)', async () => {
    // The feed read uses the declared `envelope.itemsField`
    // (`data.transactions`); the collection read of the same operation
    // locates items at a top-level array property or a common envelope
    // name only, so this list is never read completely, and the feed is
    // never read.
    const fake = fakeFor(transactionsFeed, (r, path) => {
      if (r.method === 'GET' && path === '/budgets/b1/transactions')
        return json({
          data: {
            transactions: [{ id: 't1', amount: '-1200', deleted: false }],
            server_knowledge: 12,
          },
        });
      return undefined;
    });
    const read = await readCollections(transactionsFeed, {
      transport: fake.transport,
      constants: { budgetId: 'b1' },
    });
    expect(read.collections).toMatchObject([
      {
        complete: false,
        items: [],
        error: expect.stringMatching(/Could not locate the items array/),
      },
    ]);
    fake.requests.length = 0;
    const client = createApiClient(transactionsFeed, {
      transport: fake.transport,
      constants: { budgetId: 'b1' },
    });
    await expect(client.sync()).rejects.toThrow(
      /Read incomplete: transactions: Could not locate the items array/,
    );
    // One list read; no feed read follows an incomplete collection read.
    expect(fake.requests).toEqual(['GET /budgets/b1/transactions']);
    expect(await client.list('transactions', { budgetId: 'b1' })).toEqual([]);
  });

  it('applies the §6 overlay to a document without the declaration, giving the §2 document', () => {
    const base = withoutDeclaration(transactionsFeed, 'x-deletion-feed');
    expect(base).not.toEqual(transactionsFeed);
    expect(prepareDocument(base, [transactionsFeedOverlay])).toEqual(
      transactionsFeed,
    );
  });
});

/**
 * The §7.1 calendar: events per calendar, cancelled ones logged with
 * `status: cancelled`, read as a change list with `syncToken`. Tokens are
 * `t<n>` for the log length n. An item GET of a cancelled event is 404.
 */
function calendar(
  initial: Row[],
  hooks: {
    item?: (id: string) => Answer;
    write?: (r: TransportRequest) => Answer;
    /** Answers a list read with this token (a 410, say). */
    expired?: (token: string) => Answer;
  } = {},
): Fake & {
  events: Map<string, Row>;
  log: Row[];
  cancel: (id: string) => void;
} {
  const events = new Map(initial.map((e) => [String(e['id']), e]));
  const log: Row[] = [];
  const fake = fakeFor(calendarChangeList, (r, path, query) => {
    const m = /^\/calendars\/c1\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return undefined;
    const id = m[1] && decodeURIComponent(m[1]);
    if (r.method === 'GET' && !id) {
      const token = query.get('syncToken');
      if (token === null)
        return json({
          items: [...events.values()],
          nextSyncToken: `t${log.length}`,
        });
      const refused = hooks.expired?.(token);
      if (refused) return refused;
      return json({
        items: log.slice(Number(token.slice(1))),
        nextSyncToken: `t${log.length}`,
      });
    }
    if (r.method === 'GET' && id) {
      const hooked = hooks.item?.(id);
      if (hooked) return hooked;
      const event = events.get(id);
      return event ? json(event) : json({ error: 'not found' }, 404);
    }
    const hooked = hooks.write?.(r);
    if (hooked) return hooked;
    if (r.method === 'PUT' && id) {
      if (!events.has(id)) return json({ error: 'not found' }, 404);
      const event = { ...JSON.parse(r.body ?? '{}'), id };
      events.set(id, event);
      return json(event);
    }
    return unavailable();
  });
  return {
    ...fake,
    events,
    log,
    cancel: (id): void => {
      events.delete(id);
      log.push({ id, status: 'cancelled' });
    },
  };
}

const e1 = { id: 'e1', summary: 'Standup', status: 'confirmed' };
const e2 = { id: 'e2', summary: 'Review', status: 'confirmed' };
const c1 = { calendarId: 'c1' };

describe('Deletion Feeds §7.1: a change list with a status marker', () => {
  it('reads the list without a token, keeps nextSyncToken as the cursor, and sends it on the next feed read', async () => {
    const fake = calendar([e1, e2]);
    const storage = new CrashableStorage();
    const client = createApiClient(calendarChangeList, {
      transport: fake.transport,
      constants: c1,
      storage,
    });
    await client.sync();
    // The collection read, then the feed read (the same operation, no
    // cursor yet).
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events',
    ]);
    expect(outboxOf(storage).feedCursors).toMatchObject([
      { cursor: 't0', operation: 'listEvents' },
    ]);
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events?syncToken=t0',
    ]);
  });

  it('fails a held update of an event the feed lists as cancelled, when its own GET did not decide', async () => {
    const reports: MissingRecord[] = [];
    const fake = calendar([e1, e2], { item: unavailable, write: unavailable });
    const client = createApiClient(calendarChangeList, {
      ...slow,
      transport: fake.transport,
      constants: c1,
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    await hold(client, 'events', 'e1', c1);
    fake.cancel('e1');
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events/e1',
      'GET /calendars/c1/events?syncToken=t0',
    ]);
    expect(reports).toEqual([
      {
        resource: 'events',
        id: 'e1',
        context: c1,
        evidence: 'deleted',
        source: 'feed',
      },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      {
        id: 'e1',
        state: 'failed',
        missingRecord: 'deleted',
        lastError: expect.stringMatching(
          /the deletion feed listEvents reports it deleted/,
        ),
      },
    ]);
  });

  it("lets the event's own GET (404) decide before the feed read, which still runs for its cursor", async () => {
    const reports: MissingRecord[] = [];
    const fake = calendar([e1, e2], { write: unavailable });
    const client = createApiClient(calendarChangeList, {
      ...slow,
      transport: fake.transport,
      constants: c1,
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    await hold(client, 'events', 'e1', c1);
    fake.cancel('e1');
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events/e1',
      'GET /calendars/c1/events?syncToken=t0',
    ]);
    expect(reports).toMatchObject([
      { id: 'e1', evidence: 'deleted', source: 'read', status: 404 },
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted', lastStatus: 404 },
    ]);
  });

  it('takes the cursor from the body of a 410, else drops it, and reads without one next (§4.2)', async () => {
    let refuse: Answer;
    const fake = calendar([e1], { expired: () => refuse });
    const storage = new CrashableStorage();
    const client = createApiClient(calendarChangeList, {
      transport: fake.transport,
      constants: c1,
      storage,
    });
    await client.sync();
    refuse = json({ nextSyncToken: 'fresh' }, 410);
    await client.sync();
    expect(outboxOf(storage).feedCursors).toMatchObject([{ cursor: 'fresh' }]);
    refuse = json({ error: 'Sync token is no longer valid' }, 410);
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events?syncToken=fresh',
    ]);
    expect(outboxOf(storage).feedCursors).toBeUndefined();
    refuse = undefined;
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events',
    ]);
  });
});

/**
 * The §7.2 project tool: tasks (by `gid`) in a project, and an event log
 * at `/projects/p1/events?sync=`, which answers 412 with a fresh token for
 * a missing or expired one. Tokens are `s<n>` for the log length n.
 */
function projectTool(
  initial: Row[],
  hooks: { item?: (gid: string) => Answer } = {},
): Fake & { tasks: Map<string, Row>; log: Row[] } {
  const tasks = new Map(initial.map((t) => [String(t['gid']), t]));
  const log: Row[] = [];
  const fake = fakeFor(projectEventLog, (r, path, query) => {
    if (r.method === 'GET' && path === '/projects/p1/tasks')
      return json([...tasks.values()]);
    if (r.method === 'GET' && path === '/projects/p1/events') {
      const sync = query.get('sync');
      if (sync === null || !/^s\d+$/.test(sync))
        return json(
          {
            sync: `s${log.length}`,
            errors: [{ message: 'Sync token invalid' }],
          },
          412,
        );
      return json({
        data: log.slice(Number(sync.slice(1))),
        sync: `s${log.length}`,
      });
    }
    const m = /^\/tasks\/([^/]+)$/.exec(path);
    if (m && r.method === 'GET') {
      const hooked = hooks.item?.(m[1]!);
      if (hooked) return hooked;
      const task = tasks.get(m[1]!);
      return task ? json(task) : json({ error: 'not found' }, 404);
    }
    return unavailable();
  });
  return { ...fake, tasks, log };
}

const g1 = { gid: 'g1', name: 'Write the plan' };
const g2 = { gid: 'g2', name: 'Review the plan' };
const p1 = { projectId: 'p1' };

describe('Deletion Feeds §7.2: an event log', () => {
  it('takes the fresh token of the first 412 as the cursor and sends it on the next read (§4.2), using no items of that answer', async () => {
    const fake = projectTool([g1, g2]);
    const storage = new CrashableStorage();
    const client = createApiClient(projectEventLog, {
      transport: fake.transport,
      constants: p1,
      storage,
    });
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /projects/p1/tasks',
      'GET /projects/p1/events',
    ]);
    expect(outboxOf(storage).feedCursors).toMatchObject([
      { cursor: 's0', operation: 'getProjectEvents' },
    ]);
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /projects/p1/tasks',
      'GET /projects/p1/events?sync=s0',
    ]);
  });

  it('finds the task an event is about at idField resource.gid, and fails its held update', async () => {
    const fake = projectTool([g1, g2], { item: unavailable });
    const client = createApiClient(projectEventLog, {
      ...slow,
      transport: fake.transport,
      constants: p1,
    });
    await client.sync();
    await hold(client, 'projectTasks', 'g1', p1);
    fake.tasks.delete('g1');
    fake.log.push({ action: 'deleted', resource: { gid: 'g1' } });
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { id: 'g1', state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('lastStatus');
  });

  it('does not take an "undeleted" after a "deleted" as a tombstone: the last item about the object decides (§4.1)', async () => {
    const fake = projectTool([g1, g2], { item: unavailable });
    const client = createApiClient(projectEventLog, {
      ...slow,
      transport: fake.transport,
      constants: p1,
    });
    await client.sync();
    await hold(client, 'projectTasks', 'g1', p1);
    // Deleted, restored, and then not in the list (filtered).
    fake.tasks.delete('g1');
    fake.log.push(
      { action: 'deleted', resource: { gid: 'g1' } },
      { action: 'undeleted', resource: { gid: 'g1' } },
    );
    await client.sync();
    // The GET did not decide (503), and the feed has no tombstone: unknown.
    expect(client.pendingWrites()).toMatchObject([
      { id: 'g1', state: 'failed', missingRecord: 'unknown', lastStatus: 503 },
    ]);
  });
});

/**
 * The §7.3 to-do API: tasks, and `/deleted-tasks?since=` listing deleted
 * tasks as `{ items: [{ id }], next }`. `next` is a number, the log length.
 */
function todo(
  initial: Row[],
  hooks: { item?: (id: string) => Answer } = {},
): Fake & { tasks: Map<string, Row>; deleted: Row[] } {
  const tasks = new Map(initial.map((t) => [String(t['id']), t]));
  const deleted: Row[] = [];
  const fake = fakeFor(deletedItemsEndpoint, (r, path, query) => {
    if (r.method === 'GET' && path === '/tasks')
      return json([...tasks.values()]);
    if (r.method === 'GET' && path === '/deleted-tasks') {
      const since = Number(query.get('since') ?? deleted.length);
      return json({ items: deleted.slice(since), next: deleted.length });
    }
    const m = /^\/tasks\/([^/]+)$/.exec(path);
    if (m && r.method === 'GET') {
      const hooked = hooks.item?.(m[1]!);
      if (hooked) return hooked;
      const task = tasks.get(m[1]!);
      return task ? json(task) : json({ error: 'not found' }, 404);
    }
    return unavailable();
  });
  return { ...fake, tasks, deleted };
}

const t1 = { id: 't1', name: 'Buy milk' };
const t2 = { id: 't2', name: 'Call back' };

describe('Deletion Feeds §7.3: a deleted-items endpoint', () => {
  it('treats every item as a tombstone without a tombstone field, and sends a numeric cursor back in its decimal form (§4.2)', async () => {
    const fake = todo([t1, t2], { item: unavailable });
    const storage = new CrashableStorage();
    const client = createApiClient(deletedItemsEndpoint, {
      ...slow,
      transport: fake.transport,
      storage,
    });
    await client.sync();
    expect(outboxOf(storage).feedCursors).toMatchObject([{ cursor: '0' }]);
    await hold(client, 'tasks', 't1');
    fake.tasks.delete('t1');
    fake.deleted.push({ id: 't1' });
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual([
      'GET /tasks',
      'GET /tasks/t1',
      'GET /deleted-tasks?since=0',
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { id: 't1', state: 'failed', missingRecord: 'deleted' },
    ]);
    expect(outboxOf(storage).feedCursors).toMatchObject([{ cursor: '1' }]);
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests).toEqual(['GET /tasks', 'GET /deleted-tasks?since=1']);
  });
});

/**
 * The §7.4 calendar: the list leaves cancelled events out, and a cancelled
 * event's own GET answers 200 with `{ id, status: "cancelled" }`.
 */
function tombstoneCalendar(
  doc: OpenApiDocument,
  initial: Row[],
  hooks: { item?: (id: string) => Answer; write?: () => Answer } = {},
): Fake & {
  events: Map<string, Row>;
  cancelled: Set<string>;
  hidden: Set<string>;
} {
  const events = new Map(initial.map((e) => [String(e['id']), e]));
  const cancelled = new Set<string>();
  const hidden = new Set<string>();
  const fake = fakeFor(doc, (r, path) => {
    const m = /^\/calendars\/c1\/events(?:\/([^/]+))?$/.exec(path);
    if (!m) return undefined;
    const id = m[1] && decodeURIComponent(m[1]);
    if (r.method === 'GET' && !id)
      return json(
        [...events.values()].filter(
          (e) =>
            !cancelled.has(String(e['id'])) && !hidden.has(String(e['id'])),
        ),
      );
    if (r.method === 'GET' && id) {
      const hooked = hooks.item?.(id);
      if (hooked) return hooked;
      if (cancelled.has(id)) return json({ id, status: 'cancelled' });
      const event = events.get(id);
      return event ? json(event) : json({ error: 'not found' }, 404);
    }
    return hooks.write?.() ?? unavailable();
  });
  return { ...fake, events, cancelled, hidden };
}

describe('Deletion Feeds §7.4: an item read that returns tombstones', () => {
  for (const [label, doc] of [
    ['declared on the resource', readTombstoneCalendar],
    [
      'declared by the §6 overlay',
      prepareDocument(
        withoutDeclaration(readTombstoneCalendar, 'x-read-tombstone'),
        [readTombstoneOverlay],
      ),
    ],
  ] as const)
    it(`fails a held update of an event whose GET answers 200 with status cancelled (${label})`, async () => {
      const reports: MissingRecord[] = [];
      const fake = tombstoneCalendar(doc, [e1, e2]);
      const client = createApiClient(doc, {
        ...slow,
        transport: fake.transport,
        constants: c1,
        onMissingRecord: (r) => reports.push(r),
      });
      await client.sync();
      await hold(client, 'events', 'e1', c1);
      fake.cancelled.add('e1');
      await client.sync();
      expect(reports).toEqual([
        {
          resource: 'events',
          id: 'e1',
          context: c1,
          evidence: 'deleted',
          source: 'read',
          status: 200,
        },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'deleted',
          lastStatus: 200,
          lastError: expect.stringMatching(/tombstone: status is "cancelled"/),
        },
      ]);
    });

  it('keeps a held update on an event whose GET answers 200 with another status: the list only leaves it out', async () => {
    const reports: MissingRecord[] = [];
    const fake = tombstoneCalendar(readTombstoneCalendar, [e1, e2]);
    const client = createApiClient(readTombstoneCalendar, {
      ...slow,
      transport: fake.transport,
      constants: c1,
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    await hold(client, 'events', 'e1', c1);
    fake.hidden.add('e1');
    await client.sync();
    expect(reports).toMatchObject([
      { id: 'e1', evidence: 'filtered', status: 200, record: e1 },
    ]);
    expect(client.pendingWrites()).toMatchObject([{ state: 'pending' }]);
    expect(client.pendingWrites()[0]).not.toHaveProperty('awaitingRefresh');
  });

  it('does not count a 200 whose body is about another event as a read tombstone (§9)', async () => {
    const fake = tombstoneCalendar(readTombstoneCalendar, [e1, e2], {
      item: () => json({ id: 'e2', status: 'cancelled' }),
    });
    const client = createApiClient(readTombstoneCalendar, {
      ...slow,
      transport: fake.transport,
      constants: c1,
    });
    await client.sync();
    await hold(client, 'events', 'e1', c1);
    fake.hidden.add('e1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'unknown', lastStatus: 200 },
    ]);
  });

  it('reads the event again for a later edit: a 200 without the marker supersedes the read tombstone (§4.4)', async () => {
    const fake = tombstoneCalendar(readTombstoneCalendar, [e1, e2]);
    const client = createApiClient(readTombstoneCalendar, {
      ...slow,
      transport: fake.transport,
      constants: c1,
    });
    await client.sync();
    await hold(client, 'events', 'e1', c1);
    fake.cancelled.add('e1');
    await client.sync();
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    // A new edit of the deleted event is held, not sent on it.
    await client.update('events', 'e1', { summary: 'Standup, moved' }, c1);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed' },
      { state: 'pending', awaitingRefresh: true },
    ]);
    // Restored by its organizer, but still left out of the list.
    fake.cancelled.delete('e1');
    fake.hidden.add('e1');
    fake.requests.length = 0;
    await client.sync();
    expect(fake.requests.slice(0, 2)).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events/e1',
    ]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed' },
      { state: 'pending' },
    ]);
    expect(client.pendingWrites()[1]).not.toHaveProperty('awaitingRefresh');
    await vi.waitFor(() =>
      expect(fake.requests).toContain('PUT /calendars/c1/events/e1'),
    );
  });
});

/** A fake for the Collection Completeness documents: one collection, item GET, PUT and DELETE. */
function store(
  doc: OpenApiDocument,
  listPath: string,
  itemPath: (id: string) => string,
  initial: Row[],
  hooks: { write?: (r: TransportRequest) => Answer } = {},
): Fake & { rows: Map<string, Row>; hidden: Set<string> } {
  const rows = new Map(initial.map((r) => [String(r['id']), r]));
  const hidden = new Set<string>();
  const fake = fakeFor(doc, (r, path) => {
    if (r.method === 'GET' && path === listPath)
      return json(
        [...rows.values()].filter((x) => !hidden.has(String(x['id']))),
      );
    const id = [...rows.keys(), ...hidden].find((k) => itemPath(k) === path);
    const hooked = hooks.write?.(r);
    if (hooked && r.method !== 'GET') return hooked;
    if (r.method === 'GET') {
      const row = id && rows.get(id);
      return row ? json(row) : json({ error: 'not found' }, 404);
    }
    return unavailable();
  });
  return { ...fake, rows, hidden };
}

const rex = { id: 'rex', name: 'Rex' };
const tom = { id: 'tom', name: 'Tom' };

describe('Collection Completeness: absent means deleted', () => {
  for (const [label, doc] of [
    ['§2, on the Collection Object', completePets],
    ['§2, on the list operation (no crudResources)', completePetsLegacy],
    [
      '§5 overlay',
      prepareDocument(withoutDeclaration(completePets, 'x-completeness'), [
        completePetsOverlay,
      ]),
    ],
  ] as const)
    it(`fails a held update of a pet absent from a complete read, without reading it (${label})`, async () => {
      const reports: MissingRecord[] = [];
      const fake = store(doc, '/pets', (id) => `/pets/${id}`, [rex, tom]);
      const resource = doc.components ? 'pets' : '/pets';
      const client = createApiClient(doc, {
        ...slow,
        transport: fake.transport,
        onMissingRecord: (r) => reports.push(r),
      });
      await client.sync();
      await hold(client, resource, 'rex');
      fake.rows.delete('rex');
      fake.requests.length = 0;
      await client.sync();
      expect(fake.requests).toEqual(['GET /pets']);
      expect(reports).toEqual([
        {
          resource,
          id: 'rex',
          evidence: 'deleted',
          source: 'declaration',
        },
      ]);
      expect(client.pendingWrites()).toMatchObject([
        {
          state: 'failed',
          missingRecord: 'deleted',
          lastError: expect.stringMatching(/deleted at the provider/),
        },
      ]);
      // Nothing is deleted locally: the edit stays visible.
      expect(await client.get(resource, 'rex')).toMatchObject({
        name: 'edited offline',
      });
    });

  it('§6: covers a nested collection whose items live at another URL (/tasks/{taskId}); with absent: removed that URL is read instead', async () => {
    const run = async (
      doc: OpenApiDocument,
    ): Promise<{ requests: string[]; reports: MissingRecord[] }> => {
      const reports: MissingRecord[] = [];
      const fake = store(doc, '/projects/p1/tasks', (id) => `/tasks/${id}`, [
        t1,
        t2,
      ]);
      const client = createApiClient(doc, {
        ...slow,
        transport: fake.transport,
        constants: p1,
        onMissingRecord: (r) => reports.push(r),
      });
      await client.sync();
      await hold(client, 'projectTasks', 't1', p1);
      fake.rows.delete('t1');
      fake.requests.length = 0;
      await client.sync();
      expect(client.pendingWrites()).toMatchObject([
        { state: 'failed', missingRecord: 'deleted' },
      ]);
      return { requests: fake.requests, reports };
    };
    const deleted = await run(completeProjectTasks);
    expect(deleted.requests).toEqual(['GET /projects/p1/tasks']);
    expect(deleted.reports).toMatchObject([
      { id: 't1', source: 'declaration', context: p1 },
    ]);
    const removed = structuredClone(completeProjectTasks);
    (
      (removed.components!['crudResources'] as Record<string, Row>)['task']![
        'collections'
      ] as Record<string, Row>
    )['projectTasks']!['x-completeness'] = { absent: 'removed' };
    const read = await run(removed);
    expect(read.requests).toEqual(['GET /projects/p1/tasks', 'GET /tasks/t1']);
    expect(read.reports).toMatchObject([
      { id: 't1', source: 'read', status: 404 },
    ]);
  });

  it('§4.1: applies a declaration on the Collection Object to its fixed x-list-query, but not one on the shared list operation', async () => {
    const run = async (
      doc: OpenApiDocument,
    ): Promise<{ requests: string[]; source: MissingRecord['source'] }> => {
      const reports: MissingRecord[] = [];
      const fake = store(
        doc,
        '/projects/p1/issues',
        (id) => `/projects/p1/issues/${id}`,
        [{ id: '7', title: 'Bug' }],
      );
      const client = createApiClient(doc, {
        ...slow,
        transport: fake.transport,
        constants: p1,
        onMissingRecord: (r) => reports.push(r),
      });
      await client.sync();
      await hold(client, 'allIssues', '7', p1);
      fake.rows.delete('7');
      fake.requests.length = 0;
      await client.sync();
      return { requests: fake.requests, source: reports[0]!.source };
    };
    const onCollection = await run(
      issuesDocument({ on: 'collection', absent: 'deleted' }),
    );
    expect(onCollection).toEqual({
      requests: ['GET /projects/p1/issues?state=all'],
      source: 'declaration',
    });
    const onOperation = await run(
      issuesDocument({ on: 'operation', absent: 'deleted' }),
    );
    expect(onOperation).toEqual({
      requests: [
        'GET /projects/p1/issues?state=all',
        'GET /projects/p1/issues/7',
      ],
      source: 'read',
    });
  });

  it('§7: draws no conclusion from an incomplete read: a failed list leaves the held update pending and reads nothing', async () => {
    const reports: MissingRecord[] = [];
    let listFails = false;
    const fake = fakeFor(completePets, (r, path) => {
      if (r.method === 'GET' && path === '/pets')
        return listFails ? json({ error: 'outage' }, 500) : json([rex, tom]);
      return unavailable();
    });
    const client = createApiClient(completePets, {
      ...slow,
      transport: fake.transport,
      onMissingRecord: (r) => reports.push(r),
    });
    await client.sync();
    await hold(client, 'pets', 'rex');
    listFails = true;
    fake.requests.length = 0;
    await expect(client.sync()).rejects.toThrow(/Read incomplete/);
    expect(fake.requests).toEqual(['GET /pets']);
    expect(reports).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { id: 'rex', state: 'pending', attempts: 1 },
    ]);
    expect(await client.list('pets')).toHaveLength(2);
  });
});

describe('pending-edit recovery on the spec documents', () => {
  it('a PUT in flight across a restart (§7.1): the restored update waits for a refresh and is replayed on the refreshed event', async () => {
    const storage = new CrashableStorage();
    const fake = calendar([e1, e2], {
      write: (r) => (r.method === 'PUT' ? 'hang' : undefined),
    });
    const first = createApiClient(calendarChangeList, {
      transport: fake.transport,
      constants: c1,
      storage,
    });
    await first.sync();
    await first.update('events', 'e1', { summary: 'Standup, moved' }, c1);
    await vi.waitFor(() =>
      expect(fake.requests).toContain('PUT /calendars/c1/events/e1'),
    );
    // The process dies with the PUT in flight. The provider did not apply
    // it, and someone else changed another field meanwhile.
    fake.events.set('e1', { ...e1, location: 'Room 2' });
    const puts: Row[] = [];
    const second = calendar([...fake.events.values()], {
      write: (r) => {
        if (r.method !== 'PUT') return undefined;
        puts.push(JSON.parse(r.body ?? '{}'));
        return undefined;
      },
    });
    const restarted = createApiClient(calendarChangeList, {
      transport: second.transport,
      constants: c1,
      storage: storage.crash(),
    });
    await restarted.ready();
    expect(restarted.pendingWrites()).toMatchObject([
      {
        id: 'e1',
        type: 'update',
        state: 'pending',
        attempts: 1,
        awaitingRefresh: true,
        lastError: expect.stringMatching(/in flight/),
      },
    ]);
    await settle();
    expect(second.requests).toEqual([]);
    await restarted.sync();
    await vi.waitFor(() => expect(restarted.pendingWrites()).toEqual([]));
    expect(puts).toEqual([
      {
        id: 'e1',
        summary: 'Standup, moved',
        status: 'confirmed',
        location: 'Room 2',
      },
    ]);
  });

  it('a PUT in flight across a restart, the event cancelled meanwhile (§7.1): the restored update fails on the 404, none is sent', async () => {
    const storage = new CrashableStorage();
    const fake = calendar([e1, e2], {
      write: (r) => (r.method === 'PUT' ? 'hang' : undefined),
    });
    const first = createApiClient(calendarChangeList, {
      transport: fake.transport,
      constants: c1,
      storage,
    });
    await first.sync();
    await first.update('events', 'e1', { summary: 'Standup, moved' }, c1);
    await first.update('events', 'e1', { location: 'Room 3' }, c1);
    await vi.waitFor(() =>
      expect(fake.requests).toContain('PUT /calendars/c1/events/e1'),
    );
    const second = calendar([e1, e2]);
    second.cancel('e1');
    const reports: MissingRecord[] = [];
    const restarted = createApiClient(calendarChangeList, {
      transport: second.transport,
      constants: c1,
      storage: storage.crash(),
      onMissingRecord: (r) => reports.push(r),
    });
    await restarted.ready();
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'pending', attempts: 1, awaitingRefresh: true },
      { state: 'pending', attempts: 0, awaitingRefresh: true },
    ]);
    await restarted.sync();
    // The feed read sends the cursor the first process stored.
    expect(second.requests).toEqual([
      'GET /calendars/c1/events',
      'GET /calendars/c1/events/e1',
      'GET /calendars/c1/events?syncToken=t0',
    ]);
    expect(reports).toMatchObject([
      { id: 'e1', evidence: 'deleted', source: 'read', status: 404 },
    ]);
    expect(restarted.pendingWrites()).toMatchObject([
      { state: 'failed', missingRecord: 'deleted' },
      { state: 'failed', missingRecord: 'deleted' },
    ]);
    await settle();
    expect(second.requests.filter((r) => r.startsWith('PUT'))).toEqual([]);
    // The edits stay visible until the app decides.
    expect(await restarted.get('events', 'e1', c1)).toMatchObject({
      summary: 'Standup, moved',
      location: 'Room 3',
    });
  });

  it('a lost answer: a PUT whose transport throws is retried, a POST becomes uncertain and is confirmable', async () => {
    const storage = new CrashableStorage();
    let lose = false;
    const posts: string[] = [];
    const fake = fakeFor(completePets, (r, path) => {
      if (r.method === 'GET' && path === '/pets') return json([rex, tom]);
      if (lose) throw new Error('socket hang up (invented)');
      if (r.method === 'POST') {
        posts.push(r.body ?? '');
        return json({ id: 'srv-1', ...JSON.parse(r.body ?? '{}') }, 201);
      }
      return json({ ...JSON.parse(r.body ?? '{}') });
    });
    const client = createApiClient(completePets, {
      ...slow,
      transport: fake.transport,
      storage,
    });
    await client.sync();
    lose = true;
    await client.update('pets', 'rex', { name: 'Rex II' });
    const created = await client.create('pets', { name: 'Milo' });
    await vi.waitFor(() =>
      expect(client.pendingWrites().map((w) => w.state)).toEqual([
        'pending',
        'uncertain',
      ]),
    );
    expect(client.pendingWrites()).toMatchObject([
      {
        id: 'rex',
        type: 'update',
        attempts: 1,
        lastError: expect.stringMatching(/socket hang up/),
      },
      { id: created['id'], type: 'create', attempts: 1 },
    ]);
    lose = false;
    await settle();
    // Neither is resent on its own: the update waits out its backoff, the
    // create waits for a decision.
    expect(fake.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1);
    await client.resolveWrite('pets', String(created['id']), {
      action: 'confirm',
      id: 'srv-1',
    });
    // The move to the server id is applied by the queue, without a request.
    await vi.waitFor(async () =>
      expect(await client.get('pets', 'srv-1')).toMatchObject({ name: 'Milo' }),
    );
    expect(client.pendingWrites().map((w) => w.type)).toEqual(['update']);
    expect(fake.requests.filter((r) => r.startsWith('POST'))).toHaveLength(1);
    // The same state survives a restart: the update waits for a refresh.
    const restarted = createApiClient(completePets, {
      transport: fake.transport,
      storage: storage.crash(),
    });
    await restarted.ready();
    expect(restarted.pendingWrites()).toMatchObject([
      { id: 'rex', type: 'update', state: 'pending', awaitingRefresh: true },
    ]);
    await restarted.sync();
    await vi.waitFor(() => expect(restarted.pendingWrites()).toEqual([]));
    expect(fake.requests.filter((r) => r === 'PUT /pets/rex')).toHaveLength(2);
  });

  it('a refused write: a 422 fails the update at once, a DELETE answered 404 is satisfied, and a 403 blocks the client', async () => {
    const answers = new Map<string, TransportResponse>();
    const fake = store(
      completePets,
      '/pets',
      (id) => `/pets/${id}`,
      [rex, tom],
      {
        write: (r) => answers.get(`${r.method} ${r.url.pathname}`),
      },
    );
    const blocks: number[] = [];
    const client = createApiClient(completePets, {
      ...slow,
      transport: fake.transport,
      onAuthBlocked: (b) => blocks.push(b.status),
    });
    await client.sync();
    answers.set(
      'PUT /api/pets/rex',
      json({ error: 'name must not be empty' }, 422),
    );
    await client.update('pets', 'rex', { name: '' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: 'rex', state: 'failed', attempts: 1, lastStatus: 422 },
      ]),
    );
    await settle();
    expect(fake.requests.filter((r) => r === 'PUT /pets/rex')).toHaveLength(1);
    // Someone deleted tom meanwhile; the local delete is then satisfied.
    answers.set('DELETE /api/pets/tom', json({ error: 'not found' }, 404));
    await client.remove('pets', 'tom');
    await vi.waitFor(() =>
      expect(client.pendingWrites().map((w) => w.id)).toEqual(['rex']),
    );
    // The provider refuses the credentials: blocked, not retried.
    answers.set('PUT /api/pets/rex', json({ error: 'forbidden' }, 403));
    await client.resolveWrite('pets', 'rex', { action: 'retry' });
    await vi.waitFor(() =>
      expect(client.pendingWrites()).toMatchObject([
        { id: 'rex', state: 'blocked', lastStatus: 403 },
      ]),
    );
    expect(blocks).toEqual([403]);
    expect(client.authBlocked()).toMatchObject({ status: 403, id: 'rex' });
    // Renewed credentials: the write is sent again and accepted.
    answers.set('PUT /api/pets/rex', json({ id: 'rex', name: '' }));
    client.authRenewed();
    await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
    expect(client.authBlocked()).toBeUndefined();
  });
});
