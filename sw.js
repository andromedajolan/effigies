// Offline cache for Effigies. Bump VERSION on every release (it must match APP_VERSION in js/main.js).
const VERSION = '0.8.0';
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
  'js/fonts.js',
  'js/type.js',
  'js/styles.js',
  'js/styles-ui.js',
  'js/contours.js',
  'js/pat.js',
  'js/patterns.js',
  'js/bevel.js',
  'js/guides.js',
  'js/transform.js',
  'js/filters.js',
  'js/retouch.js',
  'fonts/abril-fatface-400.woff2',
  'fonts/alfa-slab-one-400.woff2',
  'fonts/anton-400.woff2',
  'fonts/archivo-black-400.woff2',
  'fonts/audiowide-400.woff2',
  'fonts/bangers-400.woff2',
  'fonts/barlow-condensed-400.woff2',
  'fonts/barlow-condensed-700.woff2',
  'fonts/bebas-neue-400.woff2',
  'fonts/black-ops-one-400.woff2',
  'fonts/bowlby-one-sc-400.woff2',
  'fonts/bungee-400.woff2',
  'fonts/caveat-400.woff2',
  'fonts/caveat-700.woff2',
  'fonts/cinzel-400.woff2',
  'fonts/cinzel-700.woff2',
  'fonts/cinzel-decorative-400.woff2',
  'fonts/cinzel-decorative-700.woff2',
  'fonts/cormorant-garamond-400.woff2',
  'fonts/cormorant-garamond-700.woff2',
  'fonts/creepster-400.woff2',
  'fonts/dancing-script-400.woff2',
  'fonts/dancing-script-700.woff2',
  'fonts/dm-serif-display-400.woff2',
  'fonts/fjalla-one-400.woff2',
  'fonts/fredericka-the-great-400.woff2',
  'fonts/gloock-400.woff2',
  'fonts/great-vibes-400.woff2',
  'fonts/inter-400.woff2',
  'fonts/inter-700.woff2',
  'fonts/league-gothic-400.woff2',
  'fonts/limelight-400.woff2',
  'fonts/lobster-400.woff2',
  'fonts/metal-mania-400.woff2',
  'fonts/monoton-400.woff2',
  'fonts/montserrat-400.woff2',
  'fonts/montserrat-700.woff2',
  'fonts/orbitron-400.woff2',
  'fonts/orbitron-700.woff2',
  'fonts/oswald-400.woff2',
  'fonts/oswald-700.woff2',
  'fonts/pacifico-400.woff2',
  'fonts/permanent-marker-400.woff2',
  'fonts/pirata-one-400.woff2',
  'fonts/playfair-display-400.woff2',
  'fonts/playfair-display-700.woff2',
  'fonts/poppins-400.woff2',
  'fonts/poppins-700.woff2',
  'fonts/press-start-2p-400.woff2',
  'fonts/raleway-400.woff2',
  'fonts/raleway-700.woff2',
  'fonts/righteous-400.woff2',
  'fonts/rock-salt-400.woff2',
  'fonts/rubik-mono-one-400.woff2',
  'fonts/satisfy-400.woff2',
  'fonts/shadows-into-light-400.woff2',
  'fonts/space-grotesk-400.woff2',
  'fonts/space-grotesk-700.woff2',
  'fonts/special-elite-400.woff2',
  'fonts/staatliches-400.woff2',
  'fonts/syne-400.woff2',
  'fonts/syne-700.woff2',
  'fonts/teko-400.woff2',
  'fonts/teko-700.woff2',
  'fonts/unbounded-400.woff2',
  'fonts/unbounded-700.woff2',
  'fonts/unifrakturcook-700.woff2',
  'fonts/yeseva-one-400.woff2',
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
