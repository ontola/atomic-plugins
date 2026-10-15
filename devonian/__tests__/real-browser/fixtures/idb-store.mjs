/* global indexedDB */
// A string key-value store in IndexedDB, shared by every tab and the
// service worker of one origin: the kind of `SyncStateStore` a browser host
// gives BackgroundSync (src/background/BackgroundSync.ts). Plain JS, bundled
// by esbuild for ../background.spec.ts.

const open = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open('devonian-real-browser', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('kv');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Runs `body` on the store in one transaction; resolves with its value. */
async function transact(mode, body) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    let value;
    body(tx.objectStore('kv'), (v) => (value = v));
    tx.oncomplete = () => {
      db.close();
      resolve(value);
    };
    tx.onerror = () => reject(tx.error);
  });
}

export const idbStore = {
  get: (key) =>
    transact('readonly', (store, done) => {
      const request = store.get(key);
      request.onsuccess = () => done(request.result);
    }),
  set: (key, value) =>
    transact('readwrite', (store) => {
      store.put(value, key);
    }),
};

/** Adds one to the counter `key`, read and written in one transaction. */
export const bump = (key) =>
  transact('readwrite', (store) => {
    const request = store.get(key);
    request.onsuccess = () =>
      store.put(String(Number(request.result ?? 0) + 1), key);
  });

export const count = async (key) => Number((await idbStore.get(key)) ?? 0);
