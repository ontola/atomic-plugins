import { headerTime } from '../throttling/throttling.js';

export function readRetryBackoff(retries: number): number {
  return 1000 * 2 ** Math.min(retries, 2);
}

/** Minimum delay for repeating a read after a temporary gateway failure. */
export function gatewayRetryDelay(
  status: number,
  retries: number,
  receivedAt: number,
  retryAfter?: string,
  date?: string,
): number | undefined {
  if (status !== 502 && status !== 503 && status !== 504) return undefined;
  const retryAt = retryAfter
    ? headerTime(retryAfter, 'deltaSecondsOrHttpDate', receivedAt, date)
    : undefined;
  return Math.max(readRetryBackoff(retries), (retryAt ?? 0) - receivedAt);
}
