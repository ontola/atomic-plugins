// @wc-ignore-file
import type { LinkResolutionObject } from './types.js';

/**
 * A `nextLink` or `previousLink` value that Pagination Schemes 0.4.0
 * §4.4.3 or §4.4.4 forbids following. A read that meets one ends with this
 * error; the page is never treated as the last one.
 */
export class LinkRefused extends Error {}

/**
 * Whitespace, an ASCII control character, a backslash or any character
 * outside ASCII (§4.4.3 rule 2): URL parsers disagree on these.
 */
// eslint-disable-next-line no-control-regex
const UNFOLLOWABLE = /[\s\x00-\x1f\x7f\\]|[^\x00-\x7f]/;
/** `scheme:` at the start of a URI reference (RFC 3986 §3.1). */
const SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
/** `scheme://` followed by the first character of an authority. */
const SCHEME_WITH_AUTHORITY = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]/;
/** A network-path reference whose authority is empty: `//` alone, or `//` before a `/`. */
const EMPTY_AUTHORITY = /^\/\/(?:$|\/)/;

export interface ResolveLinkOptions {
  /** The request whose response carried the link, as addressed to the API's server. */
  requestUrl: URL;
  /** The server URL the request was sent to (`servers[0].url`, variables substituted). */
  serverUrl: URL;
  /** The field's Link Resolution Object; absent or null means `base: request`. */
  resolution?: LinkResolutionObject | null | undefined;
}

const refused = (reason: string): LinkRefused =>
  new LinkRefused(`Pagination link refused: ${reason}`);

/**
 * Resolves one `nextLink`/`previousLink` value under §4.4.3 and checks it
 * under §4.4.4. Returns `null` when there is no next page (`null`,
 * `undefined` or `""`), else the URL to request, exactly as checked: the
 * caller requests this object and never re-resolves the raw string.
 * Throws `LinkRefused` for a value that must not be followed (rule 2): not
 * a string; whitespace, a control character, a backslash or a character
 * outside ASCII; three or more leading slashes (`///host/x`, which a WHATWG
 * parser would turn into `https://host/x`); a scheme not followed by `//`
 * and an authority (`https:x`, `https:/x`, `https:///host/x`,
 * `javascript:…`, `file:///…`); an empty authority after `//`; a fragment
 * in the raw value (`/next#` has an empty one) or in the result; userinfo;
 * or an origin other than the server's (scheme, host and port).
 *
 * This is the consumer's side of `resolve_link()` in
 * `openapi-extensions/spec/pagination-schemes/validate.py`. It resolves
 * with the WHATWG URL parser after rule 2 has removed the inputs on which
 * parsers disagree, and the URL it returns is the one the caller requests
 * (§4.4.4 rule 4). The URLs here are provider-side; a transport that goes
 * through a proxy maps the returned URL onto its route as it maps any
 * operation URL. Hosts are compared as the parser serialises them (ASCII);
 * a non-ASCII link never reaches the comparison.
 */
export function resolveLink(
  value: unknown,
  options: ResolveLinkOptions,
): URL | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw refused('the link is not a string');
  if (UNFOLLOWABLE.test(value))
    throw refused(
      'the link contains whitespace, a control character, a backslash or a non-ASCII character',
    );
  if (value.startsWith('///'))
    throw refused('the link starts with three or more slashes');
  if (SCHEME.test(value) && !SCHEME_WITH_AUTHORITY.test(value))
    throw refused('the link has a scheme without "//" and an authority');
  if (EMPTY_AUTHORITY.test(value))
    throw refused('the link has an empty authority');
  if (value.includes('#')) throw refused('the link contains a fragment');
  const base = baseFor(options);
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    throw refused(`${value} does not resolve to a URL`);
  }
  if (resolved.username || resolved.password)
    throw refused('the link contains userinfo');
  if (resolved.hash || resolved.href.includes('#'))
    throw refused('the link contains a fragment');
  if (resolved.origin !== options.serverUrl.origin)
    throw new LinkRefused('Pagination left the API origin');
  return resolved;
}

/** The base URL of §4.4.3's table for the field's `linkResolution`. */
function baseFor({
  requestUrl,
  serverUrl,
  resolution,
}: ResolveLinkOptions): URL {
  const base = resolution?.base ?? 'request';
  if (base === 'request') return requestUrl;
  if (base === 'server') {
    // A server URL is a directory: operation paths are appended to it.
    const directory = new URL(serverUrl.href);
    if (!directory.pathname.endsWith('/')) directory.pathname += '/';
    return directory;
  }
  if (base === 'declared') {
    if (typeof resolution?.url !== 'string' || resolution.url === '')
      throw refused('linkResolution base "declared" has no url');
    try {
      return new URL(resolution.url);
    } catch {
      throw refused(
        `linkResolution url ${resolution.url} is not an absolute URL`,
      );
    }
  }
  throw refused(`unknown linkResolution base "${String(base)}"`);
}
