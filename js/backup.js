// Зашифрованные бэкапы «Тетради дней».
//
// Формат файла .tetrad (версия 1):
//   "TETRADBK" (8 байт) | версия (1 байт) | длина заголовка (u32 BE) | заголовок JSON
//   затем блоки: флаг (1 байт: 0 — обычный, 1 — последний) | длина (u32 BE) | шифротекст AES-256-GCM
// Заголовок открыт и содержит только параметры шифрования: {kdf, iter, salt, np}. Даты, имена файлов,
// количество дней — всё внутри шифротекста.
// Ключ: PBKDF2-SHA256 из пароля и соли. Nonce блока = np (8 случайных байт) + номер блока (u32 BE).
// AAD блока = SHA-256(заголовок) | номер блока | флаг — подмена, перестановка и обрезка блоков обнаруживаются.
// Открытый поток внутри: u32 BE длина манифеста | манифест JSON | байты вложений подряд в порядке манифеста.

import { store } from "./db.js";

const MAGIC = new TextEncoder().encode("TETRADBK");
const FORMAT = 1;
const CHUNK = 4 * 1024 * 1024;
export const KDF_ITER = 600000;

const te = new TextEncoder(), td = new TextDecoder();
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

export async function deriveKey(password, salt, iter = KDF_ITER) {
  const base = await crypto.subtle.importKey("raw", te.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// Ключ бэкапа хранится на устройстве как неизвлекаемый CryptoKey — его нельзя прочитать даже скриптом,
// но им можно шифровать автобэкапы без повторного ввода пароля.
export async function setBackupPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(password, salt);
  const rec = { key, salt, iter: KDF_ITER, setAt: Date.now() };
  await store.put("kv", "backupKey", rec);
  return rec;
}
export const getBackupKey = () => store.get("kv", "backupKey");

/* ---------- запись ---------- */

async function* plainStream(snapshot) {
  const files = snapshot.files;
  const manifest = {
    app: "tetrad", format: FORMAT, created: new Date().toISOString(),
    days: snapshot.days, prefs: snapshot.prefs, kv: snapshot.kv || {},
    files: files.map(f => ({ id: f.id, name: f.name, mime: f.mime, size: f.blob.size, created: f.created }))
  };
  const m = te.encode(JSON.stringify(manifest));
  yield cat(u32(m.length), m);
  for (const f of files) {
    for (let p = 0; p < f.blob.size; p += CHUNK) yield new Uint8Array(await f.blob.slice(p, p + CHUNK).arrayBuffer());
  }
}

export async function snapshot(prefs) {
  const kv = {};
  for (const k of ["habits", "templates"]) { const v = await store.get("kv", k); if (v !== undefined) kv[k] = v; }
  const days = Object.fromEntries((await store.entries("days")).filter(([, d]) => d && (d.blocks?.length || d.title)));
  const used = new Set();
  for (const d of Object.values(days)) for (const b of d.blocks || []) if (b.fid) used.add(b.fid);
  const files = [];
  for (const [id, f] of await store.entries("files")) if (used.has(id) && f?.blob) files.push({ id, ...f });
  return { days, prefs, files, kv };
}

// write(Uint8Array) вызывается по порядку; onProgress(доля 0..1).
export async function writeBackup(snap, keyRec, write, onProgress) {
  const np = crypto.getRandomValues(new Uint8Array(8));
  const header = te.encode(JSON.stringify({ kdf: "PBKDF2-SHA256", iter: keyRec.iter, salt: b64(new Uint8Array(keyRec.salt)), np: b64(np) }));
  const head = cat(MAGIC, new Uint8Array([FORMAT]), u32(header.length), header);
  const hh = new Uint8Array(await crypto.subtle.digest("SHA-256", head));
  await write(head);
  const total = snap.files.reduce((n, f) => n + f.blob.size, 0) + 1;
  let done = 0, idx = 0, buf = [], bufLen = 0, pending = null;

  const seal = async (plain, last) => {
    const iv = cat(np, u32(idx));
    const aad = cat(hh, u32(idx), new Uint8Array([last ? 1 : 0]));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, keyRec.key, plain));
    await write(cat(new Uint8Array([last ? 1 : 0]), u32(ct.length), ct));
    idx++;
  };
  const take = () => { const c = cat(...buf); buf = []; bufLen = 0; return c; };

  for await (let part of plainStream(snap)) {
    done += part.length;
    while (part.length) {
      const room = CHUNK - bufLen, piece = part.subarray(0, room);
      buf.push(piece); bufLen += piece.length; part = part.subarray(piece.length);
      if (bufLen === CHUNK) { if (pending) await seal(pending, false); pending = take(); }
    }
    onProgress && onProgress(Math.min(.99, done / total));
  }
  if (bufLen) { if (pending) await seal(pending, false); pending = take(); }
  await seal(pending, true);
  onProgress && onProgress(1);
  return { days: Object.keys(snap.days).length, files: snap.files.length, bytes: total - 1 };
}

export async function backupToBlob(snap, keyRec, onProgress) {
  const parts = [];
  const info = await writeBackup(snap, keyRec, async u => { parts.push(u); }, onProgress);
  return { blob: new Blob(parts, { type: "application/octet-stream" }), info };
}

/* ---------- чтение ---------- */

export class BackupError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function readHeader(file) {
  const first = new Uint8Array(await file.slice(0, 13).arrayBuffer());
  if (first.length < 13 || MAGIC.some((b, i) => first[i] !== b)) throw new BackupError("not_backup", "Это не файл бэкапа «Тетради дней»");
  if (first[8] !== FORMAT) throw new BackupError("version", "Бэкап сделан более новой версией приложения. Обновите приложение");
  const hlen = new DataView(first.buffer).getUint32(9);
  if (hlen > 4096) throw new BackupError("corrupt", "Файл бэкапа повреждён");
  const hdrBytes = new Uint8Array(await file.slice(13, 13 + hlen).arrayBuffer());
  let h; try { h = JSON.parse(td.decode(hdrBytes)); } catch (e) { throw new BackupError("corrupt", "Файл бэкапа повреждён"); }
  const head = cat(first, hdrBytes);
  return { h, head, offset: 13 + hlen, hh: new Uint8Array(await crypto.subtle.digest("SHA-256", head)) };
}

async function* plainChunks(file, key, hdr) {
  const np = unb64(hdr.h.np);
  let off = hdr.offset, idx = 0, sawLast = false;
  while (off < file.size) {
    if (sawLast) throw new BackupError("corrupt", "Файл бэкапа повреждён: лишние данные в конце");
    const meta = new Uint8Array(await file.slice(off, off + 5).arrayBuffer());
    if (meta.length < 5) throw new BackupError("corrupt", "Файл бэкапа обрезан");
    const flag = meta[0], len = new DataView(meta.buffer).getUint32(1);
    if (flag > 1 || len > CHUNK + 64) throw new BackupError("corrupt", "Файл бэкапа повреждён");
    const ct = await file.slice(off + 5, off + 5 + len).arrayBuffer();
    if (ct.byteLength < len) throw new BackupError("corrupt", "Файл бэкапа обрезан");
    let pt;
    try {
      pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: cat(np, u32(idx)), additionalData: cat(hdr.hh, u32(idx), new Uint8Array([flag])) }, key, ct));
    } catch (e) {
      throw idx === 0 ? new BackupError("password", "Неверный пароль") : new BackupError("corrupt", "Файл бэкапа повреждён");
    }
    yield { pt, progress: (off + 5 + len) / file.size };
    off += 5 + len; idx++; sawLast = flag === 1;
  }
  if (!sawLast) throw new BackupError("corrupt", "Файл бэкапа обрезан: нет завершающего блока");
}

// Читает бэкап. withFiles=false — только манифест (для предпросмотра).
export async function readBackup(file, password, { withFiles = true, onProgress } = {}) {
  const hdr = await readHeader(file);
  if (hdr.h.kdf !== "PBKDF2-SHA256") throw new BackupError("version", "Неизвестный способ шифрования");
  const key = await deriveKey(password, unb64(hdr.h.salt), hdr.h.iter);
  let acc = new Uint8Array(0), manifest = null, fileIdx = 0, parts = [], got = 0;
  const blobs = {};
  for await (const { pt, progress } of plainChunks(file, key, hdr)) {
    let data = pt;
    if (!manifest) {
      acc = cat(acc, data);
      if (acc.length < 4) continue;
      const mlen = new DataView(acc.buffer).getUint32(0);
      if (acc.length < 4 + mlen) continue;
      try { manifest = JSON.parse(td.decode(acc.subarray(4, 4 + mlen))); } catch (e) { throw new BackupError("corrupt", "Файл бэкапа повреждён"); }
      if (manifest.app !== "tetrad") throw new BackupError("corrupt", "Файл бэкапа повреждён");
      if (!withFiles) return { manifest };
      data = acc.subarray(4 + mlen); acc = null;
    }
    while (data.length) {
      const f = manifest.files[fileIdx];
      if (!f) throw new BackupError("corrupt", "Файл бэкапа повреждён: лишние данные");
      const need = f.size - got, piece = data.subarray(0, need);
      parts.push(piece.slice()); got += piece.length; data = data.subarray(piece.length);
      if (got === f.size) { blobs[f.id] = new Blob(parts, { type: f.mime || "application/octet-stream" }); parts = []; got = 0; fileIdx++; }
    }
    onProgress && onProgress(progress);
    // пустые файлы
    while (manifest.files[fileIdx] && manifest.files[fileIdx].size === 0) { const f = manifest.files[fileIdx++]; blobs[f.id] = new Blob([], { type: f.mime }); }
  }
  if (!manifest) throw new BackupError("corrupt", "Файл бэкапа повреждён");
  while (manifest.files[fileIdx] && manifest.files[fileIdx].size === 0) { const f = manifest.files[fileIdx++]; blobs[f.id] = new Blob([], { type: f.mime }); }
  if (fileIdx !== manifest.files.length) throw new BackupError("corrupt", "В бэкапе не хватает вложений");
  return { manifest, blobs };
}

// mode: "merge" — дни из бэкапа заменяют локальные, только если они новее; "replace" — всё как в бэкапе.
export async function restore({ manifest, blobs }, mode) {
  const ops = [];
  let daysIn = 0, filesIn = 0;
  if (mode === "replace") { ops.push({ s: "days", clear: true }, { s: "files", clear: true }); }
  const local = mode === "merge" ? Object.fromEntries(await store.entries("days")) : {};
  const haveFiles = mode === "merge" ? new Set(await store.keys("files")) : new Set();
  const meta = Object.fromEntries(manifest.files.map(f => [f.id, f]));
  for (const [k, d] of Object.entries(manifest.days)) {
    const cur = local[k];
    if (mode === "replace" || !cur || (d.updatedAt || 0) > (cur.updatedAt || 0)) { ops.push({ s: "days", k, v: d }); daysIn++; }
  }
  for (const [id, blob] of Object.entries(blobs)) {
    if (haveFiles.has(id)) continue;
    const m = meta[id];
    ops.push({ s: "files", k: id, v: { name: m.name, mime: m.mime, size: blob.size, created: m.created, blob } });
    filesIn++;
  }
  // Привычки и свои шаблоны: при замене — как в бэкапе, при объединении — добавить недостающие по id.
  for (const k of ["habits", "templates"]) {
    const inc = manifest.kv && manifest.kv[k];
    if (!Array.isArray(inc)) { if (mode === "replace") ops.push({ s: "kv", k, del: true }); continue; }
    if (mode === "replace") { ops.push({ s: "kv", k, v: inc }); continue; }
    const cur = (await store.get("kv", k)) || [], ids = new Set(cur.map(x => x.id));
    ops.push({ s: "kv", k, v: [...cur, ...inc.filter(x => !ids.has(x.id))] });
  }
  await store.bulk(ops);
  return { daysIn, filesIn };
}

/* ---------- автобэкап в папку (File System Access API) ---------- */

export const folderSupported = () => typeof window.showDirectoryPicker === "function";

export async function pickFolder() {
  const dir = await window.showDirectoryPicker({ id: "tetrad-backups", mode: "readwrite", startIn: "documents" });
  await store.put("kv", "backupDir", dir);
  return dir;
}
export async function folderState(ask) {
  const dir = await store.get("kv", "backupDir");
  if (!dir) return { dir: null, perm: "none" };
  let perm = "prompt";
  try {
    perm = await dir.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && ask) perm = await dir.requestPermission({ mode: "readwrite" });
  } catch (e) { perm = "denied"; }
  return { dir, perm };
}

const stamp = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0") +
  "_" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0");
const NAME_RE = /^tetrad-(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.tetrad$/;

export async function backupToFolder(dir, snap, keyRec, onProgress) {
  const name = "tetrad-" + stamp(new Date()) + ".tetrad";
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  let info;
  try { info = await writeBackup(snap, keyRec, u => w.write(u), onProgress); await w.close(); }
  catch (e) { try { await w.abort(); } catch (_) {} try { await dir.removeEntry(name); } catch (_) {} throw e; }
  const removed = await rotate(dir);
  return { name, info, removed };
}

// Ротация «дед — отец — сын»: все копии за последние 2 дня, затем по одной на день за 14 дней,
// по одной на неделю за 8 недель и по одной на месяц за 24 месяца. Так случайная порча
// или удаление данных не вытеснит старые хорошие копии сразу.
export function planRetention(names, now = new Date()) {
  const items = names.map(n => { const m = NAME_RE.exec(n); return m && { n, d: new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) }; })
    .filter(Boolean).sort((a, b) => b.d - a.d);
  const keep = new Set(), seen = new Set(), DAY = 864e5;
  const wk = d => { const t = new Date(d); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return t.toDateString(); };
  for (const it of items) {
    const age = (now - it.d) / DAY;
    if (age < 2) { keep.add(it.n); continue; }
    const buckets = [];
    if (age < 14) buckets.push("d" + it.d.toDateString());
    if (age < 56) buckets.push("w" + wk(it.d));
    if (age < 730) buckets.push("m" + it.d.getFullYear() + "-" + it.d.getMonth());
    for (const b of buckets) if (!seen.has(b)) { seen.add(b); keep.add(it.n); }
  }
  if (items.length && !keep.size) keep.add(items[0].n);
  return items.filter(i => !keep.has(i.n)).map(i => i.n);
}
async function rotate(dir) {
  const names = [];
  for await (const [n, h] of dir.entries()) if (h.kind === "file") names.push(n);
  const del = planRetention(names);
  for (const n of del) { try { await dir.removeEntry(n); } catch (e) {} }
  return del.length;
}
export async function listFolderBackups(dir) {
  const out = [];
  for await (const [n, h] of dir.entries()) if (h.kind === "file" && NAME_RE.test(n)) out.push(n);
  return out.sort().reverse();
}
