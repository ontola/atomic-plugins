// @wc-ignore-file
/**
 * Who syncs right now. The app syncs whenever its view is open, and every
 * person with access to the drive may have it open at once. Two passes at
 * the same time would each create a note for the same new row, so a pass
 * first takes a lease on the App (`google-keep-lease`: `<holder> <until>`),
 * writes it, waits for the drive to settle, and goes ahead only if the
 * lease it reads back is still its own. A browser that finds another's
 * lease that has not run out skips its pass ("another browser is syncing").
 *
 * The drive merges concurrent writes to one property by last writer wins,
 * so two browsers that write a lease together both read back the same
 * winner once the write has spread. That holds while the drive delivers a
 * write within `SETTLE_MS`; a slower drive can still let two passes
 * overlap, which `sync.ts` narrows further by re-reading a row just before
 * it creates its note. A lease that is never released (a closed tab) runs
 * out after `LEASE_MS`.
 */
import type { Drive } from './drive.js';
import type { PluginStore } from './store.js';

export const LEASE_MS = 90_000;
export const SETTLE_MS = 1_500;

export interface Lease {
  holder: string;
  until: number;
}

export function parseLease(value: unknown): Lease | undefined {
  if (typeof value !== 'string') return undefined;
  const [holder, until] = value.split(' ');
  const at = Date.parse(until ?? '');

  return holder && Number.isFinite(at) ? { holder, until: at } : undefined;
}

/** A random holder id for this frame. */
export function newHolder(): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);

  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface LeaseOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const timerSleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Takes (or renews) the lease for `holder`. Resolves `true` when the pass
 * may run, `false` when another browser holds a lease that has not run out.
 */
export async function acquire(
  store: PluginStore,
  drive: Drive,
  holder: string,
  { now = Date.now, sleep = timerSleep }: LeaseOptions = {},
): Promise<boolean> {
  const property = drive.properties.lease;
  const current = parseLease(
    (await store.getResource(drive.app)).get(property),
  );
  if (current && current.holder !== holder && current.until > now())
    return false;

  const app = await store.getResource(drive.app);
  await app
    .set(property, `${holder} ${new Date(now() + LEASE_MS).toISOString()}`)
    .save();
  await sleep(SETTLE_MS);
  const after = parseLease((await store.getResource(drive.app)).get(property));

  return after?.holder === holder;
}

/** Gives the lease up, if `holder` still has it. */
export async function release(
  store: PluginStore,
  drive: Drive,
  holder: string,
): Promise<void> {
  const app = await store.getResource(drive.app);
  if (parseLease(app.get(drive.properties.lease))?.holder !== holder) return;
  await app.remove(drive.properties.lease).save();
}
