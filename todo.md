# To do

## Notar 1.1: chords, a real cursor, click-to-place (October 2026)

- [x] Chords: a note holds a list of pitches (one = note, several = chord, none = rest)
- [x] Engraving: stems per staff, seconds displaced across the stem, stacked accidentals, ledger lines, dots, 1/16
- [x] Chord symbols above the staff for recognised chords (C, Am, G7, C/E, …)
- [x] Spacing that widens with note length and makes room for accidentals; bar lines follow the music
- [x] Cursor: notes go in where it is; ruler with measure numbers; click or drag the ruler; ← → Home End
- [x] Current note (just before the cursor) highlighted on the staff and on the keyboard
- [x] Click the staff: ghost preview; append past the end; chord tone on a column; remove a head; insert at the cursor
- [x] Shift / Chord toggle stacks keys onto the current note
- [x] Dotted notes and 1/16; keys 1–5 and `.`
- [x] ↑ ↓ transpose the current note (Shift: an octave)
- [x] Undo / redo for every edit (Clear and Import too); Delete button for touch
- [x] Hear notes as they are entered; Play starts at the cursor
- [x] 4/4 time signature
- [x] Fixes: playhead hides when stopped; Stop silences scheduled notes; highlights survive a redraw
- [x] Export v3; v1/v2 files and saved drafts still load
- [x] Tests, README, version 1.1.0

## Ties, beams and changing a note's length (October 2026)

- [x] Ties: a note that runs past a bar line is drawn split at it into tied standard values (dots allowed, 32nds
      where dotted sixteenths leave one), every head of a chord tied; rests split untied. Bar lines fall at the
      true measure boundaries. Still one note for playback, the cursor, clicks, ↑ ↓ and Delete
- [x] Ties and accidentals: the continuation repeats none; a later note in the new measure restates its own, and a
      natural after a tied-over sharp or flat is printed as a reminder
- [x] Beams for eighths and sixteenths within a beat (rests and longer notes break a group): one stem direction
      per group, slope from the outer notes (clamped, level for concave shapes), stems lengthened to the beam and
      to the middle line, secondary and broken beams, chords, a beam per staff; lone notes keep their flags
- [x] Change the length of an existing note: Apply beside the length picker, Shift+1–5 and Shift+.; the current
      note's length is edged on the picker; undoable
- [x] Playback lights every segment of a tied note, and the playhead steps across them

## Sharing, MIDI, images, print, selection and sound (October 2026)

- [x] Share link: notes and tempo packed into the URL hash (deflated with CompressionStream, raw where that is
      missing or longer), copied (the share sheet on phones); opening one is one undoable edit that says Undo brings
      back the draft, then clears the hash; damaged or tampered links open nothing and say so; a link pasted into an
      open tab opens too
- [x] MIDI export: SMF format 0, tempo, 4/4, the sound's General MIDI program, chords, rests, dots, tied notes as one
      note-on/off; parsed back in the smoke test
- [x] Image export: the whole sheet as a self-contained SVG (computed styles in a `<style>` block, clef embedded once)
      and a PNG at 2×
- [x] Print and Save as PDF: systems of whole measures that fit the page, reusing the engraving; ties hang across a
      line break; a print stylesheet shows only the music
- [x] Selection: Shift + arrows, Home, End and ⌘A; Shift+click and Shift+drag on the ruler, with a dashed preview; a
      long-press and drag on touch screens; one tinted region; Delete, ↑ ↓, Apply and Shift + 1–5 / . act on it; Esc
      stops playback first, then lets it go
- [x] Clipboard: Cut, Copy, Paste (Edit panel and ⌘X ⌘C ⌘V); Notar's own clipboard in localStorage for other tabs,
      the system clipboard as text where allowed; paste replaces a selection; every operation one undo step
- [x] Play plays only the selection (and loops it)
- [x] Sounds: piano (additive partials, two detuned strings, a closing filter, piano-like decay), electric piano (FM)
      and the soft tone; persisted; matched in loudness (measured offline); a soft clipper instead of clipping; a
      metronome toggle
- [x] Export menu (the formats under one Export button) and Share in the Import / Export tray; Edit's clipboard tray
- [x] Tests, README, todo

## Review fixes (October 2026)

- [x] A share link opened while an update waits: pwa.js no longer reloads into the update at that launch (the
      reload took the Undo with it); the replaced piece is kept in localStorage, with a Bring back bar after a reload
- [x] Pieces stop at 2000 notes (links, imports, pastes, typing), each with its own message; a 300-character link of
      100 000 notes froze the tab; a failed save is reported
- [x] The metronome turned off mid-pass stops its queued clicks (and turned on, joins in at the next beat)
- [x] The Export menu gives focus back to its button after a choice, and keeps every key pressed in it
- [x] Shift + a key, or Chord, with a selection adds the pitch to every selected note (or takes it out of all)
- [x] Volume applied once, with headroom: the piano no longer hard-clips at full volume; the soft clipper shapes up
      to four times full scale
- [x] Stop at the instant a note starts no longer bursts (cancelAndHoldAtTime; a render quantum's grace without it)
- [x] Tempos from files, drafts and links brought into 40–220 BPM; one that isn't a number is left out
- [x] A compressed link in a browser without DecompressionStream says so, rather than "damaged"

## Later

- [ ] Key and time signatures other than C major and 4/4 (beams group by quarter-note beats today; 6/8 needs dotted-quarter beats)
- [x] Select a range of notes to copy, paste, delete or transpose together
- [x] MIDI export
- [ ] Ties the writer chooses (two notes of the same pitch joined), and slurs
- [ ] Beams: rests inside a beam, cross-staff beams, beams that sit, straddle or hang on staff lines
- [ ] Ties that also split a note at the half bar in 4/4 where that shows the beat better (a dotted half from beat 2)
- [ ] A cautionary accidental option beyond the tie reminder (after a bar line in general)
- [ ] Printed systems stretched to the full width (justified), not ragged: needs the columns re-placed per system
- [ ] A title (and composer) for a composition, printed above the music and named in exports and share links
- [ ] MIDI import; MIDI with each hand (staff) on its own track
- [ ] Select by dragging across the staff itself (today the staff's drag is the page's scroll on touch, and a click
      writes, so a mouse selects with Shift or along the ruler)
- [ ] The Paste button reading the system clipboard too (most browsers ask for permission from a button)
- [ ] A count-in bar from the metronome; dynamics (velocity) and a sustain pedal for the piano
- [ ] Redraw only what an edit changes, so pieces longer than 2000 notes stay quick (the limit is the full redraw)
- [ ] A volume slider on a perceptual (dB) curve; it is linear in amplitude today

## Found while commenting the code base

- [x] `.sr-only` in styles.css was used nowhere, and nothing styled the `.scrollable` class app.js toggled on the
      keyboard frame. Both removed in 1.1.
