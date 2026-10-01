// @wc-ignore-file
/**
 * The Calendar drive app's declared scope: the provider operations it may
 * send through the host's integration-proxy relay, and the host operations
 * it uses. This file is the declaration the catalog entry, README.md and the
 * tests refer to, and `relay.ts` enforces it at runtime: a request that
 * matches none of `OPERATIONS` never reaches `store.proxy.request`.
 *
 * The three provider operations are the ones the composed `google-calendar`
 * proxy catalog permits for this app
 * (`integration-proxy/tests/identity-catalog/google-calendar-composed.yaml`,
 * composed from `overlays/googleapis.com/google-calendar/v3/`). The scopes
 * are Google OAuth scopes under `https://www.googleapis.com/auth/`.
 * `operations.test.ts` checks each declared operation against that
 * document, and that the app's whole flow uses every declared operation and
 * nothing else; the calendar lane's e2e checks the same against the mock
 * proxy's record of what the real plugin frame sent.
 *
 * There is no sandbox manifest for this app any more (0.1.4): the drive app
 * is the one supported runtime (README.md, "Supported path"), and a
 * declaration of actions, secrets and operations the app does not perform
 * would say more than the app does.
 */

export const PLATFORM = 'google-calendar';
export const UPSTREAM = 'https://www.googleapis.com/calendar/v3';

export interface Operation {
  /** Google's operation id, without the `calendar.` prefix. */
  id: 'calendarList.list' | 'events.list' | 'events.patch';
  method: 'GET' | 'PATCH';
  /** The path as the proxy catalog's OpenAPI document writes it, under its server base. */
  template: string;
  /** `template` as a pattern over the relay path, which keeps the base's `/calendar/v3`. */
  path: RegExp;
  /** The one Google OAuth scope (under `https://www.googleapis.com/auth/`) the operation needs. */
  scope: 'calendar.calendarlist.readonly' | 'calendar.events';
  effect: 'read' | 'write';
  /** Query parameters the app sends with a fixed value, always. */
  fixedQuery: Record<string, string>;
  /** Query parameters the app may send with a varying value. */
  query: readonly string[];
  /** Whether every request carries `If-Match` (a conditional write). */
  ifMatch: boolean;
}

/** The relay path for a template: `{calendarId}` becomes one path segment, as `encodeURIComponent` leaves it. */
function pattern(template: string): RegExp {
  return new RegExp(
    `^${new URL(UPSTREAM).pathname}${template.replace(/\{[a-zA-Z]+\}/g, '[^/?#]+')}$`,
  );
}

export const OPERATIONS: readonly Operation[] = [
  {
    id: 'calendarList.list',
    method: 'GET',
    template: '/users/me/calendarList',
    path: pattern('/users/me/calendarList'),
    scope: 'calendar.calendarlist.readonly',
    effect: 'read',
    fixedQuery: { maxResults: '250' },
    query: ['pageToken'],
    ifMatch: false,
  },
  {
    id: 'events.list',
    method: 'GET',
    template: '/calendars/{calendarId}/events',
    path: pattern('/calendars/{calendarId}/events'),
    scope: 'calendar.events',
    effect: 'read',
    // Full scans: series masters with their tombstones, never a date window
    // (README.md, "Scope and policies").
    fixedQuery: {
      maxResults: '250',
      singleEvents: 'false',
      showDeleted: 'true',
    },
    query: ['pageToken'],
    ifMatch: false,
  },
  {
    id: 'events.patch',
    method: 'PATCH',
    template: '/calendars/{calendarId}/events/{eventId}',
    path: pattern('/calendars/{calendarId}/events/{eventId}'),
    scope: 'calendar.events',
    effect: 'write',
    // Guests are never emailed about an edit made through the app.
    fixedQuery: { sendUpdates: 'none' },
    query: [],
    ifMatch: true,
  },
];

/** The Google OAuth scopes the declared operations need, deduplicated and sorted. */
export const SCOPES: readonly string[] = [
  ...new Set(OPERATIONS.map(o => o.scope)),
].sort();

/**
 * The members of the host's `store` the app calls (`store.ts`). The first
 * group every host with `store.proxy` has; the second arrived at pin
 * 007869464 and is feature-detected, so an older host lacks the controls
 * that need it (README.md, "Design decisions").
 */
export const HOST_OPERATIONS = {
  store: ['getData', 'getResource', 'query', 'newResource'],
  proxy: ['request', 'connections', 'connect'],
  optional: {
    store: ['openExternal', 'openResource', 'getTheme', 'onThemeChange'],
    proxy: ['disconnect'],
  },
} as const;

export interface RelayRequest {
  method: string;
  /** The provider path after `/proxy/<connection>/google-calendar`. */
  path: string;
  query?: Record<string, string>;
  ifMatch?: string;
}

/**
 * The declared operation a request is an instance of. Throws, naming the
 * reason, for anything undeclared: another method, a path outside the three,
 * a query parameter the app does not send, a fixed parameter with another
 * value, a write without `If-Match`.
 */
export function operationFor(request: RelayRequest): Operation {
  const method = request.method.toUpperCase();
  const match = OPERATIONS.find(
    o => o.method === method && o.path.test(request.path),
  );
  if (!match)
    throw new Error(
      `The Calendar app does not send ${method} ${request.path}; see app/operations.ts`,
    );

  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (name in match.fixedQuery) {
      if (match.fixedQuery[name] !== value)
        throw new Error(
          `The Calendar app sends ${match.id} with ${name}=${match.fixedQuery[name]}, not ${name}=${value}`,
        );
    } else if (!match.query.includes(name))
      throw new Error(
        `The Calendar app does not send ${match.id} with ${name}; see app/operations.ts`,
      );
  }

  for (const [name, value] of Object.entries(match.fixedQuery))
    if (request.query?.[name] !== value)
      throw new Error(
        `The Calendar app sends ${match.id} only with ${name}=${value}`,
      );

  if (match.ifMatch && !request.ifMatch)
    throw new Error('Refusing a Calendar write without If-Match');

  return match;
}
