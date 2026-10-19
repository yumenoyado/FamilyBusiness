/* Rubber Ledger service worker: caches the app so it opens without signal. */
const CACHE = 'rubber-ledger-v1';
const CHART = 'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js';
const ASSETS = ['./', 'index.html', 'styles.css', 'js/db.js', 'js/parser.js', 'js/app.js', 'manifest.webmanifest',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];

self.addEventListener('install', ev => {
  ev.waitUntil(caches.open(CACHE).then(async c => {
    await c.addAll(ASSETS);
    try { await c.add(CHART); } catch (e) { /* charts load later */ }
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', ev => {
  ev.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', ev => {
  const req = ev.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/script\.google(usercontent)?\.com$/.test(url.hostname)) return; // never cache sheet data
  if (url.href === CHART) {
    ev.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  // network first (so updates arrive), fall back to cache after 3 s or when offline
  ev.respondWith(new Promise(resolve => {
    let done = false;
    const fallback = () => caches.match(req, { ignoreSearch: true }).then(hit => { if (!done && hit) { done = true; resolve(hit); } });
    const timer = setTimeout(fallback, 3000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      if (!done) { done = true; resolve(res); }
    }).catch(() => {
      clearTimeout(timer);
      caches.match(req, { ignoreSearch: true }).then(hit => { if (!done) { done = true; resolve(hit || Response.error()); } });
    });
  }));
});
