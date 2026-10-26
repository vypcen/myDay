// GET    /api/share/:id        — отдать пакет (одноразовая ссылка удаляется сразу после выдачи)
// GET    /api/share/:id?meta=1 — только статус для «Моих ссылок»: {expires, once}, {gone:true} или {missing:true}
// DELETE /api/share/:id        — отозвать (заголовок x-share-token)
import { ID_RE, json, fail, sha256, safeEqual, expired, storage } from "../../../lib/share-api.js";

const bin = body => new Response(body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });

export async function onRequestGet({ request, env, params }) {
  const st = storage(env);
  if (!st) return fail(503, "Хранилище ссылок не настроено");
  const id = String(params.id || "");
  if (new URL(request.url).searchParams.get("meta")) {
    // Статус всегда отвечает 200, чтобы не засорять консоль ошибками.
    if (!ID_RE.test(id)) return json({ gone: true });
    const m = await st.meta(id);
    if (!m) return json({ missing: true });
    if (m.gone) return json({ gone: true });
    if (expired(m)) { await st.bury(id, m); return json({ gone: true }); }
    return json({ expires: +m.exp, once: m.once === "1" });
  }
  if (!ID_RE.test(id)) return fail(404, "Нет такой ссылки");
  const obj = await st.get(id);
  if (!obj) return fail(404, "Нет такой ссылки");
  if (obj.meta.gone) return fail(410, "Ссылку отозвали или её уже открыли");
  if (expired(obj.meta)) { await st.bury(id, obj.meta); return fail(410, "Срок истёк"); }
  if (obj.meta.once === "1") await st.bury(id, obj.meta);
  return bin(obj.bytes);
}

export async function onRequestDelete({ request, env, params }) {
  const st = storage(env);
  if (!st) return fail(503, "Хранилище ссылок не настроено");
  const id = String(params.id || ""), token = request.headers.get("x-share-token") || "";
  if (!ID_RE.test(id) || !token) return fail(404, "Нет такой ссылки");
  const m = await st.meta(id);
  if (!m || m.gone) return new Response(null, { status: 204 });
  if (!safeEqual(await sha256(token), m.th || "")) return fail(403, "Нет прав отозвать эту ссылку");
  await st.bury(id, m);
  return new Response(null, { status: 204 });
}
