# Notar

Browser-based composer for melodies and chords, with grand-staff notation and Web Audio playback.

**Live:** [eliasv.com/projects/notar/](https://eliasv.com/projects/notar/)

- Range C2–C6 (four octaves plus the top C), chromatic, Nordic pitch names (H = B).
- Middle C and up are written on the treble staff, lower notes on the bass staff, with ledger lines and
  measure-scoped accidentals. Chords are engraved properly: a stem per staff, seconds set either side of the stem,
  stacked accidentals. Recognised chords get a symbol above the staff (C, Am7, G7, C/E, …).
- Lengths from whole to sixteenth notes, dotted or not, in 4/4. Columns widen with length and make room for
  accidentals; a note that runs past a bar line stays whole, and the bar line follows it.
- The keyboard is one continuous row of octave groups; it scrolls horizontally
  (with an octave switcher) when it does not fit, and shows every octave on wide screens.

## Writing

The **cursor** (the blue line, with the next note's length on its handle) is where new notes go: keys, the
piano and Rest insert there and move it on. The note just before it is the **current note**, tinted on the
staff, with its keys marked on the keyboard; chord tones, ↑ ↓ and Delete act on it. Every note sounds as you
enter it.

Click the **staff** itself (a mouse sees a preview first):

| Where | What happens |
| --- | --- |
| Past the music | A new note at that line or space |
| On a note's column | That pitch joins the note as a chord tone (a rest becomes the note) |
| On a head of the current chord | That pitch comes out of the chord |
| On another note's head | That note becomes the current one |
| On the cursor line | A new note there, between the notes either side |
| The ruler along the top | Moves the cursor (click or drag) |

**Chords:** hold Shift while pressing keys, or turn on Chord (for touch), and each key stacks onto the current
note instead of starting a new one. Press a key that is already in the chord to take it out.

Every edit can be undone and redone, Clear and Import included.

## Installable app

Notar installs as an app (Add to Home Screen / Install) and works fully offline: `sw.js` precaches the whole
shell in a cache named after `VERSION`, a hash of the shell files, and serves it cache-first; activation deletes
older caches. After any change to a shell file run `node scripts/sw-version.mjs` (the unit test fails otherwise).
A new version downloads in the background and is applied at launch before anything is touched, or from the
quiet "Update ready" hint in the header, which never shows while playing. Compositions are saved on every
change, so that reload loses nothing. Audio starts on the first note or Play (browsers need a tap after launch).

Icons (`favicon.svg`, `favicon.ico`, `icons/`) are drawn by `node scripts/icons.mjs` from the keyboard's own
colours in `styles.css`.

## Files

Export writes version 3 JSON: `{ "version": 3, "bpm": 96, "notes": [{ "pitches": ["C4", "E4", "G4"],
"duration": 4 }, { "pitches": [], "duration": 8, "dotted": true }] }`. Each note's `duration` is the note value's
denominator (1 whole … 16 sixteenth). An empty `pitches` list is a rest. Import also reads versions 1 and 2,
which have a single `pitch` per note (version 1 without octaves, read as octave 4).

## Shortcuts

| Key | Action |
| --- | --- |
| `A S D F G H J` | C D E F G A H in the active octave |
| `W E T Y U` | C♯ D♯ F♯ G♯ A♯ |
| `K` | C of the next octave |
| Shift + note key | Stack onto the current note (chord) |
| `Z` / `X` | Active octave down / up |
| `1`–`5` | Length: 1/1, 1/2, 1/4, 1/8, 1/16 |
| `.` | Dotted on / off |
| `Space` | Rest |
| `←` `→` / `Home` `End` | Move the cursor / to the start or end |
| `↑` `↓` | Transpose the current note a semitone (with Shift, an octave) |
| `Backspace` / `Delete` | Delete the note before / after the cursor |
| `⌘Z` / `⇧⌘Z` (`Ctrl+Z` / `Ctrl+Y`) | Undo / redo |
| `Enter` / `Esc` | Play from the cursor / stop |

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
node tests/smoke.cjs            # layout and behaviour: keys, chords, the cursor, staff clicks, undo, playback
node tests/e2e-pwa.cjs          # installability, control, update flow, offline reload
```

Puppeteer smoke test across phone, iPad (portrait and landscape) and desktop sizes.
It finds puppeteer in this repo, in the parent portfolio checkout (`../../node_modules`),
or at `$PUPPETEER_MODULE`.
