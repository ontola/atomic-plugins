// @wc-ignore-file
import type { Transport } from 'syncables/browser';
import type { HostProxy } from './store.js';

export const PLATFORM = 'notion';

/**
 * One relayed request and what came back, for observers that need more than
 * syncables does: the controller records failures by status and proxy code
 * (`errors.ts`), and the sync reports progress per data source. `status` is
 * 0 when the host's call threw; `body` is the parsed body; `code` is the
 * integration proxy's refusal code, when it refused.
 */
export interface RelayExchange {
  method: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  code?: string;
}

export type RelayObserver = (exchange: RelayExchange) => void;

/** Wraps a transport so `observe` sees every exchange; the response is unchanged. */
export function observedTransport(
  transport: Transport,
  observe: RelayObserver,
): Transport {
  return async request => {
    const response = await transport(request);
    let body: unknown = response.body;

    try {
      body = JSON.parse(response.body);
    } catch {
      // Not JSON: observers get the text.
    }

    observe({
      method: request.method,
      path: `${request.url.pathname}${request.url.search}`,
      status: response.status,
      headers: response.headers,
      body,
    });

    return response;
  };
}

/**
 * Whether a Notion error body says its public API blocked this integration's
 * requests (`additional_data.rate_limit_reason` is
 * `public_api_request_blocked`). Notion sends that with a 429, but it is
 * permanent: retrying won't help, only Notion support can lift it. Read from
 * the body itself (an object, or JSON text), so it holds whatever the
 * transport or syncables make of the status.
 */
export function isBlockedByNotion(body: unknown): boolean {
  let value = body;

  if (typeof value === 'string')
    try {
      value = JSON.parse(value);
    } catch {
      return false;
    }

  const data =
    typeof value === 'object' && value !== null
      ? (value as { additional_data?: unknown }).additional_data
      : undefined;

  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { rate_limit_reason?: unknown }).rate_limit_reason ===
      'public_api_request_blocked'
  );
}

/**
 * Thrown by `syncablesTransport` for a 429 Notion marks as blocked
 * (`isBlockedByNotion`), after the observer has seen it: syncables retries a
 * 429 whose `Retry-After` is short, and a blocked request must not be sent
 * again (0.5.5). From 0.5.6 the same transport then refuses every later
 * request without sending it, so the read stops at the first block. The
 * controller classifies the sync as blocked from the observed failure.
 */
export class NotionBlocked extends Error {
  constructor(readonly path: string) {
    super(`Notion blocked this integration's request (429 for ${path}).`);
    this.name = 'NotionBlocked';
  }
}

/**
 * The integration proxy's own refusals (`integration-proxy/src/api_error.rs`):
 * `{ error, message }` with one of these codes, answered before the provider
 * is called. `RECONNECT_CODES` mean the connection is gone or no longer this
 * app's, so the person has to connect again; `ACCESS_CODES` are an access
 * problem that reconnecting does not fix.
 */
export const RECONNECT_CODES = [
  'unknown_connection',
  'not_delegated',
  'capability_scope',
  'platform_mismatch',
  'credential_refresh_failed',
  // Still expired after view-client.js's own single retry with a fresh one.
  'capability_expired',
  // A retired `Bearer` code: a connection from before #54 phase 2.
  'unsupported_authorization',
];
/**
 * The proxy says this person may not do this with the connection: an access
 * problem to explain, not something reconnecting fixes.
 */
export const ACCESS_CODES = ['unauthorized', 'forbidden'];
const REFUSAL_CODES = [
  ...RECONNECT_CODES,
  ...ACCESS_CODES,
  'missing_signature',
  'unsupported_signature_version',
  'invalid_agent',
  'agent_key_mismatch',
  'stale_timestamp',
  'bad_signature',
  'replayed',
  'invalid_capability',
  'capability_too_long',
  'wrong_audience',
  'capability_key_mismatch',
  'not_owner',
  'access_denied',
];

/** A refusal by the integration proxy itself, carrying its code. */
export class ProxyRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ProxyRefusal';
  }
}

/** A proxy refusal as an error, or `undefined` for a provider answer. */
export function proxyRefusal(response: {
  status: number;
  body: unknown;
}): ProxyRefusal | undefined {
  const body = response.body as { error?: unknown; message?: unknown } | null;
  const code = typeof body?.error === 'string' ? body.error : undefined;
  if (response.status < 400 || !code || !REFUSAL_CODES.includes(code))
    return undefined;
  const detail = typeof body?.message === 'string' ? `: ${body.message}` : '';

  return new ProxyRefusal(
    RECONNECT_CODES.includes(code)
      ? `The integration proxy refused this connection (${code}${detail}). Connect again.`
      : `The integration proxy refused the request (${code}${detail}).`,
    code,
    response.status,
  );
}

/**
 * syncables' injected transport, over the host's `store.proxy.request` (the
 * host's frame client calls the proxy itself with a capability and its own
 * key, ontola/atomic-plugins#54). syncables builds absolute URLs under the
 * document's server (`https://api.notion.com/v1`). The proxy wants the
 * provider path after `/proxy/<connection>/notion`, which keeps the `/v1`
 * base path (integration-proxy only allows `/v1/search`, not `/search`).
 * Anything outside that server is refused before it reaches the host.
 *
 * The host parses a JSON response body; syncables wants text, so it is
 * serialised again. Notion's list bodies are small, capped at 100 results.
 * A proxy refusal is thrown rather than handed over as Notion's answer.
 */
export function syncablesTransport(
  proxy: HostProxy,
  connectionId: string,
  upstream: URL,
  observe?: RelayObserver,
): Transport {
  const base = upstream.pathname.replace(/\/$/, '');
  /**
   * Set at the first 429 Notion marks as blocked (0.5.6): from then on this
   * transport sends nothing, so the read stops there instead of requesting
   * every remaining data source once more (each would be blocked too).
   */
  let blocked: NotionBlocked | undefined;

  return async request => {
    if (blocked) throw blocked;
    const { url } = request;
    if (
      url.origin !== upstream.origin ||
      (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(`Refusing a request outside ${upstream.href}`);

    const path = `${url.pathname}${url.search}`;
    let response;

    try {
      response = await proxy.request({
        platform: PLATFORM,
        connectionId,
        path,
        method: request.method,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
    } catch (error) {
      observe?.({
        method: request.method,
        path,
        status: 0,
        headers: {},
        body: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }

    const refused = proxyRefusal(response);
    observe?.({
      method: request.method,
      path,
      status: response.status,
      headers: response.headers ?? {},
      body: response.body,
      ...(refused ? { code: refused.code } : {}),
    });
    if (refused) throw refused;

    if (response.status === 429 && isBlockedByNotion(response.body)) {
      blocked = new NotionBlocked(path);
      throw blocked;
    }

    return {
      status: response.status,
      headers: response.headers ?? {},
      body:
        typeof response.body === 'string'
          ? response.body
          : JSON.stringify(response.body ?? null),
    };
  };
}
