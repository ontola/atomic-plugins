// @wc-ignore-file
/**
 * A failed sync, as the banners in design #89 §6J need it: what kind of
 * failure it was, when to try again, and the raw detail for bug reports.
 * Pure; the controller attaches one to a failed `SyncOutcome`.
 */
import { ProxyError } from './transport.js';

export type ProblemKind =
  /** 401: the key was deleted or regenerated. */
  | 'reauth'
  /** 403 on time entries: this account cannot read that workspace. */
  | 'forbidden'
  /**
   * The integration proxy's own access check refuses this person or app
   * (`access_denied`: "this agent may not use the proxy"): neither another
   * workspace nor a reconnect changes that (0.8.2).
   */
  | 'proxy-access'
  /**
   * The proxy refuses this agent because its key was replaced: a key
   * transfer (#410) moved its connections to the new agent and retired
   * this id (`agent_retired`). Reconnecting cannot help, since the proxy
   * refuses the retired id at `/connect/redeem` too; Atomic opened with the
   * new key has the connections already (0.8.3; 0.8.2 said reconnect).
   */
  | 'agent-retired'
  /** 429. */
  | 'rate-limited'
  /** The relay or the proxy could not be reached (no HTTP status). */
  | 'network'
  /** More than the page cap (200 × 50 entries). */
  | 'too-many'
  | 'other';

export interface Problem {
  kind: ProblemKind;
  /** For `rate-limited`: from `retry-after` when relayed, else 60. */
  retryAfterSeconds?: number;
  /** HTTP status and message, or the error text: for the Details disclosure. */
  detail: string;
}

export const DEFAULT_RETRY_SECONDS = 60;

/** Proxy refusal codes that mean: connect again (#54 phase 2). */
const REAUTH = new Set([
  'unknown_connection',
  'not_delegated',
  'capability_scope',
  'platform_mismatch',
  'credential_refresh_failed',
  // The connection belongs to another owner: connecting again gives this
  // person a connection of their own (0.8.2; before, it read as "choose
  // another workspace").
  'not_owner',
  // Only after the frame client's own single retry. (The retired
  // Bearer-code refusal is left out, as in transport.ts: only a host from
  // before #54 sends it, and build.test.ts keeps that word out of the bundle.)
  'capability_expired',
]);
/**
 * Proxy refusal codes that mean: the proxy's access check refuses this
 * person or app (`integration-proxy/src/api_error.rs` `AccessDenied`).
 * `api_error.rs` has no `unauthorized` or `forbidden` code; they are kept
 * defensively, for a proxy or host that answers with those generic words.
 * Only whoever runs the proxy can change it.
 */
const ACCESS = new Set(['unauthorized', 'forbidden', 'access_denied']);

/**
 * The proxy's own wording (`integration-proxy/src/api_error.rs`) for the
 * refusals a connect can end in. The host relays a failed delegation
 * (`POST /connections/<id>/agents`, picking an existing connection) or a
 * failed listing (`GET /connections`) to the frame as a message only ("The
 * integration proxy refused POST /connections/<id>/agents: <the proxy's
 * message>"), without the code, so these are matched by their text (0.8.4).
 * A refused `/connect/redeem` never reaches the frame: the host's return page
 * shows it. `proxyMessages.test.ts` checks both phrases are still in
 * `api_error.rs`. The long-term fix is the host passing the code along
 * (ontola/atomic-server#2321); then this table can go.
 */
export const PROXY_MESSAGES: [RegExp, string][] = [
  [
    /this agent id was transferred to another one and can no longer own connections/,
    'agent_retired',
  ],
  [/this agent may not use the proxy/, 'access_denied'],
];

const messageCode = (detail: string) =>
  PROXY_MESSAGES.find(([pattern]) => pattern.test(detail))?.[1];

/** `retry-after` as seconds (a number or an HTTP date), else undefined. */
export function retryAfterSeconds(
  header: string | undefined,
  now: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();

  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);

  return Number.isFinite(at)
    ? Math.max(0, Math.ceil((at - now) / 1000))
    : undefined;
}

const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function classify(error: unknown, now = Date.now()): Problem {
  if (error instanceof ProxyError) {
    const message =
      error.body && typeof error.body === 'object' && 'message' in error.body
        ? ` "${String((error.body as { message: unknown }).message)}"`
        : typeof error.body === 'string' && error.body
          ? ` "${error.body}"`
          : '';
    const detail = `HTTP ${error.status} on GET ${error.path}${message}`;

    if (error.status === 401) return { kind: 'reauth', detail };
    if (error.status === 403) return { kind: 'forbidden', detail };

    if (error.status === 429)
      return {
        kind: 'rate-limited',
        retryAfterSeconds:
          retryAfterSeconds(error.retryAfter, now) ?? DEFAULT_RETRY_SECONDS,
        detail,
      };

    return { kind: 'other', detail };
  }

  const detail = text(error);
  // The integration proxy's own refusals (#54 phase 2): `transport.ts`'s
  // `proxyRefusal` messages, or an error from the host's frame client that
  // carries the proxy's code.
  const code =
    typeof (error as { code?: unknown } | null)?.code === 'string'
      ? (error as { code: string }).code
      : (/refused (?:this connection|the request) \((\w+)/.exec(detail)?.[1] ??
        messageCode(detail));
  // Before the reconnect check: reconnecting loops on a retired id.
  if (code === 'agent_retired') return { kind: 'agent-retired', detail };
  if (/refused this connection/.test(detail) || (code && REAUTH.has(code)))
    return { kind: 'reauth', detail };
  if (code && ACCESS.has(code)) return { kind: 'proxy-access', detail };
  if (code || /refused the request/.test(detail))
    return { kind: 'other', detail };
  if (/returned more than \d+ pages/.test(detail))
    return { kind: 'too-many', detail };

  // What the relay throws instead of answering: the proxy (or the host
  // page's connection to it) was not reachable. The host's exact error
  // text is not specified, so this matches loosely.
  if (error instanceof TypeError || /fetch|network|relay|proxy/i.test(detail))
    return { kind: 'network', detail };

  return { kind: 'other', detail };
}
