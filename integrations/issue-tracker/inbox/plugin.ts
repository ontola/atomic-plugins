// @wc-ignore-file
/**
 * The GitHub issues webhook inbox (#369 step 4b), as an atomic-server sync
 * session: the preview/step continuation protocol an Installation runs
 * unattended through `sync_worker.rs` and `sync_session.rs`, on the interval
 * its schedule sets (one minute at least). Each run:
 *
 * 1. `preview`: no network; it names the repository and the subscription.
 * 2. `step` (first): one consumer step. It acknowledges what the previous
 *    run stored and reports a reconciliation the previous run found done,
 *    both read from `ctx.connection`; renews the lease when due; fetches up
 *    to `limit` events (no long poll: the schedule paces the runs); and
 *    returns an `atomic` effect with a delivery row and a work item per new
 *    delivery and a gap row per gap.
 * 3. `step` (after the receipt): a `checkpoint` effect with the new state
 *    (`journal.ts`), then `complete`.
 *
 * So no event is acknowledged until a later run has read the checkpoint
 * written after its rows landed. A run stopped in between is resumed by the
 * worker from its saved session, or a later run fetches the same events and
 * finds their rows by delivery id.
 *
 * Gaps (the first subscription's included) are not reported reconciled
 * until a `reconcile` work item for that gap is `done`; the issue table's
 * full sync (the drive app) is to mark it so. Until then the subscription
 * stays reconciling: deliveries are still stored and acknowledged.
 *
 * It never holds a credential. The host signs every request as this
 * installation's node agent, which the integration proxy accepts as a
 * runtime of the app the GitHub connection is delegated to.
 *
 * This module runs inside atomic-server's QuickJS sandbox: no `URL`,
 * `Buffer`, `TextDecoder` or `fetch`; `ctx.http` is synchronous, and the
 * host returns a response's status and body but not its headers (so
 * `Retry-After` is not seen, and backoffs use syncables' defaults).
 */
import {
  InboxClient,
  InboxConsumer,
  type StoredSubscription,
  type TransportRequest,
  type TransportResponse,
} from 'syncables/browser';
import {
  BudgetReached,
  lastError,
  readState,
  SandboxInboxJournal,
  stateRecord,
  type ConnectionState,
  type Destination,
  type Intent,
  type JournalHost,
} from './journal.js';
import {
  DELIVERY_FIELDS,
  GAP_FIELDS,
  inboxSchema,
  WORK_FIELDS,
} from './schema.js';

/**
 * The integration proxy this build talks to. `build.mjs --proxy-origin`
 * replaces it (the lane's mock proxy in the e2e).
 *
 * TODO(ontola/atomic-server#2228): once `atomic-proxy:` reaches the consumer
 * routes, drop this origin and the absolute operation URLs below; the host
 * will resolve the proxy and the delegated connection itself.
 */
declare const __INBOX_PROXY_ORIGIN__: string | undefined;

export const PROXY_ORIGIN =
  typeof __INBOX_PROXY_ORIGIN__ === 'string'
    ? __INBOX_PROXY_ORIGIN__
    : 'https://localthought.io';

export const PLATFORM = 'github-issues';

/**
 * At most this many events per run.
 *
 * Two host caps bound a run's payloads: a fetched response is at most 8 MiB
 * (`egress::FETCH_MAX_RESPONSE_BYTES`), and a saved session, which holds
 * the pending `atomic` effect with every delivery's base64 payload, at most
 * 8 MiB (`sync_session::save`).
 *
 * - The session: the journal stops collecting at `RUN_PAYLOAD_BUDGET`
 *   (6 MiB of base64, 4.5 MiB raw; the first new event is always taken)
 *   and refuses one event over `MAX_EVENT_PAYLOAD` (7.5 MiB of base64,
 *   about 5.6 MiB raw).
 * - The fetch: a page fits when its events together are under about 6 MiB
 *   raw (8 MiB of base64, less the envelopes). GitHub issue and comment
 *   deliveries are usually a few tens of KiB. A page over the cap fails the
 *   fetch, and the run records `lastError`. A run after a failed one asks
 *   for one event only, so a page over the cap only because of its
 *   neighbours gets through one event at a time.
 *
 * Not every delivery fits. The proxy retains bodies up to 8 MiB
 * (`delivery.maxBodyBytes`, pilot value). One event over about 5.6 MiB raw
 * is refused, and one over about 6 MiB raw cannot be fetched at all, so
 * every run fails at it until the proxy drops it (7 days). A `maxBytes`
 * parameter on `events`, returning an oversized event without its body, is
 * the planned fix (#369 step 4b plan, Unit B).
 */
export const DEFAULT_LIMIT = 4;

/**
 * The consumer routes, as declared operations. Every `ctx.http` request is a
 * read effect to the host; none of these changes provider data.
 *
 * TODO(ontola/atomic-server#2228): these call the integration proxy by its
 * absolute URL, which atomic-server accepts (and signs) but logs as
 * deprecated. Switch to `atomic-proxy:` URLs when #2228 lands.
 */
export function operations(origin: string) {
  return [
    {
      id: 'inbox-subscribe',
      method: 'POST',
      url: `${origin}/connections/{*rest}`,
      effect: 'read',
    },
    {
      id: 'inbox-read',
      method: 'GET',
      url: `${origin}/subscriptions/{*rest}`,
      effect: 'read',
    },
    {
      id: 'inbox-update',
      method: 'POST',
      url: `${origin}/subscriptions/{*rest}`,
      effect: 'read',
    },
    {
      id: 'inbox-delete',
      method: 'DELETE',
      url: `${origin}/subscriptions/{*rest}`,
      effect: 'read',
    },
  ];
}

export const manifest = {
  schemaVersion: 2,
  name: 'github-issues-inbox',
  namespace: 'atomic-plugins',
  version: '0.1.0',
  description:
    'Keep GitHub issue webhook deliveries from the integration proxy, before acknowledging them.',
  operations: operations(PROXY_ORIGIN),
  // The platform whose connection the Installation page connects and
  // delegates to this installation, and whose id the host hands over as
  // `ctx.connections['github-issues']`. No `atomic-proxy:` operation uses it
  // yet (TODO(ontola/atomic-server#2228)).
  proxy: [PLATFORM],
  secrets: [],
  config: {
    key: 'github-issues-inbox',
    properties: {
      repository: {
        type: 'string',
        description: 'The repository, as owner/name',
      },
      events: {
        type: 'array',
        description: 'Event types to subscribe to (default: issues)',
      },
      limit: {
        type: 'integer',
        description: `Events per run (default ${DEFAULT_LIMIT})`,
      },
      table: { type: 'string', description: 'Table the deliveries go to' },
      rowClass: { type: 'string', description: 'Class of a delivery row' },
      properties: {
        type: 'object',
        description: 'Inbox properties, by shortname',
      },
      tables: {
        type: 'object',
        description: '`work` and `gaps`: the other two tables Set up created',
      },
    },
    // Only the repository at install: the tables, classes and properties come
    // from `provisionDestination` afterwards (the host has no "Set up" for a
    // plugin that is not a file importer), and the sync preview's config
    // carries them all; `readConfig` checks that one.
    required: ['repository'],
  },
  destination: {
    schema: inboxSchema(),
    table: {
      name: 'Webhook deliveries',
      rowClass: 'webhook-delivery',
      columns: [
        'webhook-received-at',
        'webhook-event-type',
        'webhook-action',
        'webhook-source-key',
        'webhook-delivery-id',
        'webhook-payload-bytes',
      ],
    },
    tables: {
      work: {
        name: 'Webhook work',
        rowClass: 'webhook-work-item',
        columns: [
          'webhook-work-kind',
          'webhook-work-status',
          'webhook-delivery',
          'webhook-gap-key',
        ],
      },
      gaps: {
        name: 'Webhook gaps',
        rowClass: 'webhook-gap',
        columns: [
          'webhook-detected-at',
          'webhook-gap-reason',
          'webhook-subscription',
          'webhook-generation',
        ],
      },
    },
  },
};

export interface Config {
  repository: string;
  events?: string[];
  limit?: number;
  table: string;
  rowClass: string;
  properties: Record<string, string>;
  tables: { work: Destination; gaps: Destination };
}

/** What the host hands a sync-session invocation (`sync_session::invoke`). */
export interface Ctx extends JournalHost {
  phase: 'preview' | 'step' | 'action';
  config?: Config;
  connections?: Record<string, string>;
  connection?: ConnectionState;
  proposal?: Proposal | null;
  cursor?: Cursor | null;
  /** The receipt of the previous effect. */
  result?: unknown;
  /** `at` is the run's start; the sandbox's `Date` is frozen to it too. */
  trigger?: { kind?: string; at?: number };
  http(request: {
    operation: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): HttpResponse | Promise<HttpResponse>;
}

export interface Proposal {
  repository: string;
  subscription: string | null;
  /** The last run's failure, shown for review. */
  lastError: { message: string; at: string } | null;
}

/** The session cursor between the steps of one run. */
export interface Cursor {
  stage: 'checkpoint' | 'done';
  state: StoredSubscription | null;
  error?: { message: string; at: string };
}

/** What `ctx.http` returns: the host passes on no response headers. */
export interface HttpResponse {
  status: number;
  body: string;
}

/** Which declared operation a consumer request is. */
export function operationOf(method: string, path: string): string {
  if (method === 'POST' && path.startsWith('/connections/')) {
    return 'inbox-subscribe';
  }

  if (path.startsWith('/subscriptions/')) {
    if (method === 'GET') return 'inbox-read';
    if (method === 'POST') return 'inbox-update';
    if (method === 'DELETE') return 'inbox-delete';
  }

  throw new Error(`webhook inbox: no operation for ${method} ${path}`);
}

/** `ctx.http`, as the syncables transport the inbox client uses. */
export function sandboxTransport(ctx: Pick<Ctx, 'http'>) {
  return async (request: TransportRequest): Promise<TransportResponse> => {
    // Synchronous in the sandbox; awaiting a plain value is harmless.
    const response = await ctx.http({
      operation: operationOf(request.method, request.url.pathname),
      method: request.method,
      url: request.url.href,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });

    return { status: response.status, headers: {}, body: response.body };
  };
}

/** Every property shortname a run writes or queries. */
const SHORTNAMES = [
  ...new Set(
    [...DELIVERY_FIELDS, ...WORK_FIELDS, ...GAP_FIELDS].map(([name]) => name),
  ),
];

function readConfig(config: Config | undefined): Config {
  const missing = (
    ['repository', 'table', 'rowClass', 'properties', 'tables'] as const
  ).filter(key => !config?.[key]);

  if (!config || missing.length) {
    throw new Error(
      `Configure this plugin before running it: missing ${missing.join(', ')}`,
    );
  }

  if (!config.tables.work?.table || !config.tables.gaps?.table) {
    throw new Error(
      'Configure this plugin before running it: missing tables.work or tables.gaps',
    );
  }

  if (!/^[^/\s]+\/[^/\s]+$/.test(config.repository)) {
    throw new Error('repository must be owner/name');
  }

  // A missing property would drop that field silently; the work item's
  // would leave a delivery row without its work item, and that row would
  // then be found by its id and kept that way.
  const unset = SHORTNAMES.filter(name => !config.properties[name]);

  if (unset.length) {
    throw new Error(
      `Configure this plugin before running it: no property for ${unset.join(', ')}`,
    );
  }

  return config;
}

/** A run's output, as `sync_session::Output` reads it. */
export type Output =
  | { kind: 'preview'; proposal: Proposal; problems: never[] }
  | {
      kind: 'effect';
      effect:
        | {
            kind: 'atomic';
            id: string;
            verdict: { intents: Intent[]; problems: never[] };
          }
        | {
            kind: 'checkpoint';
            id: string;
            records: ReturnType<typeof stateRecord>[];
          };
      cursor: Cursor;
    }
  | { kind: 'complete' };

export async function run(ctx: Ctx): Promise<Output> {
  if (ctx.phase === 'action') {
    throw new Error('The webhook inbox has no actions');
  }

  const config = readConfig(ctx.config);
  const connection = ctx.connections?.[PLATFORM];

  if (!connection) {
    throw new Error(
      `Delegate a ${PLATFORM} connection to this installation before running it`,
    );
  }

  const state = readState(ctx.connection);

  if (ctx.phase === 'preview') {
    return {
      kind: 'preview',
      proposal: {
        repository: config.repository,
        subscription: state?.id ?? null,
        lastError: lastError(ctx.connection) ?? null,
      },
      problems: [],
    };
  }

  if (ctx.proposal?.repository !== config.repository) {
    throw new Error('An approved proposal for this repository is required');
  }

  const checkpoint = (
    next: StoredSubscription | undefined,
    error?: { message: string; at: string },
    written?: string[],
  ): Output => ({
    kind: 'effect',
    effect: {
      kind: 'checkpoint',
      id: 'inbox-checkpoint',
      records: [stateRecord(next, config.table, error, written)],
    },
    cursor: { stage: 'done', state: next ?? null, ...(error ? { error } : {}) },
  });
  if (ctx.cursor?.stage === 'done') return { kind: 'complete' };

  // The rows landed (the host stops the run on a failed atomic effect).
  if (ctx.cursor?.stage === 'checkpoint') {
    // The receipt names the rows written, kept in the state so a person (or
    // a test) can find what the last run stored.
    const outcomes = (ctx.result as { outcomes?: { subject?: unknown }[] })
      ?.outcomes;
    const written = (outcomes ?? [])
      .map(o => o.subject)
      .filter((s): s is string => typeof s === 'string');

    return checkpoint(ctx.cursor.state ?? undefined, ctx.cursor.error, written);
  }

  const [owner, repo] = config.repository.split('/') as [string, string];
  const journal = new SandboxInboxJournal(
    ctx,
    {
      properties: config.properties,
      deliveries: { table: config.table, rowClass: config.rowClass },
      work: config.tables.work,
      gaps: config.tables.gaps,
    },
    state,
  );
  const consumer = new InboxConsumer({
    client: new InboxClient(PROXY_ORIGIN, sandboxTransport(ctx)),
    journal,
    subscription: {
      connection,
      source: 'repository',
      parameters: { owner, repo },
      events: config.events?.length ? config.events : ['issues'],
    },
    reconcile: (reason, required) => journal.reconcile(reason, required),
    acknowledge: 'next-step',
    wait: 0,
    // After a failed run, one event: a page over the host's fetch cap may
    // be over it only because of its neighbours.
    limit: lastError(ctx.connection)
      ? 1
      : Math.min(config.limit ?? DEFAULT_LIMIT, DEFAULT_LIMIT),
    now: () => ctx.trigger?.at ?? Date.now(),
  });
  // One consumer step per run: a second would acknowledge this run's events
  // before their checkpoint.
  //
  // A step that throws must not fail the run: atomic-server stops a sync
  // session that errors, and its schedule with it, until a person reviews it
  // again (`sync_worker::execute` skips a session in `error`). A transport
  // failure, a refusal a retry would not fix, or an `events` page over the
  // host's 8 MiB fetch cap (see `DEFAULT_LIMIT`) is recorded in the state as
  // `lastError` instead, with whatever state the step reached (an ack it
  // made, a subscription it created), and nothing is written: the next run
  // tries again.
  let error: { message: string; at: string } | undefined;

  try {
    await consumer.step();
  } catch (thrown) {
    // A spent payload budget ends the step early, and is not a failure.
    if (!(thrown instanceof BudgetReached)) {
      error = {
        message: thrown instanceof Error ? thrown.message : String(thrown),
        at: new Date(ctx.trigger?.at ?? Date.now()).toISOString(),
      };
    }
  }

  const next = journal.current();
  if (journal.intents.length === 0) return checkpoint(next, error);

  // Rows the step collected are written even when it failed later: the
  // state may already name their cursor to acknowledge.
  return {
    kind: 'effect',
    effect: {
      kind: 'atomic',
      id: 'inbox-writes',
      verdict: { intents: journal.intents, problems: [] },
    },
    cursor: {
      stage: 'checkpoint',
      state: next ?? null,
      ...(error ? { error } : {}),
    },
  };
}
