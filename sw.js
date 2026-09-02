// Offline shell for PEGEL://. Deliberately the smallest thing that works.
//
// Network first, cache second — never the other way round. The page is one
// HTML file served from GitHub Pages with max-age=600, and the reason a
// cache-first worker is wrong here is that it would pin a reader to whatever
// version they first installed until they cleared site data. Readings move
// every five minutes; the drawing has to be able to move too.
//
// So: the fetch goes out, a good response is copied into the cache and
// returned, and the cache only answers when the network could not. That makes
// the app openable on a train with no signal — the archive it draws from
// already lives in localStorage — without ever serving a stale page to someone
// who does have signal.
//
// Only the shell is cached. Live API responses and archive JSON are not: a
// gauge reading from an hour ago dressed up as current is worse than an honest
// "no data" — the page has states for that and says so.

const CACHE = 'pegel-shell-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './favicon-32.png',
  './apple-touch-icon.png',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
];

self.addEventListener('install', e => {
  // one miss must not fail the whole install (an icon renamed, a 404 on a
  // partial deploy): cache what answers, skip what does not
  e.waitUntil(caches.open(CACHE)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // PEGELONLINE, open-meteo: never ours to cache
  if (url.pathname.includes('/archive/')) return;    // data, not shell

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      // offline: the shell, or the page itself for a navigation to any ?query
      .catch(() => caches.match(req).then(hit => hit || (req.mode === 'navigate'
        ? caches.match('./index.html')
        : undefined)))
  );
});
