// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  paginate,
  readCollections,
  type OpenApiDocument,
  type Transport,
  type TransportRequest,
} from '../../../src/browser.js';
import {
  callsPath,
  callsUrl,
  declaredBase,
  itemsPath,
  twilioShaped,
} from '../../fixtures/links.js';

// Pagination Schemes 0.4.0: relative next links, read through `walkPages`
// on the spec's own examples (§8.10 Twilio-shaped, §8.11 declared base).
// Every followed link is resolved per §4.4.3 and checked per §4.4.4; a
// refused link is never requested and ends the read with an error, not as
// the last page. Providers and data are invented.

const reply = (
  body: unknown,
  headers: Record<string, string> = {},
): { status: number; headers: Record<string, string>; body: string } => ({
  status: 200,
  headers,
  body: JSON.stringify(body),
});

const hrefs = (transport: ReturnType<typeof vi.fn<Transport>>): string[] =>
  transport.mock.calls.map(([r]) => r.url.href);

const page1 =
  '/2010-04-01/Accounts/AC0/Calls.json?PageSize=50&Page=1&PageToken=PA0';

/** A Twilio-shaped provider: page 0 links to `next`, page 1 ends with `last`. */
function calls(
  next: unknown,
  last: unknown = null,
): ReturnType<typeof vi.fn<Transport>> {
  return vi.fn<Transport>(async ({ url }) =>
    url.searchParams.get('Page') === '1'
      ? reply({ calls: [{ sid: 'CA2' }], next_page_uri: last, page: 1 })
      : reply({ calls: [{ sid: 'CA1' }], next_page_uri: next, page: 0 }),
  );
}

const walk = (
  transport: Transport,
  doc: OpenApiDocument = twilioShaped,
): Promise<Record<string, unknown>[]> =>
  paginate(doc, {
    transport,
    path: callsPath,
    pathParams: { AccountSid: 'AC0' },
    query: { PageSize: '50' },
  });

describe('relative next links (§8.10, Twilio-shaped)', () => {
  it('resolves the absolute-path reference against the server and requests exactly that URL', async () => {
    const transport = calls(page1);
    expect(await walk(transport)).toEqual([{ sid: 'CA1' }, { sid: 'CA2' }]);
    expect(hrefs(transport)).toEqual([
      `${callsUrl}?PageSize=50`,
      `https://api.example.com${page1}`,
    ]);
  });

  for (const [label, last] of [
    ['null', null],
    ['""', ''],
    ['absent', undefined],
  ] as const)
    it(`ends paging on a ${label} next_page_uri`, async () => {
      const transport = calls(page1, last);
      expect(await walk(transport)).toHaveLength(2);
      expect(transport).toHaveBeenCalledTimes(2);
    });

  const hostile: [string, unknown, RegExp][] = [
    ['another host', 'https://attacker.example/steal', /left the API origin/],
    [
      'a network-path reference',
      '//attacker.example/steal',
      /left the API origin/,
    ],
    ['three leading slashes', '///attacker.example/x', /three or more slashes/],
    ['four leading slashes', '////attacker.example/x', /three or more slashes/],
    [
      'a scheme without an authority',
      'https:///attacker.example/x',
      /authority/,
    ],
    [
      'http on an https server',
      'http://api.example.com/next',
      /left the API origin/,
    ],
    [
      'another port',
      'https://api.example.com:8443/next',
      /left the API origin/,
    ],
    ['userinfo', 'https://user:pw@api.example.com/next', /userinfo/],
    ['an empty fragment', '/next#', /fragment/],
    ['a fragment', '/next#frag', /fragment/],
    ['whitespace', '/next page', /whitespace/],
    ['a backslash', '/next\\..\\x', /backslash/],
    ['a control character', '/next\x00', /control character/],
    ['a number', 42, /not a string/],
    ['an array', ['/next'], /not a string/],
  ];
  for (const [label, value, message] of hostile)
    it(`never requests a link with ${label} (${JSON.stringify(value)}) and ends the read with an error`, async () => {
      const transport = calls(value);
      await expect(walk(transport)).rejects.toThrow(message);
      // Only the first page was requested; the link was not.
      expect(transport).toHaveBeenCalledTimes(1);
    });

  it('is not a complete read for a collection whose link is refused (Collection Completeness §3)', async () => {
    const doc = structuredClone(twilioShaped);
    doc.components!['crudResources'] = {
      call: {
        identity: {
          urlTemplate: '/2010-04-01/Accounts/{AccountSid}/Calls/{sid}.json',
          bindings: { sid: { field: 'sid' } },
        },
        collections: { calls: { urlTemplate: callsPath } },
      },
    };
    const transport = calls('///attacker.example/x');
    const result = await readCollections(doc, {
      transport,
      constants: { AccountSid: 'AC0' },
    });
    expect(result.collections).toMatchObject([
      {
        complete: false,
        items: [{ sid: 'CA1' }],
        error: expect.stringMatching(/three or more slashes/),
      },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('stops when a relative link repeats the same page', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply({
        calls: [{ sid: 'CA1' }],
        next_page_uri: '/2010-04-01/Accounts/AC0/Calls.json?PageSize=50',
      }),
    );
    await expect(walk(transport)).rejects.toThrow(
      'Pagination repeated a page; stopping',
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  /** `twilioShaped` with `next_page_uri`'s linkResolution removed. */
  const withoutResolution = (): OpenApiDocument => {
    const doc = structuredClone(twilioShaped);
    const schemes = doc.components!['paginationSchemes'] as unknown as Record<
      string,
      { response: { bodyFields: Record<string, Record<string, unknown>> } }
    >;
    delete schemes['linkedCollections']!.response.bodyFields['next_page_uri']![
      'linkResolution'
    ];
    return doc;
  };

  it('takes linkResolution from an x-pagination override, after the merge', async () => {
    const doc = withoutResolution();
    doc.paths[callsPath]!.get!['x-pagination'] = [
      {
        scheme: 'linkedCollections',
        overrides: {
          response: {
            bodyFields: {
              next_page_uri: { linkResolution: { base: 'server' } },
            },
          },
        },
      },
    ];
    // A relative-path reference differs per base: against the server
    // directory it is https://api.example.com/Calls.json?Page=1.
    const transport = vi.fn<Transport>(async ({ url }) =>
      url.pathname === '/Calls.json'
        ? reply({ calls: [{ sid: 'CA2' }], next_page_uri: null })
        : reply({
            calls: [{ sid: 'CA1' }],
            next_page_uri: 'Calls.json?Page=1',
          }),
    );
    expect(await walk(transport, doc)).toHaveLength(2);
    expect(hrefs(transport)[1]).toBe(
      'https://api.example.com/Calls.json?Page=1',
    );
  });

  it('resolves against the request URL when linkResolution is absent (the default)', async () => {
    const doc = withoutResolution();
    const transport = vi.fn<Transport>(async ({ url }) =>
      url.searchParams.get('Page') === '1'
        ? reply({ calls: [{ sid: 'CA2' }], next_page_uri: null })
        : reply({
            calls: [{ sid: 'CA1' }],
            next_page_uri: '?PageSize=50&Page=1',
          }),
    );
    expect(await walk(transport, doc)).toHaveLength(2);
    expect(hrefs(transport)[1]).toBe(`${callsUrl}?PageSize=50&Page=1`);
  });
});

describe('a declared base for a relative Link header (§8.11)', () => {
  const items = (
    requests: TransportRequest[],
  ): ReturnType<typeof vi.fn<Transport>> =>
    vi.fn<Transport>(async (r) => {
      requests.push(r);
      return r.url.searchParams.has('cursor')
        ? reply([{ id: 'i3' }])
        : reply([{ id: 'i1' }, { id: 'i2' }], {
            link: '<items?cursor=abc>; rel="next"',
          });
    });

  it('resolves <items?cursor=abc> against the declared url, whatever the request URL', async () => {
    const requests: TransportRequest[] = [];
    const read = await paginate(declaredBase, {
      transport: items(requests),
      path: itemsPath,
      pathParams: { projectId: 'p1' },
      query: { limit: '2' },
    });
    expect(read).toEqual([{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]);
    expect(requests.map((r) => r.url.href)).toEqual([
      'https://api.example.com/v2/projects/p1/items?limit=2',
      'https://api.example.com/v2/items?cursor=abc',
    ]);
  });

  it('refuses a Link target that leaves the origin even with a declared base', async () => {
    const transport = vi.fn<Transport>(async () =>
      reply([{ id: 'i1' }], {
        link: '<https://attacker.example/items>; rel="next"',
      }),
    );
    await expect(
      paginate(declaredBase, {
        transport,
        path: itemsPath,
        pathParams: { projectId: 'p1' },
      }),
    ).rejects.toThrow('Pagination left the API origin');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('pages on when the Link header lists several relation types (#384 item 2)', async () => {
    const transport = vi.fn<Transport>(async (r) =>
      r.url.searchParams.has('cursor')
        ? reply([{ id: 'i3' }], {
            link: '<items?cursor=abc>; rel="first last"',
          })
        : reply([{ id: 'i1' }, { id: 'i2' }], {
            link: '<items?cursor=abc>; rel="last next"',
          }),
    );
    const read = await paginate(declaredBase, {
      transport,
      path: itemsPath,
      pathParams: { projectId: 'p1' },
    });
    expect(read).toHaveLength(3);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe('an explicit x-pagination that cannot be applied (#384 item 1)', () => {
  /** `twilioShaped` with a typo in `linkResolution.base`. */
  const typo = (): OpenApiDocument => {
    const doc = structuredClone(twilioShaped);
    const schemes = doc.components!['paginationSchemes'] as unknown as Record<
      string,
      { response: { bodyFields: Record<string, Record<string, unknown>> } }
    >;
    schemes['linkedCollections']!.response.bodyFields['next_page_uri']![
      'linkResolution'
    ] = { base: 'servr' };
    return doc;
  };

  it('fails the read before any request, instead of returning one page as complete', async () => {
    const transport = calls(page1);
    await expect(walk(transport, typo())).rejects.toThrow(
      /x-pagination names the pagination scheme "linkedCollections", which is invalid/,
    );
    expect(transport).toHaveBeenCalledTimes(0);
  });

  it('leaves a collection read incomplete, with the error, for Collection Completeness consumers', async () => {
    const doc = typo();
    doc.components!['crudResources'] = {
      call: {
        identity: {
          urlTemplate: '/2010-04-01/Accounts/{AccountSid}/Calls/{sid}.json',
          bindings: { sid: { field: 'sid' } },
        },
        collections: { calls: { urlTemplate: callsPath } },
      },
    };
    const transport = calls(page1);
    const result = await readCollections(doc, {
      transport,
      constants: { AccountSid: 'AC0' },
    });
    expect(result.collections).toMatchObject([
      {
        complete: false,
        items: [],
        error: expect.stringMatching(/which is invalid/),
      },
    ]);
    expect(transport).toHaveBeenCalledTimes(0);
  });
});
