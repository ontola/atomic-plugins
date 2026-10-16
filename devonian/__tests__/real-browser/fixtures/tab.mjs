/* global navigator, window */
// The page side of ../background.spec.ts: BackgroundSync with the default
// leases (Web Locks, `navigator.locks`) and the IndexedDB store, exposed on
// `window.devonian` for page.evaluate. Plain JS, bundled by esbuild.
import {
  BackgroundSync,
  defaultLocks,
  registerBackgroundSync,
} from 'devonian/background';
import { bump, count, idbStore } from './idb-store.mjs';

const syncFor = (name, intervalMs, run) =>
  new BackgroundSync({
    name,
    intervalMs,
    store: idbStore,
    locks: defaultLocks(),
    run,
  });

let release;
let held;

window.devonian = {
  /** Whether defaultLocks found Web Locks here. */
  hasWebLocks: () => typeof navigator.locks?.request === 'function',

  /**
   * Starts a tick whose pass does not finish until `releaseHeld`: it holds
   * the lease meanwhile. Resolves once the pass has started.
   */
  startHeld: (name, intervalMs) =>
    new Promise((started) => {
      const sync = syncFor(name, intervalMs, async () => {
        await bump(`runs-${name}`);
        started();
        await new Promise((resolve) => (release = resolve));
      });
      held = sync.tick();
    }),

  /** Lets the held pass finish; resolves with its tick outcome. */
  releaseHeld: async () => {
    release();
    return (await held).outcome;
  },

  /** One tick whose pass counts itself; resolves with the outcome. */
  tick: async (name, intervalMs) =>
    (
      await syncFor(name, intervalMs, () => bump(`runs-${name}`)).tick()
    ).outcome,

  count,

  /** Registers ./sw.js and asks for its sync events. */
  registerWorker: async () => {
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    return registerBackgroundSync(registration, 'devonian', 3_600_000);
  },
};
