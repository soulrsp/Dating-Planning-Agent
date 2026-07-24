const CACHE_NAME = 'aura-date-planner-v6';

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
    // Pass-through for Firebase API, Naver Maps API, and live app.js
    if (event.request.url.includes('firebasedatabase.app') || 
        event.request.url.includes('naver.com') || 
        event.request.url.includes('app.js')) {
        return;
    }

    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
