// Offline support: app files are served from cache and refreshed in the background.
const CACHE = 'instant-search-v23';
const SHELL = [
  './', 'index.html', 'css/app.css',
  'js/app.js', 'js/search.js', 'js/store.js', 'js/ingest.js', 'js/pdf.js', 'js/keys.js', 'js/htmlview.js', 'js/remote.js',
  'vendor/pdf.min.js', 'vendor/pdf.worker.min.js',
  'manifest.webmanifest', 'favicon.ico', 'icons/icon-192x192.png',
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
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const vendor = req.url.includes('/vendor/');
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      // always ask the server whether the file changed (it answers "no change" cheaply), so updates show right away
      const network = fetch(req, { cache: 'no-cache' })
        .then((res) => { if (res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => cached);
      // vendor libraries never change for a given version: cache first. App files: network first.
      if (vendor && cached) return cached;
      return navigator.onLine === false && cached ? cached : network.then((r) => r || cached);
    })
  );
});
