const CACHE_NAME = 'aura-date-planner-v20260805_v345';

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((cache) => caches.delete(cache))
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Never intercept cross-origin traffic. Map SDKs (Naver/Kakao), geocoding endpoints, CORS proxies
    // and API calls must reach the network untouched — routing them through the worker turned ordinary
    // CORS/network failures into "Failed to convert value to 'Response'" hard errors that killed search.
    if (url.origin !== self.location.origin) return;

    // Only GETs are cacheable; let POST/PUT and non-GET verbs pass straight through.
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request).catch(async () => {
            const cached = await caches.match(event.request);
            // respondWith rejects on undefined, so always hand back a real Response
            return cached || new Response('Offline', {
                status: 503,
                statusText: 'Offline',
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        })
    );
});
