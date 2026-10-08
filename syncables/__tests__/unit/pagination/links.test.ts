// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { LinkRefused, resolveLink } from '../../../src/pagination/links.js';
import { parsePaginationState } from '../../../src/pagination/response-parser.js';
import type {
  LinkResolutionObject,
  PaginationSchemeObject,
} from '../../../src/pagination/types.js';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';

// Pagination Schemes 0.4.0 §4.4.3 (Link Resolution Object) and §4.4.4
// (Following a link). The cases mirror `ResolveLinkTests` in
// `openapi-extensions/spec/pagination-schemes/test_validate.py`, the
// spec's reference implementation, plus the raw-string rules added in the
// #375 review: three or more leading slashes, a scheme without "//" and an
// authority, and an empty fragment.

const SERVER = 'https://api.example.com';
const REQUEST =
  'https://api.example.com/2010-04-01/Accounts/AC0/Calls.json?PageSize=50';

function resolve(
  value: unknown,
  resolution?: LinkResolutionObject | null,
  server = SERVER,
  request = REQUEST,
): string | null {
  const link = resolveLink(value, {
    requestUrl: new URL(request),
    serverUrl: new URL(server),
    resolution,
  });
  return link === null ? null : link.href;
}

const server: LinkResolutionObject = { base: 'server' };

describe('resolveLink', () => {
  it('returns null for no next page: null, undefined or ""', () => {
    for (const value of [null, undefined, ''])
      expect(resolve(value, server)).toBeNull();
  });

  it("resolves Twilio's absolute-path reference to the same URL under every base", () => {
    const value =
      '/2010-04-01/Accounts/AC0/Calls.json?PageSize=50&Page=1&PageToken=PA0';
    for (const resolution of [
      undefined,
      null,
      { base: 'request' },
      { base: 'server' },
      { base: 'declared', url: 'https://api.example.com/other/' },
    ] as (LinkResolutionObject | undefined | null)[])
      expect(resolve(value, resolution)).toBe(SERVER + value);
  });

  it('resolves relative-path and query references differently per base', () => {
    const request = 'https://api.example.com/v2/items?page=1';
    const srv = 'https://api.example.com/v2';
    expect(resolve('?page=2', null, srv, request)).toBe(
      'https://api.example.com/v2/items?page=2',
    );
    expect(resolve('?page=2', server, srv, request)).toBe(
      'https://api.example.com/v2/?page=2',
    );
    expect(resolve('items?page=2', server, srv, request)).toBe(
      'https://api.example.com/v2/items?page=2',
    );
    expect(resolve('items?page=2', server, `${srv}/`, request)).toBe(
      'https://api.example.com/v2/items?page=2',
    );
    expect(resolve('items?page=2', null, srv, request)).toBe(
      'https://api.example.com/v2/items?page=2',
    );
    expect(
      resolve(
        '../items?page=2',
        { base: 'declared', url: 'https://api.example.com/v2/sub/' },
        srv,
        request,
      ),
    ).toBe('https://api.example.com/v2/items?page=2');
    // A declared base is used as written: without a trailing slash its
    // last segment is replaced.
    expect(
      resolve(
        'items',
        { base: 'declared', url: 'https://api.example.com/v2' },
        srv,
        request,
      ),
    ).toBe('https://api.example.com/items');
  });

  it('follows absolute links on the server origin, however the scheme, host and default port are written', () => {
    for (const value of [
      'https://api.example.com/next',
      'https://API.example.com:443/next',
      'HTTPS://api.example.com/next',
    ])
      expect(resolve(value, server)).toBe('https://api.example.com/next');
  });

  it('refuses links that leave the server origin, under every base', () => {
    for (const value of [
      'https://attacker.example/steal',
      '//attacker.example/steal',
      'http://api.example.com/next',
      'https://api.example.com:8443/next',
      'https://api.example.com.attacker.example/',
      'javascript:alert(1)',
      'data:text/plain,x',
      'file:///etc/passwd',
    ])
      for (const resolution of [undefined, server])
        expect(() => resolve(value, resolution)).toThrow(LinkRefused);
  });

  it('never lets a declared base widen the allowed origin', () => {
    expect(() =>
      resolve('next', { base: 'declared', url: 'https://other.example.com/' }),
    ).toThrow('Pagination left the API origin');
  });

  it('refuses userinfo, fragments and values URL parsers disagree on', () => {
    for (const value of [
      'https://user:pw@api.example.com/next',
      '//user@api.example.com/next',
      '/next#frag',
      '/next#',
      '/next page',
      ' /next',
      '/next\n',
      '/next\t',
      '\\\\attacker.example/x',
      '/next\\..\\x',
      '/next\x00',
      '/next\x7f',
      42,
      ['/next'],
    ])
      expect(() => resolve(value, server)).toThrow(LinkRefused);
  });

  it('refuses a raw value with three or more leading slashes, which a WHATWG parser would turn into another host (#375 review)', () => {
    for (const value of ['///attacker.example/x', '////attacker.example/x'])
      for (const resolution of [undefined, server])
        expect(() => resolve(value, resolution)).toThrow(
          /three or more slashes/,
        );
    // Two slashes are a network-path reference: resolved, then refused on origin.
    expect(() => resolve('//attacker.example/steal')).toThrow(
      'Pagination left the API origin',
    );
    expect(resolve('//api.example.com/next')).toBe(
      'https://api.example.com/next',
    );
  });

  it('refuses a scheme not followed by "//" and an authority (#375 review)', () => {
    for (const value of [
      'https:///attacker.example/x',
      'https:x',
      'https:/x',
      'mailto:x@example.com',
    ])
      expect(() => resolve(value, server)).toThrow(
        /scheme without "\/\/" and an authority/,
      );
  });

  it('refuses an empty authority and any character outside ASCII (rule 2, final 0.4.0)', () => {
    for (const value of ['//', '///'])
      expect(() => resolve(value, server)).toThrow(LinkRefused);
    expect(() => resolve('//', server)).toThrow(/empty authority/);
    for (const value of ['/næst', '/next ', '/next?q=☃', '/nëxt'])
      expect(() => resolve(value, server)).toThrow(/non-ASCII/);
  });

  it('refuses an empty fragment by looking at the raw string, since the parsed hash is empty (#375 review)', () => {
    expect(new URL('/next#', SERVER).hash).toBe('');
    expect(() => resolve('/next#', server)).toThrow(/fragment/);
    expect(() => resolve('/next#')).toThrow(/fragment/);
  });

  it('keeps relative resolution inside a server path, and lets an absolute-path reference replace it', () => {
    const srv = 'https://api.example.com/v1';
    expect(resolve('items?cursor=b', server, srv, `${srv}/items`)).toBe(
      'https://api.example.com/v1/items?cursor=b',
    );
    expect(resolve('/items?cursor=b', server, srv, `${srv}/items`)).toBe(
      'https://api.example.com/items?cursor=b',
    );
  });

  it('refuses a declared base without a usable url, or an unknown base', () => {
    expect(() => resolve('next', { base: 'declared' })).toThrow(/no url/);
    expect(() =>
      resolve('next', { base: 'declared', url: 'not a url' }),
    ).toThrow(/not an absolute URL/);
    expect(() =>
      resolve('next', { base: 'response' } as unknown as LinkResolutionObject),
    ).toThrow(/unknown linkResolution base/);
  });

  it('returns a URL object to request as is', () => {
    const link = resolveLink('/next?x=1', {
      requestUrl: new URL(REQUEST),
      serverUrl: new URL(SERVER),
    });
    expect(link).toBeInstanceOf(URL);
    expect(link?.href).toBe('https://api.example.com/next?x=1');
  });
});

describe('validatePaginationScheme: linkResolution (spec 0.4.0 §9 rules 8–10)', () => {
  const link = (
    field: Record<string, unknown>,
    where: 'bodyFields' | 'headers' = 'bodyFields',
  ): string[] =>
    validatePaginationScheme('links', {
      type: 'nextLink',
      response: { [where]: { next: field } } as never,
    });

  it('accepts request, server and declared bases on nextLink and previousLink fields', () => {
    expect(
      link({ role: 'nextLink', linkResolution: { base: 'request' } }),
    ).toEqual([]);
    expect(
      link({ role: 'nextLink', linkResolution: { base: 'server' } }, 'headers'),
    ).toEqual([]);
    expect(
      link({
        role: 'previousLink',
        linkResolution: {
          base: 'declared',
          url: 'https://api.example.com/v2/',
        },
      }),
    ).toEqual([]);
  });

  it('accepts the roles added up to 0.4.0', () => {
    expect(
      validatePaginationScheme('sync', {
        type: 'pageToken',
        request: { queryParameters: { syncToken: { role: 'syncToken' } } },
        response: {
          bodyFields: {
            nextSyncToken: { role: 'nextSyncToken' },
            prev: { role: 'previousPageToken' },
            offset: { role: 'offset' },
          },
        },
      }),
    ).toEqual([]);
  });

  it('allows linkResolution only on a link field', () => {
    expect(
      link({ role: 'totalCount', linkResolution: { base: 'server' } }),
    ).toEqual([
      expect.stringContaining(
        'bodyFields.next.linkResolution is allowed only on a nextLink or previousLink field',
      ),
    ]);
  });

  it('rejects an unknown base, a declared base without a usable url, and a url on another base', () => {
    expect(
      link({ role: 'nextLink', linkResolution: { base: 'response' } }),
    ).toEqual([
      expect.stringContaining(
        'linkResolution.base must be one of request, server, or declared (got "response")',
      ),
    ]);
    expect(
      link({ role: 'nextLink', linkResolution: { base: 'declared' } }),
    ).toEqual([
      expect.stringContaining(
        'linkResolution.url must be an absolute http or https URL',
      ),
    ]);
    for (const url of [
      'v2/',
      'https://user:pw@api.example.com/',
      'https://api.example.com/#',
      'ftp://api.example.com/',
    ])
      expect(
        link({ role: 'nextLink', linkResolution: { base: 'declared', url } }),
      ).toEqual([
        expect.stringContaining(
          'linkResolution.url must be an absolute http or https URL',
        ),
      ]);
    expect(
      link({
        role: 'nextLink',
        linkResolution: { base: 'server', url: 'https://api.example.com/' },
      }),
    ).toEqual([
      expect.stringContaining(
        'linkResolution.url is allowed only when base is declared',
      ),
    ]);
    expect(link({ role: 'nextLink', linkResolution: 'server' })).toEqual([
      expect.stringContaining('linkResolution must be an object'),
    ]);
  });
});

describe('parsePaginationState: the nextLink value and its linkResolution (spec 0.4.0)', () => {
  const scheme: PaginationSchemeObject = {
    type: 'nextLink',
    response: {
      bodyFields: {
        next_page_uri: { role: 'nextLink', linkResolution: { base: 'server' } },
      },
    },
  };

  it("keeps the raw value and the field's linkResolution for resolveLink", () => {
    expect(
      parsePaginationState(scheme, { next_page_uri: '/next?Page=1' }),
    ).toMatchObject({
      nextLink: '/next?Page=1',
      nextLinkValue: '/next?Page=1',
      nextLinkResolution: { base: 'server' },
      hasNextPage: true,
    });
  });

  it('treats "" and null as no next page', () => {
    for (const value of ['', null]) {
      const state = parsePaginationState(scheme, { next_page_uri: value });
      expect(state.nextLink).toBeNull();
      expect(state.nextLinkValue).toBe(value);
      expect(state.hasNextPage).toBe(false);
    }
    expect(parsePaginationState(scheme, {}).nextLinkValue).toBeUndefined();
  });

  it('does not coerce a value that is not a string: it is kept raw for resolveLink to refuse', () => {
    const state = parsePaginationState(scheme, { next_page_uri: 42 });
    expect(state.nextLink).toBeNull();
    expect(state.nextLinkValue).toBe(42);
  });

  it("keeps a relative Link header target with the header's linkResolution", () => {
    const header: PaginationSchemeObject = {
      type: 'nextLink',
      response: {
        headers: {
          Link: {
            role: 'nextLink',
            linkResolution: {
              base: 'declared',
              url: 'https://api.example.com/v2/',
            },
          },
        },
      },
    };
    const state = parsePaginationState(
      header,
      {},
      { link: '<items?cursor=abc>; rel="next"' },
    );
    expect(state.nextLinkValue).toBe('items?cursor=abc');
    expect(state.nextLinkResolution).toEqual({
      base: 'declared',
      url: 'https://api.example.com/v2/',
    });
  });
});
