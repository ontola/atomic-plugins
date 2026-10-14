// @wc-ignore-file
/**
 * Pacing against the quotas a document's `x-throttling` announces (draft
 * Throttling extension, pieces.md K2): a Limit Object with `requests` and a
 * Window Object, or the Tier Objects of a Limit Object with `tiers`
 * (Throttling 0.5.0: the plan's tier, else every tier, each a separate
 * count over the same requests). The extension describes the quota; how a client keeps
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

/** A quota the pacer keeps under: from a Limit Object with `requests`, or a Tier Object. */
export interface Quota {
  requests: number;
  seconds: number;
  kind: 'fixed' | 'sliding' | 'unspecified';
  /** A fixed window's anchor, in ms since the epoch. */
  anchor?: number;
}

export class Pacer {
  private readonly sent = new Map<string, number[]>();
  /** Every quota of each bucket, kept within at once. */
  private readonly quotas = new Map<string, readonly Quota[]>();

  /**
   * `fraction` of each bucket's `requests` (rounded down, at least one) may
   * be sent per window; it must be greater than 0 and at most 1. `tiered`
   * (Throttling 0.5.0 plan tiers, `ThrottlingDeclaration.tieredQuotas`)
   * gives a bucket several quotas, each a separate count over the same
   * requests: a request waits until it fits every one.
   */
  constructor(
    quotas: ReadonlyMap<string, Quota>,
    private readonly fraction = 0.8,
    tiered: ReadonlyMap<string, readonly Quota[]> = new Map(),
  ) {
    if (!(fraction > 0 && fraction <= 1))
      throw new Error(
        `paceFraction must be greater than 0 and at most 1, not ${fraction}`,
      );
    for (const [bucket, quota] of quotas) this.quotas.set(bucket, [quota]);
    for (const [bucket, list] of tiered)
      if (list.length) this.quotas.set(bucket, list);
  }

  /** The requests one window of `quota` allows this client. */
  allowed(quota: Quota): number {
    return Math.max(1, Math.floor(quota.requests * this.fraction));
  }

  /** Milliseconds until a request counted against `buckets` may be sent; 0 now. */
  delay(buckets: readonly string[], now: number): number {
    let wait = 0;
    for (const bucket of buckets) {
      const quotas = this.quotas.get(bucket);
      if (!quotas) continue;
      // Kept for the longest window; each quota counts its own below.
      const longest = Math.max(...quotas.map((q) => q.seconds)) * 1000;
      const times = (this.sent.get(bucket) ?? []).filter(
        (t) => t > now - longest,
      );
      this.sent.set(bucket, times);
      for (const quota of quotas)
        wait = Math.max(wait, this.quotaDelay(times, quota, now));
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

  private quotaDelay(all: number[], quota: Quota, now: number): number {
    const width = quota.seconds * 1000;
    // Older requests no longer count in any window that includes now.
    const times = all.filter((t) => t > now - width);
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
