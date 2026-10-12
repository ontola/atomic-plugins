// @wc-ignore-file
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  InMemoryStorageAdapter,
  type ApiClient,
  type OpenApiDocument,
  type OverlayDocument,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { parsePrecondition } from '../../../src/client/preconditions.js';

// K18 part 2 (docs/design/pieces.md §3.5): Google Calendar's recurring
// series are not written. The repository's own Calendar write-preconditions
// overlay is read from `overlays/` and applied, unchanged, to a minimal
// Calendar-shaped document: the event read, PATCH, PUT and DELETE, with the
// `x-crud` of the catalog's app-crud-causality overlay (PATCH update) and
// the broader crud-causality overlay (DELETE delete). The provider is a
// fake; no Google API is called. The overlay declares `ifMatch` on the body
// field `etag` and `refuseWhen: [{ field: recurrence, present: true }]`: a
// series' master event is refused, while a single event and an exception of
// a series (`recurringEventId`, no `recurrence`) are sent with `If-Match`.

const OVERLAY = new URL(
  '../../../../overlays/APIs/googleapis.com/calendar/v3/write-preconditions-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml',
  import.meta.url,
);
const EVENT = '/calendars/{calendarId}/events/{eventId}';

const overlay = yaml.load(readFileSync(OVERLAY, 'utf8')) as OverlayDocument;

const json = { content: { 'application/json': { schema: {} } } };

const base: OpenApiDocument = {
  openapi: '3.0.0',
  info: { title: 'Calendar-shaped events', version: 'v3' },
  servers: [{ url: 'https://calendar.example/calendar/v3' }],
  paths: {
    '/calendars/{calendarId}/events': {
      get: {
        operationId: 'calendar.events.list',
        'x-crud': { action: 'list', resource: 'event' },
        responses: { '200': { description: 'Events' } },
      },
    },
    [EVENT]: {
      get: {
        operationId: 'calendar.events.get',
        'x-crud': { action: 'read', resource: 'event' },
        responses: { '200': { description: 'An event' } },
      },
      patch: {
        operationId: 'calendar.events.patch',
        'x-crud': { action: 'update', resource: 'event' },
        requestBody: json,
        responses: { '200': { description: 'The event' } },
      },
      put: {
        operationId: 'calendar.events.update',
        requestBody: json,
        responses: { '200': { description: 'The event' } },
      },
      delete: {
        operationId: 'calendar.events.delete',
        'x-crud': { action: 'delete', resource: 'event' },
        responses: { '204': { description: 'Deleted' } },
      },
    },
  },
  components: {
    crudResources: {
      event: {
        identity: {
          urlTemplate: EVENT,
          bindings: { eventId: { field: 'id' } },
        },
        collections: {
          events: {
            urlTemplate: '/calendars/{calendarId}/events',
            envelope: { itemsField: 'items' },
          },
        },
      },
    },
  },
};

/**
 * Applies the overlay's `update` actions. Its targets are
 * `$.paths['<path>'].<method>`, a bracket form `applyOverlay` does not
 * take (plain dot-paths only), so each is resolved here and merged the
 * way an Overlay `update` merges an object.
 */
function applyOperationUpdates(
  document: OpenApiDocument,
  actions: OverlayDocument['actions'],
): OpenApiDocument {
  const result = structuredClone(document);
  for (const action of actions) {
    const m = /^\$\.paths\['([^']+)'\]\.(get|put|patch|post|delete)$/.exec(
      action.target,
    );
    if (!m || !action.update) throw new Error(`Unexpected ${action.target}`);
    const item = result.paths[m[1]!] as Record<string, Record<string, unknown>>;
    const operation = item[m[2]!];
    if (!operation) throw new Error(`No operation at ${action.target}`);
    Object.assign(operation, structuredClone(action.update));
  }
  return result;
}

const doc = applyOperationUpdates(base, overlay.actions);

type Event = Record<string, unknown>;

const single: Event = { id: 'single', etag: '"3181"', summary: 'Dentist' };
const master: Event = {
  id: 'series',
  etag: '"3182"',
  summary: 'Standup',
  recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
};
const exception: Event = {
  id: 'series_20261012T090000Z',
  etag: '"3183"',
  summary: 'Standup, moved',
  recurringEventId: 'series',
};
const c1 = { calendarId: 'c1' };

const response = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: value === undefined ? '' : JSON.stringify(value),
});

function headerOf(r: TransportRequest, name: string): string | undefined {
  for (const [key, value] of Object.entries(r.headers ?? {}))
    if (key.toLowerCase() === name.toLowerCase()) return value;
  return undefined;
}

/** A fake calendar: writes need `If-Match` with the current etag. */
function provider(): { log: string[]; transport: Transport } {
  const events = new Map(
    [single, master, exception].map((e) => [
      String(e['id']),
      structuredClone(e),
    ]),
  );
  let version = 4000;
  const fake = {
    log: [] as string[],
    transport: (async (r: TransportRequest) => {
      const m = /^\/calendar\/v3\/calendars\/c1\/events(?:\/([^/]+))?$/.exec(
        r.url.pathname,
      );
      const id = m?.[1] ? decodeURIComponent(m[1]) : undefined;
      const ifMatch = headerOf(r, 'if-match');
      fake.log.push(
        `${r.method} ${id ?? 'list'}${ifMatch ? ` if-match ${ifMatch}` : ''}`,
      );
      if (r.method === 'GET' && !id)
        return response({ items: [...events.values()] });
      const event = id ? events.get(id) : undefined;
      if (!event) return response({ error: 'not found' }, 404);
      if (r.method === 'GET') return response(event);
      if (ifMatch !== event['etag'])
        return response({ error: 'precondition failed' }, 412);
      if (r.method === 'DELETE') {
        events.delete(id!);
        return response(undefined, 204);
      }
      const body = r.body ? (JSON.parse(r.body) as Event) : {};
      const updated = { ...event, ...body, id, etag: `"${version++}"` };
      events.set(id!, updated);
      return response(updated);
    }) as Transport,
  };
  return fake;
}

async function synced(): Promise<{
  client: ApiClient;
  fake: ReturnType<typeof provider>;
}> {
  const fake = provider();
  const client = createApiClient(doc, {
    storage: new InMemoryStorageAdapter(),
    transport: fake.transport,
    constants: c1,
    retry: { baseDelayMs: 60_000 },
  });
  await client.sync();
  fake.log.length = 0;
  return { client, fake };
}

async function idle(client: ApiClient): Promise<void> {
  await vi.waitFor(() => expect(client.pendingWrites()).toEqual([]));
}

async function stopped(client: ApiClient): Promise<void> {
  await vi.waitFor(() =>
    expect(client.pendingWrites()).toMatchObject([{ state: 'failed' }]),
  );
}

describe("Calendar's write-preconditions overlay (K18 part 2)", () => {
  it('declares what this client parses, on PATCH, PUT and DELETE, under the placement rules', () => {
    const item = doc.paths[EVENT] as Record<string, Record<string, unknown>>;
    for (const method of ['patch', 'put', 'delete']) {
      const operation = item[method]!;
      const parsed = parsePrecondition(operation['x-write-precondition'], {
        method,
        operation,
        document: doc as unknown as Record<string, unknown>,
        path: EVENT,
      });
      expect({ method, parsed }).toMatchObject({
        method,
        parsed: {
          kind: 'ifMatch',
          version: { in: 'body', name: 'etag' },
          refuseWhen: [{ field: 'recurrence', present: true }],
        },
      });
    }
  });

  it("refuses an update of a series' master event, without a request", async () => {
    const { client, fake } = await synced();
    await client.update('events', 'series', { summary: 'Standup!' }, c1);
    await stopped(client);
    expect(fake.log).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', precondition: 'refused' },
    ]);
    expect(client.pendingWrites()[0]?.lastError).toContain(
      "recurring series' master event",
    );
  });

  it("refuses a delete of a series' master event, without a request", async () => {
    const { client, fake } = await synced();
    await client.remove('events', 'series', c1);
    await stopped(client);
    expect(fake.log).toEqual([]);
    expect(client.pendingWrites()).toMatchObject([
      { state: 'failed', precondition: 'refused' },
    ]);
  });

  it('sends an update of a single event with its etag as If-Match', async () => {
    const { client, fake } = await synced();
    await client.update('events', 'single', { summary: 'Dentist, 10:00' }, c1);
    await idle(client);
    // The client sends the PUT when the path has one (the full record), as
    // it does today even though only the PATCH carries x-crud update; both
    // carry the same precondition.
    expect(fake.log).toEqual(['PUT single if-match "3181"']);
  });

  it('sends an update of an exception of a series: one event of its own', async () => {
    const { client, fake } = await synced();
    await client.update(
      'events',
      'series_20261012T090000Z',
      { summary: 'Standup, room 2' },
      c1,
    );
    await idle(client);
    expect(fake.log).toEqual(['PUT series_20261012T090000Z if-match "3183"']);
  });

  it('sends a delete of an exception of a series', async () => {
    const { client, fake } = await synced();
    await client.remove('events', 'series_20261012T090000Z', c1);
    await idle(client);
    expect(fake.log[0]).toBe('DELETE series_20261012T090000Z if-match "3183"');
  });
});
