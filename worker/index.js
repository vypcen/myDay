// Точка входа для развёртывания как Cloudflare Worker (static assets + код).
// Запросы /api/* обрабатывает этот код, всё остальное — статические файлы приложения (привязка ASSETS).
// Те же обработчики используются и в Cloudflare Pages (папка functions/), поэтому логика одна.
import { onRequestPost, onRequestGet as health } from "../functions/api/share/index.js";
import { onRequestGet, onRequestDelete } from "../functions/api/share/[id].js";
import { fail } from "../lib/share-api.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/share" || url.pathname === "/api/share/") {
      if (request.method === "POST") return onRequestPost({ request, env });
      if (request.method === "GET") return health({ request, env });
      return fail(405, "Метод не поддерживается");
    }
    const m = /^\/api\/share\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const ctx = { request, env, params: { id: decodeURIComponent(m[1]) } };
      if (request.method === "GET") return onRequestGet(ctx);
      if (request.method === "DELETE") return onRequestDelete(ctx);
      return fail(405, "Метод не поддерживается");
    }
    if (url.pathname.startsWith("/api/")) return fail(404, "Нет такого адреса");
    return env.ASSETS.fetch(request);
  }
};
