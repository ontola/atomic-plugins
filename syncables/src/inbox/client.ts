/**
 * A client for the consumer routes of a webhook receiver
 * (`openapi-extensions/spec/webhook-subscriptions`, as `integration-proxy`
 * serves them with `WEBHOOKS_ENABLED=true`). It only shapes requests and
 * parses answers; signing is the transport's job (`signedTransport`).
 */
import type { Transport } from '../read/transport.js';
import { queryString, requestUrl, trimBase } from './url.js';

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

/**
 * Seconds until a passing refusal may be retried, when the receiver did not
 * say (`Retry-After`).
 */
export const DEFAULT_BACKOFF_SECONDS = {
  /** `429`: a limit, or the receiver's capacity. */
  tooMany: 5,
  /** `503`: the receiver's database or an access check is unavailable. */
  unavailable: 5,
  /**
   * `409 barrier-mismatch` from `reconciled`: a newer gap moved the
   * barrier, and the next fetch reports it.
   */
  conflict: 1,
} as const;

/** `Retry-After` in seconds (delta seconds or an HTTP date), if usable. */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) return Number(trimmed);
  // An HTTP date names its weekday and month; `Date.parse` would also take
  // `-1` as a year.
  if (!/[A-Za-z]/.test(trimmed)) return undefined;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

/** A refused request: the spec's error `code`, or the HTTP status alone. */
export class InboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    /** For `410`: the `resubscribe` result. */
    readonly ended?: ReconciliationRequired,
    /** The response's `Retry-After`, in seconds. */
    readonly retryAfter?: number,
  ) {
    super(`webhook inbox: ${status}${code ? ` ${code}` : ''}`);
  }

  /**
   * Seconds to wait before trying again, for a refusal that passes: a `429`
   * (`capacity-unavailable`, `rate-limited`, `quota-exceeded`), a `503`, or
   * a `409 barrier-mismatch` (the receiver's answer to `reconciled` when the
   * subscription is no longer reconciling at that barrier). `Retry-After`
   * wins when present. `undefined` for anything a retry would not fix.
   */
  backoff(): number | undefined {
    if (this.status === 429) {
      return this.retryAfter ?? DEFAULT_BACKOFF_SECONDS.tooMany;
    }
    if (this.status === 503) {
      return this.retryAfter ?? DEFAULT_BACKOFF_SECONDS.unavailable;
    }
    if (this.status === 409 && this.code === 'barrier-mismatch') {
      return this.retryAfter ?? DEFAULT_BACKOFF_SECONDS.conflict;
    }
    return undefined;
  }
}

export interface SubscribeRequest {
  connection: string;
  source: string;
  parameters: Record<string, string>;
  events: string[];
}

export class InboxClient {
  private readonly base: string;

  /** `baseUrl`: the receiver's public URL, e.g. `https://proxy.example`. */
  constructor(
    baseUrl: string,
    private readonly transport: Transport,
  ) {
    this.base = trimBase(baseUrl);
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = requestUrl(`${this.base}/${path.replace(/^\//, '')}`);
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
    const retryAfter = Object.entries(response.headers).find(
      ([name]) => name.toLowerCase() === 'retry-after',
    )?.[1];
    throw new InboxError(
      response.status,
      code,
      undefined,
      parseRetryAfter(retryAfter),
    );
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

  /**
   * Up to `limit` events after `after`; waits up to `wait` seconds for one
   * (the receiver caps it at 25). Without `wait` the receiver answers at
   * once, so a loop of such calls would poll as fast as it can.
   */
  events(
    id: string,
    options: { after?: string; limit?: number; wait?: number } = {},
  ): Promise<InboxEventPage> {
    const suffix = queryString({
      after: options.after,
      limit: options.limit,
      wait: options.wait,
    });
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
