const scopeKey = new URL(self.registration.scope).pathname.replace(/[^a-z0-9]/gi, "-");
const CACHE_PREFIX = `meu-cafe-local-${scopeKey}-`;
const CACHE_NAME = `${CACHE_PREFIX}v4`;
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./backup.js",
  "./validation.js",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  const urls = ASSETS.map((asset) => new URL(asset, self.registration.scope).href);
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urls)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.href.startsWith(self.registration.scope)) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(async (response) => {
        if (response.ok) {
          const clone = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(event.request, clone);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        if (event.request.mode === "navigate") {
          return caches.match(new URL("./", self.registration.scope).href);
        }
        throw new Error("Offline asset unavailable");
      }),
  );
});

