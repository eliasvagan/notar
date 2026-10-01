# Notar

Browser-based melody composer with scrolling grand-staff notation and Web Audio playback.

**Live:** [eliasv.com/projects/notar/](https://eliasv.com/projects/notar/)

- Range C2–C6 (four octaves plus the top C), chromatic, Nordic pitch names (H = B).
- Middle C and up are written on the treble staff, lower notes on the bass staff,
  with ledger lines and measure-scoped accidentals.
- The keyboard is one continuous row of octave groups; it scrolls horizontally
  (with an octave switcher) when it does not fit, and shows every octave on wide screens.

## Installable app

Notar installs as an app (Add to Home Screen / Install) and works fully offline: `sw.js` precaches the whole
shell in a cache named after `VERSION`, a hash of the shell files, and serves it cache-first; activation deletes
older caches. After any change to a shell file run `node scripts/sw-version.mjs` (the unit test fails otherwise).
A new version downloads in the background and is applied at launch before anything is touched, or from the
quiet "Update ready" hint in the header, which never shows while playing. Compositions are saved on every
change, so that reload loses nothing. Audio starts on the first Play (browsers need a tap after launch).

Icons (`favicon.svg`, `favicon.ico`, `icons/`) are drawn by `node scripts/icons.mjs` from the keyboard's own
colours in `styles.css`.

## Shortcuts

| Key | Action |
| --- | --- |
| `A S D F G H J` | C D E F G A H in the active octave |
| `W E T Y U` | C♯ D♯ F♯ G♯ A♯ |
| `K` | C of the next octave |
| `Z` / `X` | Active octave down / up |
| `Space` | Rest |
| `Enter` / `Esc` | Play / stop |
| `Backspace` | Undo |

## Development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Every commit raises the `version` in `package.json` (`npm version patch --no-git-tag-version`).
`.githooks/pre-commit` enforces it once a clone has run `git config core.hooksPath .githooks`.

## Tests

```bash
node --test tests/sw.test.mjs   # service worker version, precache list, manifest, icon links
node tests/smoke.cjs            # layout and behaviour
node tests/e2e-pwa.cjs          # installability, control, update flow, offline reload
```

Puppeteer smoke test across phone, iPad (portrait and landscape) and desktop sizes.
It finds puppeteer in this repo, in the parent portfolio checkout (`../../node_modules`),
or at `$PUPPETEER_MODULE`.
