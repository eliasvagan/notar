# Notar

Browser-based composer for melodies and chords, with grand-staff notation and Web Audio playback.

**Live:** [eliasv.com/projects/notar/](https://eliasv.com/projects/notar/)

- Range C2–C6 (four octaves plus the top C), chromatic, Nordic pitch names (H = B).
- Middle C and up are written on the treble staff, lower notes on the bass staff, with ledger lines and
  measure-scoped accidentals. Chords are engraved properly: a stem per staff, seconds set either side of the stem,
  stacked accidentals. Recognised chords get a symbol above the staff (C, Am7, G7, C/E, …).
- Lengths from whole to sixteenth notes, dotted or not, in 4/4. Columns widen with length and make room for
  accidentals.
- **Ties:** a note that runs past a bar line is written as tied notes of standard values (2½ beats after the bar
  line are a half tied to an eighth), every head of a chord tied, so bar lines fall where the measures really
  end. It is still one note: it sounds once, for its whole length, and the cursor, clicks, ↑ ↓ and Delete treat it
  as one. The continuation repeats no accidental; a later note in the new measure restates its own. A rest that
  crosses a bar line splits into rests, untied.
- **Beams:** eighths and sixteenths are beamed by beat. Rests and longer notes break a group; a group shares one
  stem direction, set by its note farthest from the middle line; the beam follows the outer notes at a gentle
  slope. Sixteenths get a second beam, broken for mixed and dotted rhythms (a dotted eighth and a sixteenth). A
  lone eighth or sixteenth keeps its flag. Each staff of a chord across both staves has its own beam, kept on its
  own side of the gap between the staves: a beam that would reach into the other half turns its stems around, or,
  if that leaves the drawing, gives way to flags.
- The keyboard is one continuous row of octave groups; it scrolls horizontally
  (with an octave switcher) when it does not fit, and shows every octave on wide screens.
- **Selection:** select a run of notes to delete, transpose, re-length, copy, cut, paste or play together.
- **Sound:** piano (the default), electric piano or the original soft triangle tone, and a metronome.
- **Out of Notar:** a share link that carries the composition, MIDI files, SVG and PNG images of the whole sheet,
  and a printout (or PDF) broken into lines of whole measures.

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
| With Shift, anywhere | Selects, from the cursor to there (see below) |

**Chords:** hold Shift while pressing keys, or turn on Chord (for touch), and each key stacks onto the current
note instead of starting a new one. Press a key that is already in the chord to take it out.

**Changing a length:** the length picker sets the length of new notes; the current note's own length is edged in
the accent on it, as its keys are on the keyboard. To change the current note, pick a length (and dot) and press
**Apply**, beside the picker (on a tablet, the arrow-into-note icon), or press Shift + `1`–`5` (Shift + `.` for
its dot). The notes after it move along, and Undo puts it back.

**Selecting:** a selection works as in a text field: it runs from where the cursor was (the anchor) to where the
cursor is now, and shows as one tinted region over its notes, edged in the accent and carried up through the
ruler (the current note's band is softer and has no edge, and is hidden while there is a selection).

- Keyboard: Shift + `←` `→` stretch it a note at a time from the cursor, Shift + `Home` `End` to the start or end,
  `⌘A` / `Ctrl+A` selects everything. `←` or `→` alone lets it go, at that end of it, and so does `Esc` (which
  stops playback first if anything is playing: what you hear comes first).
- Mouse: Shift + click a note to take the selection from the cursor through that note; Shift + click or drag on
  the ruler to take it to a gap. Holding Shift over the staff previews it, dashed. A plain click lets it go.
- Touch: long-press a note (about half a second, without moving) to select it, then drag along the staff to take
  in more; long-press another note to stretch an existing selection to it. A swipe still scrolls and a tap still
  writes, as before. Cut and Copy look disabled with nothing selected, but a tap on them says how to select.

With a selection, `Delete` and `Backspace` delete it, `↑` `↓` transpose it (Shift: an octave), Apply and
Shift + `1`–`5` / Shift + `.` set its length, a key with Shift (or with Chord on) adds that pitch to every
selected note, or takes it out of all of them when they all have it, and Play (or `Enter`) plays only the selection,
looping it with Loop on. Cut, Copy and Paste are in the Edit panel and on `⌘X` `⌘C` `⌘V` (`Ctrl` elsewhere): a paste goes in at the
cursor, or replaces the selection, as typing over selected text does. Each of these is one undo step, and Undo
brings back the selection an edit let go. Writing a note, or any other edit, lets the selection go too: notes
still go in at the cursor.

The clipboard is Notar's own (kept in `localStorage`, so another Notar tab can paste it) and, where the browser
allows, the system clipboard too, as text (see Files), so notes copied in one tab paste into another, or into a
text file. `⌘V` reads the system clipboard (notes copied elsewhere, or an exported file's JSON) and falls back to
Notar's own; the Paste button reads Notar's own, since reading the system clipboard from a button asks for
permission in most browsers.

Every edit can be undone and redone, Clear, Import and opening a share link included.

A piece holds at most 2000 notes: every edit redraws the whole staff, about 20 ms per thousand notes on a fast
desktop and several times that on a phone. Share links, imports, pastes and typing stop there and say so. If the
browser's storage is full or blocked, each edit says that it wasn't saved.

## Playback

Play starts at the cursor (from the beginning when the cursor is at the end), or plays the selection. Loop
repeats it; the metronome (beside Loop) clicks every beat, higher on the first of each measure, and turning it on or
off takes effect at once, mid-pass too. **Sound** picks
the voice, and is remembered:

- **Piano** (the default): additive partials of a struck string on two slightly detuned oscillators, through a
  filter that closes after the strike; it decays as a piano does, long in the bass and short in the treble, and
  a damper ends it when the note does.
- **Electric piano**: frequency modulation, with a bright attack that mellows as the note rings.
- **Soft tone**: the original triangle wave, steady for the note's length.

A chord shares its loudness between its voices (each gets 1/√n) and the three sounds are matched in loudness. The
volume is applied once, at the end, with headroom: at 100% a single piano note (whose strike peaks well above its
level) stays nearly linear, and a soft clipper, linear to 0.6 and shaping up to four times full scale, rounds off a
big chord's strike instead of cutting it. Stop silences everything at once without a click, notes still queued
included, and one starting at that very instant.

## Installable app

Notar installs as an app (Add to Home Screen / Install) and works fully offline: `sw.js` precaches the whole
shell in a cache named after `VERSION`, a hash of the shell files, and serves it cache-first; activation deletes
older caches. After any change to a shell file run `node scripts/sw-version.mjs` (the unit test fails otherwise).
Updates are checked on load and whenever the app comes back (visibility, focus, pageshow: an installed app on
iOS resumes without a load). A new version applies itself, with one reload, whenever Notar is idle: nothing
playing and nothing edited since launch (a reload would take the undo history). Otherwise the quiet "Update
ready" hint shows in the header, never while playing, and a tap applies it. A reload guard stops any update
loop. Compositions are saved on every change, so that reload loses nothing. Audio starts on the first note or Play (browsers need a tap after launch).

Icons (`favicon.svg`, `favicon.ico`, `icons/`) are drawn by `node scripts/icons.mjs` from the keyboard's own
colours in `styles.css`.

## Files and links

Import / Export holds Import, the **Export** menu (every format: Notar file, MIDI, SVG, PNG, Print) and **Share**.

**Notar file.** Export writes version 3 JSON: `{ "version": 3, "bpm": 96, "notes": [{ "pitches": ["C4", "E4", "G4"],
"duration": 4 }, { "pitches": [], "duration": 8, "dotted": true }] }`. Each note's `duration` is the note value's
denominator (1 whole … 16 sixteenth). An empty `pitches` list is a rest. Import also reads versions 1 and 2,
which have a single `pitch` per note (version 1 without octaves, read as octave 4). Copied notes go on the system
clipboard in the same shape without the tempo, `{"version":3,"notes":[…]}`.

**Share link.** Share puts the composition (its notes and tempo, nothing else) into a link and copies it (on a
phone or tablet it opens the share sheet instead), saying which it did. The link is the page's address with the
music in its hash: `#n=`, one letter for the packing, then bytes in base64url (RFC 4648 §5, no padding):

- `D`: the bytes compressed with zlib's deflate (CompressionStream), whose checksum also catches a damaged link;
- `R`: the bytes as they are, where CompressionStream is missing or deflate would come out longer (short pieces).

The bytes are a format version (1), the tempo (40–220), the note count (LEB128), then per note one byte (bits 0–2
the length's index, 1/1 to 1/16; bit 3 dotted; bits 4–7 the number of pitches, 0 for a rest) and one byte per
pitch (bits 2–7 its staff step above H♯1, bits 0–1 its accidental + 1, so C♯ and D♭ stay as written). Most notes
take two bytes. Measured hashes: 64 eighth notes in a repeating figure, 32 characters; 52 notes and chords over
12 measures, 59; 200 varied notes, 192.

Opening a link replaces the composition as one undoable edit, and the status line says that Undo brings back what
you had. The piece it replaced is also kept in `localStorage`, so no reload can lose it: after one, a bar above the
status line offers to **Bring it back** (or to forget it). An update waiting to install is not applied at that
launch, which would reload the page and take the Undo with it. The hash is cleared at once, so a reload doesn't
open the link again. A link pasted into an open Notar tab opens the same way. A damaged or tampered link (bad
characters, a failed checksum, a version, length or pitch that can't be, missing or extra bytes) opens nothing,
says so, and leaves the composition as it was; so does a link of more than 2000 notes, and a compressed link in a
browser without DecompressionStream, each with its own message. A tempo outside 40–220 is brought into that range,
in a link as in an imported file or a saved draft.

**MIDI.** A Standard MIDI File, format 0: one track, since Notar writes one instrument's part and every player, DAW
and notation program reads format 0 (format 1 would only add a separate tempo track). 480 ticks a quarter note;
the track has its name, the tempo, 4/4, C major and the General MIDI program of the chosen sound (Acoustic Grand
Piano, Electric Piano 1, or Ocarina for the soft tone), then a note-on and note-off per pitch on channel 1,
velocity 80. A chord's notes start and stop together, a tied note is one note-on and one note-off for its whole
length, a rest is the wait before the next note, and the track lasts through a closing rest. MIDI has no
spelling: C♯ and D♭ are the same key.

**Images.** SVG and PNG export the whole sheet, not just what is on screen, laid out as on paper (below), 1200
units wide. The SVG stands alone: each element's paint and font are read from the page's styles into a `<style>`
block in the file, and the G clef is embedded once. The PNG is the same drawing at twice the size (smaller for a
piece long enough to pass the browser's canvas limit).

**Print.** Print (or the browser's own Print, or Save as PDF from its dialog) shows only the music, broken into
systems (lines) of whole measures that fit the page, each system scaled to the page width and never split across
pages; clefs repeat on every system, the time signature and the tempo are on the first, and a tie across a line
break hangs off one system and comes in on the next. Systems are left ragged on the right, not stretched.

## Shortcuts

| Key | Action |
| --- | --- |
| `A S D F G H J` | C D E F G A H in the active octave |
| `W E T Y U` | C♯ D♯ F♯ G♯ A♯ |
| `K` | C of the next octave |
| Shift + note key | Stack onto the current note (chord) |
| `Z` / `X` | Active octave down / up |
| `1`–`5` | Length for new notes: 1/1, 1/2, 1/4, 1/8, 1/16 |
| `.` | Dotted on / off for new notes |
| Shift + `1`–`5` | Change the current note's length (it keeps its dot) |
| Shift + `.` | Dot the current note, or take its dot off |
| `Space` | Rest |
| `←` `→` / `Home` `End` | Move the cursor / to the start or end |
| Shift + `←` `→` / `Home` `End` | Select from the cursor, a note at a time / to the start or end |
| `⌘A` (`Ctrl+A`) | Select every note |
| `↑` `↓` | Transpose the current note, or the selection, a semitone (with Shift, an octave) |
| `Backspace` / `Delete` | Delete the note before / after the cursor, or the selection |
| `⌘C` `⌘X` `⌘V` (`Ctrl+C` `X` `V`) | Copy, cut, paste (over the selection, if there is one) |
| `⌘Z` / `⇧⌘Z` (`Ctrl+Z` / `Ctrl+Y`) | Undo / redo |
| `Enter` / `Esc` | Play from the cursor, or the selection / stop; once stopped, let the selection go |

## Development

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

Every commit raises the `version` in `package.json` (`npm version patch --no-git-tag-version`); Markdown files and
the hooks themselves need no bump. The bump also stamps the version into the page footer (`scripts/app-version.mjs`,
run by the `version` script, then `sw-version.mjs`); a unit test fails if the two ever differ. `.githooks/pre-commit` enforces it, and `.githooks/pre-push` runs the unit tests
before a push, once a clone has run `git config core.hooksPath .githooks`.

## Tests

```bash
node --test tests/sw.test.mjs   # service worker version, precache list, manifest, icon links
node tests/smoke.cjs            # layout and behaviour: keys, chords, the cursor, staff clicks, undo, playback,
                                # ties, beams and changing a note's length; share links (round trip, deflated and
                                # raw, tampered), MIDI parsed back, SVG/PNG export, print systems, the Export menu;
                                # selection (keyboard, mouse, long-press), the clipboard, playing a selection,
                                # the metronome and the sounds
node tests/e2e-pwa.cjs          # installability, control, update flow, offline reload
```

Puppeteer smoke test across phone, iPad (portrait and landscape) and desktop sizes.
It finds puppeteer in this repo, in the parent portfolio checkout (`../../node_modules`),
or at `$PUPPETEER_MODULE`.
