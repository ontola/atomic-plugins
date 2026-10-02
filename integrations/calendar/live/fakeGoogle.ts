// @wc-ignore-file
/**
 * A small in-memory Google Calendar for the live check's offline tests: a
 * `fetch` stand-in with the behaviour the scenario relies on (list with and
 * without tombstones, insert with a chosen id, `If-Match` on patch, delete
 * leaving a cancelled tombstone, 410 for a second delete). Test-only; it is
 * not evidence about Google, only about the script.
 */
type Json = Record<string, unknown>;

export const TEST_CALENDAR = 'abc123testcal@group.calendar.google.com';

export function fakeGoogle({
  token,
  calendarName = 'Atomic live-check test',
  primary = false,
  accessRole = 'owner',
  existing = [] as Json[],
}: {
  token: string;
  calendarName?: string;
  primary?: boolean;
  accessRole?: string;
  existing?: Json[];
}) {
  let version = 0;
  const events = new Map<string, Json>();
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const etag = () => `"${++version}"`;
  for (const e of existing) events.set(e.id as string, { ...e, etag: etag() });

  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) => ({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  const fetcher = async (href: string, init: Record<string, unknown>) => {
    const url = new URL(href);
    const method = String(init.method ?? 'GET');
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    calls.push({ method, path: url.pathname + url.search, headers });
    if (headers.authorization !== `Bearer ${token}`) return reply(401, { error: { code: 401 } });
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Json) : {};
    const rest = url.pathname.replace('/calendar/v3', '');

    if (rest === '/users/me/calendarList')
      return reply(200, {
        items: [
          { id: 'owner@example.com', summary: 'owner@example.com', primary: true, accessRole: 'owner' },
          { id: TEST_CALENDAR, summary: calendarName, primary, accessRole },
        ],
      });

    const m = rest.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (!m || decodeURIComponent(m[1]) !== TEST_CALENDAR) return reply(404, {});
    const id = m[2] ? decodeURIComponent(m[2]) : undefined;

    if (!id) {
      if (method === 'GET') {
        const showDeleted = url.searchParams.get('showDeleted') === 'true';

        return reply(200, {
          items: [...events.values()].filter(e => showDeleted || e.status !== 'cancelled'),
        });
      }
      if (method === 'POST') {
        const newId = body.id as string;
        if (events.has(newId)) return reply(409, {});
        const created = { status: 'confirmed', htmlLink: `https://example.test/e/${newId}`, ...body, etag: etag() };
        events.set(newId, created);

        return reply(200, created, { etag: created.etag });
      }

      return reply(405, {});
    }

    const event = events.get(id);
    if (!event) return reply(404, {});
    if (method === 'GET') return reply(200, event, { etag: event.etag as string });
    if (method === 'PATCH') {
      if (headers['if-match'] && headers['if-match'] !== event.etag) return reply(412, {});
      Object.assign(event, body, { etag: etag() });

      return reply(200, event, { etag: event.etag as string });
    }
    if (method === 'DELETE') {
      if (event.status === 'cancelled') return reply(410, {});
      event.status = 'cancelled';
      event.etag = etag();

      return reply(204);
    }

    return reply(405, {});
  };

  return { fetcher, calls, events };
}
