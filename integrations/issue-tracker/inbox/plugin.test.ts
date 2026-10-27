// @wc-ignore-file
import { describe, expect, it } from 'vitest';

import { config, FakeHost, FakeInbox } from './fake-host.js';
import {
  INBOX_RECORD,
  MAX_EVENT_PAYLOAD,
  readState,
  RUN_PAYLOAD_BUDGET,
} from './journal.js';
import {
  DEFAULT_LIMIT,
  manifest,
  operationOf,
  operations,
  PROXY_ORIGIN,
  run,
} from './plugin.js';

/** atomic-server's `egress::FETCH_MAX_RESPONSE_BYTES`. */
const FETCH_CAP = 8 * 1024 * 1024;

const paths = (host: FakeHost) =>
  host.sent.map(s => `${s.operation} ${s.method} ${new URL(s.url).pathname}`);

const since = (host: FakeHost) => {
  const out = paths(host);
  host.sent.length = 0;

  return out;
};

const state = (host: FakeHost) => readState(host.connection);
const deliveries = (host: FakeHost) =>
  host.table(config().table).map(row => row['webhook-delivery-id']);

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

  it(`asks for at most ${RUN_PAYLOAD_BUDGET} bytes of payload per fetch; what does not fit follows in the next run`, async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    // The host's fetch cap on, so the page stays one it lets through.
    host.fetchCap = FETCH_CAP;
    await host.run();
    const big = (n: number) => ({ text: String(n).repeat(3_500_000) });
    inbox.deliver('d-1', big(1));
    inbox.deliver('d-2', big(2));
    inbox.deliver('d-3');
    since(host);
    await host.run();
    expect(host.sent.at(-1)?.url).toMatch(
      new RegExp(`[?&]maxBytes=${RUN_PAYLOAD_BUDGET}(&|$)`),
    );
    // The receiver cut the page after d-1, which was stored whole, so its
    // cursor is kept for the next run to acknowledge.
    expect(deliveries(host)).toEqual(['d-1']);
    expect(state(host)?.unacknowledged).toBeDefined();
    await host.run();
    expect(deliveries(host)).toEqual(['d-1', 'd-2', 'd-3']);
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
  });

  it(`keeps a delivery over ${RUN_PAYLOAD_BUDGET} bytes of base64 without its payload, and acknowledges it`, async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    const huge = { text: 'x'.repeat(6 * 1024 * 1024) };
    inbox.deliver('d-huge', huge);
    inbox.deliver('d-after');
    await host.run();
    expect(host.connection.records[INBOX_RECORD]!.baseline).not.toHaveProperty(
      'lastError',
    );
    const [row] = host.table(config().table);
    expect(row).toMatchObject({
      'webhook-delivery-id': 'd-huge',
      'webhook-payload-bytes': String(JSON.stringify(huge).length),
      'webhook-payload-sha256': expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(row).not.toHaveProperty('webhook-payload');
    expect(
      host
        .table(config().tables.work.table)
        .filter(r => r['webhook-work-kind'] === 'delivery'),
    ).toHaveLength(1);
    await host.run();
    expect(deliveries(host)).toEqual(['d-huge', 'd-after']);
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
  });

  it(`against a receiver that ignores maxBytes, stops collecting past ${RUN_PAYLOAD_BUDGET} bytes of base64 payload, without error, and the next run goes on`, async () => {
    const inbox = new FakeInbox();
    inbox.ignoreMaxBytes = true;
    const host = new FakeHost(inbox);
    host.fetchCap = FETCH_CAP;
    await host.run();
    // Each about 3.4 MiB in base64: together over the budget, so a run that
    // took both could not save its session, but the page of all three
    // (about 6.9 MiB) is under the 8 MiB fetch cap.
    const big = (n: number) => ({ text: String(n).repeat(2_700_000) });
    inbox.deliver('d-1', big(1));
    inbox.deliver('d-2', big(2));
    inbox.deliver('d-3');
    await host.run();
    expect(deliveries(host)).toEqual(['d-1']);
    expect(host.connection.records[INBOX_RECORD]!.baseline).not.toHaveProperty(
      'lastError',
    );
    // Nothing is acknowledged: the page was not stored whole.
    expect(state(host)?.unacknowledged).toBeUndefined();
    // The next run fetches the same page, finds d-1 by its id, and takes
    // d-2 (the first new event of a run always fits) and d-3.
    await host.run();
    expect(deliveries(host)).toEqual(['d-1', 'd-2', 'd-3']);
    expect(state(host)?.unacknowledged).toBeDefined();
    await host.run();
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(0);
    // One work item per delivery, none twice.
    expect(
      host
        .table(config().tables.work.table)
        .filter(row => row['webhook-work-kind'] === 'delivery'),
    ).toHaveLength(3);
  });

  it(`against a receiver that ignores maxBytes, stores a lone event between ${RUN_PAYLOAD_BUDGET} and ${MAX_EVENT_PAYLOAD} bytes of base64 whole`, async () => {
    const inbox = new FakeInbox();
    inbox.ignoreMaxBytes = true;
    const host = new FakeHost(inbox);
    host.fetchCap = FETCH_CAP;
    await host.run();
    // About 6.7 MiB of base64: over the run budget, but the first new event
    // of a run is always taken, and under the one-event refusal.
    const lone = { text: 'x'.repeat(5 * 1024 * 1024) };
    inbox.deliver('d-lone', lone);
    inbox.deliver('d-next');
    await host.run();
    expect(deliveries(host)).toEqual(['d-lone']);
    const payload = String(host.table(config().table)[0]!['webhook-payload']);
    expect(payload.length).toBeGreaterThan(RUN_PAYLOAD_BUDGET);
    expect(payload.length).toBeLessThan(MAX_EVENT_PAYLOAD);
    expect(Buffer.from(payload, 'base64').toString('utf8')).toBe(
      JSON.stringify(lone),
    );
    expect(host.connection.records[INBOX_RECORD]!.baseline).not.toHaveProperty(
      'lastError',
    );
    // The budget stopped the run before d-next; the next run takes it.
    await host.run();
    expect(deliveries(host)).toEqual(['d-lone', 'd-next']);
  });

  it('against a receiver that ignores maxBytes, a page over the host fetch cap fails, the next run asks for one event, and the runs alternate until the page fits', async () => {
    const inbox = new FakeInbox();
    inbox.ignoreMaxBytes = true;
    const host = new FakeHost(inbox);
    host.fetchCap = FETCH_CAP;
    await host.run();
    // Each about 4.3 MiB of base64: one fits the cap, two do not.
    const big = (n: number) => ({ text: String(n).repeat(3_200_000) });
    inbox.deliver('d-1', big(1));
    inbox.deliver('d-2', big(2));
    inbox.deliver('d-3', big(3));
    const urls = () =>
      host.sent.map(s => s.url).filter(u => /\/events/.test(u));
    const lastError = () =>
      (
        host.connection.records[INBOX_RECORD]!.baseline as {
          lastError?: { message: string };
        }
      ).lastError;
    since(host);
    // Run 1: a page of up to four (all three events) is over the cap.
    await host.run();
    expect(urls().at(-1)).toMatch(/[?&]limit=4(&|$)/);
    expect(lastError()?.message).toContain('exceeds the byte limit');
    expect(deliveries(host)).toEqual([]);
    // Run 2: one event fits, and the error clears.
    await host.run();
    expect(urls().at(-1)).toMatch(/[?&]limit=1(&|$)/);
    expect(deliveries(host)).toEqual(['d-1']);
    expect(lastError()).toBeUndefined();
    // Run 3: a full page again, still over the cap with d-2 and d-3.
    await host.run();
    expect(urls().at(-1)).toMatch(/[?&]limit=4(&|$)/);
    expect(lastError()?.message).toContain('exceeds the byte limit');
    expect(deliveries(host)).toEqual(['d-1']);
    // Run 4: one event again.
    await host.run();
    expect(urls().at(-1)).toMatch(/[?&]limit=1(&|$)/);
    expect(deliveries(host)).toEqual(['d-1', 'd-2']);
    // Run 5: d-3 alone fits a full page.
    await host.run();
    expect(urls().at(-1)).toMatch(/[?&]limit=4(&|$)/);
    expect(lastError()).toBeUndefined();
    expect(deliveries(host)).toEqual(['d-1', 'd-2', 'd-3']);
  });

  it(`against a receiver that ignores maxBytes, refuses one event over ${MAX_EVENT_PAYLOAD} bytes of base64, recording why`, async () => {
    const inbox = new FakeInbox();
    inbox.ignoreMaxBytes = true;
    const host = new FakeHost(inbox);
    await host.run();
    inbox.deliver('d-huge', { text: 'x'.repeat(6 * 1024 * 1024) });
    const refused = await host.run();
    expect(refused.status).toBe('complete');
    expect(deliveries(host)).toEqual([]);
    expect(host.connection.records[INBOX_RECORD]!.baseline).toMatchObject({
      lastError: {
        message: expect.stringContaining('d-huge'),
      },
    });
    expect(inbox.subs.get('sub-1')!.refs).toHaveLength(1);
  });

  it('reports a reconciliation only after its work item is done', async () => {
    const inbox = new FakeInbox();
    const host = new FakeHost(inbox);
    await host.run();
    await host.run();
    await host.run();
    expect(inbox.subs.get('sub-1')!.needsReconciliation).toBe(true);
    expect(paths(host).some(p => p.endsWith('/reconciled'))).toBe(false);
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
    // The next run fetches again, one event only (a page over the host's
    // fetch cap may be so only because of its neighbours), and clears the
    // error.
    since(host);
    await host.run();
    expect(host.sent.at(-1)?.url).toMatch(/[?&]limit=1(&|$)/);
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
    // Without the work item's property, a delivery row would be written
    // without its work item, and then found by its id and kept that way.
    const partial = config();
    delete partial.properties['webhook-delivery'];
    await expect(
      run(new FakeHost(inbox, partial).ctx('preview')),
    ).rejects.toThrow('no property for webhook-delivery');
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
        a.slice(head.length).every(s => s && s !== '.' && s !== '..') &&
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
      const operation = declared.find(o => o.id === id)!;
      expect(operation.method).toBe(method);
      expect(operation.effect).toBe('read');
      const pattern = operation.url.slice(PROXY_ORIGIN.length);
      expect(matches(pattern, path)).toBe(true);
    }

    expect(() => operationOf('GET', '/connections/c-1')).toThrow();
  });
});
