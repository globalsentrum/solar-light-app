/*
 * Service worker: keeps the app shell available offline.
 * VERSION is stamped by `npm run build` so phones pick up new versions automatically.
 * API calls (Apps Script) and Google sign-in are never cached here — data lives in IndexedDB.
 */
const VERSION = 'fd2881a8d7';
const CACHE = 'solar-shell-' + VERSION;
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/config.js', 'js/logic.js', 'js/db.js', 'js/api.js', 'js/watermark.js',
  'js/sync.js', 'js/app.js', 'lib/exifr.umd.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('solar-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Apps Script, Google sign-in: straight to network
  if (req.mode === 'navigate') {
    // App page: cached copy first (works offline), ignore the #hash / ?query
    e.respondWith(caches.match('index.html').then((r) => r || fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => r || fetch(req)));
});
