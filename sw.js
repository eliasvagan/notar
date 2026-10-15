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
 *   - Each launch of the installed app checks that this address still serves Notar (its sw.js). If something else
 *     answers there (a 404, or another app's page), Notar was moved or the address now serves another app: the
 *     worker unregisters, drops its caches and reloads the page into what is really served. A browser never
 *     removes a worker on its own, so without this an address like http://127.0.0.1:8080/ would keep showing
 *     Notar over any later app. No answer at all is offline (or a stopped server), and Notar keeps working.
 */
const VERSION = '16b62bf3c078';
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
const shellUrl = new URL('./', scope).href; // the key SHELL's './' (index.html) is cached under

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

// SKIP_WAITING ({type}) comes from pwa.js applying an update ('skip-waiting' from older pages); 'version' is asked by tests/e2e-pwa.cjs.
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting' || event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  else if (event.data === 'version') event.source?.postMessage({ version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return; // not ours: network
  if (request.mode === 'navigate') {
    event.respondWith(navigate(url));
    event.waitUntil(stillServed().then((served) => served || stepAside(event.resultingClientId)));
    return;
  }
  event.respondWith(caches.match(request, { cacheName: SHELL_CACHE, ignoreSearch: true }).then((hit) => hit || fetch(request)));
});

/** Whether this address still serves Notar: its worker script, past every cache. Offline or a server error: assume so. */
async function stillServed() {
  let response;
  try {
    response = await fetch(new URL('sw.js', scope), { cache: 'no-store' });
  } catch {
    return true;
  }
  if (response.status === 404 || response.status === 410) return false;
  return !response.ok || (await response.text()).includes(PREFIX);
}

/**
 * Notar is gone from this address: unregister, drop its caches, and reload open pages into what is served now. The
 * page just opened (`opening`) may not be ready for that yet, so it is waited for, up to a few seconds.
 */
async function stepAside(opening) {
  await self.registration.unregister();
  for (const key of await caches.keys()) if (key.startsWith(PREFIX)) await caches.delete(key);
  for (let tries = 0; opening && tries < 50 && !(await self.clients.get(opening)); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url).catch(() => {});
}

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
