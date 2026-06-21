// Service worker — makes the app installable and loads the UI shell offline.
// Strategy:
//   - /api/* : never cached (always hit the network; the app needs live data/auth).
//   - app shell + CDN assets : cache-first, so the UI opens instantly and offline.
// Data still requires a connection; offline you get the shell, not your numbers.
const CACHE = 'expense-tracker-v1';
const SHELL = [
  '/',
  '/index.html',
  '/login.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache API calls — they need live auth/data.
  if (url.origin === self.location.origin && url.pathname.startsWith('/api/')) return;

  // Navigations: serve the cached shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match('/index.html'))));
    return;
  }

  // Static + CDN assets: cache-first, then fill the cache from the network.
  e.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).then((res) => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => cached))
  );
});
