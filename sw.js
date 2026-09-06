var CACHE = 'daiqilema-v3';
var FILES = ['./', './index.html', './icon.png', './icon-512.png', './manifest.webmanifest'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // 页面走 network-first：发版后用户总能拿到新版本，断网时回退到缓存
  if (e.request.mode === 'navigate' || /\/index\.html$/.test(url.pathname)) {
    e.respondWith(
      fetch(e.request).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put('./index.html', copy); });
        }
        return resp;
      }).catch(function () {
        return caches.match('./index.html');
      })
    );
    return;
  }

  // 其他静态资源 cache-first，后台顺便更新缓存
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) {
        fetch(e.request).then(function (resp) {
          if (resp && resp.ok) {
            caches.open(CACHE).then(function (c) { c.put(e.request, resp.clone()); });
          }
        }).catch(function () {});
        return hit;
      }
      return fetch(e.request).then(function (resp) {
        if (resp && resp.ok) {
          var copy = resp.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return resp;
      });
    })
  );
});
