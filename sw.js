const CACHE_NAME = 'aura-date-planner-v20261113_v397';

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

    // Firebase Hosting serves the Auth sign-in helper (handler, iframe, init.json) under /__/ on the
    // same origin as the app now. Firebase's guidance is to keep service workers out of those
    // requests — they're redirect-heavy navigations that must reach the network untouched.
    if (url.pathname.startsWith('/__/')) return;

    // Let POST/PUT and non-GET verbs pass straight through.
    if (event.request.method !== 'GET') return;

    // No offline cache on purpose: Dexie, Firebase and Leaflet load from CDNs (cross-origin, which this
    // worker must not touch — see above), so a cached app shell couldn't start without a network anyway.
    // The activate step only clears caches older builds left behind.
    event.respondWith(
        fetch(event.request).catch(() => {
            // respondWith rejects on undefined, so always hand back a real Response
            return new Response('Offline', {
                status: 503,
                statusText: 'Offline',
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        })
    );
});
