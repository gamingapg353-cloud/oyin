// Ilova (PWA): internet yo'q bo'lsa — oflayn sahifa; telefonga bildirishnoma.
// Sahifa va API javoblari saqlanmaydi (akkaunt ma'lumoti qurilmada qolmasin).
const CACHE = 'oyin-v1';
const OFFLINE = '/__offline';
const PAGE = `<!doctype html><html lang="uz"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Internet yo'q</title>
<style>body{margin:0;min-height:100vh;display:grid;place-content:center;gap:12px;padding:24px;text-align:center;background:#0a1020;color:#e8edf6;font:16px/1.5 system-ui,sans-serif}button{padding:12px 20px;border:0;border-radius:12px;background:#3b82f6;color:#fff;font:inherit;font-weight:700}</style>
<h1>📡 Internet yo'q</h1><p>Aloqa tiklanganda qayta urinib ko'ring.</p><button onclick="location.reload()">Qayta urinish</button></html>`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.put(OFFLINE, new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
});

// Push mazmunsiz keladi — matnni shu yerda, foydalanuvchining o'z sessiyasi bilan olamiz
self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    let item = null;
    try {
      const res = await fetch('/api/notifications/last', { credentials: 'same-origin' });
      if (res.ok) ({ item } = await res.json());
    } catch { /* internet yo'q */ }
    await self.registration.showNotification("O'yin", {
      body: item ? item.text : 'Sizga yangi xabar bor',
      icon: '/static/icons/icon-192.png',
      badge: '/static/icons/badge-96.png',
      tag: item ? `n${item.id}` : 'oyin',
      data: { link: (item && item.link) || '/panel' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.link || '/panel', self.location.origin);
  const target = url.origin === self.location.origin ? url.href : `${self.location.origin}/panel`;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = list.find((c) => new URL(c.url).pathname === new URL(target).pathname);
    if (same) {
      await same.focus();
      if ('navigate' in same) await same.navigate(target).catch(() => {});
    } else await self.clients.openWindow(target);
  })());
});
