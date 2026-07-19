// Service worker: makes the app installable, works offline, and receives Web Push
// notifications so reception is alerted even when the app tab is in the background
// or fully closed.

const CACHE = 'laundry-v9';
const CORE = [
  '/app', '/app.html', '/assets/app.js', '/assets/styles.css',
  '/favicon.svg', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

// Never cache API calls; cache-first for static assets; network-first for pages.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // let the network handle API

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match('/app.html')));
    return;
  }
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
      return res;
    }).catch(() => hit)),
  );
});

// Incoming push from the server.
self.addEventListener('push', (event) => {
  let data = { title: 'Laundry', body: 'You have a new notification', url: '/app' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch {}
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'laundry',
      renotify: true,
      data: { url: data.url || '/app' },
    }),
  );
});

// Focus/open the app when a notification is tapped.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) { if (c.url.includes('/app') && 'focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    }),
  );
});
