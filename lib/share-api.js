// Общие помощники для API «Поделиться днём» (Cloudflare Pages Functions и worker/index.js).
// Хранилище — Workers KV (привязка SHARES_KV, бесплатно, без подписок) или R2 (привязка SHARES).
// Сервер хранит только зашифрованные пакеты: ключ есть лишь в ссылке после «#», на сервер он не попадает.

export const MAX_BYTES = 25 * 1024 * 1024 + 8192;
export const KV_MAX = 25 * 1024 * 1024; // предел значения в KV
export const DAYS = [1, 7, 30];
export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
const MAGIC = "MYDAYSH1";

export const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }
});
export const fail = (status, error) => json({ error }, status);

const b64url = u => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomId = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function sha256(s) { return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))); }
export function looksLikePackage(bytes) { if (bytes.length < 12) return false; for (let i = 0; i < 8; i++) if (bytes[i] !== MAGIC.charCodeAt(i)) return false; return true; }
export function safeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; }
export const expired = meta => !meta || !meta.exp || Date.now() > +meta.exp;

// Единый интерфейс хранилища: put / get / meta / del / bury. meta = {exp, once, th} или {gone:"1"}.
// bury — вместо удаления оставить «надгробие» до конца срока: так получатель отличает
// «ссылку отозвали или уже открыли» (410) от «ссылка только что создана и ещё не дошла до этого региона» (404, в KV до минуты).
export function storage(env) {
  if (env.SHARES_KV) {
    const kv = env.SHARES_KV;
    return {
      kind: "kv", max: KV_MAX,
      // KV сам удаляет ключ по истечении срока (+1 час запаса).
      put: (id, bytes, meta) => kv.put(id, bytes, { expirationTtl: Math.ceil((+meta.exp - Date.now()) / 1000) + 3600, metadata: meta }),
      get: async id => { const r = await kv.getWithMetadata(id, { type: "arrayBuffer" }); return r && r.value ? { bytes: r.value, meta: r.metadata || {} } : null; },
      meta: async id => { const l = await kv.list({ prefix: id, limit: 1 }); const k = l.keys[0]; return k && k.name === id ? (k.metadata || {}) : null; },
      del: id => kv.delete(id),
      bury: (id, meta) => kv.put(id, new Uint8Array(1), { expirationTtl: Math.max(3600, Math.ceil(((+meta.exp || 0) - Date.now()) / 1000) + 3600), metadata: { gone: "1", exp: String(meta.exp || Date.now()) } })
    };
  }
  if (env.SHARES) {
    const r2 = env.SHARES;
    return {
      kind: "r2", max: MAX_BYTES,
      put: (id, bytes, meta) => r2.put(id, bytes, { httpMetadata: { contentType: "application/octet-stream" }, customMetadata: meta }),
      get: async id => { const o = await r2.get(id); return o ? { bytes: await o.arrayBuffer(), meta: o.customMetadata || {} } : null; },
      meta: async id => { const h = await r2.head(id); return h ? (h.customMetadata || {}) : null; },
      del: id => r2.delete(id),
      bury: (id, meta) => r2.put(id, new Uint8Array(1), { customMetadata: { gone: "1", exp: String(meta.exp || Date.now()) } })
    };
  }
  return null;
}
