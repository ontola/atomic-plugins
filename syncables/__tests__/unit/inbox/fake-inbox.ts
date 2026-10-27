// An in-memory webhook receiver speaking the consumer protocol of
// openapi-extensions/spec/webhook-subscriptions, as integration-proxy serves
// it: generations, barriers, gaps at a retention limit, leases that expire
// on a simulated clock, 410 with a resubscribe result. Cursors are plain
// `<generation>:<seq>` strings here; the real receiver authenticates them.
import type {
  InboxEvent,
  InboxEventPage,
  InboxSubscription,
  ReconciliationRequired,
} from '../../../src/inbox/client.js';
import type {
  Transport,
  TransportRequest,
  TransportResponse,
} from '../../../src/read/transport.js';

interface Ref {
  seq: number;
  generation: number;
  event: Omit<InboxEvent, 'cursor' | 'generation'>;
}

interface Sub {
  id: string;
  generation: number;
  nextSeq: number;
  barrier: number;
  ack: number;
  refs: Ref[];
  needsReconciliation: boolean;
  gap: ReconciliationRequired['gap'];
  expiresAt: number;
  renewAfter: number;
  ended?: string;
}

const DAY = 86_400_000;

export class FakeInbox {
  now = Date.parse('2026-10-09T12:00:00Z');
  /** Pending events a subscription keeps; more evict the oldest (a gap). */
  maxPending = 100;
  /** Ignore `maxBytes`, as a receiver before Webhook Subscriptions 0.2.0-draft does. */
  ignoreMaxBytes = false;
  /** Requests to fail once, by `METHOD path-suffix`, e.g. `POST /ack`. */
  failOnce = new Set<string>();
  /** Canned answers, once each, by `METHOD path-suffix`. */
  readonly answerOnce = new Map<string, TransportResponse>();
  readonly requests: string[] = [];
  /** The query string of each request, in order. */
  readonly queries: string[] = [];
  readonly subs = new Map<string, Sub>();
  private count = 0;

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** A provider delivery, routed to every live subscription. */
  deliver(deliveryId: string, body: object = { kind: 'task' }): void {
    const raw = Buffer.from(JSON.stringify(body));
    for (const sub of this.subs.values()) {
      if (sub.ended) continue;
      if (this.now >= sub.expiresAt) {
        sub.ended = 'lease-expired';
        sub.refs = [];
        continue;
      }
      if (sub.refs.length >= this.maxPending) {
        const evicted = sub.refs.shift()!;
        if (evicted.generation === sub.generation) {
          this.gap(sub, 'subscription-events-limit');
        }
      }
      sub.refs.push({
        seq: sub.nextSeq++,
        generation: sub.generation,
        event: {
          deliveryId,
          eventType: 'task',
          action: 'updated',
          receivedAt: this.iso(this.now),
          source: { kind: 'project', key: 'p-1' },
          payload: {
            mediaType: 'application/json',
            bytes: raw.length,
            sha256: '0'.repeat(64),
            body: raw.toString('base64'),
          },
        },
      });
    }
  }

  private gap(sub: Sub, reason: string): void {
    sub.gap = {
      generation: `g${sub.generation}`,
      reason,
      detectedAt: this.iso(this.now),
      lastAcknowledged: null,
      earliestAvailableCursor: null,
    };
    sub.generation += 1;
    sub.barrier = sub.nextSeq - 1;
    sub.needsReconciliation = true;
  }

  private required(sub: Sub): ReconciliationRequired | undefined {
    if (!sub.needsReconciliation) return undefined;
    return {
      status: 'reconciliation-required',
      subscription: sub.id,
      state: 'needs-reconciliation',
      action: 'reconcile',
      generation: `g${sub.generation}`,
      barrier: `${sub.generation}:${sub.barrier}`,
      gap: sub.gap,
    };
  }

  private view(sub: Sub): InboxSubscription {
    const required = this.required(sub);
    return {
      id: sub.id,
      connection: 'c-1',
      consumer: 'atomic:agent:fake',
      source: { kind: 'project', key: 'p-1' },
      events: ['task'],
      hook: 'sharedApplication',
      state: sub.needsReconciliation ? 'needs-reconciliation' : 'active',
      generation: `g${sub.generation}`,
      lease: {
        expiresAt: this.iso(sub.expiresAt),
        renewAfter: this.iso(sub.renewAfter),
        progressDeadlineAt: null,
      },
      acknowledged: null,
      pending: { events: sub.refs.length, bytes: 0 },
      ...(required ? { reconciliationRequired: required } : {}),
      createdAt: this.iso(this.now),
    };
  }

  private ended(sub: Sub): TransportResponse {
    const result: ReconciliationRequired = {
      status: 'reconciliation-required',
      subscription: sub.id,
      state: 'expired',
      action: 'resubscribe',
      gap: {
        generation: `g${sub.generation}`,
        reason: sub.ended ?? 'lease-expired',
        detectedAt: this.iso(this.now),
        lastAcknowledged: null,
        earliestAvailableCursor: null,
      },
    };
    return json(410, result);
  }

  readonly transport: Transport = async (request: TransportRequest) => {
    const path = request.url.pathname;
    this.requests.push(`${request.method} ${path}`);
    this.queries.push(request.url.search);
    for (const failure of this.failOnce) {
      const [method, suffix] = failure.split(' ');
      if (request.method === method && path.endsWith(suffix)) {
        this.failOnce.delete(failure);
        throw new Error(`connection lost on ${failure}`);
      }
    }
    for (const [key, response] of this.answerOnce) {
      const [method, suffix] = key.split(' ');
      if (request.method === method && path.endsWith(suffix)) {
        this.answerOnce.delete(key);
        return response;
      }
    }
    if (
      request.method === 'POST' &&
      /\/connections\/[^/]+\/subscriptions$/.test(path)
    ) {
      const sub: Sub = {
        id: `sub-${++this.count}`,
        generation: 1,
        nextSeq: 1,
        barrier: 0,
        ack: 0,
        refs: [],
        needsReconciliation: true,
        gap: {
          generation: null,
          reason: 'initial',
          detectedAt: this.iso(this.now),
          lastAcknowledged: null,
          earliestAvailableCursor: null,
        },
        expiresAt: this.now + 7 * DAY,
        renewAfter: this.now + DAY / 2,
      };
      this.subs.set(sub.id, sub);
      return json(201, this.view(sub));
    }
    const match = /\/subscriptions\/([^/]+)(\/[a-z]+)?$/.exec(path);
    const sub = match ? this.subs.get(decodeURIComponent(match[1])) : undefined;
    if (!match || !sub)
      return json(404, { status: 'error', code: 'unknown-subscription' });
    if (!sub.ended && this.now >= sub.expiresAt) {
      sub.ended = 'lease-expired';
      sub.refs = [];
    }
    if (sub.ended) return this.ended(sub);
    const action = match[2] ?? '';
    const body = request.body ? JSON.parse(request.body) : {};
    switch (`${request.method} ${action}`) {
      case 'POST /renew':
        sub.expiresAt = this.now + 7 * DAY;
        sub.renewAfter = this.now + DAY / 2;
        return json(200, this.view(sub));
      case 'GET /events': {
        // From `search`, not `searchParams`: in a sandbox without `URL` the
        // client hands over a stand-in that has only `href`, `origin`,
        // `pathname` and `search`.
        const raw = /[?&]after=([^&]*)/.exec(request.url.search)?.[1];
        const after = raw === undefined ? null : decodeURIComponent(raw);
        const start = after ? Number(after.split(':')[1]) : sub.ack;
        const pending = sub.refs.filter((ref) => ref.seq > start);
        const generation = pending[0]?.generation ?? sub.generation;
        const limit = Number(
          /[?&]limit=([0-9]+)/.exec(request.url.search)?.[1] ?? Infinity,
        );
        let events: InboxEvent[] = pending
          .filter((ref) => ref.generation === generation)
          .slice(0, limit)
          .map((ref) => ({
            ...ref.event,
            cursor: `${ref.generation}:${ref.seq}`,
            generation: `g${ref.generation}`,
          }));
        // `maxBytes`, as integration-proxy's `fetch_within`: an event that
        // does not fit ends the page, unless it is the first, which then
        // comes back alone without its body.
        const maxBytes = /[?&]maxBytes=(\d+)/.exec(request.url.search)?.[1];
        let cut = false;
        if (maxBytes !== undefined && !this.ignoreMaxBytes) {
          let room = Number(maxBytes);
          const kept: InboxEvent[] = [];
          for (const event of events) {
            const size = event.payload.body?.length ?? 0;
            if (size <= room) {
              room -= size;
              kept.push(event);
              continue;
            }
            if (kept.length === 0) {
              const payload = { ...event.payload, omitted: true as const };
              delete payload.body;
              kept.push({ ...event, payload });
            }
            break;
          }
          cut = kept.length < events.length;
          events = kept;
        }
        const required = this.required(sub);
        const page: InboxEventPage = {
          subscription: sub.id,
          generation: `g${generation}`,
          events,
          next: events.at(-1)?.cursor ?? null,
          more: cut,
          ...(required ? { reconciliationRequired: required } : {}),
        };
        return json(200, page);
      }
      case 'POST /ack': {
        const seq = Number(String(body.cursor).split(':')[1]);
        if (seq > sub.ack) {
          sub.ack = seq;
          sub.refs = sub.refs.filter((ref) => ref.seq > seq);
        }
        return json(200, { generation: body.generation, cursor: body.cursor });
      }
      case 'POST /reconciled': {
        // As integration-proxy's `complete_reconciliation`: the generation
        // first (a newer gap started another one), then the barrier.
        if (body.generation !== `g${sub.generation}`) {
          return json(409, { status: 'error', code: 'obsolete-generation' });
        }
        if (body.barrier !== `${sub.generation}:${sub.barrier}`) {
          return json(409, { status: 'error', code: 'barrier-mismatch' });
        }
        sub.needsReconciliation = false;
        return json(200, this.view(sub));
      }
      default:
        return json(404, { status: 'error', code: 'unknown-subscription' });
    }
  };
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
