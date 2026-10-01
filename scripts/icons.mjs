#!/usr/bin/env node
/**
 * Draws Notar's favicon and app icons: a fragment of its own keyboard, three white keys and the two black keys
 * between them, the middle key struck and sounding (the .key.white.sounding colours from styles.css), on the
 * accent navy. Drawn on a 32-unit grid where every key edge falls on a whole pixel at 16 and 32 px.
 * Writes favicon.svg, favicon.ico (16/32/48) and icons/*.png:
 *
 *     PUPPETEER_MODULE=/path/to/node_modules/puppeteer node scripts/icons.mjs
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const css = readFileSync(resolve(ROOT, 'styles.css'), 'utf8');
// The first hex colour in `prop` of the first `sel { … }` rule in styles.css that sets it.
const rule = (sel, prop) => css.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{[^}]*?${prop}:[^;]*?(#[0-9a-f]{3,6})`, 'i'))[1];
const ACCENT = css.match(/--accent:\s*(#[0-9a-f]+)/i)[1]; // the tile
const BLACK = rule('.key.black', 'background'); // the black keys
const STRUCK = rule('.key.white.sounding', 'background'); // the struck key
const GOLD = rule('.key.sounding', 'box-shadow'); // its sounding edge
const WHITE = '#fff';

/** The keys on the 32-unit grid; `bleed` drops the tile's corner radius (for icons the OS masks itself). */
function mark({ bleed = false, scale = 1 } = {}) {
  const t = scale === 1 ? '' : ` transform="translate(${16 - 16 * scale} ${16 - 16 * scale}) scale(${scale})"`;
  return `<rect width="32" height="32"${bleed ? '' : ' rx="7"'} fill="${ACCENT}"/>`
    + `<g${t}>`
    + `<g fill="${WHITE}"><rect x="4" y="4" width="6" height="24" rx="1.5"/><rect x="22" y="4" width="6" height="24" rx="1.5"/></g>`
    // The struck middle key, then its gold bottom edge (the .key.sounding inset shadow), then the black keys on top.
    + `<rect x="12" y="4" width="8" height="24" rx="1.5" fill="${STRUCK}"/>`
    + `<path d="M12 24h8v2.5a1.5 1.5 0 0 1-1.5 1.5h-5a1.5 1.5 0 0 1-1.5-1.5Z" fill="${GOLD}"/>`
    + `<g fill="${BLACK}"><rect x="8" y="2" width="6" height="16" rx="1.5"/><rect x="18" y="2" width="6" height="16" rx="1.5"/></g>`
    + '</g>';
}
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${body}</svg>`;

const plain = svg(mark()); // tabs, the install dialog, Android "any"
const touch = svg(mark({ bleed: true })); // iOS: opaque, it rounds the corners itself
// Maskable: the keys (24 x 26 units, half-diagonal 17.7) inside the 40 %-radius safe circle (12.8 units).
const maskable = svg(mark({ bleed: true, scale: 0.7 }));

writeFileSync(resolve(ROOT, 'favicon.svg'), plain + '\n');
mkdirSync(resolve(ROOT, 'icons'), { recursive: true });

function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  for (const c of [process.env.PUPPETEER_MODULE, 'puppeteer', resolve(ROOT, 'node_modules/puppeteer'), resolve(ROOT, '../../node_modules/puppeteer')].filter(Boolean)) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('puppeteer not found; set PUPPETEER_MODULE to its path');
}
const browser = await loadPuppeteer().launch({ args: ['--no-sandbox'] });
const page = await browser.newPage();
// Renders an SVG to a px-square PNG with a transparent background.
async function png(source, px) {
  await page.setViewport({ width: px, height: px, deviceScaleFactor: 1 });
  const sized = source.replace('<svg ', `<svg width="${px}" height="${px}" `);
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
}
const outputs = [
  ['icon-16.png', plain, 16], ['icon-32.png', plain, 32], ['icon-192.png', plain, 192], ['icon-512.png', plain, 512],
  ['apple-touch-icon.png', touch, 180], ['icon-maskable-512.png', maskable, 512],
];
for (const [name, source, px] of outputs) {
  writeFileSync(resolve(ROOT, 'icons', name), await png(source, px));
  console.log(`icons/${name} ${px}x${px}`);
}

// favicon.ico: PNG-compressed entries at 16, 32 and 48 (supported by every browser that still asks for .ico).
const images = [];
for (const px of [16, 32, 48]) images.push([px, Buffer.from(await png(plain, px))]);
// ICONDIR (reserved 0, type 1 = icon, image count), then a 16-byte entry per image: width, height, palette size 0,
// reserved, 1 colour plane, 32 bits per pixel, byte length and offset of its PNG.
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach(([px, data], i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(px, e); header.writeUInt8(px, e + 1); header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
  header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8); header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
writeFileSync(resolve(ROOT, 'favicon.ico'), Buffer.concat([header, ...images.map(([, d]) => d)]));
console.log('favicon.ico 16, 32, 48');
await browser.close();
