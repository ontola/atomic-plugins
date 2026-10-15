/* global self */
// The service worker of ../background.spec.ts: a `sync` or `periodicsync`
// event tagged "devonian" runs one BackgroundSync tick against the same
// IndexedDB store and Web Locks leases as the tabs. Plain JS, bundled by
// esbuild into one classic script.
import {
  BackgroundSync,
  defaultLocks,
  handleBackgroundSyncEvent,
} from 'devonian/background';
import { bump, idbStore } from './idb-store.mjs';

const sync = new BackgroundSync({
  name: 'worker',
  intervalMs: 3_600_000,
  store: idbStore,
  locks: defaultLocks(),
  run: () => bump('runs-worker'),
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
for (const type of ['sync', 'periodicsync'])
  self.addEventListener(type, (event) =>
    handleBackgroundSyncEvent(event, sync, 'devonian'),
  );
