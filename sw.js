const CACHE = "showtime-v15";
const ASSETS = [
  "./",
  "index.html",
  "styles.css?v=9",
  "app.js?v=13",
  "manifest.webmanifest",
  "icon.svg?v=2",
  "apple-touch-icon.png?v=2",
  "share-target/",
];

// Keep in sync with the DB_NAME / DB_VERSION / STORE_TICKETS / STORE_SHARE
// constants in app.js — this is a separate script context so it can't
// import them, but both must agree for IndexedDB to open without conflict.
const DB_NAME = "showtime-db";
const DB_VERSION = 2;
const STORE_TICKETS = "tickets";
const STORE_SHARE = "pending-share";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TICKETS)) {
        db.createObjectStore(STORE_TICKETS, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_SHARE)) {
        db.createObjectStore(STORE_SHARE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function savePendingShare(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SHARE, "readwrite");
    tx.objectStore(STORE_SHARE).put({ id: "current", ...entry });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function handleShareTarget(request) {
  const formData = await request.formData();
  const title = formData.get("title") || "";
  const text = formData.get("text") || "";
  const url = formData.get("url") || "";
  const file = formData.getAll("file")[0] || null;

  await savePendingShare({
    title,
    text,
    url,
    fileBlob: file || null,
    fileType: file ? file.type : null,
    fileName: file ? file.name : null,
    ts: Date.now(),
  });

  return Response.redirect(new URL("../index.html?shared=1", request.url), 303);
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "POST" && url.pathname.endsWith("/share-target/")) {
    event.respondWith(handleShareTarget(event.request));
    return;
  }

  if (event.request.method !== "GET") return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const fetchPromise = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
