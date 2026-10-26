// «Поделиться днём»: зашифрованная копия дня — ссылкой или файлом.
//
// Пакет (.mydayshare и тело ссылки):
//   "MYDAYSH1" (8 байт) | длина заголовка (u32 BE) | заголовок JSON | шифротекст AES-256-GCM
//   заголовок: {v:1, iv, pw?:{salt, iter}, key?}  — key есть только в файле без пароля
//   открытый текст: u32 BE длина манифеста | манифест JSON | байты вложений подряд
//   AAD = байты заголовка.
// Ключ ссылки — 32 случайных байта, живёт только в части ссылки после «#», которую браузер не отправляет на сервер.
// С паролем ключ шифрования = HKDF(ключ ссылки ‖ PBKDF2(пароль)): без пароля не открыть даже с полной ссылкой.

const MAGIC = new TextEncoder().encode("MYDAYSH1");
const te = new TextEncoder(), td = new TextDecoder();
export const MAX_BYTES = 25 * 1024 * 1024;
const PW_ITER = 300000;

const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const u32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; };
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const b64url = u => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64url = s => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));

export class ShareError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

async function contentKey(linkKey, pw) {
  let material = linkKey;
  if (pw) {
    const base = await crypto.subtle.importKey("raw", te.encode(pw.password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: pw.salt, iterations: pw.iter }, base, 256));
    material = cat(linkKey, bits);
  }
  const h = await crypto.subtle.importKey("raw", material, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode("myday-share-v1") }, h, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

// manifest: {date, title, blocks, files:[{id,name,mime,size}], created}; blobs: {id: Blob}
export async function pack(manifest, blobs, { password = "", embedKey = false } = {}) {
  const linkKey = rnd(32), iv = rnd(12);
  const header = { v: 1, iv: b64(iv) };
  let pw = null;
  if (password) { pw = { salt: rnd(16), iter: PW_ITER, password }; header.pw = { salt: b64(pw.salt), iter: PW_ITER }; }
  if (embedKey) header.key = b64(linkKey);
  const m = te.encode(JSON.stringify({ app: "myday-share", v: 1, ...manifest }));
  const parts = [u32(m.length), m];
  for (const f of manifest.files) parts.push(new Uint8Array(await blobs[f.id].arrayBuffer()));
  const plain = cat(...parts);
  const hb = te.encode(JSON.stringify(header));
  const head = cat(MAGIC, u32(hb.length), hb);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: head }, await contentKey(linkKey, pw), plain));
  const out = cat(head, ct);
  if (out.length > MAX_BYTES) throw new ShareError("too_large", "Получилось больше 25 МБ. Отправьте без вложений или выберите меньше элементов");
  return { bytes: out, linkKey };
}

export function readHeader(bytes) {
  if (bytes.length < 12 || MAGIC.some((b, i) => bytes[i] !== b)) throw new ShareError("not_share", "Это не присланный день myDay");
  const hl = new DataView(bytes.buffer, bytes.byteOffset).getUint32(8);
  if (hl > 4096 || 12 + hl > bytes.length) throw new ShareError("corrupt", "Файл повреждён");
  let h; try { h = JSON.parse(td.decode(bytes.subarray(12, 12 + hl))); } catch (e) { throw new ShareError("corrupt", "Файл повреждён"); }
  if (h.v !== 1) throw new ShareError("version", "День отправлен более новой версией myDay. Обновите приложение");
  return { header: h, head: bytes.subarray(0, 12 + hl), body: bytes.subarray(12 + hl) };
}
export const needsPassword = bytes => !!readHeader(bytes).header.pw;

export async function unpack(bytes, linkKey, password = "") {
  const { header, head, body } = readHeader(bytes);
  const key = linkKey || (header.key && unb64(header.key));
  if (!key) throw new ShareError("no_key", "В ссылке не хватает ключа — попросите отправить её заново");
  if (header.pw && !password) throw new ShareError("password", "Нужен пароль");
  const pw = header.pw ? { salt: unb64(header.pw.salt), iter: header.pw.iter, password } : null;
  let plain;
  try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(header.iv), additionalData: head }, await contentKey(key, pw), body)); }
  catch (e) { throw new ShareError(header.pw ? "password" : "corrupt", header.pw ? "Неверный пароль" : "Не удалось открыть: ссылка неполная или данные повреждены"); }
  const ml = new DataView(plain.buffer).getUint32(0);
  let manifest; try { manifest = JSON.parse(td.decode(plain.subarray(4, 4 + ml))); } catch (e) { throw new ShareError("corrupt", "Данные повреждены"); }
  if (manifest.app !== "myday-share") throw new ShareError("corrupt", "Данные повреждены");
  const blobs = {}; let p = 4 + ml;
  for (const f of manifest.files) { blobs[f.id] = new Blob([plain.subarray(p, p + f.size)], { type: f.mime || "application/octet-stream" }); p += f.size; }
  if (p !== plain.length) throw new ShareError("corrupt", "Данные повреждены");
  return { manifest, blobs };
}

/* ---------- сервер (Cloudflare Pages Functions + R2, см. functions/api/share) ---------- */

async function api(method, path, body, headers = {}) {
  let r;
  try { r = await fetch(path, { method, body, headers, cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" }); }
  catch (e) { throw new ShareError("offline", "Нет связи с сервером. Проверьте интернет или отправьте файлом"); }
  const isJson = /json/.test(r.headers.get("content-type") || "");
  // Ответ не от наших функций (HTML-страница 404/405 или index.html) — серверная часть ссылок не развернута.
  if (!isJson && (!r.ok || method !== "GET" || /text\/html/.test(r.headers.get("content-type") || "")))
    throw new ShareError("no_api", "Сервер ссылок не отвечает: на хостинге не развернуты функции myDay (папка functions). Пока отправьте день файлом — инструкция по настройке в README, раздел «Поделиться днём»");
  if (r.ok) return r;
  let msg = ""; try { msg = (await r.json()).error || ""; } catch (e) {}
  const code = r.status === 404 ? "notfound" : r.status === 410 ? "gone" : r.status === 413 ? "too_large" : r.status === 429 ? "rate" : r.status === 503 ? "not_configured" : "server";
  const text = { gone: "Ссылка больше не работает: её отозвали, она уже была открыта или истёк срок", notfound: "Ссылка не найдена: она неполная или срок её действия давно истёк",
    too_large: "Слишком большой день для ссылки (до 25 МБ)", rate: "Слишком много ссылок за сутки. Попробуйте завтра или отправьте файлом",
    not_configured: "Ссылки пока не настроены на сервере. Отправьте день файлом" }[code];
  throw new ShareError(code, text || msg || "Ошибка сервера (" + r.status + ")");
}
export async function upload(bytes, { days, once }) {
  const r = await api("POST", "/api/share", bytes, { "content-type": "application/octet-stream", "x-share-days": String(days), "x-share-once": once ? "1" : "0" });
  return r.json(); // {id, token, expires}
}
export async function download(id) { return new Uint8Array(await (await api("GET", "/api/share/" + encodeURIComponent(id))).arrayBuffer()); }
export async function status(id) { try { const s = await (await api("GET", "/api/share/" + encodeURIComponent(id) + "?meta=1")).json(); if (s.missing) s.gone = true; return s; } catch (e) { return { gone: e.code === "gone" || e.code === "notfound", error: e.code }; } }
export async function revoke(id, token) { await api("DELETE", "/api/share/" + encodeURIComponent(id), null, { "x-share-token": token }); }

// Третья часть ссылки — время создания (не секрет): свежую ссылку получатель подождёт, пока она разойдётся
// по серверам Cloudflare (в KV новая запись доходит до других регионов за время до минуты).
export const linkFor = (id, key, created = Date.now()) => location.origin + location.pathname + "#share=" + id + "." + b64url(key) + "." + Math.floor(created / 1000).toString(36);
export function parseLink(hash) {
  const m = /^#share=([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{40,64})(?:\.([0-9a-z]{1,10}))?$/.exec(hash || "");
  return m ? { id: m[1], key: unb64url(m[2]), created: m[3] ? parseInt(m[3], 36) * 1000 : 0 } : null;
}
