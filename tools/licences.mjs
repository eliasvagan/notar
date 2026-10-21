#!/usr/bin/env node
// licences.mjs: writes licences.txt, the third party notice an app ships at its root.
// Canonical copy: eliasv_com/tools/licences.mjs. Every app vendors this exact file as tools/licences.mjs. Fix it
// there first, then copy it unchanged into each app. No dependencies, Node 18 or newer.
//
// Config lives in the app's package.json:
//   "licences": { "out": "dist/prod/browser", "credits": "credits.json", "title": "GemTD" }
//   out      folder that receives licences.txt (default "."). `--out <dir>` overrides it.
//   credits  checked in manifest of everything that is not an npm package (default "credits.json", optional)
//   title    heading of the notice (default package.json displayName or name)
//   lang     "en" (default) or "nb", the language of the headings and labels
// npm packages: every production dependency in package-lock.json (dev packages are left out), read from the
// installed node_modules, with name, version, licence and the full licence text the package ships.
// credits.json: { "assets": [ { "name", "files": [], "author", "licence", "source", "notes", "licenceFile" } ] }
//   licenceFile is a path (relative to the package.json) whose text is included in full.
// Licences that need attention before monetizing (copyleft, non commercial, unknown) are printed as warnings.
// `--check` exits 1 on such a warning.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const root = path.resolve(opt('--dir') ?? '.');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const cfg = pkg.licences ?? {};
const outDir = path.resolve(root, opt('--out') ?? cfg.out ?? '.');
const title = cfg.title ?? pkg.displayName ?? pkg.name;
const T = {
  en: { sub: 'Third party licences and credits', intro: (v) => `${title}${v ? ` ${v}` : ''} includes the work of others, listed below with their licences.`, assets: 'Assets and credits', pkgs: 'Open source packages', by: 'By', licence: 'Licence', source: 'Source', files: 'Files', home: 'Home', unknown: 'Unknown', noText: (l) => `No licence text is included in the package. Its declared licence is ${l}.`, none: 'This app uses no third party packages or assets.' },
  nb: { sub: 'Tredjepartslisenser og kreditering', intro: (v) => `${title}${v ? ` ${v}` : ''} bygger på arbeid fra andre. Her er de, med lisensene sine.`, assets: 'Data, ressurser og kreditering', pkgs: 'Pakker med åpen kildekode', by: 'Av', licence: 'Lisens', source: 'Kilde', files: 'Filer', home: 'Nettside', unknown: 'Ukjent', noText: (l) => `Pakken har ingen lisenstekst med seg. Oppgitt lisens er ${l}.`, none: 'Appen bruker ingen pakker eller ressurser fra andre.' },
}[cfg.lang ?? 'en'];
const RISK = /\b(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|NC|UNLICENSED|Unknown|Ukjent|SEE LICENSE|BY-SA)\b/i;
const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;
const warnings = [];

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const licenceOf = (p) => {
  const l = p.license ?? p.licenses;
  if (!l) return 'Unknown';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ');
  return l.type ?? 'Unknown';
};
const licenceTexts = (dir) => {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => LICENCE_FILE.test(n)).sort(); } catch { /* none */ }
  return names.map((n) => fs.readFileSync(path.join(dir, n), 'utf8').trim()).filter(Boolean);
};

// npm packages from the lockfile, production only
const packages = [];
const lock = readJson(path.join(root, 'package-lock.json'));
if (lock?.packages) {
  const seen = new Set();
  for (const [where, meta] of Object.entries(lock.packages)) {
    if (!where || meta.dev || meta.link || !where.includes('node_modules/')) continue;
    const dir = path.join(root, where);
    const p = readJson(path.join(dir, 'package.json'));
    if (!p) continue; // optional package for another platform, not installed
    const key = `${p.name}@${p.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name: p.name, version: p.version, licence: licenceOf(p), author: typeof p.author === 'string' ? p.author : p.author?.name, url: p.homepage, texts: licenceTexts(dir) });
  }
} else if (Object.keys(pkg.dependencies ?? {}).length) {
  console.error('licences: package.json has dependencies but no package-lock.json'); process.exit(1);
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));

const creditsFile = path.join(root, cfg.credits ?? 'credits.json');
const assets = fs.existsSync(creditsFile) ? (readJson(creditsFile)?.assets ?? []) : [];

const rule = '='.repeat(72), thin = '-'.repeat(72);
const lines = [title, T.sub, '', T.intro(pkg.version), ''];
if (assets.length) {
  lines.push(rule, T.assets, rule, '');
  for (const a of assets) {
    lines.push(a.name);
    if (a.author) lines.push(`${T.by}: ${a.author}`);
    lines.push(`${T.licence}: ${a.licence ?? T.unknown}`);
    if (a.source) lines.push(`${T.source}: ${a.source}`);
    if (a.files?.length) lines.push(`${T.files}: ${a.files.join(', ')}`);
    if (a.notes) lines.push('', a.notes);
    if (a.licenceFile) lines.push('', fs.readFileSync(path.resolve(root, a.licenceFile), 'utf8').trim());
    lines.push('', thin, '');
    if (RISK.test(a.licence ?? 'Unknown')) warnings.push(`asset "${a.name}": ${a.licence ?? 'Unknown'}`);
  }
}
if (packages.length) {
  lines.push(rule, T.pkgs, rule, '');
  for (const p of packages) {
    lines.push(`${p.name} ${p.version}`, `${T.licence}: ${p.licence}`);
    if (p.author) lines.push(`${T.by}: ${p.author}`);
    if (p.url) lines.push(`${T.home}: ${p.url}`);
    lines.push('', p.texts.length ? p.texts.join('\n\n') : T.noText(p.licence), '', thin, '');
    if (RISK.test(p.licence)) warnings.push(`package ${p.name}@${p.version}: ${p.licence}`);
  }
}
if (!assets.length && !packages.length) lines.push(T.none, '');

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'licences.txt'), lines.join('\n'));
console.log(`licences: ${packages.length} packages, ${assets.length} assets -> ${path.relative(process.cwd(), path.join(outDir, 'licences.txt')) || 'licences.txt'}`);
for (const w of warnings) console.warn(`licences: review before monetizing: ${w}`);
if (args.includes('--check') && warnings.length) process.exit(1);
