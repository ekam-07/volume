/**
 * A persistent audio cache on each phone, in IndexedDB.
 *
 * Without this, a phone re-downloads the whole song every time the page
 * reloads, the screen locks long enough to drop the socket, or someone rejoins
 * the room. With it, a phone that already has the track is ready instantly and
 * the host sees it go green without a byte crossing the network.
 *
 * Storing decoded PCM would be faster still, but it is roughly ten times the
 * size — a four-minute stereo track is ~42 MB decoded against ~4 MB encoded.
 * So we keep the compressed bytes and re-decode, which costs a few hundred
 * milliseconds and happens well before playback starts.
 */

const DB_NAME = 'volume-audio';
const STORE = 'tracks';
const META = 'meta';
const DB_VERSION = 1;

/** Evict least-recently-used tracks past this. Phones are not laptops. */
const MAX_BYTES = 300 * 1024 * 1024;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!self.indexedDB) return reject(new Error('IndexedDB unavailable'));
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the cache'));
  }).catch((err) => {
    // Private windows and blocked site data both land here. The app must still
    // work, just without the cache, so remember the failure and stop retrying.
    dbPromise = Promise.reject(err);
    throw err;
  });
  return dbPromise;
}

function run(storeName, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const request = fn(tx.objectStore(storeName));
        tx.onabort = () => reject(tx.error);
        tx.onerror = () => reject(tx.error);
        if (request) {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        } else {
          tx.oncomplete = () => resolve();
        }
      }),
  );
}

// ---------------------------------------------------------------------------

/** @returns {Promise<ArrayBuffer|null>} */
export async function get(trackId) {
  try {
    const bytes = await run(STORE, 'readonly', (store) => store.get(trackId));
    if (!bytes) return null;
    await touch(trackId, bytes.byteLength);
    return bytes;
  } catch {
    return null;
  }
}

export async function put(trackId, arrayBuffer) {
  try {
    await run(STORE, 'readwrite', (store) => store.put(arrayBuffer, trackId));
    await touch(trackId, arrayBuffer.byteLength);
    await evictIfNeeded();
    return true;
  } catch {
    // A full or unavailable cache must never stop playback.
    return false;
  }
}

export async function has(trackId) {
  try {
    const key = await run(STORE, 'readonly', (store) => store.getKey(trackId));
    return key !== undefined;
  } catch {
    return false;
  }
}

/** Every track id this phone holds — reported to the host as readiness. */
export async function keys() {
  try {
    return (await run(STORE, 'readonly', (store) => store.getAllKeys())) ?? [];
  } catch {
    return [];
  }
}

export async function usage() {
  const index = await readIndex();
  const bytes = Object.values(index).reduce((total, entry) => total + (entry.bytes ?? 0), 0);
  return { bytes, count: Object.keys(index).length, maxBytes: MAX_BYTES };
}

export async function clear() {
  try {
    await run(STORE, 'readwrite', (store) => store.clear());
    await run(META, 'readwrite', (store) => store.put({}, 'index'));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------

async function readIndex() {
  try {
    return (await run(META, 'readonly', (store) => store.get('index'))) ?? {};
  } catch {
    return {};
  }
}

async function touch(trackId, bytes) {
  try {
    const index = await readIndex();
    index[trackId] = { bytes, usedAt: Date.now() };
    await run(META, 'readwrite', (store) => store.put(index, 'index'));
  } catch {
    /* the cache still works without accurate LRU bookkeeping */
  }
}

async function evictIfNeeded() {
  try {
    const index = await readIndex();
    let total = Object.values(index).reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
    if (total <= MAX_BYTES) return;

    const oldestFirst = Object.entries(index).sort((a, b) => (a[1].usedAt ?? 0) - (b[1].usedAt ?? 0));
    for (const [trackId, entry] of oldestFirst) {
      if (total <= MAX_BYTES) break;
      await run(STORE, 'readwrite', (store) => store.delete(trackId));
      total -= entry.bytes ?? 0;
      delete index[trackId];
    }
    await run(META, 'readwrite', (store) => store.put(index, 'index'));
  } catch {
    /* nothing evicted; the next put will try again */
  }
}
