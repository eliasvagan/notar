/*
 * Notar's service worker: the whole app is precached, so it launches and composes and plays offline (it has no
 * server; compositions live in localStorage). Scope is this directory, e.g. https://eliasv.com/projects/notar/.
 *
 *   - VERSION is a hash of the shell files (node scripts/sw-version.mjs stamps it; tests/sw.test.mjs checks it),
 *     so any change to the shell is a new worker and a new cache, and nothing else is.
 *   - The shell is served cache-first from its versioned cache (query strings like ?v=4 ignored); navigations
 *     inside the scope get index.html. Only GETs in the scope are touched.
 *   - Activation deletes every older notar-shell-* cache.
 *   - A new worker installs in the background and waits. pwa.js applies it at launch before anything is touched,
 *     otherwise shows a quiet "update ready" hint (never while playing); it takes over when that is tapped or on
 *     the next launch.
 */
const VERSION = '05430208e410';
const PREFIX = 'notar-shell-';
const SHELL_CACHE = `${PREFIX}${VERSION}`;
const SHELL = [
  './',
  'styles.css',
  'app.js',
  'pwa.js',
  'manifest.webmanifest',
  'favicon.svg',
  'favicon.ico',
  'icons/icon-32.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'assets/g-clef.svg',
];

const scope = new URL(self.registration.scope);
const shellUrl = new URL('./', scope).href;

self.addEventListener('install', (event) => {
  // `reload`: fetch past the HTTP cache, so a new version never precaches an old file.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== SHELL_CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
  else if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return; // not ours: network
  if (request.mode === 'navigate') {
    event.respondWith(navigate(url));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true }).then((hit) => hit || fetch(request)));
});

/** The app's own page is the shell; any other page in the scope is tried on the network first. */
async function navigate(url) {
  const cache = await caches.open(SHELL_CACHE);
  const isShell = url.pathname === scope.pathname || url.pathname === `${scope.pathname}index.html`;
  if (isShell) return (await cache.match(shellUrl)) || fetch(url);
  try {
    return await fetch(url);
  } catch {
    return Response.redirect(shellUrl, 302); // offline and not the app's address: go to the app
  }
}
