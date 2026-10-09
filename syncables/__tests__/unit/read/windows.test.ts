// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  paginate,
  readCollections,
  WindowReadError,
  type OpenApiDocument,
  type Transport,
} from '../../../src/browser.js';

// Pagination Schemes 0.5.0 §4.6.3–§4.6.4: reading a range by windows. The
// document is shaped like the spec's examples/range-window.yaml (Moneybird's
// financial mutations: no page parameter, at most `cap` answers per
// request, a closed day range in `filter`). Fixture data only.

const CAP = 100;

function document(cap = CAP): OpenApiDocument {
  return {
    openapi: '3.0.3',
    info: { title: 'Range windows', version: '1.0.0' },
    servers: [{ url: 'https://api.example.com/v2' }],
    paths: {
      '/ledgers/{ledgerId}/transactions': {
        get: {
          parameters: [{ name: 'filter', in: 'query' }],
          'x-pagination': [{ scheme: 'periodWindows' }],
          responses: { '200': { description: 'At most cap transactions' } },
        },
      },
      '/ledgers/{ledgerId}/transactions/{id}': {
        get: { responses: { '200': { description: 'One transaction' } } },
      },
    },
    components: {
      paginationSchemes: {
        periodWindows: {
          type: 'rangeWindow',
          autoDetect: false,
          window: { unit: 'day', format: 'basicDate', bounds: 'closed', cap },
          request: {
            queryParameters: {
              filter: {
                role: 'windowRange',
                template: 'period:{start}..{end},state:all',
              },
            },
          },
        },
      },
      crudResources: {
        transaction: {
          identity: {
            urlTemplate: '/ledgers/{ledgerId}/transactions/{id}',
            bindings: { id: { field: 'id' } },
          },
          collections: {
            transactions: { urlTemplate: '/ledgers/{ledgerId}/transactions' },
          },
        },
      },
    },
  } as OpenApiDocument;
}

/** A provider that answers the transactions of a closed day range, cut at `cap`. */
function provider(
  dates: string[],
  cap = CAP,
): { transport: Transport; filters: string[] } {
  const filters: string[] = [];
  const transport: Transport = (request) => {
    const filter = request.url.searchParams.get('filter') ?? '';
    filters.push(filter);
    const match = /^period:(\d{8})\.\.(\d{8}),state:all$/.exec(filter);
    if (!match) {
      return Promise.resolve({ status: 400, headers: {}, body: '{}' });
    }
    const [, low, high] = match as unknown as [string, string, string];
    const items = dates
      .map((date, i) => ({ id: `m${i}`, date, amount: '1.00' }))
      .filter(({ date }) => date >= low && date <= high)
      .slice(0, cap);
    return Promise.resolve({
      status: 200,
      headers: {},
      body: JSON.stringify(items),
    });
  };
  return { transport, filters };
}

const YEAR = { start: '20260101', end: '20261231' };

describe('a range read by windows', () => {
  it('asks for the whole range first and stops when it is below the cap', async () => {
    const { transport, filters } = provider(Array(99).fill('20260105'));
    const items = await paginate(document(), {
      transport,
      path: '/ledgers/{ledgerId}/transactions',
      pathParams: { ledgerId: 'l1' },
      range: YEAR,
    });
    expect(items).toHaveLength(99);
    expect(filters).toEqual(['period:20260101..20261231,state:all']);
  });

  it('halves full windows depth first, as the Money app does', async () => {
    const dates = Array.from({ length: 12 }, (_, m) =>
      Array(20).fill(`2026${String(m + 1).padStart(2, '0')}15`),
    ).flat();
    const { transport, filters } = provider(dates);
    const items = await paginate(document(), {
      transport,
      path: '/ledgers/{ledgerId}/transactions',
      pathParams: { ledgerId: 'l1' },
      range: YEAR,
    });
    expect(items).toHaveLength(240);
    expect(filters.map((f) => f.slice(7, 25))).toEqual([
      '20260101..20261231',
      '20260101..20260702',
      '20260101..20260402',
      '20260403..20260702',
      '20260703..20261231',
      '20260703..20261001',
      '20261002..20261231',
    ]);
  });

  it('counts an answer of exactly cap items as full (§4.6.4 rule 2)', async () => {
    const { transport, filters } = provider([
      ...Array(50).fill('20260101'),
      ...Array(50).fill('20260102'),
    ]);
    const items = await paginate(document(), {
      transport,
      path: '/ledgers/{ledgerId}/transactions',
      pathParams: { ledgerId: 'l1' },
      range: { start: '20260101', end: '20260102' },
    });
    expect(filters).toHaveLength(3);
    expect(items).toHaveLength(100);
  });

  it('ends with WindowReadError on a full window too narrow to split', async () => {
    const { transport } = provider(Array(100).fill('20260415'));
    await expect(
      paginate(document(), {
        transport,
        path: '/ledgers/{ledgerId}/transactions',
        pathParams: { ledgerId: 'l1' },
        range: YEAR,
      }),
    ).rejects.toThrow(WindowReadError);
  });

  it('needs a range: which range to read is the caller’s choice', async () => {
    const { transport } = provider([]);
    await expect(
      paginate(document(), {
        transport,
        path: '/ledgers/{ledgerId}/transactions',
        pathParams: { ledgerId: 'l1' },
      }),
    ).rejects.toThrow(/pass the range/);
  });

  it('keeps an item that two windows return once (§4.6.4 rule 3)', async () => {
    // A transaction whose date moves between two window reads.
    let calls = 0;
    const transport = vi.fn<Transport>((request) => {
      calls += 1;
      const filter = request.url.searchParams.get('filter') ?? '';
      const full = Array.from({ length: 3 }, (_, i) => ({ id: `x${i}` }));
      const body =
        calls === 1
          ? full
          : filter.includes('20260101..20260101')
            ? [{ id: 'moved' }]
            : [{ id: 'moved' }, { id: 'other' }];
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(body),
      });
    });
    const result = await readCollections(document(3), {
      transport,
      constants: { ledgerId: 'l1' },
      ranges: () => ({ start: '20260101', end: '20260102' }),
    });
    expect(result.errors).toEqual([]);
    expect(result.collections[0]!.items.map((i) => i['id'])).toEqual([
      'moved',
      'other',
    ]);
  });
});

describe('completeness of a windowed read (§4.6.4 rule 5)', () => {
  it('is never complete, even when every window was below the cap', async () => {
    const { transport } = provider(Array(10).fill('20260105'));
    const result = await readCollections(document(), {
      transport,
      constants: { ledgerId: 'l1' },
      ranges: () => YEAR,
    });
    const [snapshot] = result.collections;
    expect(snapshot!.items).toHaveLength(10);
    expect(snapshot!.complete).toBe(false);
    expect(snapshot!.notComplete).toMatch(/never a complete read/);
    expect(snapshot!.error).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('is incomplete with an error when a window fails', async () => {
    const { transport } = provider(Array(100).fill('20260415'));
    const result = await readCollections(document(), {
      transport,
      constants: { ledgerId: 'l1' },
      ranges: () => YEAR,
    });
    expect(result.collections[0]!.complete).toBe(false);
    expect(result.errors[0]).toMatch(/too narrow to split/);
  });

  it('leaves a collection unread, with an error, when no range is given', async () => {
    const { transport, filters } = provider([]);
    const result = await readCollections(document(), {
      transport,
      constants: { ledgerId: 'l1' },
    });
    expect(filters).toEqual([]);
    expect(result.errors[0]).toMatch(/pass the range/);
  });
});

describe("a windowed read and the scheme's own envelope (#384 item 10a)", () => {
  it('reads the items at the scheme-level response.envelope, strictly', async () => {
    const doc = document();
    const scheme = (
      doc.components!['paginationSchemes'] as unknown as Record<
        string,
        Record<string, unknown>
      >
    )['periodWindows']!;
    scheme['response'] = { envelope: { itemsField: 'data.rows' } };
    const answer = (body: unknown): ReturnType<Transport> =>
      Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    expect(
      await paginate(doc, {
        transport: () =>
          answer({ data: { rows: [{ id: 'm1' }] }, items: [{ id: 'x' }] }),
        path: '/ledgers/{ledgerId}/transactions',
        pathParams: { ledgerId: 'l1' },
        range: YEAR,
      }),
    ).toEqual([{ id: 'm1' }]);
    await expect(
      paginate(doc, {
        transport: () => answer({ items: [{ id: 'x' }] }),
        path: '/ledgers/{ledgerId}/transactions',
        pathParams: { ledgerId: 'l1' },
        range: YEAR,
      }),
    ).rejects.toThrow(/No items array at data\.rows/);
  });
});
