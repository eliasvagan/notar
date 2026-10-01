// Unit tests for the installable app: node --test tests/sw.test.mjs
// Static checks, no browser: sw.js's VERSION stamp, the precache list against what index.html and app.js load,
// the manifest, the icon links and favicon.ico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeVersion, shellFiles, stampedVersion } from '../scripts/sw-version.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (f) => readFileSync(resolve(ROOT, f), 'utf8');

test('the service worker version matches the shell it precaches', () => {
  assert.equal(stampedVersion(), computeVersion(), 'stale VERSION: run node scripts/sw-version.mjs');
});

test('a change to any shell file changes the version', () => {
  const sw = read('sw.js');
  // An in-memory edit: one more SHELL entry (favicon.svg a second time), which the hash must notice.
  const edited = sw.replace("'./',", "'./', 'favicon.svg',");
  assert.notEqual(computeVersion(edited), computeVersion(sw));
});

test('every precached file exists, and everything the page loads is precached', () => {
  const files = shellFiles();
  for (const f of files) assert.ok(existsSync(resolve(ROOT, f)), f);
  const html = read('index.html');
  // Relative href and src values, ?v= queries dropped; '#' (<use href="#i-…">) and ':' (absolute URLs) never match.
  for (const [, ref] of html.matchAll(/(?:href|src)="([^"#:]+?)(?:\?[^"]*)?"/g)) {
    if (ref.startsWith('/')) continue; // outside the app (the portfolio)
    assert.ok(files.includes(ref), `index.html uses ${ref}`);
  }
  for (const [, ref] of read('app.js').matchAll(/"(assets\/[^"]+)"/g)) assert.ok(files.includes(ref), `app.js uses ${ref}`);
});

test('activation deletes older shell caches', () => {
  const sw = read('sw.js');
  assert.match(sw, /addEventListener\('activate'[\s\S]*caches\.delete/);
  assert.match(sw, /const SHELL_CACHE = `\$\{PREFIX\}\$\{VERSION\}`/);
});

test('the manifest is installable and relative to where the app is served', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.name, 'Notar');
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.equal(m.display, 'standalone');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  for (const icon of m.icons) assert.ok(existsSync(resolve(ROOT, icon.src)), icon.src);
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  assert.ok(m.icons.some((i) => i.sizes === '192x192' && i.purpose === 'any'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'any'));
});

test('the page links the icons, the manifest and a matching theme colour', () => {
  const html = read('index.html');
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.match(html, /<link rel="manifest" href="manifest.webmanifest">/);
  assert.match(html, /<link rel="icon" href="favicon.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="icon" href="favicon.ico" sizes="16x16 32x32 48x48">/);
  assert.match(html, /<link rel="apple-touch-icon" href="icons\/apple-touch-icon.png" sizes="180x180">/);
  assert.ok(html.includes(`<meta name="theme-color" content="${m.theme_color}">`));
  assert.doesNotMatch(html, /rel="icon" href="data:/);
});

test('favicon.ico holds 16, 32 and 48 px images', () => {
  const ico = readFileSync(resolve(ROOT, 'favicon.ico'));
  // ICONDIR: type 1 (icon) at byte 2, the image count at 4; each 16-byte entry from byte 6 starts with its width.
  assert.equal(ico.readUInt16LE(2), 1);
  const n = ico.readUInt16LE(4);
  const sizes = Array.from({ length: n }, (_, i) => ico.readUInt8(6 + 16 * i));
  assert.deepEqual(sizes, [16, 32, 48]);
});
