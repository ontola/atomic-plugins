// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { compoundDocument } from '../../fixtures/compound-create.js';

// CRUD Causality 0.5.0 compound creates (§4.7.2) in the client, on a
// GitHub-issues-shaped document after the held overlay: the create sends
// `labels`, which GitHub silently drops without push access, and
// `issues-add-labels` adds what is missing; `assignees` is `create: omit`.
// Transports and data are invented.

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

interface Issue {
  number: number;
  title: string;
  labels: { name: string }[];
  assignees: { login: string }[];
}

/**
 * A fake GitHub: the create applies `labels` only with `pushAccess`; the
 * follow-ups answer as `labelsAnswer`/`assigneesAnswer` say (status), and
 * apply only on a 2xx. Every request is recorded as `METHOD path`.
 */
function github(
  options: {
    pushAccess?: boolean;
    labelsAnswer?: () => number;
    assigneesAnswer?: () => number;
  } = {},
): {
  issues: Map<number, Issue>;
  requests: { line: string; body?: unknown }[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const issues = new Map<number, Issue>();
  const requests: { line: string; body?: unknown }[] = [];
  let next = 7;
  return {
    issues,
    requests,
    transport: async (r): Promise<TransportResponse> => {
      const path = r.url.pathname;
      const body = r.body ? JSON.parse(r.body) : undefined;
      requests.push({ line: `${r.method} ${path}`, body });
      if (r.method === 'GET' && path === '/repos/o/r/issues')
        return json([...issues.values()]);
      if (r.method === 'POST' && path === '/repos/o/r/issues') {
        const issue: Issue = {
          number: next++,
          title: String(body.title),
          labels: options.pushAccess
            ? (body.labels ?? []).map((name: string) => ({ name }))
            : [],
          assignees: [],
        };
        issues.set(issue.number, issue);
        return json(issue, 201);
      }
      const labels = /^\/repos\/o\/r\/issues\/(\d+)\/labels$/.exec(path);
      if (r.method === 'POST' && labels) {
        const status = options.labelsAnswer?.() ?? 200;
        if (status >= 300) return json({ message: 'no' }, status);
        const issue = issues.get(Number(labels[1]))!;
        for (const name of body.labels as string[]) issue.labels.push({ name });
        return json(issue.labels);
      }
      const assignees = /^\/repos\/o\/r\/issues\/(\d+)\/assignees$/.exec(path);
      if (r.method === 'POST' && assignees) {
        const status = options.assigneesAnswer?.() ?? 201;
        if (status >= 300) return json({ message: 'no' }, status);
        const issue = issues.get(Number(assignees[1]))!;
        for (const login of body.assignees as string[])
          issue.assignees.push({ login });
        return json(issue, 201);
      }
      return json({ message: 'not found' }, 404);
    },
  };
}

const settle = (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function client(
  fake: ReturnType<typeof github>,
  document: OpenApiDocument = compoundDocument(),
  storage = new InMemoryStorageAdapter(),
): ReturnType<typeof createApiClient> {
  return createApiClient(document, {
    transport: fake.transport,
    constants: { owner: 'o', repo: 'r' },
    retry: { baseDelayMs: 5, maxDelayMs: 10 },
    storage,
  });
}

const lines = (fake: ReturnType<typeof github>): string[] =>
  fake.requests.map((r) => r.line).filter((l) => !l.startsWith('GET'));

describe('compound creates (CRUD Causality 0.5.0 §4.7)', () => {
  it('sends no follow-up when the create applied the field (§4.7.2 step 4)', async () => {
    const fake = github({ pushAccess: true });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug', 'ui'] });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual(['POST /repos/o/r/issues']);
    expect(fake.requests[0]!.body).toEqual({
      title: 'Bug',
      labels: ['bug', 'ui'],
    });
  });

  it('adds only the labels the create dropped, through the follow-up (include, itemKey)', async () => {
    const fake = github({ pushAccess: false });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug', 'ui'] });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
    ]);
    expect(fake.requests[1]!.body).toEqual({ labels: ['bug', 'ui'] });
    expect(fake.issues.get(7)!.labels).toEqual([
      { name: 'bug' },
      { name: 'ui' },
    ]);
    // The record is filed under the server's identity.
    expect(await c.get('issues', '7')).toMatchObject({ number: 7 });
  });

  it('leaves an omit field out of the create body and sets it with its follow-up', async () => {
    const fake = github({ pushAccess: true });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', assignees: ['ada'] });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(fake.requests[0]!.body).toEqual({ title: 'Bug' });
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/assignees',
    ]);
    expect(fake.requests[1]!.body).toEqual({ assignees: ['ada'] });
  });

  it('a refused follow-up leaves the create partly applied: never sent again, later follow-ups not sent (§4.7.2 step 6)', async () => {
    const fake = github({ pushAccess: false, labelsAnswer: () => 422 });
    const c = client(fake);
    await c.create('issues', {
      title: 'Bug',
      labels: ['bug'],
      assignees: ['ada'],
    });
    await vi.waitFor(() =>
      expect(c.pendingWrites().map((w) => w.state)).toEqual([
        'failed',
        'failed',
      ]),
    );
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
    ]);
    expect(c.pendingWrites()).toMatchObject([
      {
        id: '7',
        type: 'update',
        lastStatus: 422,
        followUp: {
          operation: 'issues-add-labels',
          field: 'labels',
          reason: 'refused',
        },
      },
      {
        id: '7',
        type: 'update',
        followUp: {
          operation: 'issues-add-assignees',
          field: 'assignees',
          reason: 'notSent',
        },
      },
    ]);
    // The issue exists and is bound; nothing creates it again.
    expect(fake.issues.size).toBe(1);
    await c.sync();
    await settle();
    expect(lines(fake)).toHaveLength(2);
  });

  it('retrying a refused follow-up sends only what is still missing', async () => {
    let answer = 422;
    const fake = github({ pushAccess: false, labelsAnswer: () => answer });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([{ state: 'failed' }]),
    );
    answer = 200;
    await c.resolveWrite('issues', '7', { action: 'retry' });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
      'POST /repos/o/r/issues/7/labels',
    ]);
  });

  it('an unknown follow-up outcome waits for a read of the record, and is skipped when the read shows it applied', async () => {
    const fake = github({
      pushAccess: false,
      labelsAnswer: () => {
        // GitHub applied the labels, then the answer was lost.
        const issue = fake.issues.get(7)!;
        issue.labels.push({ name: 'bug' });
        return 502;
      },
    });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        {
          state: 'pending',
          awaitingRefresh: true,
          followUp: { reason: 'unknown' },
        },
      ]),
    );
    await settle(50);
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
    ]);
    // The read shows the label: settled, not sent again.
    await c.sync();
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toHaveLength(2);
  });

  it('an unknown follow-up outcome is sent again after the read when the field is still missing', async () => {
    let answer = 502;
    const fake = github({ pushAccess: false, labelsAnswer: () => answer });
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        { followUp: { reason: 'unknown' } },
      ]),
    );
    answer = 200;
    await c.sync();
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
      'POST /repos/o/r/issues/7/labels',
    ]);
  });

  it('keeps a pending follow-up across a restart, stored as type followUp', async () => {
    const storage = new InMemoryStorageAdapter();
    let answer = 502;
    const fake = github({ pushAccess: false, labelsAnswer: () => answer });
    const first = client(fake, compoundDocument(), storage);
    await first.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(first.pendingWrites()).toMatchObject([
        { followUp: { reason: 'unknown' } },
      ]),
    );
    const outbox = (await storage.get('syncables:outbox', 'outbox')) as {
      records: { writes: { type: string; followUp?: unknown }[] }[];
    };
    expect(JSON.stringify(outbox)).toContain('"type":"followUp"');
    answer = 200;
    const second = client(fake, compoundDocument(), storage);
    await second.ready();
    expect(second.pendingWrites()).toMatchObject([
      {
        id: '7',
        type: 'update',
        followUp: { operation: 'issues-add-labels', field: 'labels' },
      },
    ]);
    await second.sync();
    await vi.waitFor(() => expect(second.pendingWrites()).toEqual([]));
    expect(fake.issues.get(7)!.labels).toEqual([{ name: 'bug' }]);
  });

  it('an uncertain create confirmed with resolveWrite reads the object back before any follow-up (§4.7.2 step 2)', async () => {
    let createAnswer = 502;
    const fake = github({ pushAccess: false });
    const inner = fake.transport;
    fake.transport = async (r): Promise<TransportResponse> => {
      if (r.method === 'POST' && r.url.pathname === '/repos/o/r/issues') {
        const answer = await inner(r); // the issue is made...
        if (createAnswer >= 300) return json({}, createAnswer); // ...the answer lost
        return answer;
      }
      return inner(r);
    };
    const c = client(fake);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        { type: 'create', state: 'uncertain' },
      ]),
    );
    createAnswer = 201;
    const [pending] = c.pendingWrites();
    await c.resolveWrite('issues', pending!.id, {
      action: 'confirm',
      id: '7',
    });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        {
          id: '7',
          awaitingRefresh: true,
          followUp: { field: 'labels' },
        },
      ]),
    );
    expect(lines(fake)).toEqual(['POST /repos/o/r/issues']);
    await c.sync();
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual([
      'POST /repos/o/r/issues',
      'POST /repos/o/r/issues/7/labels',
    ]);
  });

  it('a follow-up whose bound value resolves to nothing is not sent', async () => {
    const doc = compoundDocument([
      {
        field: 'labels',
        create: 'include',
        itemKey: 'name',
        operation: 'issues-add-labels',
        bind: {
          'path.issue_number': { from: 'created', field: 'node_id' },
          'body.labels': { from: 'missing', field: 'labels' },
        },
      },
    ]);
    const fake = github({ pushAccess: false });
    const c = client(fake, doc);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() =>
      expect(c.pendingWrites()).toMatchObject([
        { state: 'failed', followUp: { reason: 'notSent' } },
      ]),
    );
    expect(lines(fake)).toEqual(['POST /repos/o/r/issues']);
  });

  it('refuses a create whose followUps it cannot make, before any request', async () => {
    const doc = compoundDocument([
      {
        field: 'labels',
        create: 'include',
        operation: 'issues-get',
        bind: { 'body.labels': { from: 'missing', field: 'labels' } },
      },
    ]);
    const fake = github();
    const c = client(fake, doc);
    await expect(
      c.create('issues', { title: 'Bug', labels: ['bug'] }),
    ).rejects.toThrow(/compound create this client cannot make/);
    expect(fake.requests).toEqual([]);
  });

  it('a create without followUps behaves as before', async () => {
    const doc = compoundDocument();
    const create = (
      doc.paths['/repos/{owner}/{repo}/issues']!.post as Record<
        string,
        Record<string, unknown>
      >
    )['x-crud']!;
    delete create['followUps'];
    const fake = github({ pushAccess: false });
    const c = client(fake, doc);
    await c.create('issues', { title: 'Bug', labels: ['bug'] });
    await vi.waitFor(() => expect(c.pendingWrites()).toEqual([]));
    expect(lines(fake)).toEqual(['POST /repos/o/r/issues']);
  });
});
