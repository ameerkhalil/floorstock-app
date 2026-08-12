// FloorStock service worker.
//
// Scope, deliberately narrow:
//  1. App shell (this HTML page + icons) — cache-first, so the app can at
//     least open and show its UI with no connection at all.
//  2. UPC lookups (/api/upc-lookup/:upc) — network-first, falling back to
//     cache. A product looked up once (by anyone at this store, or cached
//     from a previous session) still resolves offline on a later scan.
//
// Everything else — the live items list, creating/editing/selling items,
// auth, billing — is NEVER cached and always goes straight to the network.
// Caching business data (current stock, prices) would risk showing stale,
// actively misleading information in a shop-floor tool. The offline *write*
// path for new items is handled separately, in the page itself (see
// floorstock_offline_item_queue in index.html), not here.

const SHELL_CACHE = 'floorstock-shell-v1';
const LOOKUP_CACHE = 'floorstock-lookup-v1';

const SHELL_URLS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {
      // If even one shell asset fails to fetch during install (e.g. flaky
      // connection during deploy), don't block install entirely — the
      // service worker still activates, it just won't have that one asset
      // pre-cached yet, and will pick it up opportunistically on first use.
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name !== SHELL_CACHE && name !== LOOKUP_CACHE)
          .map((name) => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes (POST/PUT/DELETE)

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch third-party CDN requests

  // UPC lookups: try the network first (so a fresh scan gets fresh data
  // whenever there's a connection), fall back to whatever was last cached
  // for that exact UPC if the network fails.
  if (url.pathname.startsWith('/api/upc-lookup/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(LOOKUP_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Everything else under /api/ always goes to the network, live data only.
  if (url.pathname.startsWith('/api/')) return;

  // App shell: cache-first, so the UI itself opens even with zero
  // connection, then refresh the cache in the background for next time.
  if (SHELL_URLS.includes(url.pathname) || url.pathname === '/index.html') {
    event.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
  }
});
