// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { LinkRefused, resolveLink } from '../../../src/pagination/links.js';
import {
  splitPath,
  readNestedField,
  setNestedField,
} from '../../../src/pagination/response-parser.js';
import { validatePaginationScheme } from '../../../src/pagination/validate.js';

// #384 items 3, 4, 5 and 8: conformance with Pagination Schemes 0.4.0 that
// the #380 review found short.

const SERVER = new URL('https://api.example.com/v1');
const REQUEST = new URL('https://api.example.com/v1/items?page=1');

const resolve = (value: unknown, server = SERVER): string | null =>
  resolveLink(value, { requestUrl: REQUEST, serverUrl: server })?.href ?? null;

describe('resolveLink (#384 items 3 and 4)', () => {
  it('refuses empty userinfo in the raw authority, which a WHATWG parser would drop (item 3)', () => {
    for (const value of [
      '//@api.example.com/x',
      'https://:@api.example.com/x',
      'https://@api.example.com/x',
      '//user@api.example.com/x',
    ])
      expect(() => resolve(value)).toThrow(/userinfo/);
    // A path that merely contains an @ is fine.
    expect(resolve('/items?mail=a@b.example')).toBe(
      'https://api.example.com/items?mail=a@b.example',
    );
  });

  it('refuses a server URL that is not http(s), and a result that is not, instead of matching "null" origins (item 4)', () => {
    expect(() => resolve('/next', new URL('ftp://api.example.com/'))).toThrow(
      /server URL is not http or https/,
    );
    expect(() => resolve('/next', new URL('file:///srv/api/'))).toThrow(
      LinkRefused,
    );
    // An http(s) server never pages onto another scheme, whatever the
    // origin strings would say.
    expect(() => resolve('ftp://api.example.com/next')).toThrow(LinkRefused);
  });
});

describe('validatePaginationScheme rule 10 (#384 item 5)', () => {
  const declared = (url: string): string[] =>
    validatePaginationScheme('links', {
      type: 'nextLink',
      response: {
        bodyFields: {
          next: { role: 'nextLink', linkResolution: { base: 'declared', url } },
        },
      },
    });

  it('accepts what the spec schema pattern accepts', () => {
    for (const url of [
      'https://api.example.com',
      'https://api.example.com/',
      'http://api.example.com:8080/v2/',
      'https://api.example.com/v2/?x=1',
      'https://api.example.com?x=1',
    ])
      expect(declared(url)).toEqual([]);
  });

  it('rejects what the WHATWG parser would have accepted', () => {
    for (const url of [
      'https:api.example.com/v2/',
      'https:/api.example.com/v2/',
      'https://api.example.com/v2\\x',
      'https://api.example.com/v 2/',
      'https://user@api.example.com/',
      'https://api.example.com/#',
      'https:///api.example.com/',
      'ftp://api.example.com/',
      'https://',
    ])
      expect(declared(url)).toEqual([
        expect.stringContaining(
          'linkResolution.url must be an absolute http or https URL',
        ),
      ]);
  });

  it('checks a scheme-level envelope', () => {
    const scheme = (envelope: unknown): string[] =>
      validatePaginationScheme('env', {
        type: 'pageToken',
        response: {
          envelope,
          bodyFields: { next: { role: 'nextPageToken' } },
        },
      } as never);
    expect(scheme({ itemsField: 'results' })).toEqual([]);
    expect(scheme({ itemsField: null })).toEqual([]);
    expect(scheme({})).toEqual([]);
    expect(scheme({ itemsField: 7 })).toEqual([
      expect.stringContaining('envelope.itemsField must be a string or null'),
    ]);
    expect(scheme('results')).toEqual([
      expect.stringContaining('envelope must be an object'),
    ]);
  });
});

describe('dot-paths with bracket escapes (#384 item 8)', () => {
  it('splits plain and escaped segments', () => {
    expect(splitPath('pagination.total_count')).toEqual([
      'pagination',
      'total_count',
    ]);
    expect(splitPath('meta["page.info"].next')).toEqual([
      'meta',
      'page.info',
      'next',
    ]);
    expect(splitPath('["a.b"]')).toEqual(['a.b']);
    expect(splitPath('a["q\\"uote"].b')).toEqual(['a', 'q"uote', 'b']);
    expect(splitPath('')).toEqual(['']);
    expect(() => splitPath('a[0].b')).toThrow(/Malformed dot-path/);
  });

  it('reads and writes through an escaped segment', () => {
    const body: Record<string, unknown> = {
      meta: { 'page.info': { next: 'abc' } },
    };
    expect(readNestedField(body, 'meta["page.info"].next')).toBe('abc');
    setNestedField(body, 'meta["page.info"].cursor', 'xyz');
    expect(body).toEqual({
      meta: { 'page.info': { next: 'abc', cursor: 'xyz' } },
    });
    // Unchanged for ordinary paths.
    expect(readNestedField({ a: { b: 1 } }, 'a.b')).toBe(1);
  });
});
