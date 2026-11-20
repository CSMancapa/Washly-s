/* Washly's offline support.
   - The app's own files are kept on the phone so it opens instantly and works without signal.
   - Pages and settings are fetched fresh when there's a connection (so updates show up straight away),
     and the saved copy is used only when offline.
   - Bookings, accounts and prices (Supabase) are never cached: they always come live from the database. */
const VERSION = "washlys-v3";
const SHELL = ["./", "./index.html", "./config.js", "./vendor/supabase.js", "./manifest.webmanifest",
  "./icons/icon-192.png", "./icons/icon-512.png", "./icons/apple-touch-icon.png", "./icons/favicon-32.png",
  "./img/hero.webp"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isFuel = url => /\/Fuel_Friend\/(index\.html)?$/.test(url.pathname);

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isPhoto = url.hostname === "images.unsplash.com";  // photos: saved on the phone after the first visit
  if (!sameOrigin && !isFuel(url) && !isPhoto) return;            // Supabase, fonts etc.: straight to the network

  const fresh = /\/$|\.html$|config\.js$|manifest\.webmanifest$/.test(url.pathname) || req.mode === "navigate" || isFuel(url);
  if (fresh) {                                         // network first, saved copy when offline
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(r => r || caches.match("./index.html"))));
    return;
  }
  e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => {   // saved copy first for library and icons
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});
