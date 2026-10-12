// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  createApiClient,
  readCollections,
  readPlatform,
  type MissingRecord,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import {
  isListTombstone,
  parseListTombstone,
} from '../../../src/read/list-tombstones.js';
import { listTombstones } from '../../fixtures/list-tombstones.js';

// Deletion Feeds 0.3.0-draft §4.5 list tombstones, on the spec's §7.5
// example: cancelled events in a showDeleted=true read are deletions, not
// members, except cancelled exceptions of a recurring event. Invented data.

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

type Event = Record<string, unknown>;

/** A calendar whose list returns `listed()`; every request is recorded. */
function calendar(
  listed: () => Event[],
  item: (id: string) => Event | undefined = () => undefined,
): {
  requests: string[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const requests: string[] = [];
  return {
    requests,
    transport: async (r): Promise<TransportResponse> => {
      requests.push(`${r.method} ${r.url.pathname}${r.url.search}`);
      if (r.method === 'GET' && r.url.pathname === '/calendars/c1/events')
        return json({ items: listed() });
      if (r.method === 'PATCH') return json({ message: 'busy' }, 503);
      const read = /^\/calendars\/c1\/events\/([^/]+)$/.exec(r.url.pathname);
      if (r.method === 'GET' && read) {
        const found = item(decodeURIComponent(read[1]!));
        if (found) return json(found);
      }
      return json({ message: 'not found' }, 404);
    },
  };
}

/** The example with a PATCH on the event, so updates can be queued. */
function writable(): OpenApiDocument {
  const doc = structuredClone(listTombstones);
  doc.paths['/calendars/{calendarId}/events/{eventId}']!.patch = {
    responses: { '200': { description: 'Updated' } },
  };
  return doc;
}

const meeting = { id: 'e1', status: 'confirmed', summary: 'Meeting' };
const cancelled = { id: 'e1', status: 'cancelled' };
const exception = {
  id: 'e2_20261012',
  status: 'cancelled',
  recurringEventId: 'e2',
  originalStartTime: { dateTime: '2026-10-12T09:00:00Z' },
};

describe('isListTombstone (list_tombstone)', () => {
  const declaration = parseListTombstone({
    field: 'status',
    values: ['cancelled'],
    except: [{ field: 'recurringEventId', present: true }],
  })!;

  it('marks a cancelled event, not a cancelled exception or another status', () => {
    expect(isListTombstone(declaration, cancelled)).toBe(true);
    expect(isListTombstone(declaration, exception)).toBe(false);
    expect(
      isListTombstone(declaration, { ...exception, recurringEventId: null }),
    ).toBe(false);
    expect(isListTombstone(declaration, meeting)).toBe(false);
    expect(isListTombstone(declaration, { id: 'e3' })).toBe(false);
  });

  it('compares by JSON type', () => {
    const flag = parseListTombstone({ field: 'deleted', values: [true] })!;
    expect(isListTombstone(flag, { deleted: true })).toBe(true);
    expect(isListTombstone(flag, { deleted: 'true' })).toBe(false);
    expect(isListTombstone(flag, { deleted: 1 })).toBe(false);
  });

  it.each([
    [{ field: 'status', values: [] }],
    [{ field: '', values: ['cancelled'] }],
    [{ field: 'status', values: ['cancelled'], except: [] }],
    [{ field: 'status', values: ['cancelled'], except: [{ field: 'x' }] }],
    [
      {
        field: 'status',
        values: ['cancelled'],
        except: [{ field: 'x', present: true, values: ['a'] }],
      },
    ],
  ])('does not parse %j', (raw) => {
    expect(parseListTombstone(raw)).toBeUndefined();
  });
});

describe('readCollections and readPlatform with list tombstones', () => {
  it('keeps list tombstones out of the members and reports their ids', async () => {
    const fake = calendar(() => [meeting, cancelled, exception]);
    const result = await readCollections(listTombstones, {
      transport: fake.transport,
      constants: { calendarId: 'c1' },
    });
    const [snapshot] = result.collections;
    expect(snapshot!.complete).toBe(true);
    expect(snapshot!.items.map((i) => i['id'])).toEqual(['e1', 'e2_20261012']);
    expect(snapshot!.tombstones).toEqual(['e1']);
    // The fixed read sends showDeleted=true.
    expect(fake.requests[0]).toContain('showDeleted=true');
  });

  it('gives readPlatform no record for a list tombstone', async () => {
    const fake = calendar(() => [cancelled, exception]);
    const result = await readPlatform(listTombstones, {
      platform: 'calendar',
      constants: { calendarId: 'c1' },
      transport: fake.transport,
    });
    expect(result.records.map((r) => r.id)).toEqual(['e2_20261012']);
  });

  it('reads a declaration on the list operation too', async () => {
    const doc = structuredClone(listTombstones);
    const collections = (
      doc.components!['crudResources'] as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >
    )['event']!['collections']!;
    const declared = collections['eventsWithDeleted']!['x-list-tombstone'];
    delete collections['eventsWithDeleted']!['x-list-tombstone'];
    doc.paths['/calendars/{calendarId}/events']!.get!['x-list-tombstone'] =
      declared;
    const result = await readCollections(doc, {
      transport: calendar(() => [cancelled]).transport,
      constants: { calendarId: 'c1' },
    });
    expect(result.collections[0]!.tombstones).toEqual(['e1']);
  });

  it('keeps every item a member when the declaration does not parse', async () => {
    const doc = structuredClone(listTombstones);
    const collections = (
      doc.components!['crudResources'] as Record<
        string,
        Record<string, Record<string, Record<string, unknown>>>
      >
    )['event']!['collections']!;
    collections['eventsWithDeleted']!['x-list-tombstone'] = {
      field: 'status',
      values: [],
    };
    const result = await readCollections(doc, {
      transport: calendar(() => [cancelled]).transport,
      constants: { calendarId: 'c1' },
    });
    expect(result.collections[0]!.items).toEqual([cancelled]);
    expect(result.collections[0]).not.toHaveProperty('tombstones');
  });
});

describe('sync() with list tombstones', () => {
  it('removes a deleted event, keeps a cancelled exception, and takes the event back after a restore', async () => {
    let items: Event[] = [meeting, exception];
    const fake = calendar(() => items);
    const c = createApiClient(listTombstones, {
      transport: fake.transport,
      constants: { calendarId: 'c1' },
    });
    await c.sync();
    expect((await c.list('eventsWithDeleted')).map((e) => e['id'])).toEqual([
      'e1',
      'e2_20261012',
    ]);
    items = [cancelled, exception];
    await c.sync();
    expect((await c.list('eventsWithDeleted')).map((e) => e['id'])).toEqual([
      'e2_20261012',
    ]);
    // The organizer restores it: a member again.
    items = [{ ...meeting, summary: 'Meeting, restored' }, exception];
    await c.sync();
    expect(await c.get('eventsWithDeleted', 'e1')).toMatchObject({
      summary: 'Meeting, restored',
    });
  });

  it("fails a held update of a listed-as-deleted event as deleted, source 'list', without reading it", async () => {
    let items: Event[] = [meeting];
    const reports: MissingRecord[] = [];
    const fake = calendar(() => items);
    const c = createApiClient(writable(), {
      transport: fake.transport,
      constants: { calendarId: 'c1' },
      retry: { baseDelayMs: 60_000 },
      onMissingRecord: (r) => reports.push(r),
    });
    await c.sync();
    await c.update('eventsWithDeleted', 'e1', { summary: 'Moved' });
    await vi.waitFor(() => expect(c.pendingWrites()[0]?.attempts).toBe(1));
    items = [cancelled];
    await c.sync();
    expect(reports).toMatchObject([
      { id: 'e1', evidence: 'deleted', source: 'list' },
    ]);
    expect(c.pendingWrites()).toMatchObject([
      { id: 'e1', state: 'failed', missingRecord: 'deleted' },
    ]);
    // No read of the event itself.
    expect(
      fake.requests.filter((r) => r.startsWith('GET /calendars/c1/events/')),
    ).toEqual([]);
  });
});

describe('read tombstones with except conditions (one reading with lists, §4.3)', () => {
  /** The example plus the read-tombstone-v2 declaration on the event read. */
  function withReadTombstone(): OpenApiDocument {
    const doc = writable();
    doc.paths['/calendars/{calendarId}/events/{eventId}']!.get![
      'x-read-tombstone'
    ] = {
      field: 'status',
      values: ['cancelled'],
      except: [{ field: 'recurringEventId', present: true }],
    };
    return doc;
  }

  for (const [label, answer, evidence] of [
    ['a deleted event', { id: 'e1', status: 'cancelled' }, 'deleted'],
    [
      'a cancelled exception, which is not a deletion',
      { id: 'e1', status: 'cancelled', recurringEventId: 'e0' },
      'filtered',
    ],
  ] as const)
    it(`reads ${label} by GET as ${evidence}`, async () => {
      let items: Event[] = [meeting];
      const reports: MissingRecord[] = [];
      const fake = calendar(
        () => items,
        (id) => (id === 'e1' ? answer : undefined),
      );
      const c = createApiClient(withReadTombstone(), {
        transport: fake.transport,
        constants: { calendarId: 'c1' },
        retry: { baseDelayMs: 60_000 },
        onMissingRecord: (r) => reports.push(r),
      });
      await c.sync();
      await c.update('eventsWithDeleted', 'e1', { summary: 'Moved' });
      await vi.waitFor(() => expect(c.pendingWrites()[0]?.attempts).toBe(1));
      // The list leaves it out entirely: its read decides.
      items = [];
      await c.sync();
      expect(reports).toMatchObject([
        { id: 'e1', evidence, source: 'read', status: 200 },
      ]);
    });

  it('ignores a read tombstone whose except does not parse: no deletion on a guess', async () => {
    const doc = withReadTombstone();
    (
      doc.paths['/calendars/{calendarId}/events/{eventId}']!.get![
        'x-read-tombstone'
      ] as Record<string, unknown>
    )['except'] = [{ field: 'recurringEventId' }];
    let items: Event[] = [meeting];
    const reports: MissingRecord[] = [];
    const fake = calendar(
      () => items,
      () => ({ id: 'e1', status: 'cancelled' }),
    );
    const c = createApiClient(doc, {
      transport: fake.transport,
      constants: { calendarId: 'c1' },
      retry: { baseDelayMs: 60_000 },
      onMissingRecord: (r) => reports.push(r),
    });
    await c.sync();
    await c.update('eventsWithDeleted', 'e1', { summary: 'Moved' });
    await vi.waitFor(() => expect(c.pendingWrites()[0]?.attempts).toBe(1));
    items = [];
    await c.sync();
    expect(reports).toMatchObject([{ id: 'e1', evidence: 'filtered' }]);
  });
});
