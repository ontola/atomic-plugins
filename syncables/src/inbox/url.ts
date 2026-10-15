/**
 * Request URLs for the inbox client, without depending on the WHATWG `URL`
 * global, which atomic-server's QuickJS sandbox does not have (#369 step
 * 4b). Where `URL` exists the transport gets a real one; elsewhere it gets
 * an object with the fields a transport reads (`href`, `origin`,
 * `pathname`, `search`, `toString()`), built from the same string. Either
 * way `href` is exactly the string built here: the base URL, plus the path
 * and query, which is what a v2 signature covers. That holds only for a base
 * `URL` would not rewrite, so `trimBase` refuses any other.
 */

/**
 * A canonical base: `http` or `https`, a lower-case host name or a
 * dotted-decimal IPv4 address (`isCanonicalHost`), a port only when it is not
 * the scheme's default, and an optional path of plain segments; no user
 * info, query, fragment, percent-escape, space or other character `URL`
 * would encode. IPv6 literals are refused: `URL` compresses and rewrites
 * them, and checking their canonical form is not worth it for a base URL.
 */
const CANONICAL_BASE =
  /^(https?):\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::([0-9]{1,5}))?((?:\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)*)$/;

/**
 * A host `URL` keeps as it is. When its last label is a number (decimal, or
 * `0x` hex), `URL` parses the whole host as IPv4 and rewrites shorthand
 * (`127.1`), hex (`0x7f.0.0.1`) and octal (`010.0.0.1`), or refuses it
 * (`1.2.3.4.5`): only four decimal octets, 0 to 255, without leading zeros,
 * are canonical then.
 */
function isCanonicalHost(host: string): boolean {
  const labels = host.split('.');
  if (!/^(?:[0-9]+|0x[0-9a-f]*)$/.test(labels.at(-1)!)) return true;
  return (
    labels.length === 4 &&
    labels.every(
      (label) => /^(?:0|[1-9][0-9]{0,2})$/.test(label) && Number(label) <= 255,
    )
  );
}

/**
 * The receiver's base URL without its trailing `/` (all of them), refused
 * unless canonical (`CANONICAL_BASE`): only then is the URL a request is
 * signed for exactly the one `URL` hands to the transport, and the one the
 * receiver rebuilds from its own `BASE_URL`.
 */
export function trimBase(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const match = CANONICAL_BASE.exec(base);
  const port = match?.[3];
  const defaultPort =
    (match?.[1] === 'https' && port === '443') ||
    (match?.[1] === 'http' && port === '80');
  // `URL` resolves dot segments, so they would change the signed path too.
  const dotSegment = /\/\.\.?(?=\/|$)/.test(match?.[4] ?? '');
  if (
    !match ||
    !isCanonicalHost(match[2]!) ||
    defaultPort ||
    dotSegment ||
    (port !== undefined && (/^0/.test(port) || Number(port) > 65535)) ||
    rewrittenByUrl(base)
  ) {
    throw new TypeError(
      `webhook inbox: ${JSON.stringify(baseUrl)} is not a canonical base URL (lower-case host, no default port, no query, fragment, user info or escapes)`,
    );
  }
  return base;
}

/**
 * Where `URL` exists, a last check that it keeps the base as written (it
 * adds a `/` to a bare origin). Without `URL` (the QuickJS sandbox) the
 * pattern above is the whole check.
 */
function rewrittenByUrl(base: string): boolean {
  const Url = (globalThis as { URL?: typeof URL }).URL;
  if (typeof Url !== 'function') return false;
  try {
    return new Url(base).href.replace(/\/$/, '') !== base;
  } catch {
    return true;
  }
}

/** `?a=1&b=2` from defined values, each `encodeURIComponent`-encoded. */
export function queryString(
  values: Record<string, string | number | undefined>,
): string {
  const parts = Object.entries(values)
    .filter(
      (entry): entry is [string, string | number] => entry[1] !== undefined,
    )
    .map(
      ([name, value]) =>
        `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`,
    );
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

/** A `URL` for `href`, or a stand-in with the same `href` without one. */
export function requestUrl(href: string): URL {
  const Url = (globalThis as { URL?: typeof URL }).URL;
  if (typeof Url === 'function') {
    return new Url(href);
  }
  const match = /^([a-z][a-z0-9+.-]*:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(
    href,
  );
  const origin = match?.[1] ?? '';
  const pathname = match?.[2] || '/';
  const search = match?.[3] ?? '';
  return {
    href,
    origin,
    pathname,
    search,
    toString: (): string => href,
  } as unknown as URL;
}
