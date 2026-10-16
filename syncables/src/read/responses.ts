import type { Transport, TransportRequest } from './transport.js';

/** A data-read response before JSON parsing, item extraction or datatype conversion. */
export interface RawReadResponse {
  url: string;
  method: TransportRequest['method'];
  /** List request body before authentication is applied, when present. */
  requestBody?: string;
  status: number;
  /** Relevant data headers only; cookies and authentication headers are excluded. */
  headers: Record<string, string>;
  body: string;
  receivedAt: string;
}

/** Awaited before processing the response; the caller chooses storage and retention. */
export type StoreReadResponse = (
  response: RawReadResponse,
) => void | Promise<void>;

export function captureReadResponses(
  transport: Transport,
  store?: StoreReadResponse,
): Transport {
  if (!store) return transport;
  return async (request) => {
    const response = await transport(request);
    await store({
      url: request.url.href,
      method: request.method,
      ...(request.body === undefined ? {} : { requestBody: request.body }),
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers).filter(([name]) =>
          [
            'content-type',
            'etag',
            'last-modified',
            'link',
            'retry-after',
          ].includes(name.toLowerCase()),
        ),
      ),
      body: response.body,
      receivedAt: new Date().toISOString(),
    });
    return response;
  };
}
