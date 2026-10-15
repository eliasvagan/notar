#!/usr/bin/env node
/**
 * Builds media/ from the app itself: a melody typed into the score key by key, then played back with the moving
 * playhead. Run `node scripts/icons.mjs` first for media/logo.png.
 *
 *     PUPPETEER=/path/to/node_modules/puppeteer node tools/media/build.mjs
 *
 * Writes media/banner.gif, banner.webp and banner.png (960x540, the still is the first frame), media/screenshots/
 * and media/media.json. Needs ffmpeg. The page runs on a virtual clock (setTimeout and the audio clock advance only
 * when a frame is captured), so every run gives the same frames. The banner ends on the finished score and fades
 * back to the empty one, so it loops without a jump.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OUT = resolve(ROOT, 'media');
const W = 960, H = 540, FPS = 25, FRAME_MS = 1000 / FPS;
const HOLD_START = 10, TYPE_FRAMES = 2, HOLD_TYPED = 10, HOLD_END = 16, FADE = 0.6; // frames, seconds
const BPM = 160;
// Ode to Joy, the first phrase, in the app's own keys (A S D F G H J = C D E F G A H, 3 = quarter, 2 = half,
// 4 = eighth, . = dotted on or off).
const MELODY = ['3', 'd', 'd', 'f', 'g', 'g', 'f', 'd', 's', 'a', 'a', 's', 'd', '.', 'd', '.', '4', 's', '2', 's'];

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
function serve() {
  const server = createServer((req, res) => {
    let file = join(ROOT, normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(ROOT)) return res.writeHead(403).end();
    try {
      if (statSync(file).isDirectory()) file = join(file, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}
async function loadPuppeteer() {
  const where = process.env.PUPPETEER;
  if (where) return (await import(pathToFileURL(createRequire(import.meta.url).resolve(resolve(where))).href)).default;
  return (await import('puppeteer')).default;
}

const server = await serve();
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await (await loadPuppeteer()).launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

/** A fresh page on the virtual clock, with an empty score; `tick()` advances the clock one frame. */
async function open([width, height]) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.evaluateOnNewDocument(() => {
    let a = 20261015;
    Math.random = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // The virtual clock: timers fire and the audio clock moves only in __tick.
    let now = 0, seq = 0;
    const timers = new Map();
    window.setTimeout = (fn, ms = 0, ...args) => { const id = ++seq; timers.set(id, { at: now + Math.max(0, +ms || 0), fn, args }); return id; };
    window.clearTimeout = (id) => timers.delete(id);
    Object.defineProperty(BaseAudioContext.prototype, 'currentTime', { get: () => now / 1000 });
    window.__tick = (ms) => {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at || (t.at === next[1].at && id < next[0]))) next = [id, t];
        if (!next) break;
        timers.delete(next[0]);
        now = Math.max(now, next[1].at);
        try { typeof next[1].fn === 'function' && next[1].fn(...next[1].args); } catch (e) { console.error(e); }
      }
      now = end;
    };
  });
  await page.goto(base, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle0' });
  await page.evaluate((bpm) => {
    const r = document.getElementById('bpm');
    r.value = String(bpm);
    r.dispatchEvent(new Event('input', { bubbles: true }));
    document.activeElement?.blur();
  }, BPM);
  await page.evaluate(() => document.fonts.ready);
  // The composition panel at the top of the view (on a phone, the page as it opens).
  if (width > height) await page.evaluate(() => window.scrollTo(0, document.querySelector('.staff-panel').getBoundingClientRect().top + window.scrollY - 16));
  const paint = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const tick = async () => { await page.evaluate((ms) => window.__tick(ms), FRAME_MS); await paint(); };
  await tick();
  return { page, context, tick };
}

const isNote = (k) => /^[asdfghjkwetyu]$/.test(k);
async function type(page, keys) { for (const k of keys) await page.keyboard.press(k === '.' ? 'Period' : k.length === 1 && /[a-z]/.test(k) ? `Key${k.toUpperCase()}` : `Digit${k}`); }

mkdirSync(join(OUT, 'screenshots'), { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), 'notar-media-'));
let frame = 0;
try {
  const { page, context, tick } = await open([W, H]);
  const shot = async () => { await page.screenshot({ path: join(tmp, `${String(frame++).padStart(4, '0')}.png`) }); };
  const hold = async (n) => { for (let i = 0; i < n; i++) { await tick(); await shot(); } };
  await hold(HOLD_START);
  // Typing: settings keys go in with the next note, each note gets TYPE_FRAMES frames.
  let pending = [];
  for (const k of MELODY) {
    pending.push(k);
    if (!isNote(k)) continue;
    await type(page, pending);
    pending = [];
    await hold(TYPE_FRAMES);
  }
  await hold(HOLD_TYPED);
  // Playback from the start: Home, then Enter, on the virtual clock until it finishes.
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  for (let i = 0; i < 2000; i++) {
    await tick(); await shot();
    if (!(await page.evaluate(() => document.getElementById('playBtn').disabled))) break;
  }
  await page.keyboard.press('End');
  await hold(HOLD_END);
  await page.screenshot({ path: join(OUT, 'screenshots', '01-score.png') });
  await context.close();
  copyFileSync(join(tmp, '0000.png'), join(OUT, 'banner.png'));

  const offset = (frame / FPS - FADE).toFixed(3);
  const loop = `[0]fps=${FPS}[a];[1]fps=${FPS},trim=duration=${FADE}[b];[a][b]xfade=transition=fade:duration=${FADE}:offset=${offset}`;
  const inputs = ['-framerate', String(FPS), '-i', join(tmp, '%04d.png'), '-loop', '1', '-framerate', String(FPS), '-t', String(FADE), '-i', join(tmp, '0000.png')];
  const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, ...a], { stdio: 'inherit' });
  ff('-filter_complex', `${loop},split[x][y];[x]palettegen=max_colors=64:stats_mode=diff[p];[y][p]paletteuse=dither=none:diff_mode=rectangle`, '-loop', '0', join(OUT, 'banner.gif'));
  ff('-filter_complex', loop, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', '80', '-loop', '0', join(OUT, 'banner.webp'));

  // Screenshots: the score mid playback on a desktop and on a phone.
  const screenshots = [{ src: 'screenshots/01-score.png', caption: 'The first phrase of Ode to Joy, typed on the computer keyboard' }];
  for (const [name, view, caption, ticks] of [
    ['02-playback', [1280, 800], 'Playback, the playhead and the keys follow the music', 60],
    ['03-phone', [390, 844], 'On a phone, playback controls above the score', 45],
  ]) {
    const v = await open(view);
    await type(v.page, MELODY);
    await v.page.keyboard.press('Home');
    await v.page.keyboard.press('Enter');
    for (let i = 0; i < ticks; i++) await v.tick();
    await v.page.screenshot({ path: join(OUT, 'screenshots', `${name}.png`) });
    await v.context.close();
    screenshots.push({ src: `screenshots/${name}.png`, caption });
  }

  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const manifest = {
    logo: 'logo.png',
    banner: { webp: 'banner.webp', gif: 'banner.gif', still: 'banner.png' },
    screenshots,
    version: pkg.version,
    commit: git('rev-parse', '--short', 'HEAD'),
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  };
  writeFileSync(join(OUT, 'media.json'), `${JSON.stringify(manifest, null, '\t')}\n`);
  console.log(`${frame} frames, ${(frame / FPS).toFixed(1)} s`);
  for (const f of ['logo.png', 'banner.png', 'banner.gif', 'banner.webp', ...screenshots.map((s) => s.src)]) {
    console.log(`media/${f} ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KB`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
  await browser.close();
  server.close();
}
