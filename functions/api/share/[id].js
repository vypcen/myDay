// GET    /api/share/:id        — отдать пакет (одноразовая ссылка удаляется сразу после выдачи)
// GET    /api/share/:id?meta=1 — только статус для «Моих ссылок»: {expires, once} или {gone:true}
// DELETE /api/share/:id        — отозвать (заголовок x-share-token)
import { ID_RE, json, fail, sha256, safeEqual, expired } from "../../../lib/share-api.js";

export async function onRequestGet({ request, env, params }) {
  if (!env.SHARES) return fail(503, "Хранилище ссылок не настроено");
  const id = String(params.id || "");
  if (!ID_RE.test(id)) return fail(404, "Нет такой ссылки");
  if (new URL(request.url).searchParams.get("meta")) {
    // Статус для «Моих ссылок» всегда отвечает 200, чтобы не засорять консоль ошибками.
    const h = await env.SHARES.head(id);
    if (!h) return json({ gone: true });
    if (expired(h.customMetadata)) { await env.SHARES.delete(id); return json({ gone: true }); }
    return json({ expires: +h.customMetadata.exp, once: h.customMetadata.once === "1" });
  }
  const obj = await env.SHARES.get(id);
  if (!obj) return fail(404, "Нет такой ссылки");
  if (expired(obj.customMetadata)) { await env.SHARES.delete(id); return fail(410, "Срок истёк"); }
  const body = await obj.arrayBuffer();
  if (obj.customMetadata.once === "1") await env.SHARES.delete(id);
  return new Response(body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
}

export async function onRequestDelete({ request, env, params }) {
  if (!env.SHARES) return fail(503, "Хранилище ссылок не настроено");
  const id = String(params.id || ""), token = request.headers.get("x-share-token") || "";
  if (!ID_RE.test(id) || !token) return fail(404, "Нет такой ссылки");
  const h = await env.SHARES.head(id);
  if (!h) return new Response(null, { status: 204 });
  if (!safeEqual(await sha256(token), h.customMetadata.th || "")) return fail(403, "Нет прав отозвать эту ссылку");
  await env.SHARES.delete(id);
  return new Response(null, { status: 204 });
}
