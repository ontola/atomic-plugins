/**
 * Request URLs for the inbox client, without depending on the WHATWG `URL`
 * global, which atomic-server's QuickJS sandbox does not have (#369 step
 * 4b). Where `URL` exists the transport gets a real one; elsewhere it gets
 * an object with the fields a transport reads (`href`, `origin`,
 * `pathname`, `search`, `toString()`), built from the same string. Either
 * way `href` is exactly the string built here: the base URL as given, plus
 * the path and query, which is what a v2 signature covers.
 */

/** The base URL as given, without a trailing `/`. */
export function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
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
