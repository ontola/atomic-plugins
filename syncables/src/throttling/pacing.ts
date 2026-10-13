// @wc-ignore-file
/**
 * Pacing against the quotas a document's `x-throttling` announces (draft
 * Throttling extension, pieces.md K2): a Limit Object with `requests` and a
 * Window Object. The extension describes the quota; how a client keeps
 * under it is this consumer's choice, not a spec rule. The pacer counts the
 * requests this client sends, per bucket, and says how long the next one
 * must wait so that at most `fraction` of `requests` are sent in a window.
 *
 * - `sliding` and `unspecified` windows count the preceding `seconds`.
 * - A `fixed` window with an `anchor` counts from its boundaries
 *   (`anchor + n * seconds`).
 * - A `fixed` window without an `anchor` has an unknown phase (the spec
 *   says not to assume one), so it is paced as sliding: at most the allowed
 *   number in any `seconds`, which keeps under the quota whatever the phase.
 *
 * Only this client's own requests are counted: a bucket partitioned by
 * `sourceIp` behind a shared proxy, or shared with other clients of the same
 * user, can still run out (pieces.md P4). Counts are kept in memory.
 */

/** A bucket the pacer keeps under: from a Limit Object with `requests`. */
export interface Quota {
  requests: number;
  seconds: number;
  kind: 'fixed' | 'sliding' | 'unspecified';
  /** A fixed window's anchor, in ms since the epoch. */
  anchor?: number;
}

export class Pacer {
  private readonly sent = new Map<string, number[]>();

  /**
   * `fraction` of each bucket's `requests` (rounded down, at least one) may
   * be sent per window; it must be greater than 0 and at most 1.
   */
  constructor(
    private readonly quotas: ReadonlyMap<string, Quota>,
    private readonly fraction = 0.8,
  ) {
    if (!(fraction > 0 && fraction <= 1))
      throw new Error(
        `paceFraction must be greater than 0 and at most 1, not ${fraction}`,
      );
  }

  /** The requests one window of `quota` allows this client. */
  allowed(quota: Quota): number {
    return Math.max(1, Math.floor(quota.requests * this.fraction));
  }

  /** Milliseconds until a request counted against `buckets` may be sent; 0 now. */
  delay(buckets: readonly string[], now: number): number {
    let wait = 0;
    for (const bucket of buckets) {
      const quota = this.quotas.get(bucket);
      if (quota) wait = Math.max(wait, this.bucketDelay(bucket, quota, now));
    }
    return wait;
  }

  /** Counts a request sent now against `buckets`. */
  take(buckets: readonly string[], now: number): void {
    for (const bucket of new Set(buckets))
      if (this.quotas.has(bucket)) {
        const times = this.sent.get(bucket) ?? [];
        times.push(now);
        this.sent.set(bucket, times);
      }
  }

  private bucketDelay(bucket: string, quota: Quota, now: number): number {
    const width = quota.seconds * 1000;
    // Older requests no longer count in any window that includes now.
    const times = (this.sent.get(bucket) ?? []).filter((t) => t > now - width);
    this.sent.set(bucket, times);
    const allowed = this.allowed(quota);
    if (quota.kind === 'fixed' && quota.anchor !== undefined) {
      const start =
        quota.anchor + Math.floor((now - quota.anchor) / width) * width;
      const inWindow = times.filter((t) => t >= start).length;
      return inWindow < allowed ? 0 : start + width - now;
    }
    if (times.length < allowed) return 0;
    // The request that leaves the window first makes room.
    return (times[times.length - allowed] as number) + width - now;
  }
}
