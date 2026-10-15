// @wc-ignore-file
/**
 * The webhook inbox's consumer routes for the mock proxy (#369 step 4b),
 * enough for the issue-tracker inbox e2e: a sandbox plugin, signing as an
 * installation's node agent, subscribes through a connection delegated to
 * its app, fetches events, acknowledges them, and reports reconciliations.
 * Shapes follow `openapi-extensions/spec/webhook-subscriptions` as
 * `integration-proxy/src/webhooks/routes.rs` serves them. Never deploy this.
 *
 * What it has: signed requests checked exactly like the rest of the mock
 * (`authenticate`), the consumer's standing on the connection re-checked on
 * every request (owner, delegate, or runtime of a delegated app), one
 * generation per subscription with the initial gap and its barrier, and
 * cursors `<generation>:<seq>`.
 * What it does not have: Postgres, leases that expire, quotas, retention
 * limits, provider hooks or verification. Events come from the test driver
 * `POST /__mock/inbox/deliver`, and `GET /__mock/inbox` shows the state.
 */
import { createHash } from 'node:crypto';
import { ProxyRefusal } from './mock-proxy-auth.mjs';

const DAY = 86_400_000;

class InboxRefusal extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function mockInbox({ authenticate, connections, standing, now }) {
  /** id -> subscription. */
  const subs = new Map();
  let count = 0;
  const iso = ms => new Date(ms).toISOString();

  const view = sub => ({
    id: sub.id,
    connection: sub.connection,
    consumer: sub.consumer,
    source: sub.source,
    events: sub.events,
    hook: 'mock-shared-hook',
    state: sub.needsReconciliation ? 'needs-reconciliation' : 'active',
    generation: `g${sub.generation}`,
    lease: {
      expiresAt: iso(sub.expiresAt),
      renewAfter: iso(sub.expiresAt - 6.5 * DAY),
      progressDeadlineAt: null,
    },
    acknowledged: sub.ack ? `${sub.generation}:${sub.ack}` : null,
    pending: {
      events: sub.refs.length,
      bytes: sub.refs.reduce((n, ref) => n + ref.event.payload.bytes, 0),
    },
    ...(sub.needsReconciliation
      ? { reconciliationRequired: required(sub) }
      : {}),
    createdAt: sub.createdAt,
  });

  const required = sub => ({
    status: 'reconciliation-required',
    subscription: sub.id,
    state: 'needs-reconciliation',
    action: 'reconcile',
    generation: `g${sub.generation}`,
    barrier: `${sub.generation}:${sub.barrier}`,
    gap: sub.gap,
  });

  /** The signer, and the subscription it may use. */
  const consumerOf = (req, body, id) => {
    const signer = authenticate(req, body);
    const sub = subs.get(id);
    if (!sub) throw new InboxRefusal(404, 'unknown-subscription');
    const row = connections.get(sub.connection);
    // As the real inbox: a consumer that lost its standing reads nothing.
    if (!row || !standing(row, signer))
      throw new InboxRefusal(403, 'access-denied');

    return sub;
  };

  const error = (status, code) => ({ status, body: { status: 'error', code } });

  /**
   * Answers a consumer route, or returns `undefined` when `path` is not one.
   * `{ status, body }` either way, thrown refusals included.
   */
  async function route(req, url, readBody) {
    const subscribe = url.pathname.match(
      /^\/connections\/([^/]+)\/subscriptions$/,
    );
    const own = url.pathname.match(/^\/subscriptions\/([^/]+)(\/[a-z]+)?$/);
    if (!subscribe && !own) return undefined;
    const body = (await readBody(64 * 1024)) ?? Buffer.alloc(0);

    try {
      if (subscribe) {
        if (req.method !== 'POST') return { status: 405, body: {} };
        const signer = authenticate(req, body);
        const id = decodeURIComponent(subscribe[1]);
        const row = connections.get(id);
        if (!row) return error(403, 'access-denied');
        if (!standing(row, signer)) return error(403, 'access-denied');
        const request = JSON.parse(body.toString('utf8') || '{}');
        const sub = {
          id: `mock-sub-${++count}`,
          connection: id,
          consumer: signer,
          source: {
            kind: request.source,
            key: Object.values(request.parameters ?? {}).join('/'),
          },
          events: request.events ?? [],
          generation: 1,
          nextSeq: 1,
          barrier: 0,
          ack: 0,
          refs: [],
          needsReconciliation: true,
          gap: {
            generation: null,
            reason: 'initial',
            detectedAt: iso(now()),
            lastAcknowledged: null,
            earliestAvailableCursor: null,
          },
          expiresAt: now() + 7 * DAY,
          createdAt: iso(now()),
        };
        subs.set(sub.id, sub);

        return { status: 201, body: view(sub) };
      }

      const sub = consumerOf(req, body, decodeURIComponent(own[1]));
      const action = own[2] ?? '';
      const input = body.length ? JSON.parse(body.toString('utf8')) : {};

      switch (`${req.method} ${action}`) {
        case 'GET ':
          return { status: 200, body: view(sub) };
        case 'DELETE ':
          subs.delete(sub.id);

          return { status: 200, body: { ...view(sub), state: 'closed' } };
        case 'POST /renew':
          sub.expiresAt = now() + 7 * DAY;

          return { status: 200, body: view(sub) };

        case 'GET /events': {
          const limit = Number(url.searchParams.get('limit') ?? 100);
          const after = url.searchParams.get('after');
          const start = after ? Number(after.split(':')[1]) : sub.ack;
          const events = sub.refs
            .filter(ref => ref.seq > start)
            .slice(0, limit)
            .map(ref => ({
              ...ref.event,
              cursor: `${sub.generation}:${ref.seq}`,
              generation: `g${sub.generation}`,
            }));

          return {
            status: 200,
            body: {
              subscription: sub.id,
              generation: `g${sub.generation}`,
              events,
              next: events.at(-1)?.cursor ?? null,
              more: sub.refs.filter(ref => ref.seq > start).length > limit,
              ...(sub.needsReconciliation
                ? { reconciliationRequired: required(sub) }
                : {}),
            },
          };
        }

        case 'POST /ack': {
          if (input.generation !== `g${sub.generation}`)
            return error(409, 'obsolete-generation');
          const seq = Number(String(input.cursor).split(':')[1]);
          if (!(seq < sub.nextSeq)) return error(409, 'cursor-not-issued');

          if (seq > sub.ack) {
            sub.ack = seq;
            sub.refs = sub.refs.filter(ref => ref.seq > seq);
          }

          return {
            status: 200,
            body: { generation: input.generation, cursor: input.cursor },
          };
        }

        case 'POST /reconciled': {
          if (
            input.generation !== `g${sub.generation}` ||
            input.barrier !== `${sub.generation}:${sub.barrier}`
          )
            return error(409, 'barrier-mismatch');
          sub.needsReconciliation = false;

          return { status: 200, body: view(sub) };
        }

        default:
          return {
            status: 404,
            body: { status: 'error', code: 'unknown-subscription' },
          };
      }
    } catch (refusal) {
      if (refusal instanceof InboxRefusal)
        return error(refusal.status, refusal.code);
      if (!(refusal instanceof ProxyRefusal)) throw refusal;

      return {
        status: refusal.status,
        body: { status: 'error', code: refusal.code },
      };
    }
  }

  /**
   * The driver: a verified delivery for every subscription on `connection`.
   * `body` is the raw payload text.
   */
  function deliver({ connection, deliveryId, eventType, action, body }) {
    const raw = Buffer.from(body, 'utf8');
    let routed = 0;

    for (const sub of subs.values()) {
      if (sub.connection !== connection) continue;
      sub.refs.push({
        seq: sub.nextSeq++,
        event: {
          deliveryId,
          eventType,
          action: action ?? null,
          receivedAt: iso(now()),
          source: sub.source,
          payload: {
            mediaType: 'application/json',
            bytes: raw.length,
            sha256: createHash('sha256').update(raw).digest('hex'),
            body: raw.toString('base64'),
          },
        },
      });
      routed++;
    }

    return routed;
  }

  const state = () =>
    [...subs.values()].map(sub => ({
      ...view(sub),
      ack: sub.ack,
      refs: sub.refs.length,
      needsReconciliation: sub.needsReconciliation,
    }));

  return { route, deliver, state };
}
