// Service worker de Soumission Pro : l'app s'ouvre sans réseau, avec les dernières données reçues.
// Ne touche jamais aux pages client (/s/, /f/), au site public, à la connexion ni aux paiements.
const VERSION = 'sp-2.6.0';
const SHELL = `${VERSION}-shell`;
const API = 'sp-api';
const SHELL_FILES = [
  '/app', '/dossier', '/manifest.webmanifest',
  '/assets/styles.css', '/assets/app.js', '/assets/store.js', '/assets/utils.js', '/assets/money.js',
  '/assets/line-editor.js', '/assets/templates.js', '/assets/invoices-ui.js', '/assets/catalog-ui.js',
  '/assets/sign-ui.js', '/assets/signature-pad.js', '/assets/offline.js', '/assets/dossier-page.js',
  '/assets/icon.svg', '/assets/icon-192.png',
];
// Lectures de l'app gardées pour le mode hors ligne (jamais les pages publiques).
const API_CACHED = /^\/api\/(me|quotes|invoices|catalog)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.endsWith('-shell') && key !== SHELL) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

async function apiNetworkFirst(request) {
  const cache = await caches.open(API);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(request.url, res.clone());
    else if (res.status === 401) await cache.delete(request.url); // session finie : rien ne reste
    return res;
  } catch {
    const cached = await cache.match(request.url);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-sp-offline', '1');
      return new Response(cached.body, { status: 200, headers });
    }
    return new Response(JSON.stringify({ error: { code: 'network', message: 'Pas de connexion. Vérifie ton réseau et réessaie.' } }), {
      status: 503, headers: { 'content-type': 'application/json; charset=utf-8', 'x-sp-offline': '1' },
    });
  }
}

async function pageNetworkFirst(request, fallbackPath) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(SHELL);
      await cache.put(fallbackPath, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(fallbackPath, { cacheName: SHELL });
    return cached || Response.error();
  }
}

async function assetStaleWhileRevalidate(request) {
  const cache = await caches.open(SHELL);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (API_CACHED.test(path)) { event.respondWith(apiNetworkFirst(request)); return; }
  if (path === '/app' || path === '/app/') { event.respondWith(pageNetworkFirst(request, '/app')); return; }
  if (path === '/dossier') { event.respondWith(pageNetworkFirst(request, '/dossier')); return; }
  if (path.startsWith('/assets/') || path === '/manifest.webmanifest') { event.respondWith(assetStaleWhileRevalidate(request)); }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'clear-api') event.waitUntil(caches.delete(API));
});
