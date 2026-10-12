// Aerolith Core's service worker (docs/wave6-plan.md step 4): the app opens with no signal. Pages are network-first
// with the last good copy as the fallback; built assets (hashed names, never changed) are cache-first. The API is
// never cached: forms with no signal wait in the app's outbox, not here.
const CACHE = 'aerolith-shell-v1';
const MAX_ASSETS = 400;

self.addEventListener('install', (event) => {
  // The page and the assets it names, so the first visit is enough to open the app with no signal; assets the app
  // loads later are kept as they are fetched.
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        await c.addAll(['/', '/manifest.webmanifest', '/icon.svg']);
        const page = await (await c.match('/')).text();
        const assets = [...new Set(page.match(/\/assets\/[^"'\s>]+/g) ?? [])];
        await c.addAll(assets);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            void caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit ?? Response.error())),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((c) => c.put(req, copy).then(() => trim(c)));
            }
            return res;
          }),
      ),
    );
  }
});
