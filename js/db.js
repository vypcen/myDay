// Локальное хранилище myDay. Всё лежит в IndexedDB браузера на устройстве пользователя.
// Хранилища: days (ключ — дата YYYY-MM-DD), files (ключ — id вложения, значение — {name,mime,size,created,blob}), kv (настройки и служебное).
//
// Если включён замок приложения, записи проходят через «кодек» (см. vault.js): содержимое дней, файлов
// и чувствительных настроек шифруется до записи в базу и расшифровывается после чтения.
// Шифрование асинхронное, поэтому оно выполняется до открытия транзакции и после её завершения —
// транзакции IndexedDB закрываются сами, если внутри них ждать что-то постороннее.

const NAME = "tetrad"; // внутреннее имя базы со времён «Тетради дней» — не менять, иначе данные пользователей потеряются
const VERSION = 1;
export const STORES = ["days", "files", "kv"];

let dbPromise = null;
let codec = null; // {sensitive(s,k), enc(s,k,v), dec(s,k,v)} | null

export function setCodec(c) { codec = c; }

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

export async function deleteEverything() {
  if (dbPromise) { try { (await dbPromise).close(); } catch (e) {} dbPromise = null; }
  await new Promise((res, rej) => { const r = indexedDB.deleteDatabase(NAME); r.onsuccess = res; r.onerror = () => rej(r.error); r.onblocked = res; });
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

const needs = (s, k) => codec && codec.sensitive(s, k);
const enc = (s, k, v) => needs(s, k) && v !== undefined ? codec.enc(s, k, v) : v;
const dec = (s, k, v) => needs(s, k) && v !== undefined ? codec.dec(s, k, v) : v;

// Прямой доступ без кодека: служебные проверки, перешифрование при включении и отключении замка.
export const raw = {
  get: (s, k) => tx([s], "readonly", t => req(t.objectStore(s).get(k))),
  put: (s, k, v) => tx([s], "readwrite", t => { t.objectStore(s).put(v, k); }),
  keys: s => tx([s], "readonly", t => req(t.objectStore(s).getAllKeys())),
  entries: s => tx([s], "readonly", t => {
    const os = t.objectStore(s);
    return Promise.all([req(os.getAllKeys()), req(os.getAll())]).then(([k, v]) => k.map((x, i) => [x, v[i]]));
  })
};

export const store = {
  get: async (s, k) => dec(s, k, await raw.get(s, k)),
  put: async (s, k, v) => { const e = await enc(s, k, v); return tx([s], "readwrite", t => { t.objectStore(s).put(e, k); }); },
  del: (s, k) => tx([s], "readwrite", t => { t.objectStore(s).delete(k); }),
  keys: s => raw.keys(s),
  count: s => tx([s], "readonly", t => req(t.objectStore(s).count())),
  entries: async s => {
    const list = await raw.entries(s);
    const out = [];
    for (const [k, v] of list) out.push([k, await dec(s, k, v)]);
    return out;
  },
  // Несколько операций атомарно: [{s, k, v}] — запись, [{s, k, del:true}] — удаление, [{s, clear:true}] — очистка.
  bulk: async ops => {
    const prepared = [];
    for (const o of ops) prepared.push(o.clear || o.del ? o : { ...o, v: await enc(o.s, o.k, o.v) });
    const names = [...new Set(prepared.map(o => o.s))];
    return tx(names, "readwrite", t => {
      for (const o of prepared) {
        const os = t.objectStore(o.s);
        if (o.clear) os.clear();
        else if (o.del) os.delete(o.k);
        else os.put(o.v, o.k);
      }
    });
  }
};
