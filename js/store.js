// Tiny IndexedDB wrapper. Documents live on this device only.
// stores: docs (metadata), texts (page text per doc), files (original PDF bytes for the page view)

const DB_NAME = 'instant-search';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('texts')) db.createObjectStore('texts', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(stores, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(stores, mode);
        const out = fn(t);
        t.oncomplete = () => resolve(out && 'result' in out ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
      })
  );
}

export const store = {
  async allDocs() {
    return tx(['docs'], 'readonly', (t) => t.objectStore('docs').getAll());
  },
  async allTexts() {
    return tx(['texts'], 'readonly', (t) => t.objectStore('texts').getAll());
  },
  async addDoc(meta, pages, fileBytes) {
    return tx(['docs', 'texts', 'files'], 'readwrite', (t) => {
      t.objectStore('docs').put(meta);
      t.objectStore('texts').put({ id: meta.id, pages });
      if (fileBytes) t.objectStore('files').put({ id: meta.id, bytes: fileBytes });
    });
  },
  async updateDoc(meta) {
    return tx(['docs'], 'readwrite', (t) => t.objectStore('docs').put(meta));
  },
  async updateDocs(metas) {
    return tx(['docs'], 'readwrite', (t) => metas.forEach((m) => t.objectStore('docs').put(m)));
  },
  async file(id) {
    const rec = await tx(['files'], 'readonly', (t) => t.objectStore('files').get(id));
    return rec ? rec.bytes : null;
  },
  async deleteDoc(id) {
    return tx(['docs', 'texts', 'files'], 'readwrite', (t) => {
      t.objectStore('docs').delete(id);
      t.objectStore('texts').delete(id);
      t.objectStore('files').delete(id);
    });
  },
  async clear() {
    return tx(['docs', 'texts', 'files'], 'readwrite', (t) => {
      t.objectStore('docs').clear();
      t.objectStore('texts').clear();
      t.objectStore('files').clear();
    });
  },
};
