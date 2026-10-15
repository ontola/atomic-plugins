/**
 * A client for the consumer routes of a webhook receiver
 * (`openapi-extensions/spec/webhook-subscriptions`, as `integration-proxy`
 * serves them with `WEBHOOKS_ENABLED=true`). It only shapes requests and
 * parses answers; signing is the transport's job (`signedTransport`).
 */
import type { Transport } from '../read/transport.js';
import { parseHttpDate } from '../throttling/throttling.js';
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
    /**
     * The raw body, base64. Absent exactly when `omitted`: the body alone
     * was over the fetch's `maxBytes` (Webhook Subscriptions 0.2.0-draft).
     */
    body?: string;
    omitted?: true;
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
   * `409 barrier-mismatch` (a newer gap moved the barrier, or the
   * subscription is still provisioning) or `409 obsolete-generation` (a gap
   * ended the generation an ack or `reconciled` named): the next fetch
   * reports the current state.
   */
  conflict: 1,
} as const;

/**
 * `Retry-After` in seconds, if usable, by the same rules as the client's
 * write retries (`client.ts` `retryAfterMs`): only space, tab, CR and LF are
 * stripped; delay-seconds up to 2^53 − 1; or an HTTP-date in one of its
 * exact forms (RFC 9110 §5.6.7, `parseHttpDate`). Anything else, such as
 * `1.5`, `-1`, a 400-digit number or a date with a no-break space, is not.
 */
export function parseRetryAfter(
  value: string | undefined,
  now: number = Date.now(),
): number | undefined {
  const stripped = value?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!stripped) return undefined;
  if (/^[0-9]+$/.test(stripped)) {
    const seconds = Number(stripped);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }
  const date = parseHttpDate(stripped);
  if (date === undefined) return undefined;
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
   * (`capacity-unavailable`, `rate-limited`, `quota-exceeded`), a `503`, a
   * `409 barrier-mismatch` (the receiver's answer to `reconciled` when the
   * subscription is no longer reconciling at that barrier, and to a fetch
   * while it is still provisioning), or a `409 obsolete-generation` (an ack
   * or `reconciled` for a generation a gap has ended). `Retry-After` wins
   * when present. `undefined` for anything a retry would not fix.
   */
  backoff(): number | undefined {
    if (this.status === 429) {
      return this.retryAfter ?? DEFAULT_BACKOFF_SECONDS.tooMany;
    }
    if (this.status === 503) {
      return this.retryAfter ?? DEFAULT_BACKOFF_SECONDS.unavailable;
    }
    if (
      this.status === 409 &&
      (this.code === 'barrier-mismatch' || this.code === 'obsolete-generation')
    ) {
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
   *
   * `maxBytes` (an integer, at least 1) bounds the page's base64 payload
   * bytes. An event whose body alone is over it comes back alone, with
   * `payload.omitted` and no `body`. The envelopes are not counted.
   */
  events(
    id: string,
    options: {
      after?: string;
      limit?: number;
      maxBytes?: number;
      wait?: number;
    } = {},
  ): Promise<InboxEventPage> {
    if (
      options.maxBytes !== undefined &&
      !(Number.isInteger(options.maxBytes) && options.maxBytes >= 1)
    ) {
      throw new RangeError('maxBytes must be an integer of at least 1');
    }
    const suffix = queryString({
      after: options.after,
      limit: options.limit,
      maxBytes: options.maxBytes,
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
