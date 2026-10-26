// Офлайн-оболочка приложения. Кэширует только файлы самого приложения — пользовательские данные сюда не попадают.
const VERSION = "myday-v1.3.0";
const SHELL = [
  "./", "./manifest.webmanifest",
  "./css/app.css", "./css/fonts.css",
  "./js/app.js", "./js/db.js", "./js/backup.js", "./js/vault.js",
  "./icons/icon.svg", "./icons/icon-180.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/maskable-512.png",
  "./fonts/amatic-sc-cyrillic-400-normal.woff2",
  "./fonts/amatic-sc-cyrillic-700-normal.woff2",
  "./fonts/amatic-sc-latin-400-normal.woff2",
  "./fonts/amatic-sc-latin-700-normal.woff2",
  "./fonts/caveat-cyrillic-500-normal.woff2",
  "./fonts/caveat-cyrillic-700-normal.woff2",
  "./fonts/caveat-latin-500-normal.woff2",
  "./fonts/caveat-latin-700-normal.woff2",
  "./fonts/comfortaa-cyrillic-400-normal.woff2",
  "./fonts/comfortaa-cyrillic-600-normal.woff2",
  "./fonts/comfortaa-cyrillic-700-normal.woff2",
  "./fonts/comfortaa-latin-400-normal.woff2",
  "./fonts/comfortaa-latin-600-normal.woff2",
  "./fonts/comfortaa-latin-700-normal.woff2",
  "./fonts/cormorant-garamond-cyrillic-500-normal.woff2",
  "./fonts/cormorant-garamond-cyrillic-600-normal.woff2",
  "./fonts/cormorant-garamond-cyrillic-700-normal.woff2",
  "./fonts/cormorant-garamond-latin-500-normal.woff2",
  "./fonts/cormorant-garamond-latin-600-normal.woff2",
  "./fonts/cormorant-garamond-latin-700-normal.woff2",
  "./fonts/golos-text-cyrillic-400-normal.woff2",
  "./fonts/golos-text-cyrillic-500-normal.woff2",
  "./fonts/golos-text-cyrillic-600-normal.woff2",
  "./fonts/golos-text-latin-400-normal.woff2",
  "./fonts/golos-text-latin-500-normal.woff2",
  "./fonts/golos-text-latin-600-normal.woff2",
  "./fonts/jetbrains-mono-cyrillic-400-normal.woff2",
  "./fonts/jetbrains-mono-cyrillic-600-normal.woff2",
  "./fonts/jetbrains-mono-latin-400-normal.woff2",
  "./fonts/jetbrains-mono-latin-600-normal.woff2",
  "./fonts/lora-cyrillic-400-italic.woff2",
  "./fonts/lora-cyrillic-400-normal.woff2",
  "./fonts/lora-cyrillic-600-normal.woff2",
  "./fonts/lora-latin-400-italic.woff2",
  "./fonts/lora-latin-400-normal.woff2",
  "./fonts/lora-latin-600-normal.woff2",
  "./fonts/manrope-cyrillic-400-normal.woff2",
  "./fonts/manrope-cyrillic-600-normal.woff2",
  "./fonts/manrope-cyrillic-700-normal.woff2",
  "./fonts/manrope-latin-400-normal.woff2",
  "./fonts/manrope-latin-600-normal.woff2",
  "./fonts/manrope-latin-700-normal.woff2",
  "./fonts/marck-script-cyrillic-400-normal.woff2",
  "./fonts/marck-script-latin-400-normal.woff2",
  "./fonts/playfair-display-cyrillic-500-normal.woff2",
  "./fonts/playfair-display-cyrillic-700-normal.woff2",
  "./fonts/playfair-display-latin-500-normal.woff2",
  "./fonts/playfair-display-latin-700-normal.woff2",
  "./fonts/unbounded-cyrillic-500-normal.woff2",
  "./fonts/unbounded-cyrillic-700-normal.woff2",
  "./fonts/unbounded-latin-500-normal.woff2",
  "./fonts/unbounded-latin-700-normal.woff2",
  "./fonts/yeseva-one-cyrillic-400-normal.woff2",
  "./fonts/yeseva-one-latin-400-normal.woff2",
];
self.addEventListener("install", e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL))); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "skip") self.skipWaiting(); });
self.addEventListener("fetch", e => {
  const r = e.request;
  if (r.method !== "GET" || new URL(r.url).origin !== location.origin) return;
  e.respondWith(caches.match(r, { ignoreSearch: true }).then(hit => hit || fetch(r).then(res => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(VERSION).then(c => c.put(r, copy)); }
    return res;
  }).catch(() => r.mode === "navigate" ? caches.match("./") : Response.error())));
});
