// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  createApiClient,
  readPlatform,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { userDefinedColumns } from '../../fixtures/runtime-schemas.js';

// Runtime Schemas classes in readPlatform and the client's sync(), on the
// spec's §7.1 example: rows whose `properties` their table describes.
// Invented rows and tables.

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

const TABLE = {
  id: 't1',
  properties: {
    Estimate: { id: 'a%3Ab', name: 'Estimate', type: 'number', number: {} },
    Stage: {
      id: 'c%3Ad',
      name: 'Stage',
      type: 'select',
      select: { options: [{ id: 'opt-1', name: 'Doing' }] },
    },
  },
};

const ROW = {
  id: 'r1',
  parent: { table_id: 't1' },
  properties: {
    Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
    Stage: { id: 'c%3Ad', type: 'select', select: { id: 'opt-1' } },
  },
};

const CONFLICTING = {
  id: 'r2',
  parent: { table_id: 't1' },
  properties: {
    Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
    'Old estimate': { id: 'a%3Ab', type: 'number', number: 5 },
  },
};

/** Answers the rows, and the table with `table` (a status or a body). */
function provider(
  table: TransportResponse,
  rows: TransportResponse = json([ROW, CONFLICTING]),
): {
  requests: string[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const requests: string[] = [];
  return {
    requests,
    transport: async (r): Promise<TransportResponse> => {
      requests.push(`${r.method} ${r.url.pathname}`);
      return r.url.pathname.endsWith('/rows') ? rows : table;
    },
  };
}

const document = userDefinedColumns as OpenApiDocument;

describe('readPlatform and runtime classes', () => {
  it('adds each record its interpreted members and the result its describers', async () => {
    const fake = provider(json(TABLE));
    const result = await readPlatform(document, {
      platform: 'tables',
      constants: { tableId: 't1' },
      transport: fake.transport,
    });
    expect(result.describers).toMatchObject([
      { resource: 'row', path: '/tables/t1', reads: 1 },
    ]);
    expect(
      Object.keys(result.describers![0]!.class!.properties).sort(),
    ).toEqual(['a%3Ab', 'c%3Ad']);
    const [first, second] = result.records;
    expect(first!.runtime).toEqual({
      describer: '/tables/t1',
      values: { 'a%3Ab': 3, 'c%3Ad': 'opt-1' },
      unmatched: [],
      undescribed: [],
      invalid: [],
      conflicting: [],
    });
    expect(second!.runtime).toMatchObject({
      values: {},
      conflicting: ['Estimate', 'Old estimate'],
    });
  });

  it('keeps the records, with no class, when the describer cannot be read', async () => {
    const fake = provider(json({ message: 'gone' }, 404));
    const result = await readPlatform(document, {
      platform: 'tables',
      constants: { tableId: 't1' },
      transport: fake.transport,
    });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]!.runtime).toMatchObject({
      noClass: true,
      unmatched: ['Estimate', 'Stage'],
    });
    expect(result.errors).toEqual([
      'row: describer /tables/t1: GET /v1/tables/t1 responded 404',
    ]);
  });

  it('adds nothing for a document without the extension', async () => {
    const plain = structuredClone(userDefinedColumns);
    const crud = plain.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    delete crud['row']!['x-runtime-schema'];
    const result = await readPlatform(plain, {
      platform: 'tables',
      constants: { tableId: 't1' },
      transport: provider(json(TABLE)).transport,
    });
    expect(result).not.toHaveProperty('describers');
    expect(result.records[0]).not.toHaveProperty('runtime');
  });
});

describe('sync() and runtime classes', () => {
  it('returns the describers, and runtimeMembers() gives a record its members', async () => {
    const fake = provider(json(TABLE));
    const client = createApiClient(document, {
      transport: fake.transport,
      constants: { tableId: 't1' },
    });
    expect(client.runtimeMembers('rows', 'r1')).toBeUndefined();
    const result = await client.sync();
    expect(result.changed).toEqual(['rows']);
    expect(result).not.toHaveProperty('warnings');
    expect(result.describers).toMatchObject([
      { resource: 'row', path: '/tables/t1', reads: 1 },
    ]);
    expect(client.runtimeMembers('rows', 'r1')).toMatchObject({
      describer: '/tables/t1',
      values: { 'a%3Ab': 3, 'c%3Ad': 'opt-1' },
    });
    expect(client.runtimeMembers('rows', 'r2')).toMatchObject({
      values: {},
      conflicting: ['Estimate', 'Old estimate'],
    });
    expect(client.runtimeMembers('rows', 'r9')).toBeUndefined();
    // The stored record is the provider's, unchanged.
    expect(await client.get('rows', 'r1')).toEqual(ROW);
  });

  it('does not throw for a describer it cannot read: a warning, and members with no class', async () => {
    const fake = provider(json({ message: 'no access' }, 403));
    const client = createApiClient(document, {
      transport: fake.transport,
      constants: { tableId: 't1' },
    });
    const result = await client.sync();
    expect(result.changed).toEqual(['rows']);
    expect(result.warnings).toEqual([
      'row: describer /tables/t1: GET /v1/tables/t1 responded 403',
    ]);
    expect(result.describers).toMatchObject([
      { path: '/tables/t1', error: 'GET /v1/tables/t1 responded 403' },
    ]);
    expect(client.runtimeMembers('rows', 'r1')).toEqual({
      describer: '/tables/t1',
      noClass: true,
      values: {},
      unmatched: ['Estimate', 'Stage'],
      undescribed: [],
      invalid: [],
      conflicting: [],
    });
    expect(await client.list('rows')).toHaveLength(2);
  });

  it('still throws when a collection could not be read', async () => {
    const fake = provider(json(TABLE), json({ message: 'down' }, 500));
    const client = createApiClient(document, {
      transport: fake.transport,
      constants: { tableId: 't1' },
      limits: { maxRetries: 0 },
    });
    await expect(client.sync()).rejects.toThrow(/Read incomplete: rows: /);
    expect(client.runtimeMembers('rows', 'r1')).toBeUndefined();
  });

  it('keeps the members of the latest complete read', async () => {
    let table: TransportResponse = json(TABLE);
    const client = createApiClient(document, {
      transport: async (r): Promise<TransportResponse> =>
        r.url.pathname.endsWith('/rows') ? json([ROW]) : table,
      constants: { tableId: 't1' },
    });
    await client.sync();
    expect(client.runtimeMembers('rows', 'r1')!.values).toEqual({
      'a%3Ab': 3,
      'c%3Ad': 'opt-1',
    });
    table = json({ message: 'gone' }, 404);
    await client.sync();
    expect(client.runtimeMembers('rows', 'r1')).toMatchObject({
      noClass: true,
      values: {},
    });
  });
});
