// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  readCollections,
  type OpenApiDocument,
  type TransportRequest,
  type TransportResponse,
} from '../../../src/browser.js';
import { userDefinedColumns } from '../../fixtures/runtime-schemas.js';

// Runtime Schemas 0.1.0-draft in the collection read, on the spec's own
// example (§7.1, `examples/user-defined-columns.yaml`): rows whose
// `properties` are described by their table's column definitions. Each test
// names the spec statement it checks. The rows and tables are invented.

const json = (value: unknown, status = 200): TransportResponse => ({
  status,
  headers: {},
  body: JSON.stringify(value),
});

/** The §7.1 table. */
const table = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 't1',
  properties: {
    Estimate: { id: 'a%3Ab', name: 'Estimate', type: 'number', number: {} },
    Stage: {
      id: 'c%3Ad',
      name: 'Stage',
      type: 'select',
      select: {
        options: [
          { id: 'opt-1', name: 'Doing', color: 'blue' },
          { id: 'opt-2', name: 'Done', color: 'green' },
        ],
      },
    },
    ...overrides,
  },
});

/** The §7.1 row. */
const row = (
  id = 'r1',
  properties: Record<string, unknown> = {
    Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
    Stage: {
      id: 'c%3Ad',
      type: 'select',
      select: { id: 'opt-1', name: 'Doing', color: 'blue' },
    },
  },
  parent: unknown = { table_id: 't1' },
): Record<string, unknown> => ({ id, parent, properties });

/**
 * A provider answering `rows` for the list and the next of `tables` (the
 * last one repeating) for each table read; every request is recorded.
 */
function provider(
  rows: Record<string, unknown>[],
  tables: TransportResponse[],
): {
  requests: string[];
  transport: (r: TransportRequest) => Promise<TransportResponse>;
} {
  const requests: string[] = [];
  let reads = 0;
  return {
    requests,
    transport: async (r): Promise<TransportResponse> => {
      requests.push(`${r.method} ${r.url.pathname}`);
      if (r.url.pathname.endsWith('/rows')) return json(rows);
      const answer = tables[Math.min(reads, tables.length - 1)];
      reads += 1;
      return answer as TransportResponse;
    },
  };
}

async function read(
  rows: Record<string, unknown>[],
  tables: TransportResponse[],
  document: OpenApiDocument = userDefinedColumns,
): Promise<{
  result: Awaited<ReturnType<typeof readCollections>>;
  requests: string[];
}> {
  const fake = provider(rows, tables);
  const result = await readCollections(document, {
    transport: fake.transport,
    constants: { tableId: 't1' },
  });
  return { result, requests: fake.requests };
}

describe('Runtime Schemas: the §7.1 example', () => {
  it('derives a class with two properties keyed by id, and the row values 3 and opt-1 (§7.1)', async () => {
    const { result, requests } = await read([row()], [json(table())]);
    expect(result.errors).toEqual([]);
    expect(requests).toEqual(['GET /v1/tables/t1/rows', 'GET /v1/tables/t1']);
    expect(result.describers).toEqual([
      {
        resource: 'row',
        path: '/tables/t1',
        reads: 1,
        class: {
          properties: {
            'a%3Ab': {
              name: 'Estimate',
              type: 'number',
              schema: { type: 'number', nullable: true },
              key: 'Estimate',
            },
            'c%3Ad': {
              name: 'Stage',
              type: 'select',
              schema: expect.objectContaining({ type: 'object' }),
              key: 'Stage',
              options: { 'opt-1': 'Doing', 'opt-2': 'Done' },
              multiple: false,
            },
          },
          undescribed: [],
          names: { 'a%3Ab': 'Estimate', 'c%3Ad': 'Stage' },
          duplicates: [],
          duplicateNames: [],
          duplicateIdNames: {},
          duplicateOptions: {},
        },
      },
    ]);
    expect(result.collections[0]!.runtimeMembers).toEqual([
      {
        describer: '/tables/t1',
        values: { 'a%3Ab': 3, 'c%3Ad': 'opt-1' },
        unmatched: [],
        undescribed: [],
        invalid: [],
        conflicting: [],
      },
    ]);
  });

  it('names the property Points after a rename, and keeps the values (§7.1, §5.3 rule 1)', async () => {
    const renamed = table({
      Estimate: undefined,
      Points: { id: 'a%3Ab', name: 'Points', type: 'number', number: {} },
    });
    const { result } = await read(
      [
        row('r1', {
          Points: { id: 'a%3Ab', type: 'number', number: 3 },
        }),
      ],
      [json(renamed)],
    );
    expect(result.describers![0]!.class!.properties['a%3Ab']).toMatchObject({
      name: 'Points',
    });
    expect(result.collections[0]!.runtimeMembers![0]!.values).toEqual({
      'a%3Ab': 3,
    });
  });

  it('matches by id, not by key: a row read before a rename still matches (§4.1 match: id)', async () => {
    const renamed = table({
      Estimate: undefined,
      Points: { id: 'a%3Ab', name: 'Points', type: 'number', number: {} },
    });
    const { result } = await read([row()], [json(renamed)]);
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'a%3Ab': 3, 'c%3Ad': 'opt-1' },
      unmatched: [],
    });
  });

  it('reads one describer once for the rows that share it (§5.2)', async () => {
    const { result, requests } = await read(
      [row('r1'), row('r2'), row('r3')],
      [json(table())],
    );
    expect(requests.filter((r) => r === 'GET /v1/tables/t1')).toHaveLength(1);
    expect(result.collections[0]!.runtimeMembers).toHaveLength(3);
  });
});

describe('Runtime Schemas: no value is guessed', () => {
  it('gives a member without its value path no value, not null (§4.4, §5.2)', async () => {
    const { result } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number' },
          Stage: { id: 'c%3Ad', type: 'select', select: null },
        }),
      ],
      [json(table())],
    );
    const members = result.collections[0]!.runtimeMembers![0]!;
    // Estimate: absent, not null. Stage: the provider's own null.
    expect(members.values).toEqual({ 'c%3Ad': null });
    expect('a%3Ab' in members.values).toBe(false);
    expect(members.unmatched).toEqual([]);
  });

  it('writes nothing for a definition no member matches (§5.2)', async () => {
    const { result } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number', number: 5 },
        }),
      ],
      [json(table())],
    );
    expect(result.collections[0]!.runtimeMembers![0]!.values).toEqual({
      'a%3Ab': 5,
    });
  });

  it('keeps an option the definition no longer lists (§5.3 rule 4)', async () => {
    const { result } = await read(
      [
        row('r1', {
          Stage: { id: 'c%3Ad', type: 'select', select: { id: 'opt-9' } },
        }),
      ],
      [json(table())],
    );
    expect(result.collections[0]!.runtimeMembers![0]!.values).toEqual({
      'c%3Ad': 'opt-9',
    });
  });

  it('reports an option value of the wrong shape as invalid, with no value (§5.1)', async () => {
    const tags = {
      id: 'e%3Af',
      name: 'Tags',
      type: 'multi_select',
      multi_select: { options: [{ id: 'tag-1', name: 'Red' }] },
    };
    const { result } = await read(
      [
        row('r1', {
          Stage: { id: 'c%3Ad', type: 'select', select: { name: 'Doing' } },
          Tags: {
            id: 'e%3Af',
            type: 'multi_select',
            multi_select: { id: 'tag-1' },
          },
        }),
        row('r2', {
          Tags: {
            id: 'e%3Af',
            type: 'multi_select',
            multi_select: [{ id: 'tag-1' }, { id: 'tag-2' }],
          },
        }),
      ],
      [json(table({ Tags: tags }))],
    );
    const [first, second] = result.collections[0]!.runtimeMembers!;
    expect(first).toMatchObject({
      values: {},
      invalid: ['Stage', 'Tags'],
      unmatched: [],
    });
    expect(second!.values).toEqual({ 'e%3Af': ['tag-1', 'tag-2'] });
  });
});

describe('Runtime Schemas: invalid, unmatched and undescribed stay apart', () => {
  it('gives an undescribed type no property and reports its member as undescribed (§5.4)', async () => {
    const { result } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
          Related: { id: 'g%3Ah', type: 'relation', relation: [{ id: 'x' }] },
        }),
      ],
      [
        json(
          table({
            Related: { id: 'g%3Ah', name: 'Related', type: 'relation' },
          }),
        ),
      ],
    );
    const derived = result.describers![0]!.class!;
    expect(derived.undescribed).toEqual(['g%3Ah']);
    expect(derived.properties['g%3Ah']).toBeUndefined();
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'a%3Ab': 3 },
      undescribed: ['Related'],
      unmatched: [],
      invalid: [],
    });
    // An undescribed member is not a reason to read the describer again.
    expect(result.describers![0]!.reads).toBe(1);
  });

  it('derives no property for a duplicated definition id, and treats its members as undescribed (§5.1)', async () => {
    const { result } = await read(
      [row()],
      [
        json(
          table({
            Copy: { id: 'a%3Ab', name: 'Copy', type: 'number', number: {} },
          }),
        ),
      ],
    );
    const derived = result.describers![0]!.class!;
    expect(derived.duplicates).toEqual(['a%3Ab']);
    expect(Object.keys(derived.properties)).toEqual(['c%3Ad']);
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'c%3Ad': 'opt-1' },
      undescribed: ['Estimate'],
      unmatched: [],
    });
  });

  it('reads the describer once more for a member matching no definition, and matches it then (§5.2)', async () => {
    const added = table({
      Owner: { id: 'i%3Aj', name: 'Owner', type: 'checkbox', checkbox: {} },
    });
    const { result, requests } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
          Owner: { id: 'i%3Aj', type: 'checkbox', checkbox: true },
        }),
        row('r2'),
      ],
      [json(table()), json(added)],
    );
    expect(requests.filter((r) => r === 'GET /v1/tables/t1')).toHaveLength(2);
    expect(result.describers![0]!.reads).toBe(2);
    expect(result.describers![0]!.class!.properties['i%3Aj']).toMatchObject({
      name: 'Owner',
    });
    const [first, second] = result.collections[0]!.runtimeMembers!;
    expect(first).toMatchObject({
      values: { 'a%3Ab': 3, 'i%3Aj': true },
      unmatched: [],
    });
    expect(second!.values).toEqual({ 'a%3Ab': 3, 'c%3Ad': 'opt-1' });
  });

  it('reads it at most once more: a member still matching none is unmatched, with no value (§5.2)', async () => {
    const { result, requests } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
          Ghost: { id: 'z%3Az', type: 'number', number: 9 },
        }),
        row('r2', { Ghost: { id: 'z%3Az', type: 'number', number: 8 } }),
      ],
      [json(table())],
    );
    expect(requests.filter((r) => r === 'GET /v1/tables/t1')).toHaveLength(2);
    expect(result.collections[0]!.runtimeMembers).toEqual([
      {
        describer: '/tables/t1',
        values: { 'a%3Ab': 3 },
        unmatched: ['Ghost'],
        undescribed: [],
        invalid: [],
        conflicting: [],
      },
      {
        describer: '/tables/t1',
        values: {},
        unmatched: ['Ghost'],
        undescribed: [],
        invalid: [],
        conflicting: [],
      },
    ]);
  });

  it('treats a member written under another type than its definition as unmatched (§5.3 rule 3, memberType)', async () => {
    const retyped = table({
      Estimate: { id: 'a%3Ab', name: 'Estimate', type: 'checkbox' },
    });
    const { result } = await read([row()], [json(retyped)]);
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'c%3Ad': 'opt-1' },
      unmatched: ['Estimate'],
    });
  });
});

describe('Runtime Schemas: missing describers (§5.5)', () => {
  it('leaves the items of an unreadable describer without a class: every member unmatched', async () => {
    const { result, requests } = await read(
      [row()],
      [json({ message: 'no access' }, 404)],
    );
    expect(result.describers).toEqual([
      {
        resource: 'row',
        path: '/tables/t1',
        reads: 1,
        error: 'GET /v1/tables/t1 responded 404',
      },
    ]);
    // Reported in the read's errors too.
    expect(result.errors).toEqual([
      'row: describer /tables/t1: GET /v1/tables/t1 responded 404',
    ]);
    expect(requests).toHaveLength(2);
    expect(result.collections[0]!.runtimeMembers![0]!).toEqual({
      describer: '/tables/t1',
      values: {},
      unmatched: ['Estimate', 'Stage'],
      undescribed: [],
      invalid: [],
      conflicting: [],
    });
    // The rows themselves were read.
    expect(result.collections[0]!.complete).toBe(true);
  });

  it('reads no describer for a row whose reference field is absent or null', async () => {
    const { result, requests } = await read(
      [row('r1', undefined, {}), row('r2', undefined, { table_id: null })],
      [json(table())],
    );
    expect(requests).toEqual(['GET /v1/tables/t1/rows']);
    expect(result.describers).toEqual([]);
    expect(result.collections[0]!.runtimeMembers).toEqual([
      {
        values: {},
        unmatched: ['Estimate', 'Stage'],
        undescribed: [],
        invalid: [],
        conflicting: [],
      },
      {
        values: {},
        unmatched: ['Estimate', 'Stage'],
        undescribed: [],
        invalid: [],
        conflicting: [],
      },
    ]);
  });

  it('fails the collection of a declaration it cannot use, before any request', async () => {
    const broken = structuredClone(userDefinedColumns);
    const crud = broken.components!['crudResources'] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    crud['row']!['x-runtime-schema']!['describedBy'] = {
      reference: 'nowhere',
      definitions: 'properties',
      shape: 'map',
    };
    const { result, requests } = await read([row()], [json(table())], broken);
    expect(result.errors).toEqual([
      'rows: row.x-runtime-schema.describedBy.reference names no reference nowhere',
    ]);
    expect(requests).toEqual([]);
    expect(result.collections[0]).toMatchObject({
      complete: false,
      items: [],
      error:
        'row.x-runtime-schema.describedBy.reference names no reference nowhere',
    });
  });

  it('adds nothing to the result of a document without the extension', async () => {
    const plain = structuredClone(userDefinedColumns);
    const crud = plain.components!['crudResources'] as Record<
      string,
      Record<string, unknown>
    >;
    delete crud['row']!['x-runtime-schema'];
    const { result, requests } = await read([row()], [json(table())], plain);
    expect(requests).toEqual(['GET /v1/tables/t1/rows']);
    expect(result).not.toHaveProperty('describers');
    expect(result.collections[0]).not.toHaveProperty('runtimeMembers');
  });
});

describe('Runtime Schemas: re-reads and reports in the read', () => {
  const keyed = (): OpenApiDocument => {
    const document = structuredClone(userDefinedColumns);
    const crud = document.components!['crudResources'] as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const declaration = crud['row']!['x-runtime-schema']!;
    declaration['match'] = 'key';
    delete declaration['memberId'];
    delete declaration['memberType'];
    return document;
  };

  it('under match: key, re-reads for an unmatched member but keeps the first interpretation (§5.2)', async () => {
    const added = table({
      Owner: { id: 'i%3Aj', name: 'Owner', type: 'checkbox', checkbox: {} },
    });
    const { result, requests } = await read(
      [
        row('r1', {
          Estimate: { number: 3 },
          Owner: { checkbox: true },
        }),
      ],
      [json(table()), json(added)],
      keyed(),
    );
    expect(requests.filter((r) => r === 'GET /v1/tables/t1')).toHaveLength(2);
    // The class is the re-read one; the row is not interpreted again.
    expect(result.describers![0]!.class!.properties).toHaveProperty('i%3Aj');
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'a%3Ab': 3 },
      unmatched: ['Owner'],
    });
  });

  it('under match: key, an undescribed member is no reason to re-read', async () => {
    const { result, requests } = await read(
      [
        row('r1', {
          Estimate: { number: 3 },
          Related: { relation: [] },
        }),
      ],
      [
        json(
          table({
            Related: { id: 'g%3Ah', name: 'Related', type: 'relation' },
          }),
        ),
      ],
      keyed(),
    );
    expect(requests.filter((r) => r === 'GET /v1/tables/t1')).toHaveLength(1);
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: { 'a%3Ab': 3 },
      undescribed: ['Related'],
      unmatched: [],
    });
  });

  it('reports two members matching one definition as conflicting, with no value', async () => {
    const { result } = await read(
      [
        row('r1', {
          Estimate: { id: 'a%3Ab', type: 'number', number: 3 },
          'Old estimate': { id: 'a%3Ab', type: 'number', number: 5 },
        }),
      ],
      [json(table())],
    );
    expect(result.collections[0]!.runtimeMembers![0]!).toMatchObject({
      values: {},
      conflicting: ['Estimate', 'Old estimate'],
      unmatched: [],
    });
  });

  it('names a describer the budget leaves unread in the errors', async () => {
    const fake = provider([row()], [json(table())]);
    const result = await readCollections(userDefinedColumns, {
      transport: fake.transport,
      constants: { tableId: 't1' },
      limits: { maxRequests: 1 },
    });
    expect(fake.requests).toEqual(['GET /v1/tables/t1/rows']);
    expect(result.describers![0]).toMatchObject({
      path: '/tables/t1',
      error: expect.stringMatching(/requests/),
    });
    expect(result.errors).toEqual([
      expect.stringMatching(/^row: describer \/tables\/t1: .*requests/),
    ]);
    expect(result.collections[0]!.runtimeMembers![0]!.unmatched).toEqual([
      'Estimate',
      'Stage',
    ]);
  });
});
