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

## Later

- [ ] Beams for eighths and sixteenths within a beat (flags today)
- [ ] Ties: split a note that runs past a bar line instead of letting the measure overflow
- [ ] Key and time signatures other than C major and 4/4
- [ ] Select a range of notes to copy, paste, delete or transpose together
- [ ] Change the length of an existing note (today: delete it and enter it again)
- [ ] MIDI export

## Found while commenting the code base

- [x] `.sr-only` in styles.css was used nowhere, and nothing styled the `.scrollable` class app.js toggled on the
      keyboard frame. Both removed in 1.1.
