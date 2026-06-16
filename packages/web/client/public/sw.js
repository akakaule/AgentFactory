// AgentFactory service worker — PWA installability + an offline navigation shell.
//
// SCOPE IS DELIBERATELY NARROW: only same-origin top-level NAVIGATIONS are intercepted
// (network-first, falling back to the cached app shell when offline). Hashed build assets
// and everything else go straight to the network, untouched. The previous version fell back
// to index.html for ANY failed GET — including hashed .js/.css — so a missing/stale asset
// (e.g. after a rebuild, or while the server was briefly down) got answered with HTML, and
// the browser tried to execute HTML as a script → a blank page that wouldn't recover
// (this bit Chrome, which keeps the SW active, while a SW-less Edge was fine). Never serve
// the shell for non-navigation requests. Live data (/api, /events) is never touched.
const CACHE = 'af-shell-v2';

self.addEventListener('install', (event) => {
  // Cache only the shell document; assets are always fetched fresh from the network.
  event.waitUntil(caches.open(CACHE).then((c) => c.add('/index.html')));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop older caches (e.g. the v1 shell that also cached now-stale hashed assets).
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.mode !== 'navigate') return;                       // assets/api/fonts/etc. → straight to network
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); }
        return res;
      })
      .catch(() => caches.match('/index.html')),
  );
});
