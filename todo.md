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

## Later

- [ ] Key and time signatures other than C major and 4/4 (beams group by quarter-note beats today; 6/8 needs dotted-quarter beats)
- [ ] Select a range of notes to copy, paste, delete or transpose together
- [ ] MIDI export
- [ ] Ties the writer chooses (two notes of the same pitch joined), and slurs
- [ ] Beams: rests inside a beam, cross-staff beams, beams that sit, straddle or hang on staff lines
- [ ] Ties that also split a note at the half bar in 4/4 where that shows the beat better (a dotted half from beat 2)
- [ ] A cautionary accidental option beyond the tie reminder (after a bar line in general)

## Found while commenting the code base

- [x] `.sr-only` in styles.css was used nowhere, and nothing styled the `.scrollable` class app.js toggled on the
      keyboard frame. Both removed in 1.1.
