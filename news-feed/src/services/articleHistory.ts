export const HISTORY_STORE_MAX = 500;

export interface HistoryEntry {
  id: string;
  title: string;
  url: string;
  source: string;
  sourceId: string;
  publishedAt: string;
  interactedAt: number;
}

/** Pure: keep the `max` most-recent entries by interactedAt. */
export function evictOldest(entries: HistoryEntry[], max: number): HistoryEntry[] {
  if (entries.length <= max) return entries;
  return [...entries].sort((a, b) => b.interactedAt - a.interactedAt).slice(0, max);
}

// ── IndexedDB layer ──────────────────────────────────────────────────────────

const DB_NAME = 'article-history';
const DB_VERSION = 1;
const ENTRIES_STORE = 'entries';
const META_STORE = 'meta';
const BACKFILLED_KEY = 'backfilled';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

/**
 * Upsert entries and evict the oldest past HISTORY_STORE_MAX in a single
 * readwrite transaction — `put` on keyPath `id` is the upsert, and the IDB
 * transaction serializes concurrent writers (no read-modify-write window).
 */
function putAndSweep(db: IDBDatabase, entries: HistoryEntry[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ENTRIES_STORE, 'readwrite');
    const store = tx.objectStore(ENTRIES_STORE);
    for (const e of entries) store.put(e);
    const countReq = store.count();
    countReq.onsuccess = () => {
      if (countReq.result <= HISTORY_STORE_MAX) return;
      const allReq = store.getAll();
      allReq.onsuccess = () => {
        const all = allReq.result as HistoryEntry[];
        const keep = new Set(evictOldest(all, HISTORY_STORE_MAX).map(e => e.id));
        for (const e of all) {
          if (!keep.has(e.id)) store.delete(e.id);
        }
      };
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function writeHistoryEntry(entry: HistoryEntry): Promise<void> {
  const db = await openDb();
  return putAndSweep(db, [entry]);
}

export async function writeHistoryEntries(entries: HistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openDb();
  return putAndSweep(db, entries);
}

export function readHistoryEntries(): Promise<HistoryEntry[]> {
  return openDb().then(db => new Promise<HistoryEntry[]>((resolve, reject) => {
    const tx = db.transaction(ENTRIES_STORE, 'readonly');
    const req = tx.objectStore(ENTRIES_STORE).getAll();
    req.onsuccess = () => {
      const entries = (req.result as HistoryEntry[]).sort((a, b) => b.interactedAt - a.interactedAt);
      resolve(entries);
    };
    req.onerror = () => reject(req.error);
  }));
}

export function isBackfilled(): Promise<boolean> {
  return openDb().then(db => new Promise<boolean>((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).get(BACKFILLED_KEY);
    req.onsuccess = () => resolve(req.result === true);
    req.onerror = () => reject(req.error);
  }));
}

export function markBackfilled(): Promise<void> {
  return openDb().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(true, BACKFILLED_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

export async function resetHistoryStoreForTest(): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([ENTRIES_STORE, META_STORE], 'readwrite');
    tx.objectStore(ENTRIES_STORE).clear();
    tx.objectStore(META_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
