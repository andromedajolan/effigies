// Offline cache for Effigies. Bump VERSION on every release (it must match APP_VERSION in js/main.js).
const VERSION = '0.3.0';
const CACHE = 'effigies-cache-' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/effigies.css',
  'js/main.js',
  'js/util.js',
  'js/blend.js',
  'js/render.js',
  'js/doc.js',
  'js/viewport.js',
  'js/tools.js',
  'js/tools2.js',
  'js/select.js',
  'js/gradients.js',
  'js/adjust.js',
  'js/adjust-ui.js',
  'js/store.js',
  'js/project.js',
  'js/dialogs.js',
  'js/panels.js',
  'js/chrome.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/favicon-32.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('effigies-cache-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(req).catch(() => (req.mode === 'navigate' ? caches.match('index.html') : Response.error()));
    }),
  );
});
