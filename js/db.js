/* Tiny key-value store on IndexedDB (falls back to memory if unavailable). */
(function (root) {
  'use strict';
  const DB = 'rubber-ledger', STORE = 'kv';
  const mem = new Map();
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch (e) { resolve(null); }
    });
    return dbp;
  }
  async function get(key, fallback) {
    const db = await open();
    if (!db) return mem.has(key) ? mem.get(key) : fallback;
    return new Promise((resolve) => {
      try {
        const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result === undefined ? fallback : r.result);
        r.onerror = () => resolve(fallback);
      } catch (e) { resolve(fallback); }
    });
  }
  async function set(key, value) {
    const db = await open();
    if (!db) { mem.set(key, value); return; }
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => { mem.set(key, value); resolve(); };
      } catch (e) { mem.set(key, value); resolve(); }
    });
  }
  root.KV = { get, set };
})(self);
