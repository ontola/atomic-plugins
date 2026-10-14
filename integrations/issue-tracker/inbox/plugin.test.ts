// @wc-ignore-file
import { describe, expect, it } from 'vitest';

import { config, FakeHost, FakeInbox } from './fake-host.js';
import { INBOX_RECORD, readState } from './journal.js';
import {
  DEFAULT_LIMIT,
  manifest,
  operationOf,
  operations,
  PROXY_ORIGIN,
  run,
} from './plugin.js';

const paths = (host: FakeHost) =>
  host.sent.map((s) => `${s.operation} ${s.method} ${new URL(s.url).pathname}`);
const since = (host: FakeHost) => {
  const out = paths(host);
  host.sent.length = 0;
  return out;
};
const state = (host: FakeHost) => readState(host.connection);
const deliveries = (host: FakeHost) =>
  host.table(config().table).map((row) => row['webhook-delivery-id']);

describe('the webhook inbox plugin, run as a sync session', () => {
  it('subscribes, records the first gap and asks for a full read, acknowledging nothing', async () => {
    const host = new FakeHost(new FakeInbox());
    const session = await host.run();
    expect(session.status).toBe('complete');
    expect(session.proposal).toEqual({
      repository: 'fixture-owner/fixture-repo',
      subscription: null,
      lastError: null,
    });
    expect(since(host)).toEqual([
      'inbox-subscribe POST /connections/c-1/subscriptions',
    ]);
    expect(host.effects).toEqual(['atomic', 'checkpoint']);
    expect(state(host)).toEqual({
      id: 'sub-1',
      renewAfter: expect.any(String),
    });
    expect(host.connection.records[INBOX_RECORD]!.local).toBe(config().table);
    expect(host.table(config().tables.gaps.table)).toEqual([
      expect.objectContaining({
        'webhook-gap-reason': 'initial',
        'webhook-subscription': 'sub-1',
      }),
    ]);
    expect(host.table(config().tables.work.table)).toEqual([
      expect.objectContaining({
        'webhook-work-kind': 'reconcile',
        'webhook-work-status': 'pending',
      }),
    ]);
  });

  it('stores a delivery and its work item, and acknowledges it only in the next run, after the checkpoint', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    since(host);
    inbox.deliver('d-1', { action: 'edited', issue: { number: 7 } });
    await host.run();
    // No ack in the run that stored it.
    expect(since(host)).toEqual(['inbox-read GET /subscriptions/sub-1/events']);
    const [delivery] = host.table(config().table);
    expect(delivery).toMatchObject({
      'webhook-delivery-id': 'd-1',
      'webhook-subscription': 'sub-1',
      'webhook-generation': 'g1',
      'webhook-cursor': '1:1',
      'webhook-payload': Buffer.from(
        JSON.stringify({ action: 'edited', issue: { number: 7 } }),
      ).toString('base64'),
    });
    const work = host.table(config().tables.work.table);
    expect(work[1]).toMatchObject({
      'webhook-work-kind': 'delivery',
      'webhook-work-status': 'pending',
    });
    expect(String(work[1]!['webhook-delivery'])).toMatch(
      /^https:\/\/drive\.test\/rows\//,
    );
    expect(state(host)?.unacknowledged).toEqual({
      generation: 'g1',
      cursor: '1:1',
    });
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(1);
    await host.run();
    expect(since(host)).toEqual([
      'inbox-update POST /subscriptions/sub-1/ack',
      'inbox-read GET /subscriptions/sub-1/events',
    ]);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    expect(state(host)?.unacknowledged).toBeUndefined();
    // No second gap row or reconcile item for the same gap.
    expect(host.table(config().tables.gaps.table)).toHaveLength(1);
    expect(host.table(config().tables.work.table)).toHaveLength(2);
  });

  it('a run stopped between its effect and its checkpoint, then resumed, acknowledges nothing early and loses nothing', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    inbox.deliver('d-1');
    const stopped = await host.run({ stopAfterAtomic: true });
    expect(stopped.status).toBe('running');
    // The rows landed; the state did not move, so nothing may be acked.
    expect(deliveries(host)).toEqual(['d-1']);
    expect(state(host)?.unacknowledged).toBeUndefined();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(1);
    // The worker resumes the saved session: the checkpoint, then complete.
    since(host);
    expect((await host.advance(stopped)).status).toBe('complete');
    expect(since(host)).toEqual([]);
    expect(state(host)?.unacknowledged).toEqual({
      generation: 'g1',
      cursor: '1:1',
    });
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    expect(deliveries(host)).toEqual(['d-1']);
  });

  it('a run stopped between its effect and its checkpoint, then abandoned, redelivers rather than loses its events', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    inbox.deliver('d-1');
    inbox.deliver('d-2');
    await host.run({ stopAfterAtomic: true });
    // A fresh run: the state has no cursor to ack, so the receiver hands
    // the same events over again. Their rows exist: nothing new is written.
    since(host);
    host.effects.length = 0;
    await host.run();
    expect(since(host)).toEqual(['inbox-read GET /subscriptions/sub-1/events']);
    expect(host.effects).toEqual(['checkpoint']);
    expect(deliveries(host)).toEqual(['d-1', 'd-2']);
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(2);
    // The checkpoint stored their cursor: the next run acknowledges them.
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    expect(deliveries(host)).toEqual(['d-1', 'd-2']);
  });

  it(`fetches at most ${DEFAULT_LIMIT} events per run, and a configured limit cannot raise it`, async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox, config({ limit: 50 }));
    await host.run();
    for (let n = 0; n < 6; n++) inbox.deliver(`d-${n}`);
    since(host);
    await host.run();
    expect(host.sent.at(-1)?.url).toMatch(/[?&]limit=4(&|$)/);
    expect(deliveries(host)).toHaveLength(4);
    await host.run();
    expect(deliveries(host)).toHaveLength(6);
  });

  it('keeps a delivery of about 1 MiB whole', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    const big = { text: 'x'.repeat(1_048_000) };
    inbox.deliver('d-big', big);
    await host.run();
    const [row] = host.table(config().table);
    const payload = String(row!['webhook-payload']);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(
      JSON.stringify(big),
    );
    expect(payload.length).toBeGreaterThan(1_390_000);
  });

  it('reports a reconciliation only after its work item is done', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    await host.run();
    await host.run();
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(true);
    expect(paths(host).some((p) => p.endsWith('/reconciled'))).toBe(false);
    host.finishWork('reconcile');
    await host.run();
    expect(state(host)?.unconfirmedReconciliation).toBeDefined();
    since(host);
    await host.run();
    expect(since(host)).toContain(
      'inbox-update POST /subscriptions/sub-1/reconciled',
    );
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(false);
  });

  it('a step that fails completes the run anyway, records why, and loses nothing', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    inbox.deliver('d-1');
    // The fetch fails (here: the connection drops; in practice also an
    // events page over the host's 8 MiB fetch cap). A thrown step would put
    // the session in `error`, which stops the schedule until a person
    // reviews it; instead the run completes with the failure recorded.
    inbox.failOnce.add('GET /events');
    const failed = await host.run();
    expect(failed.status).toBe('complete');
    expect(host.connection.records[INBOX_RECORD]!.baseline).toMatchObject({
      lastError: { message: expect.stringContaining('connection lost') },
    });
    expect(deliveries(host)).toEqual([]);
    expect((await host.preview()).proposal.lastError).not.toBeNull();
    // The next run fetches again, and clears the error.
    await host.run();
    expect(deliveries(host)).toEqual(['d-1']);
    expect(host.connection.records[INBOX_RECORD]!.baseline).not.toHaveProperty(
      'lastError',
    );
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
  });

  it('a step that fails after storing events still writes their rows before their cursor is kept', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    inbox.deliver('d-1');
    // The reconcile check after the appends fails.
    host.failQuery = config().properties['webhook-gap-key'];
    const run2 = await host.run();
    host.failQuery = undefined;
    expect(run2.status).toBe('complete');
    expect(host.effects.slice(-2)).toEqual(['atomic', 'checkpoint']);
    expect(deliveries(host)).toEqual(['d-1']);
    expect(state(host)?.unacknowledged).toEqual({
      generation: 'g1',
      cursor: '1:1',
    });
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    expect(deliveries(host)).toEqual(['d-1']);
  });

  it('refuses to run unconfigured, without a delegated connection, or without an approved proposal', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await expect(
      run({ ...host.ctx('preview'), config: undefined }),
    ).rejects.toThrow('Configure this plugin before running it');
    await expect(
      run(new FakeHost(inbox, config({ repository: 'nope' })).ctx('preview')),
    ).rejects.toThrow('repository must be owner/name');
    await expect(
      run(new FakeHost(inbox, config(), {}).ctx('preview')),
    ).rejects.toThrow('Delegate a github-issues connection');
    await expect(run(host.ctx('step'))).rejects.toThrow(
      'An approved proposal for this repository is required',
    );
    await expect(run(host.ctx('action'))).rejects.toThrow('no actions');
    expect(inbox.subs.size).toBe(0);
  });

  it('refuses state it cannot read rather than subscribing again', async () => {
    const host = new FakeHost(new FakeInbox());
    host.connection.records[INBOX_RECORD] = {
      local: config().table,
      baseline: { v: 2 },
    };
    await expect(host.run()).rejects.toThrow('unknown state version');
    expect(host.sent).toEqual([]);
  });
});

describe('the declared operations', () => {
  // atomic-server's `matches_path`: a literal per segment, or a trailing
  // `{*rest}` matching one or more non-empty segments.
  const matches = (pattern: string, actual: string): boolean => {
    const p = pattern.split('/');
    const a = actual.split('/');
    if (p.at(-1) === '{*rest}') {
      const head = p.slice(0, -1);
      return (
        a.length > head.length &&
        a.slice(head.length).every((s) => s && s !== '.' && s !== '..') &&
        head.every((s, i) => s === a[i])
      );
    }
    return p.length === a.length && p.every((s, i) => s === a[i]);
  };

  it('cover every consumer request, each under its own id', () => {
    const declared = operations(PROXY_ORIGIN);
    expect(manifest.operations).toEqual(declared);
    expect(manifest.proxy).toEqual(['github-issues']);
    for (const [method, path] of [
      ['POST', '/connections/c-1/subscriptions'],
      ['GET', '/subscriptions/sub-1'],
      ['GET', '/subscriptions/sub-1/events'],
      ['POST', '/subscriptions/sub-1/ack'],
      ['POST', '/subscriptions/sub-1/renew'],
      ['POST', '/subscriptions/sub-1/reconciled'],
      ['DELETE', '/subscriptions/sub-1'],
    ] as const) {
      const id = operationOf(method, path);
      const operation = declared.find((o) => o.id === id)!;
      expect(operation.method).toBe(method);
      expect(operation.effect).toBe('read');
      const pattern = operation.url.slice(PROXY_ORIGIN.length);
      expect(matches(pattern, path)).toBe(true);
    }
    expect(() => operationOf('GET', '/connections/c-1')).toThrow();
  });
});
