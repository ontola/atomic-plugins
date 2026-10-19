/**
 * The read path's only way to reach the network: a caller-supplied function.
 * In a browser plugin that is the host's `request()` into an integration
 * proxy; in a test it is a stub; `fetchTransport` adapts anything
 * fetch-shaped. Nothing under `src/read/` calls `fetch` itself.
 */

export type ListMethod = 'GET' | 'POST';
export type HttpMethod = ListMethod | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Why syncables makes a request, for a transport that treats them apart (a
 * cache that may answer a list read but must not answer a precondition
 * read or a write):
 * - `list`: a page of a collection read, `paginate`, or a range window;
 * - `feed`: a page of a deletion feed;
 * - `item`: a record's own GET, checking a record a list lacks;
 * - `describer`: a Runtime Schemas describer read;
 * - `zone`: an `x-time-zone` zone source read;
 * - `precondition`: a read a write depends on (Write Preconditions' object
 *   or source read, or resolving an unknown outcome), which must be fresh;
 * - `write`: a create, update, delete or follow-up;
 * - `inbox`: a webhook inbox consumer request.
 */
export type RequestPurpose =
  | 'list'
  | 'feed'
  | 'item'
  | 'describer'
  | 'zone'
  | 'precondition'
  | 'write'
  | 'inbox';

export interface TransportRequest {
  /** Absolute URL under the document's `servers[0].url`. */
  url: URL;
  method: HttpMethod;
  /** Lower-case header names. `content-type` is set for a POST. */
  headers: Record<string, string>;
  /** Request body as text, when present. */
  body?: string;
  /**
   * Why the request is made. Every request syncables makes sets it; a
   * transport may ignore it. Optional so that requests built elsewhere
   * still type-check.
   */
  purpose?: RequestPurpose;
}

/** A request as syncables makes it: with its purpose. */
export type PurposedRequest = TransportRequest & { purpose: RequestPurpose };

export interface TransportResponse {
  status: number;
  /** Header names in any case; the read path lower-cases them. */
  headers: Record<string, string>;
  /** Raw response text; the read path parses it as JSON. */
  body: string;
  /**
   * Set by a transport that answered without asking the provider (a
   * cache): the request then does not count against pacing quotas or the
   * read's `maxRequests`.
   */
  fromCache?: boolean;
}

export type Transport = (
  request: TransportRequest,
) => Promise<TransportResponse>;

/** The subset of `fetch` that `fetchTransport` calls. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  headers: { forEach(callback: (value: string, key: string) => void): void };
  text(): Promise<string>;
}>;

/** Adapts `fetch` (or a host function with its shape) to a `Transport`. */
export function fetchTransport(fetchLike: FetchLike): Transport {
  return async (request) => {
    const response = await fetchLike(request.url.href, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

export function lowerCaseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
