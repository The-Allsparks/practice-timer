import { ASSETS, CACHE_VERSION } from './src/cache-manifest.js';

function assetUrl(path) {
  return new URL(path, self.registration.scope).href;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    for (const path of ASSETS) {
      const response = await fetch(assetUrl(path), { cache: 'reload' });
      if (!response.ok) throw new Error('Missing ' + path);
      await cache.put(assetUrl(path), response);
    }
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'idle') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const ready = await caches.open(CACHE_VERSION);
    const cached = await ready.keys();
    if (cached.length < ASSETS.length) return;
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.cache === 'reload' || event.request.cache === 'no-store') {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const fresh = await fetch(event.request);
      if (fresh.ok) {
        await cache.put(event.request, fresh.clone());
        return fresh;
      }
    } catch { /* offline: use the saved copy */ }
    const hit = await cache.match(event.request, { ignoreSearch: true });
    if (hit) return hit;
    if (event.request.mode === 'navigate') {
      const page = await cache.match(assetUrl('./index.html'));
      if (page) return page;
    }
    return new Response('Offline', { status: 503 });
  })());
});
