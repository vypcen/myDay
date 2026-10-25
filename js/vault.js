// Замок приложения и шифрование данных на устройстве.
//
// Схема ключей:
//   DEK — случайный ключ AES-256-GCM, которым шифруются данные. Живёт в памяти только пока приложение открыто.
//   KEK — ключ из PIN-кода или пароля (PBKDF2-SHA256, 600 000 итераций). Им «завёрнут» DEK в записи kv/vault.
//   Биометрия — необязательно: секрет из ключа доступа (WebAuthn, расширение PRF) через HKDF даёт второй KEK,
//   которым DEK завёрнут ещё раз. Face ID / Touch ID лишь открывает этот секрет, сам отпечаток или лицо
//   приложение не видит.
//
// Зашифрованная запись: {__enc:1, iv, ct} (дни, настройки) или {__enc:1, created, iv, ct, div, data:Blob} (файлы).
// AAD = "<хранилище>:<ключ>", поэтому запись нельзя незаметно подменить другой.
// Расшифровщик понимает и открытые записи: так включение и отключение замка не ломают данные,
// если приложение закроют посреди перешифрования.

import { raw, setCodec, store } from "./db.js";

const te = new TextEncoder(), td = new TextDecoder();
const ITER = 600000;
const SENSITIVE_KV = new Set(["habits", "templates"]);
const sensitive = (s, k) => s === "days" || s === "files" || (s === "kv" && SENSITIVE_KV.has(k));
const rnd = n => crypto.getRandomValues(new Uint8Array(n));
const aad = (s, k) => te.encode(s + ":" + k);

let DEK = null;

export class LockedError extends Error { constructor() { super("Приложение заблокировано"); this.code = "locked"; } }
export class WrongSecret extends Error { constructor() { super("Неверный PIN или пароль"); this.code = "wrong"; } }

/* ---------- кодек для db.js ---------- */

async function encrypt(s, k, v) {
  if (!DEK) throw new LockedError();
  if (s === "files") {
    const { blob, ...meta } = v;
    const iv = rnd(12), div = rnd(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(s, k) }, DEK, te.encode(JSON.stringify(meta)));
    const dt = await crypto.subtle.encrypt({ name: "AES-GCM", iv: div, additionalData: aad(s, k + "#data") }, DEK, await blob.arrayBuffer());
    return { __enc: 1, created: meta.created || Date.now(), iv, ct, div, data: new Blob([dt]) };
  }
  const iv = rnd(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(s, k) }, DEK, te.encode(JSON.stringify(v)));
  return { __enc: 1, iv, ct };
}
async function decrypt(s, k, v) {
  if (!v || !v.__enc) return v;
  if (!DEK) throw new LockedError();
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: v.iv, additionalData: aad(s, k) }, DEK, v.ct);
  const obj = JSON.parse(td.decode(pt));
  if (s === "files") {
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: v.div, additionalData: aad(s, k + "#data") }, DEK, await v.data.arrayBuffer());
    obj.blob = new Blob([data], { type: obj.mime || "application/octet-stream" });
  }
  return obj;
}
const activeCodec = { sensitive, enc: encrypt, dec: decrypt };

/* ---------- состояние ---------- */

export const record = () => raw.get("kv", "vault");
export async function isEnabled() { return !!(await record()); }
export const isUnlocked = () => !!DEK;

async function kekFrom(secret, salt, iter) {
  const base = await crypto.subtle.importKey("raw", te.encode(secret.normalize("NFC")), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
async function wrap(kek) { const iv = rnd(12); return { iv, wrapped: await crypto.subtle.wrapKey("raw", DEK, kek, { name: "AES-GCM", iv }) }; }
async function unwrap(kek, iv, wrapped) {
  return crypto.subtle.unwrapKey("raw", wrapped, kek, { name: "AES-GCM", iv }, { name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// Перешифровать всё содержимое текущим кодеком (включение) или без него (отключение). Пишем по одной записи,
// чтобы не держать в памяти все файлы сразу; расшифровщик понимает смешанное состояние.
async function rewriteAll(toEncrypted, onProgress) {
  const jobs = [];
  for (const s of ["days", "files", "kv"]) for (const k of await raw.keys(s)) if (sensitive(s, k)) jobs.push([s, k]);
  let i = 0;
  for (const [s, k] of jobs) {
    const v = await raw.get(s, k);
    if (v !== undefined && !!(v && v.__enc) !== toEncrypted) {
      const plain = await decrypt(s, k, v);
      await raw.put(s, k, toEncrypted ? await encrypt(s, k, plain) : plain);
    }
    onProgress && onProgress(++i / jobs.length);
  }
}

/* ---------- включение, вход, смена, отключение ---------- */

export async function enable(secret, kind, onProgress) {
  if (await record()) throw new Error("Замок уже включён");
  DEK = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const salt = rnd(16), kek = await kekFrom(secret, salt, ITER);
  const w = await wrap(kek);
  // Сначала запись с ключом, потом перешифрование: если прервать, данные откроются после входа.
  await raw.put("kv", "vault", { v: 1, kind, salt, iter: ITER, ...w, bio: null, autoLock: 5, created: Date.now(), migrating: true });
  setCodec(activeCodec);
  await rewriteAll(true, onProgress);
  const r = await record(); delete r.migrating; await raw.put("kv", "vault", r);
}

export async function unlock(secret) {
  const r = await record();
  if (!r) return true;
  const kek = await kekFrom(secret, r.salt, r.iter);
  try { DEK = await unwrap(kek, r.iv, r.wrapped); } catch (e) { throw new WrongSecret(); }
  setCodec(activeCodec);
  if (r.migrating) { await rewriteAll(true); const r2 = await record(); delete r2.migrating; await raw.put("kv", "vault", r2); }
  return true;
}

export function lock() {
  DEK = null;
  setCodec({ sensitive, enc: () => { throw new LockedError(); }, dec: (s, k, v) => { if (v && v.__enc) throw new LockedError(); return v; } });
}

export async function changeSecret(secret, kind) {
  if (!DEK) throw new LockedError();
  const r = await record();
  const salt = rnd(16), kek = await kekFrom(secret, salt, ITER);
  await raw.put("kv", "vault", { ...r, kind, salt, iter: ITER, ...(await wrap(kek)) });
}

export async function verify(secret) {
  const r = await record();
  try { await unwrap(await kekFrom(secret, r.salt, r.iter), r.iv, r.wrapped); return true; } catch (e) { return false; }
}

export async function disable(secret, onProgress) {
  if (!(await verify(secret))) throw new WrongSecret();
  await rewriteAll(false, onProgress);
  await store.del("kv", "vault");
  setCodec(null);
}

export async function setAutoLock(minutes) { const r = await record(); if (r) await raw.put("kv", "vault", { ...r, autoLock: minutes }); }

/* ---------- Face ID / Touch ID через WebAuthn PRF ---------- */

export async function bioAvailable() {
  try {
    if (!window.PublicKeyCredential || !PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return false;
    if (!(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())) return false;
    if (PublicKeyCredential.getClientCapabilities) {
      const c = await PublicKeyCredential.getClientCapabilities();
      if (c && c["extension:prf"] === false) return false;
    }
    return true;
  } catch (e) { return false; }
}

async function kekFromPrf(out, salt) {
  const base = await crypto.subtle.importKey("raw", out, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: te.encode("tetrad-vault-bio") }, base, { name: "AES-GCM", length: 256 }, false, ["wrapKey", "unwrapKey"]);
}
async function assertPrf(credId, salt) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rnd(32), rpId: location.hostname, timeout: 60000, userVerification: "required",
    allowCredentials: [{ type: "public-key", id: credId }],
    extensions: { prf: { eval: { first: salt } } }
  } });
  const out = a && a.getClientExtensionResults().prf?.results?.first;
  if (!out) throw Object.assign(new Error("Это устройство не поддерживает вход по биометрии для веб-приложений"), { code: "unsupported" });
  return out;
}

export async function enableBio() {
  if (!DEK) throw new LockedError();
  const salt = rnd(32);
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rnd(32), timeout: 60000,
    rp: { name: "Тетрадь дней", id: location.hostname },
    user: { id: rnd(16), name: "Тетрадь дней", displayName: "Тетрадь дней" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: "platform", residentKey: "preferred", userVerification: "required" },
    extensions: { prf: { eval: { first: salt } } }
  } });
  const ext = cred.getClientExtensionResults().prf;
  if (ext && ext.enabled === false) throw Object.assign(new Error("Это устройство не поддерживает вход по биометрии для веб-приложений"), { code: "unsupported" });
  const credId = new Uint8Array(cred.rawId);
  const out = ext?.results?.first || await assertPrf(credId, salt);
  const w = await wrap(await kekFromPrf(out, salt));
  const r = await record();
  await raw.put("kv", "vault", { ...r, bio: { credId, salt, ...w } });
}

export async function unlockBio() {
  const r = await record();
  if (!r || !r.bio) throw new Error("Вход по биометрии не настроен");
  const out = await assertPrf(r.bio.credId, r.bio.salt);
  try { DEK = await unwrap(await kekFromPrf(out, r.bio.salt), r.bio.iv, r.bio.wrapped); } catch (e) { throw new WrongSecret(); }
  setCodec(activeCodec);
  return true;
}

export async function disableBio() { const r = await record(); if (r) await raw.put("kv", "vault", { ...r, bio: null }); }
