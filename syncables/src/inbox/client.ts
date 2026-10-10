/**
 * A client for the consumer routes of a webhook receiver
 * (`openapi-extensions/spec/webhook-subscriptions`, as `integration-proxy`
 * serves them with `WEBHOOKS_ENABLED=true`). It only shapes requests and
 * parses answers; signing is the transport's job (`signedTransport`).
 */
import type { Transport } from '../read/transport.js';

export interface GapMarker {
  generation: string | null;
  reason: string;
  detectedAt: string;
  lastAcknowledged: string | null;
  earliestAvailableCursor: string | null;
}

export interface ReconciliationRequired {
  status: 'reconciliation-required';
  subscription: string;
  state: 'needs-reconciliation' | 'expired' | 'closed';
  action: 'reconcile' | 'resubscribe';
  generation?: string;
  barrier?: string;
  gap: GapMarker;
}

export interface InboxSubscription {
  id: string;
  connection: string;
  consumer: string;
  source: { kind: string; key: string };
  events: string[];
  hook: string;
  state: string;
  generation: string | null;
  lease: {
    expiresAt: string;
    renewAfter: string;
    progressDeadlineAt: string | null;
  } | null;
  acknowledged: string | null;
  pending: { events: number; bytes: number };
  reconciliationRequired?: ReconciliationRequired;
  createdAt: string;
}

export interface InboxEvent {
  cursor: string;
  generation: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  receivedAt: string;
  source: { kind: string; key: string };
  payload: {
    mediaType: string;
    bytes: number;
    sha256: string;
    /** The raw body, base64. */
    body: string;
  };
}

export interface InboxEventPage {
  subscription: string;
  generation: string;
  events: InboxEvent[];
  next: string | null;
  more: boolean;
  reconciliationRequired?: ReconciliationRequired;
}

/** A refused request: the spec's error `code`, or the HTTP status alone. */
export class InboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    /** For `410`: the `resubscribe` result. */
    readonly ended?: ReconciliationRequired,
  ) {
    super(`webhook inbox: ${status}${code ? ` ${code}` : ''}`);
  }
}

export interface SubscribeRequest {
  connection: string;
  source: string;
  parameters: Record<string, string>;
  events: string[];
}

export class InboxClient {
  private readonly base: URL;

  /** `baseUrl`: the receiver's public URL, e.g. `https://proxy.example`. */
  constructor(
    baseUrl: string,
    private readonly transport: Transport,
  ) {
    this.base = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path.replace(/^\//, ''), this.base);
    const response = await this.transport({
      url,
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let parsed: unknown;
    try {
      parsed = response.body ? JSON.parse(response.body) : undefined;
    } catch {
      parsed = undefined;
    }
    if (response.status >= 200 && response.status < 300) {
      return parsed as T;
    }
    const record = (parsed ?? {}) as Record<string, unknown>;
    if (
      response.status === 410 &&
      record.status === 'reconciliation-required'
    ) {
      throw new InboxError(410, undefined, parsed as ReconciliationRequired);
    }
    const code =
      typeof record.code === 'string'
        ? record.code
        : typeof record.error === 'string'
          ? record.error
          : undefined;
    throw new InboxError(response.status, code);
  }

  subscribe(request: SubscribeRequest): Promise<InboxSubscription> {
    return this.call(
      'POST',
      `/connections/${encodeURIComponent(request.connection)}/subscriptions`,
      {
        source: request.source,
        parameters: request.parameters,
        events: request.events,
      },
    );
  }

  get(id: string): Promise<InboxSubscription> {
    return this.call('GET', `/subscriptions/${encodeURIComponent(id)}`);
  }

  delete(id: string): Promise<InboxSubscription> {
    return this.call('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  }

  renew(id: string): Promise<InboxSubscription> {
    return this.call(
      'POST',
      `/subscriptions/${encodeURIComponent(id)}/renew`,
      {},
    );
  }

  /** Up to `limit` events after `after`; waits up to `wait` seconds for one. */
  events(
    id: string,
    options: { after?: string; limit?: number; wait?: number } = {},
  ): Promise<InboxEventPage> {
    const query = new URLSearchParams();
    if (options.after !== undefined) query.set('after', options.after);
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.wait !== undefined) query.set('wait', String(options.wait));
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.call(
      'GET',
      `/subscriptions/${encodeURIComponent(id)}/events${suffix}`,
    );
  }

  ack(
    id: string,
    generation: string,
    cursor: string,
  ): Promise<{ generation: string; cursor: string }> {
    return this.call('POST', `/subscriptions/${encodeURIComponent(id)}/ack`, {
      generation,
      cursor,
    });
  }

  reconciled(
    id: string,
    generation: string,
    barrier: string,
  ): Promise<InboxSubscription> {
    return this.call(
      'POST',
      `/subscriptions/${encodeURIComponent(id)}/reconciled`,
      {
        generation,
        barrier,
      },
    );
  }
}
