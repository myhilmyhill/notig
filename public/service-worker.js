/// <reference lib="webworker" />

'use strict';

/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {any} */ (self);


const CACHE_NAME = 'notig-static-v15';
const PRECACHE_URLS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './ui.js',
  './git-api.js',
  './note-utils.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

sw.addEventListener('install', /** @param {ExtendableEvent} event */(event) => {

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => sw.skipWaiting())

  );
});

sw.addEventListener('activate', /** @param {ExtendableEvent} event */(event) => {

  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', /** @param {FetchEvent} event */(event) => {
  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === sw.location.origin;

  if (event.request.method !== 'GET') return;

  // Intercept share target GET requests
  if (isSameOrigin && (requestUrl.searchParams.has('title') || requestUrl.searchParams.has('text') || requestUrl.searchParams.has('url'))) {
    const payload = {
      title: requestUrl.searchParams.get('title') || '',
      text: requestUrl.searchParams.get('text') || '',
      url: requestUrl.searchParams.get('url') || '',
    };

    event.waitUntil(
      (async () => {
        // Wait a tiny bit to ensure the window has a chance to register its listener
        await new Promise(r => setTimeout(r, 500));
        const allClients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of allClients) {
          client.postMessage({
            type: 'share-target',
            payload: payload
          });
        }
      })()
    );
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html', { ignoreSearch: true }).then((cached) => cached || sw.fetch(event.request))
    );
    return;
  }

  if (!isSameOrigin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || sw.fetch(event.request))
  );
});
