// Общие помощники для API «Поделиться днём» (Cloudflare Pages Functions, см. functions/api/share).
// Хранилище — R2, привязка с именем SHARES. Сервер хранит только зашифрованные пакеты:
// ключ к ним есть лишь в ссылке после «#», а эта часть ссылки на сервер не попадает.

export const MAX_BYTES = 25 * 1024 * 1024 + 8192;
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
