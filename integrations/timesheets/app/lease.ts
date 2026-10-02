// @wc-ignore-file
/**
 * The send lease (#97 §6.2 and answer 5, #123 M5): one open copy of the app
 * at a time drives writes to Clockify. A provider write is not idempotent
 * (a create twice is two entries), so two devices, or two tabs, must not
 * both send.
 *
 * - **Where:** `clockify-lease` on the observation log's head, a property of
 *   its own, so saving the head's log state never touches it (the host
 *   saves only the properties set since the last save). JSON text:
 *   `{ device, takenAt, until }`.
 * - **Taking it:** read the head; if another copy holds a lease that has
 *   not expired, do not send. Otherwise write ours, read it back, and send
 *   only if it is still ours.
 * - **Keeping it:** 60 s at a time, renewed before each change and before
 *   each write when less than half is left. A copy that stalls longer
 *   loses it to the next one that asks.
 * - **Giving it back:** at the end of a send, by writing it as expired.
 *   A copy closed mid-send leaves it to expire.
 *
 * **Advisory.** `/app-write` has no compare-and-swap, so two copies that
 * take the lease within one read-write round trip can both believe they
 * hold it. Plans are state-based (#97 §4.2): the worst case is a duplicate
 * create, which the next sync shows as a duplicate and "Remove duplicate"
 * repairs; nothing is lost silently. Only the lease's own logic is tested,
 * through the in-memory store; two real browsers have not been tried.
 */
import type { CompleteSchema } from './schema.js';
import type { PluginStore } from './store.js';

export const LEASE_TTL_MS = 60_000;

export interface LeaseState {
  /** The app instance holding it (`frame-…`, new on every page load). */
  device: string;
  /** ISO 8601. */
  takenAt: string;
  /** ISO 8601: expired from then on. */
  until: string;
}

export interface LeaseOptions {
  device: string;
  clock: () => number;
}

const parse = (value: unknown): LeaseState | undefined => {
  if (typeof value !== 'string' || !value) return undefined;

  try {
    const lease = JSON.parse(value) as LeaseState;

    return typeof lease?.device === 'string' && typeof lease.until === 'string'
      ? lease
      : undefined;
  } catch {
    return undefined;
  }
};

const live = (lease: LeaseState | undefined, now: number) =>
  !!lease && Date.parse(lease.until) > now;

async function headOf(
  store: PluginStore,
  schema: CompleteSchema,
): Promise<string | undefined> {
  const home = await store.getResource(schema.home);
  const head = home.get(schema.log.log);

  return typeof head === 'string' && head ? head : undefined;
}

/** Another copy's lease that has not expired, if any. */
export async function leaseHeldElsewhere(
  store: PluginStore,
  schema: CompleteSchema,
  { device, clock }: LeaseOptions,
): Promise<LeaseState | undefined> {
  const head = await headOf(store, schema);
  if (!head) return undefined;
  const lease = parse((await store.getResource(head)).get(schema.log.lease));

  return lease && lease.device !== device && live(lease, clock())
    ? lease
    : undefined;
}

/** Why sending waits, for the person. */
export function heldMessage(holder: LeaseState, timeZone?: string): string {
  const until = new Date(holder.until).toLocaleTimeString(undefined, {
    ...(timeZone ? { timeZone } : {}),
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return `Another open copy of this app (another device or tab) is sending changes to Clockify. Nothing was sent; try again after ${until}, when its turn ends at the latest.`;
}

export class SendLease {
  private constructor(
    private readonly store: PluginStore,
    private readonly schema: CompleteSchema,
    private readonly options: LeaseOptions,
    private readonly head: string | undefined,
    private until: number,
  ) {}

  /**
   * Takes the lease, or returns the copy that holds it. Without a log head
   * (nothing read yet, so nothing to send) the lease is a no-op.
   */
  static async take(
    store: PluginStore,
    schema: CompleteSchema,
    options: LeaseOptions,
  ): Promise<SendLease | { heldBy: LeaseState }> {
    const head = await headOf(store, schema);
    if (!head) return new SendLease(store, schema, options, undefined, 0);
    const lease = new SendLease(store, schema, options, head, 0);
    const holder = await lease.write();

    return holder ? { heldBy: holder } : lease;
  }

  /**
   * Keeps the lease: renews it when less than half is left. Returns the
   * copy that holds it instead, if this one lost it.
   */
  async renew(): Promise<LeaseState | undefined> {
    if (!this.head) return undefined;
    const now = this.options.clock();
    const stored = await this.read();
    if (stored && stored.device !== this.options.device && live(stored, now))
      return stored;
    if (
      stored?.device === this.options.device &&
      this.until - now > LEASE_TTL_MS / 2
    )
      return undefined;

    return this.write();
  }

  /** Gives the lease back, if this copy still holds it. */
  async release(): Promise<void> {
    if (!this.head) return;
    const resource = await this.store.getResource(this.head);
    const stored = parse(resource.get(this.schema.log.lease));
    if (stored?.device !== this.options.device) return;
    const now = new Date(this.options.clock()).toISOString();
    resource.set(
      this.schema.log.lease,
      JSON.stringify({ ...stored, until: now } satisfies LeaseState),
    );
    await resource.save();
  }

  private async read(): Promise<LeaseState | undefined> {
    return parse(
      (await this.store.getResource(this.head!)).get(this.schema.log.lease),
    );
  }

  /** Writes this copy's lease unless another holds one; reads it back. */
  private async write(): Promise<LeaseState | undefined> {
    const { device, clock } = this.options;
    const resource = await this.store.getResource(this.head!);
    const stored = parse(resource.get(this.schema.log.lease));
    const now = clock();
    if (stored && stored.device !== device && live(stored, now)) return stored;
    const mine: LeaseState = {
      device,
      takenAt:
        stored?.device === device && live(stored, now)
          ? stored.takenAt
          : new Date(now).toISOString(),
      until: new Date(now + LEASE_TTL_MS).toISOString(),
    };
    resource.set(this.schema.log.lease, JSON.stringify(mine));
    await resource.save();
    // Read back: another copy may have written in between.
    const after = await this.read();
    if (after?.device !== device) return after;
    this.until = now + LEASE_TTL_MS;

    return undefined;
  }
}
