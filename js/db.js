// Локальное хранилище «Тетради дней». Всё лежит в IndexedDB браузера на устройстве пользователя.
// Хранилища: days (ключ — дата YYYY-MM-DD), files (ключ — id вложения, значение — {name,mime,size,created,blob}), kv (настройки и служебное).

const NAME = "tetrad";
const VERSION = 1;
export const STORES = ["days", "files", "kv"];

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(NAME, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of STORES) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
    };
    r.onsuccess = () => {
      const d = r.result;
      d.onversionchange = () => { d.close(); dbPromise = null; };
      resolve(d);
    };
    r.onerror = () => { dbPromise = null; reject(r.error); };
    r.onblocked = () => { dbPromise = null; reject(new Error("База занята другой вкладкой со старой версией приложения")); };
  });
  return dbPromise;
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

async function tx(stores, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, e => { try { t.abort(); } catch (_) {} reject(e); });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Транзакция прервана"));
  });
}

export const store = {
  get: (s, k) => tx([s], "readonly", t => req(t.objectStore(s).get(k))),
  put: (s, k, v) => tx([s], "readwrite", t => { t.objectStore(s).put(v, k); }),
  del: (s, k) => tx([s], "readwrite", t => { t.objectStore(s).delete(k); }),
  keys: s => tx([s], "readonly", t => req(t.objectStore(s).getAllKeys())),
  count: s => tx([s], "readonly", t => req(t.objectStore(s).count())),
  entries: s => tx([s], "readonly", t => {
    const os = t.objectStore(s);
    return Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(([k, v]) => k.map((x, i) => [x, v[i]]));
  }),
  // Несколько операций атомарно: [{s, k, v}] — запись, [{s, k, del:true}] — удаление, [{s, clear:true}] — очистка.
  bulk: ops => {
    const names = [...new Set(ops.map(o => o.s))];
    return tx(names, "readwrite", t => {
      for (const o of ops) {
        const os = t.objectStore(o.s);
        if (o.clear) os.clear();
        else if (o.del) os.delete(o.k);
        else os.put(o.v, o.k);
      }
    });
  }
};
