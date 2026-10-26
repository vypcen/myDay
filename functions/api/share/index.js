// POST /api/share — сохранить зашифрованный пакет. Заголовки: x-share-days (1|7|30), x-share-once (0|1).
// Ответ: {id, token, expires}. token нужен только отправителю — чтобы отозвать ссылку.
// GET /api/share — проверка настройки: {ok:true, storage:true|false, kind}. Откройте в браузере, чтобы убедиться, что всё развернуто.
import { MAX_BYTES, DAYS, json, fail, randomId, sha256, looksLikePackage, storage } from "../../../lib/share-api.js";

export async function onRequestPost({ request, env }) {
  const st = storage(env);
  if (!st) return fail(503, "Хранилище ссылок не настроено");
  const len = +request.headers.get("content-length") || 0;
  if (len > Math.min(MAX_BYTES, st.max)) return fail(413, "Слишком большой пакет");
  const days = +request.headers.get("x-share-days");
  if (!DAYS.includes(days)) return fail(400, "Неверный срок");
  const once = request.headers.get("x-share-once") === "1";
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > Math.min(MAX_BYTES, st.max)) return fail(413, "Слишком большой пакет");
  if (!looksLikePackage(bytes)) return fail(400, "Это не пакет myDay");
  const id = randomId(16), token = randomId(24), exp = Date.now() + days * 864e5;
  await st.put(id, bytes, { exp: String(exp), once: once ? "1" : "0", th: await sha256(token) });
  return json({ id, token, expires: exp }, 201);
}

export async function onRequestGet({ env }) {
  const st = storage(env);
  return json({ ok: true, storage: !!st, kind: st ? st.kind : null });
}
