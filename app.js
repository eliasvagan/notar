/*
 * Notar itself: the pitch model, the on-screen keyboard, the grand staff (engraved as SVG) and editing on it, Web
 * Audio playback, undo history, persistence, import/export, share links, MIDI, image and print output, in one IIFE
 * with no dependencies. index.html loads it before pwa.js and supplies every element in `ui` below.
 *
 *   - A composition is state.notes: [{ pitches, duration, dotted? }]. pitches lists pitch ids like "C4", "F#3",
 *     "Eb5" (C2–C6), low to high: one is a note, several a chord, none a rest. duration is the note value's
 *     denominator (1 whole … 16 sixteenth); dotted makes a note half as long again.
 *   - state.caret is the cursor: the gap before note `caret`, from 0 to notes.length. New notes go in there. The
 *     note just before it is the current note, which chord tones, transposing, length changes and Delete act on.
 *   - state.anchor, when set, is the other end of a selection: the notes between it and the cursor (selection()),
 *     as in a text field. While there is one, Delete, ↑ ↓, Apply, copy, cut, paste and Play act on it instead of
 *     the current note; any other edit, or moving the cursor without Shift, lets it go.
 *   - The model never splits a note. Only the engraving does (engrave): a note that crosses a bar line is drawn
 *     as tied segments, and eighths and shorter are beamed by beat. Playback, the cursor, every edit, MIDI export
 *     and share links see one note. The same layout is drawn as one long line on screen and broken into systems
 *     of whole measures for printing and image export (drawSystem).
 *   - Every change to the notes goes through edit(): one undo step, then the staff is redrawn in full and the draft
 *     saved to localStorage at once, so a reload (pwa.js applying an update) loses nothing.
 *   - pwa.js and the tests read window.Notar (end of file); "notar:playback" events on document tell pwa.js
 *     when playback starts and stops.
 *   - This file is part of the precached shell: after editing it, run node scripts/sw-version.mjs.
 */
(function () {
	"use strict";

	// ── Pitch model ──────────────────────────────────────────────────────────
	// Nordic step names (H = B natural). A pitch is stored as a compact string:
	// step + optional accidental (# or b) + octave, e.g. "C4", "F#3", "Eb5".
	// Scientific octave numbering: C4 is middle C, A4 = 440 Hz.
	const STEPS = ["C", "D", "E", "F", "G", "A", "H"];
	const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11 };
	// The octaves with a full group of keys and a tab; the range closes on one more key, C6.
	const OCTAVES = [2, 3, 4, 5];
	const LOWEST_MIDI = 36; // C2
	const HIGHEST_MIDI = 84; // C6
	// The computer keyboard's octave on a first visit, and the octave of a version-1 pitch, which has none.
	const DEFAULT_OCTAVE = 4;
	// Black keys sit after these white-key indices (C, D, F, G, A).
	const BLACK_AFTER = [0, 1, 3, 4, 5];
	// Each semitone of an octave as the keyboard spells it, with sharps: [step, alter]. Transposing by semitones
	// spells its results this way too.
	const SHARP_SPELLING = [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [3, 0], [3, 1], [4, 0], [4, 1], [5, 0], [5, 1], [6, 0]];
	const MAX_CHORD = 10; // pitches in one chord: ten fingers

	// Note lengths, each the denominator of a whole note (4 = quarter). A length's index in this list is the value
	// of the hidden #duration slider, of its radio in #durationPicker and of its number key (index + 1).
	const DURATIONS = [
		{ label: "1/1", value: 1 },
		{ label: "1/2", value: 2 },
		{ label: "1/4", value: 4 },
		{ label: "1/8", value: 8 },
		{ label: "1/16", value: 16 },
	];
	const VALID_DURATIONS = DURATIONS.map((entry) => entry.value);
	const QUARTER_INDEX = 2;

	// Chord symbols: a pitch-class set, as semitones above the root, and the suffix written after the root's name.
	// chordName tries the lowest note as the root first, so an inversion reads as a slash chord (C/E), and C–E–G–A
	// is C6 while A–C–E–G is Am7.
	const CHORD_TYPES = [
		[[0, 4, 7], ""],
		[[0, 3, 7], "m"],
		[[0, 3, 6], "dim"],
		[[0, 4, 8], "+"],
		[[0, 5, 7], "sus4"],
		[[0, 2, 7], "sus2"],
		[[0, 4, 7, 10], "7"],
		[[0, 4, 7, 11], "maj7"],
		[[0, 3, 7, 10], "m7"],
		[[0, 3, 6, 10], "m7♭5"],
		[[0, 3, 6, 9], "dim7"],
		[[0, 4, 7, 9], "6"],
		[[0, 3, 7, 9], "m6"],
		[[0, 3, 7, 11], "m(maj7)"],
		[[0, 5, 7, 10], "7sus4"],
		[[0, 2, 4, 7], "add9"],
		[[0, 2, 4, 7, 10], "9"],
		[[0, 2, 4, 7, 11], "maj9"],
		[[0, 2, 3, 7, 10], "m9"],
	];

	// ── Staff geometry (grand staff) ─────────────────────────────────────────
	// SVG user units; drawStaff sizes the SVG to its viewBox, so one unit is one CSS px. Each staff places its notes
	// from its own bottom line (staffPlacement): the gap between the two staves is layout, not pitch. From the top:
	// the ruler, room for chord symbols and ledger lines up to C6, the treble staff, the gap, the bass staff, and
	// room for ledger lines down to C2.
	const RULER_HEIGHT = 22; // the strip with measure numbers and the cursor's handle; clicking it moves the cursor
	const BEAT_WIDTH = 60; // a quarter note's column; empty measures are four of these
	const BEATS_PER_MEASURE = 4; // 4/4 throughout, a beat is a quarter note
	const STAFF_LEFT = 84; // x of the first bar line; brace, clefs and time signature sit to its left
	const LINE_GAP = 6; // half a staff space: one diatonic step
	const SPACE = LINE_GAP * 2;
	const TREBLE_TOP = 78; // F5 line
	const TREBLE_BOTTOM = TREBLE_TOP + SPACE * 4; // E4 line
	const BASS_TOP = TREBLE_BOTTOM + 66; // A3 line
	const BASS_BOTTOM = BASS_TOP + SPACE * 4; // G2 line
	const STAFF_HEIGHT = BASS_BOTTOM + 44; // styles.css gives #staffSvg the same height
	const CHORD_SYMBOL_Y = TREBLE_TOP - 36; // baseline: clear of a C6's head and ledger lines
	// Engraving: a head is an ellipse tilted 20°; the stem stands on its right (stem up) or left (stem down) edge. In
	// a chord, the upper note of a second moves across the stem (SECOND_SHIFT). Accidentals stack leftwards from the
	// leftmost head in columns.
	const HEAD_RX = 7.5;
	const HEAD_RY = 5.5;
	const STEM_X = 6.8;
	const SECOND_SHIFT = STEM_X * 2;
	const STEM_LENGTH = 36; // three staff spaces
	const ACC_GAP = 9.5; // leftmost head edge to the first column of accidentals
	const ACC_COLUMN = 9;
	const ROOM_AFTER = BEAT_WIDTH * 3; // empty staff kept after the music, to click new notes into
	const CURSOR_NUDGE = 3; // the cursor line sits this far right of its gap, so a bar line there doesn't hide it
	// Beams: a bar is a little under half a staff space thick; secondary bars sit BEAM_STEP further toward the
	// heads. The shortest stem in a group, head centre to the beam's outer edge, is BEAM_STEM plus BEAM_STEM_EXTRA
	// for each bar after the first, so sixteenths keep clear stem between head and beams. Slope is at most
	// BEAM_SLOPE (rise over run), and a broken beam is BEAM_STUB long, about a head.
	const BEAM_THICK = 5;
	const BEAM_STEP = 8;
	const BEAM_STEM = 32;
	const BEAM_STEM_EXTRA = 6;
	const BEAM_SLOPE = 0.25;
	const BEAM_STUB = 11;
	// Each staff's beams stay in their own band (beamFits): the treble's above the middle of the gap between the
	// staves, the bass's below it, BEAM_CLEAR clear of that line, so the two hands' beams and stems never meet.
	const GAP_MIDDLE = (TREBLE_BOTTOM + BASS_TOP) / 2;
	const BEAM_CLEAR = 1;
	const TIE_ROOM = 10; // extra room before a tied continuation's heads, so even a 32nd's tie reads as an arc
	const CLEF_HREF = "assets/g-clef.svg";
	// Printing and image export break the music into systems (lines) of whole measures, SHEET_WIDTH units wide, so
	// about four measures of quarter notes: on an A4 page that is a staff 7 mm tall, the usual size for piano music.
	// The first system starts at STAFF_LEFT, after the time signature; later ones, which repeat only the clefs, at
	// SYSTEM_LEFT. A system is the staff without its ruler, SYSTEM_HEIGHT tall; SYSTEM_GAP separates systems in an
	// image (the print stylesheet spaces them on paper).
	const SHEET_WIDTH = 1200;
	const SYSTEM_LEFT = 66;
	const SHEET_MARGIN = 16;
	const SYSTEM_HEIGHT = STAFF_HEIGHT - RULER_HEIGHT;
	const SYSTEM_GAP = 24;
	// A PNG is drawn at twice the SVG's size, but never above this many pixels: iOS Safari's canvas limit.
	const MAX_CANVAS_PIXELS = 16777216;

	// ── Rhythm: written values ───────────────────────────────────────────────
	// The engraver counts time in units of a 32nd note, so every position and length is a whole number: the
	// shortest note is a dotted sixteenth (3 units), and splitting at a bar line can leave a 32nd.
	const UNITS_PER_BEAT = 8;
	const MEASURE_UNITS = UNITS_PER_BEAT * BEATS_PER_MEASURE;
	// The values a note is written in, longest first. Every length a note can have is one of them, so a note inside
	// one measure is a single value; a piece cut off at a bar line is a sum of them.
	const WRITTEN_VALUES = [
		{ units: 32, duration: 1, dotted: false },
		{ units: 24, duration: 2, dotted: true },
		{ units: 16, duration: 2, dotted: false },
		{ units: 12, duration: 4, dotted: true },
		{ units: 8, duration: 4, dotted: false },
		{ units: 6, duration: 8, dotted: true },
		{ units: 4, duration: 8, dotted: false },
		{ units: 3, duration: 16, dotted: true },
		{ units: 2, duration: 16, dotted: false },
		{ units: 1, duration: 32, dotted: false },
	];
	// Flags or beams per written value: eighths one, sixteenths two, 32nds three; a quarter and longer none.
	const BEAM_COUNT = { 8: 1, 16: 2, 32: 3 };

	// ── Computer-keyboard shortcuts ──────────────────────────────────────────
	// Computer keyboard: one piano octave laid out like a DAW (home row = white
	// keys, row above = sharps). K reaches the C of the next octave.
	// step indexes STEPS, alter 1 is a sharp, shift is octaves above state.octave. Keys are matched on event.key,
	// the character typed, so on other layouts (AZERTY, QWERTZ) the letters count, not the key positions.
	const KEY_MAP = {
		a: { step: 0, alter: 0, shift: 0 },
		w: { step: 0, alter: 1, shift: 0 },
		s: { step: 1, alter: 0, shift: 0 },
		e: { step: 1, alter: 1, shift: 0 },
		d: { step: 2, alter: 0, shift: 0 },
		f: { step: 3, alter: 0, shift: 0 },
		t: { step: 3, alter: 1, shift: 0 },
		g: { step: 4, alter: 0, shift: 0 },
		y: { step: 4, alter: 1, shift: 0 },
		h: { step: 5, alter: 0, shift: 0 },
		u: { step: 5, alter: 1, shift: 0 },
		j: { step: 6, alter: 0, shift: 0 },
		k: { step: 0, alter: 0, shift: 1 },
	};
	// The letter printed on each key: white keys by step, sharps by the step they raise.
	const WHITE_HINTS = ["A", "S", "D", "F", "G", "H", "J"];
	const BLACK_HINTS = { 0: "W", 1: "E", 3: "T", 4: "Y", 5: "U" };

	// ── State and DOM ────────────────────────────────────────────────────────
	// localStorage key of the saved draft (saveToStorage). Older drafts still load: normalizeNote reads notes with a
	// single `pitch`, and parsePitch reads version-1 pitches, which have no octave, as octave 4.
	const STORAGE_KEY = "notar-composition-v1";
	// Notar's own clipboard: the notes last copied or cut. In localStorage, so another tab of Notar can paste them
	// even where the browser keeps the system clipboard to itself.
	const CLIPBOARD_KEY = "notar-clipboard-v1";
	// The piece a share link replaced, kept until it is brought back or forgotten (writeBackup).
	const BACKUP_KEY = "notar-before-link-v1";
	const HISTORY_LIMIT = 200; // undo steps kept
	// The most notes a piece may have. Every edit redraws the whole staff, which takes about 20 ms per thousand notes
	// on a fast desktop (measured, chords and beams included) and several times that on a phone, so beyond this
	// every key press would lag. A three-minute piece of eighth notes is about 700. Share links, imports, pastes and
	// typing all stop here, and say so.
	const MAX_NOTES = 2000;
	const LONG_PRESS_MS = 450; // a touch held this long on the staff starts a selection; moving first scrolls instead

	// Elements from index.html. Every one is required except #durationPicker, which is checked before use.
	const ui = {
		volume: document.getElementById("volume"),
		volumeLabel: document.getElementById("volumeLabel"),
		duration: document.getElementById("duration"),
		durationLabel: document.getElementById("durationLabel"),
		bpm: document.getElementById("bpm"),
		bpmLabel: document.getElementById("bpmLabel"),
		playBtn: document.getElementById("playBtn"),
		stopBtn: document.getElementById("stopBtn"),
		undoBtn: document.getElementById("undoBtn"),
		redoBtn: document.getElementById("redoBtn"),
		deleteBtn: document.getElementById("deleteBtn"),
		clearBtn: document.getElementById("clearBtn"),
		loopBtn: document.getElementById("loopBtn"),
		exportBtn: document.getElementById("exportBtn"),
		importBtn: document.getElementById("importBtn"),
		importInput: document.getElementById("importInput"),
		piano: document.getElementById("piano"),
		keyboardFrame: document.getElementById("keyboardFrame"),
		restBtn: document.getElementById("restBtn"),
		dotBtn: document.getElementById("dotBtn"),
		applyLengthBtn: document.getElementById("applyLengthBtn"),
		chordBtn: document.getElementById("chordBtn"),
		octaveTabs: document.getElementById("octaveTabs"),
		octaveDownBtn: document.getElementById("octaveDownBtn"),
		octaveUpBtn: document.getElementById("octaveUpBtn"),
		staffSvg: document.getElementById("staffSvg"),
		staffScroll: document.getElementById("staffScroll"),
		noteCount: document.getElementById("noteCount"),
		status: document.getElementById("status"),
		durationPicker: document.getElementById("durationPicker"),
		cutBtn: document.getElementById("cutBtn"),
		copyBtn: document.getElementById("copyBtn"),
		pasteBtn: document.getElementById("pasteBtn"),
		shareBtn: document.getElementById("shareBtn"),
		exportMenuBtn: document.getElementById("exportMenuBtn"),
		exportMenu: document.getElementById("exportMenu"),
		midiBtn: document.getElementById("midiBtn"),
		svgBtn: document.getElementById("svgBtn"),
		pngBtn: document.getElementById("pngBtn"),
		printBtn: document.getElementById("printBtn"),
		printSheet: document.getElementById("printSheet"),
		instrumentPicker: document.getElementById("instrumentPicker"),
		metronomeBtn: document.getElementById("metronomeBtn"),
		restoreBar: document.getElementById("restoreBar"),
		restoreText: document.getElementById("restoreText"),
		restoreBtn: document.getElementById("restoreBtn"),
		forgetBtn: document.getElementById("forgetBtn"),
	};

	// Read live (.matches) at each use, so a change to the OS setting applies without a reload.
	const reduceMotion = window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: { matches: false };
	// A finger is less precise than a mouse: the insert target around the cursor line is wider on touch screens.
	const coarsePointer = window.matchMedia ? window.matchMedia("(pointer: coarse)") : { matches: false };

	// notes and caret: the composition and the cursor (see the header); anchor: the selection's other end, or null.
	// selectedDuration and dotted: the length new notes get. chordMode: keys stack onto the current note, as if
	// Shift were held. volume: the master gain, 0–1. bpm: quarter-note beats per minute. octave: the one the
	// computer keyboard plays, from OCTAVES. instrument: a key of INSTRUMENTS; metronome: a click on every beat
	// while playing. pass: the playback pass now sounding, for the metronome (runPass). playbackToken: bumped by
	// stopPlayback; a run that sees it change has been cancelled.
	// audioContext and masterGain are created on first use (ensureAudio). layout: the last engrave() result, which
	// drawing, clicks and playback share. past and future: undo and redo steps (snapshots). clipboard: the notes
	// last copied in this tab. hover: the pointer's last staff position while a mouse is over it; dragging: the
	// cursor is being dragged along the ruler, and dragExtend: with Shift, so the drag selects. touchTarget: the
	// element a finger on the staff came down on, which drawStaff keeps. sounding: the note lit during playback, and
	// soundingSegment: which of its written segments the playhead is on (a tied note has several).
	const state = {
		notes: [],
		caret: 0,
		anchor: null,
		selectedDuration: 4,
		dotted: false,
		chordMode: false,
		volume: 0.35,
		bpm: 96,
		loop: false,
		octave: DEFAULT_OCTAVE,
		instrument: "piano",
		metronome: false,
		clipboard: [],
		playing: false,
		pass: null,
		playbackToken: 0,
		audioContext: null,
		masterGain: null,
		layout: null,
		past: [],
		future: [],
		hover: null,
		dragging: false,
		dragExtend: false,
		touchTarget: null,
		saveFailed: false,
		trimmedFrom: 0,
		sounding: null,
		soundingSegment: 0,
	};

	// Every voice scheduled and not yet ended, so Stop can silence what is already queued on the audio clock: one per
	// pitch sounded (and per metronome click), { sources (its oscillators), gain (its envelope), start }. The clicks
	// are in `clicks` too, so turning the metronome off can stop the ones still queued and leave the notes.
	const voices = new Set();
	const clicks = new Set();

	// ── Pitch helpers ────────────────────────────────────────────────────────
	/**
	 * Reads a stored or imported pitch: "rest" gives { rest: true }, a pitch id gives { step, alter, octave } (step
	 * indexes STEPS, alter is -1, 0 or 1). Nordic B takes no accidental and reads as Hb. null for anything else, or
	 * for a pitch outside C2–C6.
	 */
	function parsePitch(raw) {
		if (raw === "rest") {
			return { rest: true };
		}
		if (typeof raw !== "string") {
			return null;
		}
		const match = /^([CDEFGAHB])(#|b)?(-?\d)?$/.exec(raw.trim());
		if (!match) {
			return null;
		}
		let letter = match[1];
		let alter = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
		// Nordic B is H flat.
		if (letter === "B") {
			if (alter !== 0) {
				return null;
			}
			letter = "H";
			alter = -1;
		}
		// Version-1 files had no octave: they were all the octave from C4.
		const octave = match[3] === undefined ? DEFAULT_OCTAVE : Number(match[3]);
		const pitch = { step: STEPS.indexOf(letter), alter, octave };
		return inRange(pitch) ? pitch : null;
	}

	function inRange(pitch) {
		const midi = pitchMidi(pitch);
		return midi >= LOWEST_MIDI && midi <= HIGHEST_MIDI;
	}

	// Three spellings of a pitch. pitchId is the stored form and each key's data-pitch (ASCII # and b); pitchLabel
	// is for the status line and the staff (♯ ♭); pitchSpoken is for accessible names and tooltips ("C sharp 4").
	function pitchId(pitch) {
		if (pitch.rest) {
			return "rest";
		}
		const accidental = pitch.alter === 1 ? "#" : pitch.alter === -1 ? "b" : "";
		return `${STEPS[pitch.step]}${accidental}${pitch.octave}`;
	}

	// MIDI note number: C4 = 60, A4 = 69.
	function pitchMidi(pitch) {
		return 12 * (pitch.octave + 1) + STEP_SEMITONES[STEPS[pitch.step]] + pitch.alter;
	}

	// Equal temperament from A4 = 440 Hz.
	function pitchFrequency(pitch) {
		return 440 * Math.pow(2, (pitchMidi(pitch) - 69) / 12);
	}

	// The step's name and accidental, no octave: "F♯", "H♭". Chord symbols use it for roots and bass notes.
	function pitchName(pitch) {
		const accidental = pitch.alter === 1 ? "♯" : pitch.alter === -1 ? "♭" : "";
		return `${STEPS[pitch.step]}${accidental}`;
	}

	function pitchLabel(pitch) {
		return pitch.rest ? "rest" : `${pitchName(pitch)}${pitch.octave}`;
	}

	function pitchSpoken(pitch) {
		if (pitch.rest) {
			return "Rest";
		}
		const accidental = pitch.alter === 1 ? " sharp" : pitch.alter === -1 ? " flat" : "";
		return `${STEPS[pitch.step]}${accidental} ${pitch.octave}`;
	}

	// Diatonic index: one per staff position, C0 = 0.
	function diatonic(pitch) {
		return pitch.octave * 7 + pitch.step;
	}

	// Diatonic indices of the treble staff's bottom line (E4), the bass staff's bottom line (G2) and middle C.
	const D_E4 = 4 * 7 + 2;
	const D_G2 = 2 * 7 + 4;
	const D_C4 = 4 * 7;

	// Middle C and up are written on the treble staff, below on the bass staff.
	// The split is by written step, not by sound: Cb4 goes on the treble staff. Returns the staff; position, in
	// diatonic steps above that staff's bottom line (0 to 8 is the staff: even on a line, odd in a space; -2 and
	// below or 10 and above take ledger lines); y, the note's centre; and bottom, the y of that bottom line.
	function staffPlacement(pitch) {
		const d = diatonic(pitch);
		if (d >= D_C4) {
			const position = d - D_E4; // 0 = bottom line, 8 = top line
			return { staff: "treble", position, y: TREBLE_BOTTOM - position * LINE_GAP, bottom: TREBLE_BOTTOM };
		}
		const position = d - D_G2;
		return { staff: "bass", position, y: BASS_BOTTOM - position * LINE_GAP, bottom: BASS_BOTTOM };
	}

	/**
	 * The pitch `semitones` away, or null outside C2–C6. A whole number of octaves keeps the spelling (C♯4 → C♯5);
	 * any other interval is spelled with sharps, like the keyboard (D4 down one → C♯4).
	 */
	function transposePitch(pitch, semitones) {
		const moved = semitones % 12 === 0
			? { step: pitch.step, alter: pitch.alter, octave: pitch.octave + semitones / 12 }
			: spellSharp(pitchMidi(pitch) + semitones);
		return inRange(moved) ? moved : null;
	}

	// A MIDI number spelled as the keyboard spells it: naturals and sharps.
	function spellSharp(midi) {
		const [step, alter] = SHARP_SPELLING[((midi % 12) + 12) % 12];
		return { step, alter, octave: Math.floor(midi / 12) - 1 };
	}

	// Every natural pitch in the range with its y on the staff: where a click on a line or space lands (pitchAtY).
	const NATURAL_PITCHES = [];
	for (let octave = 2; octave <= 6; octave += 1) {
		for (let step = 0; step < STEPS.length; step += 1) {
			const pitch = { step, alter: 0, octave };
			if (inRange(pitch)) {
				NATURAL_PITCHES.push({ pitch, y: staffPlacement(pitch).y });
			}
		}
	}

	// ── Notes and chords ─────────────────────────────────────────────────────
	/**
	 * The canonical pitch list of a note from pitch ids or parsed pitches: readable pitches only, each once, low to
	 * high (enharmonics by staff position, so C♯4 comes before D♭4), at most MAX_CHORD of them.
	 */
	function canonicalPitches(list) {
		const byId = new Map();
		for (const raw of list) {
			const pitch = typeof raw === "string" ? parsePitch(raw) : raw;
			if (pitch && !pitch.rest) {
				byId.set(pitchId(pitch), pitch);
			}
		}
		return [...byId.values()]
			.sort((a, b) => pitchMidi(a) - pitchMidi(b) || diatonic(a) - diatonic(b))
			.slice(0, MAX_CHORD)
			.map(pitchId);
	}

	/**
	 * The canonical { pitches, duration, dotted? } of a stored or imported note, or null if none of its pitches can
	 * be read. Reads both shapes: { pitches: [...] } (version 3) and { pitch } (versions 1 and 2, "rest" for a rest).
	 * An unknown duration becomes a quarter note.
	 */
	function normalizeNote(note) {
		if (!note || typeof note !== "object") {
			return null;
		}
		const raw = Array.isArray(note.pitches) ? note.pitches : [note.pitch];
		const parsed = raw.map(parsePitch).filter(Boolean);
		const isRestNote = raw.length === 0 || parsed.some((pitch) => pitch.rest);
		if (!parsed.length && !isRestNote) {
			return null;
		}
		const duration = VALID_DURATIONS.includes(Number(note.duration)) ? Number(note.duration) : 4;
		const normal = { pitches: canonicalPitches(parsed), duration };
		if (note.dotted === true) {
			normal.dotted = true;
		}
		return normal;
	}

	function normalizeNotes(list) {
		return list.map(normalizeNote).filter(Boolean);
	}

	// Length in beats (quarter notes): a dot adds half the value again.
	function noteBeats(note) {
		return (BEATS_PER_MEASURE / note.duration) * (note.dotted ? 1.5 : 1);
	}

	// Seconds a note lasts at the current tempo.
	function noteSeconds(note) {
		return (noteBeats(note) * 60) / state.bpm;
	}

	function durationLabel(value) {
		const match = DURATIONS.find((entry) => entry.value === value);
		return match ? match.label : `1/${value}`;
	}

	function lengthLabel(duration, dotted) {
		return `${dotted ? "dotted " : ""}${durationLabel(duration)}`;
	}

	/**
	 * The chord symbol for a list of pitch ids ("C", "Am7", "C/E"), or null for fewer than three pitch classes or a
	 * set CHORD_TYPES doesn't know. Names are spelled as the chord spells them, Nordic style: H, H♭, F♯.
	 */
	function chordName(ids) {
		const pitches = canonicalPitches(ids).map(parsePitch);
		const classes = new Map(); // pitch class (0–11) → its lowest spelling in the chord
		for (const pitch of pitches) {
			const pc = pitchMidi(pitch) % 12;
			if (!classes.has(pc)) {
				classes.set(pc, pitch);
			}
		}
		if (classes.size < 3) {
			return null;
		}
		const bass = pitchMidi(pitches[0]) % 12;
		const roots = [bass, ...[...classes.keys()].filter((pc) => pc !== bass)];
		for (const root of roots) {
			const set = [...classes.keys()].map((pc) => (pc - root + 12) % 12).sort((a, b) => a - b).join();
			const type = CHORD_TYPES.find(([intervals]) => intervals.join() === set);
			if (type) {
				const symbol = `${pitchName(classes.get(root))}${type[1]}`;
				return root === bass ? symbol : `${symbol}/${pitchName(classes.get(bass))}`;
			}
		}
		return null;
	}

	// How the status line and tooltips name a note: "E4 (1/4)", "C4–E4–G4 · C (dotted 1/2)", "rest (1/8)".
	function describeNote(note) {
		const length = lengthLabel(note.duration, note.dotted);
		if (!note.pitches.length) {
			return `rest (${length})`;
		}
		const name = note.pitches.length > 2 ? chordName(note.pitches) : null;
		const pitches = note.pitches.map((id) => pitchLabel(parsePitch(id))).join("–");
		return `${pitches}${name ? ` · ${name}` : ""} (${length})`;
	}

	// ── Utilities ────────────────────────────────────────────────────────────
	function setStatus(message, isError) {
		ui.status.textContent = message;
		ui.status.classList.toggle("error", Boolean(isError));
	}

	function clamp(value, low, high) {
		return Math.max(low, Math.min(high, value));
	}

	// For pitch ids in attribute selectors. Without CSS.escape, the fallback escapes "#", the one character in a
	// pitch id that is not a letter or digit.
	function cssEscape(value) {
		return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[#]/g, "\\$&");
	}

	function createSvgEl(name, attrs) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", name);
		for (const [key, value] of Object.entries(attrs)) {
			el.setAttribute(key, String(value));
		}
		return el;
	}

	// ── Audio ────────────────────────────────────────────────────────────────
	/**
	 * Creates the AudioContext and master gain on first use, resumes the context and sets the volume. Browsers, iOS
	 * Safari above all, start audio only from a user gesture: Play and every note entered call this first thing, so
	 * the context is created and resume() called synchronously inside the click or keypress. The volume is applied
	 * here, once, by the master gain (the voices leave it out: VOICE_PEAK); the master gain feeds the soft clipper
	 * (softClip), which takes CLIP_RANGE times full scale, scaled down to the shaper's ±1 by a gain in front of it.
	 */
	async function ensureAudio() {
		if (!state.audioContext) {
			const ctx = new (window.AudioContext || window.webkitAudioContext)();
			const intoClipper = ctx.createGain();
			intoClipper.gain.value = 1 / CLIP_RANGE;
			const limiter = ctx.createWaveShaper();
			limiter.curve = softClip();
			limiter.oversample = "2x";
			intoClipper.connect(limiter);
			limiter.connect(ctx.destination);
			state.audioContext = ctx;
			state.masterGain = ctx.createGain();
			state.masterGain.gain.value = state.volume;
			state.masterGain.connect(intoClipper);
		}
		// "interrupted" is iOS after the app was backgrounded; both resume on this (user-gesture) call.
		if (state.audioContext.state !== "running") {
			await state.audioContext.resume();
		}
		state.masterGain.gain.setValueAtTime(state.volume, state.audioContext.currentTime);
	}

	// Gain staging. Each voice peaks at VOICE_PEAK (before its tilt, chord share and instrument level) and the volume
	// is applied once, by the master gain, so at the default 35% a note is as loud as it always was, and at 100% the
	// piano's strike (its loudest moment: about 2.8 times its level, two strings in phase) still peaks below full
	// scale. CLIP_RANGE is how far past full scale the soft clipper still shapes rather than cuts: far beyond any
	// chord at full volume.
	const VOICE_PEAK = 0.33;
	const CLIP_RANGE = 4;

	/**
	 * The curve of the soft clipper at the end of the chain, over inputs from −CLIP_RANGE to CLIP_RANGE (a gain in
	 * front scales them into the shaper's ±1): exactly linear up to ±0.6, then bending smoothly (a tanh knee, its
	 * slope 1 where it joins) toward ±1, which it reaches only at the range's ends. A loud chord's strike rounds off
	 * instead of clipping. Unlike a compressor, it has no makeup gain and no attack or release, so it never changes
	 * the level of anything quieter; the linear part is exact, since the shaper interpolates linearly.
	 */
	function softClip() {
		const curve = new Float32Array(4097);
		for (let i = 0; i < curve.length; i += 1) {
			const x = ((i / (curve.length - 1)) * 2 - 1) * CLIP_RANGE;
			const size = Math.abs(x);
			curve[i] = Math.sign(x) * (size < 0.6 ? size : 0.6 + 0.4 * Math.tanh((size - 0.6) / 0.4));
		}
		return curve;
	}

	// The sounds playback offers (the Sound picker, state.instrument). build schedules one pitch's oscillators and
	// envelope and returns { sources, gain, stop } for startVoice; level evens out their loudness (measured as RMS
	// over a note's first half second, so at one volume they sound about as loud as each other); midi is the
	// General MIDI program that MIDI export names, so a player picks a similar sound.
	const INSTRUMENTS = {
		piano: { label: "Piano", build: pianoVoice, level: 1.2, midi: 0 },
		epiano: { label: "Electric piano", build: electricPianoVoice, level: 0.87, midi: 4 },
		tone: { label: "Soft tone", build: toneVoice, level: 1, midi: 79 },
	};
	const DEFAULT_INSTRUMENT = "piano";

	/**
	 * Schedules one pitch on the audio clock, in the chosen instrument's voice, into the master gain. startTime is
	 * AudioContext time and both times are in seconds; share scales the peak (a chord's voices split the loudness).
	 */
	function scheduleVoice(pitch, startTime, durationSeconds, share) {
		const frequency = pitchFrequency(pitch);
		const instrument = INSTRUMENTS[state.instrument] || INSTRUMENTS[DEFAULT_INSTRUMENT];
		// Gentle equal-loudness tilt: low tones read quieter, the top octave brighter. Scales from ~1.23 at C2
		// through 1 at middle C to ~0.81 at C6.
		const tilt = clamp(Math.pow(261.63 / frequency, 0.15), 0.8, 1.3);
		// Exponential ramps can't reach 0: the soft tone's envelope runs from and to 0.0001, under any peak here.
		const peak = VOICE_PEAK * tilt * share * instrument.level;
		startVoice(instrument.build(state.audioContext, frequency, startTime, durationSeconds, peak), startTime);
	}

	// Connects a built voice to the master gain, starts its oscillators at startTime and stops them at its stop
	// time, and keeps it in `voices`, with that start time, until they have ended. Returns that entry.
	function startVoice(voice, startTime) {
		voice.gain.connect(state.masterGain);
		const entry = { sources: voice.sources, gain: voice.gain, start: startTime };
		voices.add(entry);
		voice.sources[0].addEventListener("ended", () => {
			voices.delete(entry); // they all stop together
			clicks.delete(entry);
		});
		for (const source of voice.sources) {
			source.start(startTime);
			source.stop(voice.stop);
		}
		return entry;
	}

	/**
	 * The soft tone, Notar's first sound: a triangle wave. Its envelope rises over 20 ms, holds, and falls over the
	 * last 80 ms; a note too short for that rises over its first fifth and falls over its last quarter.
	 */
	function toneVoice(ctx, frequency, start, duration, peak) {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		const end = start + duration;
		const attack = Math.min(0.02, duration * 0.2);
		const release = Math.min(0.08, duration * 0.25);
		osc.type = "triangle";
		osc.frequency.setValueAtTime(frequency, start);
		gain.gain.setValueAtTime(0.0001, start);
		gain.gain.exponentialRampToValueAtTime(peak, start + attack);
		gain.gain.setValueAtTime(peak, Math.max(start + attack, end - release));
		gain.gain.exponentialRampToValueAtTime(0.0001, end);
		osc.connect(gain);
		return { sources: [osc], gain, stop: end + 0.05 }; // once the envelope has faded out
	}

	// The piano's partials, one PeriodicWave per audio context: the nth harmonic of a struck string at about 1/n,
	// times |sin(nπ/7)| for a hammer that strikes a seventh of the way along the string, which silences the 7th and
	// 14th harmonics (piano makers place the hammer there because those are the ones that clash).
	const pianoWaves = new WeakMap();
	function pianoWave(ctx) {
		if (!pianoWaves.has(ctx)) {
			const real = new Float32Array(24);
			const imag = new Float32Array(24);
			for (let n = 1; n < imag.length; n += 1) {
				imag[n] = Math.abs(Math.sin((n * Math.PI) / 7)) / Math.pow(n, 1.05);
			}
			pianoWaves.set(ctx, ctx.createPeriodicWave(real, imag));
		}
		return pianoWaves.get(ctx);
	}

	/**
	 * A piano-like voice: those partials on two oscillators three cents apart, which beat slowly as a piano's
	 * unison strings do, through a lowpass filter that closes after the strike, so the upper partials die away
	 * first. The level jumps up in 5 ms, falls by half within a tenth of a second (the prompt sound), then rings on
	 * with a decay that is long in the bass and short in the treble (the aftersound); at the note's end the damper
	 * takes it away in about 0.1 s. A note held longer than it rings simply fades, as on a piano. Each
	 * setTargetAtTime starts from wherever the curve before it has got to, so the stages join without a step.
	 */
	function pianoVoice(ctx, frequency, start, duration, peak) {
		const end = start + duration;
		const gain = ctx.createGain();
		const filter = ctx.createBiquadFilter();
		filter.type = "lowpass";
		filter.Q.value = 0.4;
		// The cutoff follows the pitch, plus a fixed part, so a bass string keeps some brightness too.
		filter.frequency.setValueAtTime(Math.min(frequency * 12 + 2000, 16000), start);
		filter.frequency.setTargetAtTime(Math.min(frequency * 4 + 600, 8000), start + 0.005, 0.3);
		const sources = [-1.5, 1.5].map((cents) => {
			const osc = ctx.createOscillator();
			osc.setPeriodicWave(pianoWave(ctx));
			osc.frequency.setValueAtTime(frequency, start);
			osc.detune.setValueAtTime(cents, start);
			osc.connect(filter);
			return osc;
		});
		filter.connect(gain);
		const ring = clamp(1.6 * Math.pow(261.63 / frequency, 0.6), 0.4, 4); // seconds, as a time constant
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(peak, start + 0.005);
		gain.gain.setTargetAtTime(peak * 0.4, start + 0.005, 0.06);
		if (start + 0.15 < end) {
			gain.gain.setTargetAtTime(0, start + 0.15, ring);
		}
		gain.gain.setTargetAtTime(0, end, 0.025);
		return { sources, gain, stop: end + 0.15 };
	}

	/**
	 * An electric piano, by frequency modulation: a sine whose pitch a second sine at the same frequency wobbles.
	 * The wobble (the modulation index) starts deep, for the tine's bright bark, and settles shallow, leaving a
	 * round, bell-like tone; the level rings down like the piano's, but longer, and stops on a softer damper.
	 */
	function electricPianoVoice(ctx, frequency, start, duration, peak) {
		const end = start + duration;
		const carrier = ctx.createOscillator();
		const modulator = ctx.createOscillator();
		const depth = ctx.createGain(); // the modulation in Hz: the index times the modulator's frequency
		const gain = ctx.createGain();
		carrier.frequency.setValueAtTime(frequency, start);
		modulator.frequency.setValueAtTime(frequency, start);
		depth.gain.setValueAtTime(frequency * 2.6, start);
		depth.gain.setTargetAtTime(frequency * 0.35, start, 0.18);
		modulator.connect(depth);
		depth.connect(carrier.frequency);
		carrier.connect(gain);
		const ring = clamp(2.2 * Math.pow(261.63 / frequency, 0.5), 0.6, 5);
		gain.gain.setValueAtTime(0, start);
		gain.gain.linearRampToValueAtTime(peak, start + 0.004);
		gain.gain.setTargetAtTime(0, start + 0.004, ring);
		gain.gain.setTargetAtTime(0, end, 0.035);
		return { sources: [carrier, modulator], gain, stop: end + 0.2 };
	}

	// A metronome click at `time`: a short sine blip, higher (and a little louder) on the first beat of a measure.
	// It is a voice like the notes, so silence() stops one still queued, and a click too (stopClicks).
	function scheduleClick(time, downbeat) {
		const ctx = state.audioContext;
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.frequency.setValueAtTime(downbeat ? 1760 : 1320, time);
		gain.gain.setValueAtTime(0, time);
		gain.gain.linearRampToValueAtTime(downbeat ? 0.175 : 0.112, time + 0.002);
		gain.gain.setTargetAtTime(0, time + 0.002, 0.012);
		osc.connect(gain);
		clicks.add(startVoice({ sources: [osc], gain, stop: time + 0.08 }, time));
	}

	// Stops the metronome's clicks still queued (one sounding is over within 80 ms, and is left to finish).
	function stopClicks() {
		if (!state.audioContext) {
			return;
		}
		const now = state.audioContext.currentTime;
		for (const click of clicks) {
			if (click.start > now) {
				click.sources.forEach((source) => source.stop(now));
				voices.delete(click);
				clicks.delete(click);
			}
		}
	}

	// Schedules every pitch of a note (ids; none for a rest) together. Each voice gets 1/√n of the loudness, so a
	// chord sounds about as loud as a single note instead of n times louder.
	function playPitches(ids, startTime, durationSeconds) {
		const pitches = ids.map(parsePitch).filter((pitch) => pitch && !pitch.rest);
		const share = 1 / Math.sqrt(Math.max(1, pitches.length));
		pitches.forEach((pitch) => scheduleVoice(pitch, startTime, durationSeconds, share));
	}

	/**
	 * Silences every voice: one still queued is stopped before its start, so it never sounds; one sounding fades out
	 * over 40 ms from where its envelope is. That level is the automation's own at this instant
	 * (cancelAndHoldAtTime), not the gain's value property: for a voice starting at this very instant (a note's start
	 * often lands exactly on the render quantum Stop falls in) the value property still reads the gain's default of
	 * 1, and fading from there was a loud burst. Without cancelAndHoldAtTime (Firefox), a voice that starts within
	 * the current render quantum counts as queued, for the same reason.
	 */
	function silence() {
		if (!state.audioContext) {
			return;
		}
		const ctx = state.audioContext;
		const now = ctx.currentTime;
		const quantum = 128 / ctx.sampleRate;
		for (const { sources, gain, start } of voices) {
			const param = gain.gain;
			const holds = typeof param.cancelAndHoldAtTime === "function";
			if (start > now || (!holds && start > now - quantum)) {
				sources.forEach((source) => source.stop(now));
				continue;
			}
			if (holds) {
				param.cancelAndHoldAtTime(now);
			} else {
				param.cancelScheduledValues(now);
				param.setValueAtTime(param.value, now);
			}
			param.linearRampToValueAtTime(0, now + 0.04);
			sources.forEach((source) => source.stop(now + 0.05));
		}
		voices.clear();
		clicks.clear();
	}

	// Plays a note just entered, at most 0.45 s of it, so you hear what you write. Quiet while playing back.
	async function audition(note) {
		if (!note.pitches.length || state.playing) {
			return;
		}
		try {
			await ensureAudio();
		} catch (error) {
			return; // no audio here; writing still works
		}
		playPitches(note.pitches, state.audioContext.currentTime + 0.01, Math.min(0.45, noteSeconds(note)));
	}

	// ── Persistence ──────────────────────────────────────────────────────────
	// Called after every change, so a reload (pwa.js applying an update) loses nothing. Export keeps less: only the
	// notes and tempo (exportComposition). The undo history is not saved.
	function saveToStorage() {
		const payload = {
			bpm: state.bpm,
			notes: state.notes,
			caret: state.caret,
			selectedDuration: state.selectedDuration,
			dotted: state.dotted,
			chordMode: state.chordMode,
			volume: state.volume,
			loop: state.loop,
			octave: state.octave,
			instrument: state.instrument,
			metronome: state.metronome,
		};
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
			state.saveFailed = false;
		} catch (error) {
			// Storage full, or blocked (some private modes): the work survives only until the page goes. refresh()
			// says so after each edit.
			state.saveFailed = true;
		}
		return !state.saveFailed;
	}

	// Restores the draft into state; init() then sets every control from state. Each field is checked on its own,
	// so a partial or older draft loads what it can.
	function loadFromStorage() {
		try {
			const raw = window.localStorage.getItem(STORAGE_KEY);
			if (!raw) {
				return;
			}
			const payload = JSON.parse(raw);
			if (Array.isArray(payload.notes)) {
				// A draft past MAX_NOTES (none can be made now) loads its first MAX_NOTES; init() says so.
				if (payload.notes.length > MAX_NOTES) {
					state.trimmedFrom = payload.notes.length;
				}
				state.notes = normalizeNotes(payload.notes.slice(0, MAX_NOTES));
			}
			// A draft from before the cursor existed had every note entered at the end: put the cursor there.
			state.caret = Number.isInteger(payload.caret) ? clamp(payload.caret, 0, state.notes.length) : state.notes.length;
			if (normalizeBpm(payload.bpm) !== null) {
				state.bpm = normalizeBpm(payload.bpm);
			}
			if (VALID_DURATIONS.includes(payload.selectedDuration)) {
				state.selectedDuration = payload.selectedDuration;
			}
			if (typeof payload.volume === "number") {
				state.volume = payload.volume;
			}
			for (const flag of ["dotted", "chordMode", "loop", "metronome"]) {
				if (typeof payload[flag] === "boolean") {
					state[flag] = payload[flag];
				}
			}
			if (OCTAVES.includes(payload.octave)) {
				state.octave = payload.octave;
			}
			if (Object.prototype.hasOwnProperty.call(INSTRUMENTS, payload.instrument)) {
				state.instrument = payload.instrument;
			}
		} catch (error) {
			// Ignore corrupt drafts.
		}
	}

	// The notes in Notar's own clipboard: the last copy in any tab (localStorage), else this tab's, else none.
	function storedClipboard() {
		try {
			const notes = clipboardNotes(window.localStorage.getItem(CLIPBOARD_KEY));
			if (notes) {
				return notes;
			}
		} catch (error) {
			// Storage blocked: this tab's copy is all there is.
		}
		return state.clipboard;
	}

	// Whether there is anything to paste, without reading it: updateEditButtons asks on every cursor move.
	function clipboardFilled() {
		try {
			if (window.localStorage.getItem(CLIPBOARD_KEY)) {
				return true;
			}
		} catch (error) {
			// Storage blocked: ask this tab's copy.
		}
		return state.clipboard.length > 0;
	}

	// ── History and editing ──────────────────────────────────────────────────
	// A note copied deep enough (its pitch list too) that changing one leaves the other alone.
	function cloneNote(note) {
		return { ...note, pitches: [...note.pitches] };
	}

	// A copy of the notes, the cursor, the selection and the tempo, that later edits to state.notes leave alone.
	function snapshot() {
		return { notes: state.notes.map(cloneNote), caret: state.caret, anchor: state.anchor, bpm: state.bpm };
	}

	/**
	 * Runs one edit. change() changes state.notes and state.caret and returns { message, sound?, tempo?,
	 * keepSelection? }, or returns null before changing anything when there is nothing to do. A made edit becomes
	 * one undo step (labelled with its message) and clears the redo steps; then the staff is redrawn and the draft
	 * saved, the message shown and, with sound (a note), heard. tempo marks an edit that also set the tempo (an
	 * import, a shared link): only its undo and redo touch the tempo, so undoing a note never reverts the Tempo
	 * slider. The selection goes, unless keepSelection says the edit acted on it (transposing, a length), so ↑ can
	 * be pressed again; undo brings back the selection an edit let go. backup marks the opening of a share link that
	 * kept the piece it replaced (writeBackup): undoing it forgets that copy, and redoing it keeps it again. Returns
	 * whether the edit was made.
	 */
	function edit(change) {
		const before = snapshot();
		const result = change();
		if (!result) {
			return false;
		}
		if (!result.keepSelection) {
			state.anchor = null;
		}
		before.message = result.message;
		before.tempo = Boolean(result.tempo);
		before.backup = Boolean(result.backup);
		state.past.push(before);
		if (state.past.length > HISTORY_LIMIT) {
			state.past.shift();
		}
		state.future = [];
		refresh(result.message);
		if (result.sound) {
			audition(result.sound);
		}
		return true;
	}

	// After every edit, undo and redo: redraw, keep the cursor in view, save, update the Edit buttons, report.
	function refresh(message) {
		drawStaff();
		revealCursor();
		const saved = saveToStorage();
		updateEditButtons();
		updateRestoreBar();
		const warning = " Not saved: the browser's storage is full or blocked, so a reload would lose this.";
		setStatus(saved ? message : `${message}${warning}`, !saved);
	}

	// The status for a piece too long to open or import (MAX_NOTES).
	function tooManyNotes(what, count) {
		return `${what} has ${count} notes, more than the ${MAX_NOTES} a piece in Notar can have, so nothing changed.`;
	}

	function undo() {
		const step = state.past.pop();
		if (!step) {
			setStatus("Nothing to undo.");
			return;
		}
		state.future.push({ ...snapshot(), message: step.message, tempo: step.tempo, backup: step.backup });
		restore(step);
		if (step.backup) {
			clearBackup(); // the piece the link replaced is the composition again
		}
		refresh(`Undone: ${step.message}`);
	}

	function redo() {
		const step = state.future.pop();
		if (!step) {
			setStatus("Nothing to redo.");
			return;
		}
		if (step.backup) {
			writeBackup({ notes: state.notes.map(cloneNote), bpm: state.bpm, replacedBy: pieceKey(step.notes, step.bpm) });
		}
		state.past.push({ ...snapshot(), message: step.message, tempo: step.tempo, backup: step.backup });
		restore(step);
		refresh(`Redone: ${step.message}`);
	}

	function restore(step) {
		state.notes = step.notes;
		state.caret = step.caret;
		state.anchor = Number.isInteger(step.anchor) ? clamp(step.anchor, 0, state.notes.length) : null;
		if (step.tempo) {
			setBpm(step.bpm);
		}
	}

	/**
	 * Enables the actions that can act now: the Edit buttons, and Apply (the length for the current note or the
	 * selection) beside the length picker. A button that disables itself while focused (the last Undo, say) hands
	 * focus to the next one that still works, Apply to the Dot toggle beside it, so keyboard users aren't dropped
	 * back to the top of the page. Cut, Copy and Paste are only aria-disabled: they stay focusable and pressable,
	 * and pressed with nothing to act on they say how to select or copy, which on a touch screen (no tooltips) is
	 * how the long-press is found.
	 */
	function updateEditButtons() {
		const focused = document.activeElement;
		const range = selection();
		ui.undoBtn.disabled = !state.past.length;
		ui.redoBtn.disabled = !state.future.length;
		ui.deleteBtn.disabled = state.caret === 0 && !range;
		ui.clearBtn.disabled = !state.notes.length;
		ui.applyLengthBtn.disabled = state.caret === 0 && !range;
		const target = range ? "the selected notes" : "the highlighted note";
		ui.deleteBtn.title = `Delete ${target} (⌫)`;
		ui.applyLengthBtn.title = `Apply this length and dot to ${target} (Shift+1–5, Shift+.)`;
		ui.applyLengthBtn.setAttribute("aria-label", range ? "Apply length to the selection" : "Apply length to note");
		ui.cutBtn.setAttribute("aria-disabled", range ? "false" : "true");
		ui.copyBtn.setAttribute("aria-disabled", range ? "false" : "true");
		ui.pasteBtn.setAttribute("aria-disabled", clipboardFilled() ? "false" : "true");
		const actions = [ui.undoBtn, ui.redoBtn, ui.deleteBtn, ui.clearBtn];
		if (focused && focused.disabled && actions.includes(focused)) {
			const next = actions.find((button) => !button.disabled);
			if (next) {
				next.focus();
			}
		}
		if (focused === ui.applyLengthBtn && focused.disabled) {
			ui.dotBtn.focus();
		}
	}

	// A new note at the chosen length and dot; pitch ids, none for a rest.
	function makeNote(pitches) {
		const note = { pitches: canonicalPitches(pitches), duration: state.selectedDuration };
		if (state.dotted) {
			note.dotted = true;
		}
		return note;
	}

	// Enters a note (pitch ids; none for a rest) in gap `at`, the cursor's unless given; the cursor moves past it,
	// so it becomes the current note and the next one follows it.
	function insertNote(pitches, at) {
		if (state.notes.length >= MAX_NOTES) {
			setStatus(`A piece in Notar can have at most ${MAX_NOTES} notes, and this one has them all.`, true);
			return;
		}
		edit(() => {
			const index = at === undefined ? state.caret : at;
			const note = makeNote(pitches);
			const atEnd = index === state.notes.length;
			state.notes.splice(index, 0, note);
			state.caret = index + 1;
			return { message: `${atEnd ? "Added" : "Inserted"} ${describeNote(note)}${acrossBar(index)}.`, sound: note };
		});
		flashKeys(pitches.length ? pitches : ["rest"]);
	}

	/**
	 * For status messages: ", tied over the bar line" when note `index` of state.notes crosses one (", split at the
	 * bar line" for a rest), so a learner hears why one note is drawn as two. Empty otherwise.
	 */
	function acrossBar(index) {
		let start = 0;
		for (let i = 0; i < index; i += 1) {
			start += Math.round(noteBeats(state.notes[i]) * UNITS_PER_BEAT);
		}
		const note = state.notes[index];
		const end = start + Math.round(noteBeats(note) * UNITS_PER_BEAT);
		if (Math.floor(start / MEASURE_UNITS) === Math.floor((end - 1) / MEASURE_UNITS)) {
			return "";
		}
		return note.pitches.length ? ", tied over the bar line" : ", split at the bar line";
	}

	/**
	 * Gives the current note (the one before the cursor; rests too) a new length: duration, a DURATIONS value, and
	 * dotted, each left undefined to keep the note's own. One undo step; the notes after it move along with it. The
	 * length picker isn't touched: it stays the length for new notes.
	 */
	function setCurrentLength(duration, dotted) {
		const index = state.caret - 1;
		const note = state.notes[index];
		if (!note) {
			setStatus("Put the cursor after a note to change its length.", true);
			return;
		}
		const nextDuration = duration === undefined ? note.duration : duration;
		const nextDotted = dotted === undefined ? Boolean(note.dotted) : dotted;
		const made = edit(() => {
			if (nextDuration === note.duration && nextDotted === Boolean(note.dotted)) {
				return null;
			}
			note.duration = nextDuration;
			if (nextDotted) {
				note.dotted = true;
			} else {
				delete note.dotted; // the canonical note has no dotted: false (normalizeNote)
			}
			return { message: `Changed note ${index + 1} to ${describeNote(note)}${acrossBar(index)}.`, sound: note };
		});
		if (!made) {
			setStatus(`Note ${index + 1} is already ${lengthLabel(nextDuration, nextDotted)}.`);
		}
	}

	/**
	 * Adds a pitch to note `index` as a chord tone, or takes it out if the note has it already. A note left without
	 * pitches is a rest, so the rhythm after it never shifts. The cursor moves to just after the note. sameKey
	 * (keys, which spell black keys as sharps) also counts a differently spelled pitch on the same key as "has it",
	 * so Shift+W takes a D♭4 out rather than adding a C♯4 beside it; the staff matches exact spellings.
	 */
	function stackPitch(index, pitch, sameKey) {
		const note = state.notes[index];
		const id = pitchId(pitch);
		const made = edit(() => {
			const wasRest = !note.pitches.length;
			const existing = note.pitches.find((other) => other === id
				|| (sameKey && pitchMidi(parsePitch(other)) === pitchMidi(pitch)));
			if (existing) {
				note.pitches = note.pitches.filter((other) => other !== existing);
				state.caret = index + 1;
				return {
					message: note.pitches.length
						? `Took ${pitchLabel(pitch)} out of the chord: ${describeNote(note)}.`
						: `Took ${pitchLabel(pitch)} out: note ${index + 1} is a rest now.`,
				};
			}
			if (note.pitches.length >= MAX_CHORD) {
				return null;
			}
			note.pitches = canonicalPitches([...note.pitches, id]);
			state.caret = index + 1;
			return {
				message: wasRest ? `Wrote ${describeNote(note)} over the rest.` : `Added ${pitchLabel(pitch)} to the chord: ${describeNote(note)}.`,
				sound: note,
			};
		});
		if (!made) {
			setStatus(`A chord holds at most ${MAX_CHORD} notes.`, true);
		}
	}

	// A pitch from the keyboard or a key with Shift held or chord mode on: a chord tone for every selected note if
	// there is a selection (stackSelection), else for the current note, or a first note when the cursor is at the
	// very beginning.
	function enterChordTone(id) {
		if (selection()) {
			stackSelection(parsePitch(id));
			flashKeys([id]);
			return;
		}
		if (state.caret === 0) {
			insertNote([id]);
			return;
		}
		stackPitch(state.caret - 1, parsePitch(id), true);
		flashKeys([id]);
	}

	/**
	 * A chord tone for every selected note, as stackPitch is for one: if each of them has the pitch already (on the
	 * same key, as the keys spell it), it comes out of all of them, and a note left without pitches is a rest;
	 * otherwise it goes into each that lacks it, a rest becoming that note. Refused as a whole if a chord would pass
	 * MAX_CHORD. One undo step; the selection stays, for the next tone.
	 */
	function stackSelection(pitch) {
		const range = selection();
		const notes = selectedNotes();
		const key = pitchMidi(pitch);
		const has = (note) => note.pitches.some((id) => pitchMidi(parsePitch(id)) === key);
		const removing = notes.every(has);
		if (!removing && notes.some((note) => !has(note) && note.pitches.length >= MAX_CHORD)) {
			setStatus(`A chord holds at most ${MAX_CHORD} notes.`, true);
			return;
		}
		edit(() => {
			for (const note of notes) {
				if (removing) {
					note.pitches = note.pitches.filter((id) => pitchMidi(parsePitch(id)) !== key);
				} else if (!has(note)) {
					note.pitches = canonicalPitches([...note.pitches, pitchId(pitch)]);
				}
			}
			const label = pitchLabel(pitch);
			return {
				message: removing ? `Took ${label} out of ${notesLabel(range)}.` : `Added ${label} to ${notesLabel(range)}.`,
				keepSelection: true,
				sound: removing ? undefined : notes[0],
			};
		});
	}

	// Removes note `index`; the cursor keeps its place in the music around it.
	function deleteNote(index) {
		if (index < 0 || index >= state.notes.length) {
			return;
		}
		edit(() => {
			const [removed] = state.notes.splice(index, 1);
			if (state.caret > index) {
				state.caret -= 1;
			}
			return { message: `Deleted ${describeNote(removed)}.` };
		});
	}

	// Moves every pitch of the current note by `semitones` (±1, or ±12 with Shift). Refused as a whole if any pitch
	// would leave C2–C6, so a chord keeps its shape.
	function transposeCurrent(semitones) {
		const note = state.notes[state.caret - 1];
		if (!note || !note.pitches.length) {
			return;
		}
		const moved = note.pitches.map((id) => transposePitch(parsePitch(id), semitones));
		if (moved.some((pitch) => !pitch)) {
			setStatus("That would go outside C2–C6.", true);
			return;
		}
		edit(() => {
			note.pitches = canonicalPitches(moved);
			return { message: `Transposed to ${describeNote(note)}.`, sound: note };
		});
	}

	function clearNotes() {
		stopPlayback();
		edit(() => {
			if (!state.notes.length) {
				return null;
			}
			state.notes = [];
			state.caret = 0;
			return { message: "Cleared the composition. Undo brings it back." };
		});
	}

	/**
	 * Puts the cursor in gap `index` (clamped). Not an edit: no undo step. With extend (Shift), the selection
	 * stretches to it from its anchor, which is set where the cursor was if there was no selection; without, the
	 * selection goes. announce reports where the cursor is, or what is selected (a status message read by screen
	 * readers); a drag along the ruler passes false and announces once, at the end. While dragging the staff
	 * doesn't scroll: the cursor follows the pointer, and scrolling under a pointer that hasn't moved would carry
	 * the cursor away with it.
	 */
	function moveCursor(index, announce, extend) {
		const next = clamp(index, 0, state.notes.length);
		const anchor = extend ? (state.anchor === null ? state.caret : state.anchor) : null;
		if (next !== state.caret || anchor !== state.anchor) {
			state.caret = next;
			state.anchor = anchor;
			drawStaff();
			saveToStorage();
			updateEditButtons();
		}
		if (!state.dragging) {
			revealCursor();
		}
		if (announce !== false) {
			setStatus(selection() ? describeSelection() : describeCursor());
		}
	}

	function describeCursor() {
		if (state.caret === state.notes.length) {
			return state.notes.length ? "Cursor at the end: new notes are added after the last one." : "Cursor at the start.";
		}
		const event = state.layout.events[state.caret];
		const beat = Math.round(((event.beat % BEATS_PER_MEASURE) + 1) * 100) / 100;
		return `Cursor before note ${state.caret + 1} of ${state.notes.length} (measure ${event.measure + 1}, beat ${beat}): new notes go in here.`;
	}

	// ── Selection ────────────────────────────────────────────────────────────
	// The selected notes as { start, end } (end exclusive): those between the anchor and the cursor. null when there
	// is no anchor, or the cursor is back on it.
	function selection() {
		if (state.anchor === null || state.anchor === state.caret) {
			return null;
		}
		return { start: Math.min(state.anchor, state.caret), end: Math.max(state.anchor, state.caret) };
	}

	function selectedNotes() {
		const range = selection();
		return range ? state.notes.slice(range.start, range.end) : [];
	}

	// For status messages: "note 3" or "notes 3–5"; "1 note" or "4 notes"; "1 beat" or "2.5 beats".
	function notesLabel(range) {
		return range.end - range.start === 1 ? `note ${range.start + 1}` : `notes ${range.start + 1}–${range.end}`;
	}

	function countLabel(count) {
		return `${count} ${count === 1 ? "note" : "notes"}`;
	}

	function beatsLabel(beats) {
		const rounded = Math.round(beats * 100) / 100;
		return `${rounded} ${rounded === 1 ? "beat" : "beats"}`;
	}

	// What is selected and what acts on it. A touch screen has no arrow keys, so it isn't told about them.
	function describeSelection() {
		const range = selection();
		const beats = selectedNotes().reduce((sum, note) => sum + noteBeats(note), 0);
		const actions = coarsePointer.matches
			? "Copy, Cut, Delete and Apply act on it, and Play plays it."
			: "↑ ↓ transpose it; Delete, Apply, Copy, Cut and Play act on it; Esc lets it go.";
		return `Selected ${notesLabel(range)}, ${beatsLabel(beats)}. ${actions}`;
	}

	// How to select, for Cut and Copy pressed with nothing selected: the touch way on a touch screen.
	function selectHint() {
		return coarsePointer.matches
			? "Select notes first: long-press a note on the staff, then drag along the staff to take in more."
			: "Select notes first: Shift+← →, Shift+click a note, or Shift+drag along the ruler.";
	}

	/**
	 * Selects from gap `anchor` to gap `caret` (where the cursor goes), both clamped. Not an edit. Select all and
	 * the long-press use it; Shift with the arrows, clicks and drags goes through moveCursor. announce and the
	 * scrolling are as in moveCursor.
	 */
	function select(anchor, caret, announce) {
		const nextAnchor = clamp(anchor, 0, state.notes.length);
		const nextCaret = clamp(caret, 0, state.notes.length);
		if (nextAnchor !== state.anchor || nextCaret !== state.caret) {
			state.anchor = nextAnchor;
			state.caret = nextCaret;
			drawStaff();
			saveToStorage();
			updateEditButtons();
		}
		if (!state.dragging) {
			revealCursor();
		}
		if (announce !== false) {
			setStatus(selection() ? describeSelection() : describeCursor());
		}
	}

	function selectAll() {
		if (!state.notes.length) {
			setStatus("There are no notes to select yet.");
			return;
		}
		select(0, state.notes.length);
	}

	// Lets the selection go, the cursor staying where it is. Returns whether there was one.
	function clearSelection() {
		if (state.anchor === null) {
			return false;
		}
		const had = Boolean(selection());
		moveCursor(state.caret, false);
		if (had) {
			setStatus("Selection cleared.");
		}
		return had;
	}

	function deleteSelection() {
		const range = selection();
		edit(() => {
			const removed = state.notes.splice(range.start, range.end - range.start);
			state.caret = range.start;
			return { message: `Deleted ${countLabel(removed.length)}. Undo brings them back.` };
		});
	}

	// Moves every pitch in the selection by `semitones`, as transposeCurrent does one note: refused as a whole if a
	// pitch would leave C2–C6, so the passage keeps its shape. The selection stays, for the next ↑ or ↓.
	function transposeSelection(semitones) {
		const range = selection();
		const notes = selectedNotes().filter((note) => note.pitches.length);
		if (!notes.length) {
			setStatus("Only rests are selected: there is nothing to transpose.", true);
			return;
		}
		const moved = notes.map((note) => note.pitches.map((id) => transposePitch(parsePitch(id), semitones)));
		if (moved.some((pitches) => pitches.some((pitch) => !pitch))) {
			setStatus("That would take a note outside C2–C6.", true);
			return;
		}
		edit(() => {
			notes.forEach((note, i) => {
				note.pitches = canonicalPitches(moved[i]);
			});
			const interval = Math.abs(semitones) === 12 ? "an octave" : "a semitone";
			return {
				message: `Transposed ${notesLabel(range)} ${semitones > 0 ? "up" : "down"} ${interval}.`,
				keepSelection: true,
				sound: notes[0],
			};
		});
	}

	/**
	 * Gives every selected note (rests too) a length, as setCurrentLength does one: duration, a DURATIONS value,
	 * and dotted, each left undefined for every note to keep its own. One undo step; the selection stays.
	 */
	function setSelectionLength(duration, dotted) {
		const range = selection();
		const notes = selectedNotes();
		const label = notesLabel(range);
		let message;
		if (duration === undefined) {
			message = dotted ? `Dotted ${label}.` : `Took the dots off ${label}.`;
		} else {
			const length = dotted === undefined
				? `${durationLabel(duration)}, each keeping its dot`
				: lengthLabel(duration, dotted);
			message = `Changed ${label} to ${length}.`;
		}
		const made = edit(() => {
			let changed = 0;
			for (const note of notes) {
				const nextDuration = duration === undefined ? note.duration : duration;
				const nextDotted = dotted === undefined ? Boolean(note.dotted) : dotted;
				if (nextDuration !== note.duration || nextDotted !== Boolean(note.dotted)) {
					note.duration = nextDuration;
					if (nextDotted) {
						note.dotted = true;
					} else {
						delete note.dotted;
					}
					changed += 1;
				}
			}
			return changed ? { message, keepSelection: true } : null;
		});
		if (!made) {
			setStatus(`The selected notes already have that length.`);
		}
	}

	// The text a copy puts on the system clipboard: version-3 JSON, the Export format without the tempo, so it
	// pastes into another tab, or saved as a file, imports.
	function clipboardText(notes) {
		return JSON.stringify({ version: 3, notes });
	}

	// The notes in clipboard text (that JSON, an exported file's contents, or a bare list of notes), or null when it
	// holds none Notar can read.
	function clipboardNotes(text) {
		if (!text) {
			return null;
		}
		try {
			const payload = JSON.parse(text);
			const list = Array.isArray(payload) ? payload : payload && payload.notes;
			// One past MAX_NOTES is enough for pasteNotes to refuse it: the rest of a huge list isn't read.
			const notes = Array.isArray(list) ? normalizeNotes(list.slice(0, MAX_NOTES + 1)) : [];
			return notes.length ? notes : null;
		} catch (error) {
			return null;
		}
	}

	/**
	 * Copies the selection to Notar's own clipboard (this tab's, and localStorage's for other tabs) and, as text,
	 * to the system clipboard where the browser allows it: writeText needs a secure context and a key press or
	 * click, and if it refuses, Notar's own copy still pastes. With cut, the notes then go, as one undo step.
	 * written: a copy event has put the text on the system clipboard already.
	 */
	function copySelection(cut, written) {
		const range = selection();
		if (!range) {
			setStatus(selectHint(), true);
			return;
		}
		const notes = selectedNotes().map(cloneNote);
		const text = clipboardText(notes);
		state.clipboard = notes;
		try {
			window.localStorage.setItem(CLIPBOARD_KEY, text);
		} catch (error) {
			// Storage blocked: this tab's copy will do.
		}
		if (!written) {
			writeSystemClipboard(text);
		}
		if (cut) {
			edit(() => {
				state.notes.splice(range.start, range.end - range.start);
				state.caret = range.start;
				return { message: `Cut ${countLabel(notes.length)}: Paste puts them in again at the cursor.` };
			});
			return;
		}
		updateEditButtons();
		setStatus(`Copied ${countLabel(notes.length)}: Paste puts them in at the cursor, here or in another Notar tab.`);
	}

	/**
	 * Pastes notes at the cursor, or over the selection (as typing replaces selected text), as one undo step; the
	 * cursor ends after them. With none, says how to have some.
	 */
	function pasteNotes(notes) {
		if (!notes || !notes.length) {
			setStatus("Nothing to paste yet: select some notes and copy them first.", true);
			return;
		}
		const range = selection();
		const replacing = range ? range.end - range.start : 0;
		if (state.notes.length - replacing + notes.length > MAX_NOTES) {
			setStatus(`Pasting those notes would take the piece past the ${MAX_NOTES} notes it can have, so nothing changed.`, true);
			return;
		}
		edit(() => {
			const at = range ? range.start : state.caret;
			const replaced = replacing;
			// concat rather than splice(...spread): a long paste could pass more arguments than a call takes.
			state.notes = state.notes.slice(0, at).concat(notes.map(cloneNote), state.notes.slice(at + replaced));
			state.caret = at + notes.length;
			return {
				message: range
					? `Pasted ${countLabel(notes.length)} over the ${countLabel(replaced)} that were selected.`
					: `Pasted ${countLabel(notes.length)}.`,
			};
		});
	}

	// Puts text on the system clipboard if the browser lets it now; resolves to whether it did, and never rejects.
	function writeSystemClipboard(text) {
		if (navigator.clipboard && navigator.clipboard.writeText) {
			return navigator.clipboard.writeText(text).then(() => true, () => copyWithSelection(text));
		}
		return Promise.resolve(copyWithSelection(text));
	}

	// The old way to copy, for a browser without the Clipboard API or one that refuses it: select the text in a
	// hidden field and run the copy command, which browsers allow during a click or key press. The field is the
	// copy event's target, which tells Notar's own copy handler (bindClipboard) to leave the event alone.
	function copyWithSelection(text) {
		const previous = document.activeElement;
		const field = document.createElement("textarea");
		field.value = text;
		field.setAttribute("readonly", "");
		field.setAttribute("aria-hidden", "true");
		field.style.cssText = "position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none";
		document.body.appendChild(field);
		field.select();
		field.setSelectionRange(0, text.length); // iOS selects nothing on select() alone
		let copied = false;
		try {
			copied = document.execCommand("copy");
		} catch (error) {
			copied = false;
		}
		field.remove();
		if (previous && previous.focus) {
			previous.focus({ preventScroll: true });
		}
		return copied;
	}

	// ── Keyboard (piano) ─────────────────────────────────────────────────────
	// The key that sounds a pitch. The keyboard spells every black key as a sharp, so D♭4 is the C♯4 key.
	function keyFor(pitch) {
		return ui.piano.querySelector(`[data-pitch="${cssEscape(pitchId(spellSharp(pitchMidi(pitch))))}"]`);
	}

	// The short press animation (.struck) for a note entered by tap, click or computer key; the Rest button stands
	// in for a rest. With reduced motion the class comes straight off again.
	function flashPianoKey(pitchString) {
		const button = pitchString === "rest" ? ui.restBtn : keyFor(parsePitch(pitchString));
		if (!button) {
			return;
		}
		button.classList.remove("struck");
		// Force a reflow so the class re-triggers on repeated notes.
		void button.offsetWidth;
		button.classList.add("struck");
		if (!reduceMotion.matches) {
			window.setTimeout(() => button.classList.remove("struck"), 180);
		} else {
			button.classList.remove("struck");
		}
	}

	function flashKeys(ids) {
		ids.forEach(flashPianoKey);
	}

	// Marks the keys of the current note (.held): the chord a Shift-press would join or leave, seen on the keyboard
	// where you press. None while there is a selection: the edits that act on it don't act on one note's keys.
	function markHeldKeys() {
		ui.piano.querySelectorAll(".key.held").forEach((key) => key.classList.remove("held"));
		const current = selection() ? null : state.notes[state.caret - 1];
		for (const id of current ? current.pitches : []) {
			const key = keyFor(parsePitch(id));
			if (key) {
				key.classList.add("held");
			}
		}
	}

	// Marks the current note's length on the length picker and the Dot toggle (.held), the same accent edge as its
	// keys: the picker's chosen chip is the length for new notes, the edged one is the note's, and Apply makes them
	// one. With a selection, the length its notes share, if they all have one.
	function markHeldLength() {
		const notes = selection() ? selectedNotes() : [state.notes[state.caret - 1]].filter(Boolean);
		const same = notes.every((note) => note.duration === notes[0].duration
			&& Boolean(note.dotted) === Boolean(notes[0].dotted));
		const current = notes.length && same ? notes[0] : null;
		if (ui.durationPicker) {
			ui.durationPicker.querySelectorAll("label").forEach((label) => {
				const entry = DURATIONS[Number(label.querySelector("input").value)];
				label.classList.toggle("held", Boolean(current) && entry.value === current.duration);
			});
		}
		ui.dotBtn.classList.toggle("held", Boolean(current && current.dotted));
	}

	// One key: its name (sharps as ♯, each C with its octave as a subscript) and the computer key that plays it. A tap
	// also moves the computer keyboard to the key's octave; C6 has no octave of its own and leaves it where it is.
	function makeKey(pitch, colour, hint) {
		const id = pitchId(pitch);
		const button = document.createElement("button");
		button.type = "button";
		button.className = `key ${colour}`;
		button.dataset.pitch = id;
		button.setAttribute("aria-label", pitchSpoken(pitch));
		const name = STEPS[pitch.step] + (pitch.alter ? "♯" : "");
		button.innerHTML = `<span class="pitch" aria-hidden="true">${name}${pitch.step === 0 && !pitch.alter ? `<sub>${pitch.octave}</sub>` : ""}</span>`
			+ (hint ? `<kbd class="hint" aria-hidden="true">${hint}</kbd>` : "");
		button.addEventListener("click", (event) => {
			if (OCTAVES.includes(pitch.octave) && pitch.octave !== state.octave) {
				setOctave(pitch.octave, { scroll: false, announce: false });
			}
			if (event.shiftKey || state.chordMode) {
				enterChordTone(id);
			} else {
				insertNote([id]);
			}
		});
		return button;
	}

	// One labelled octave group. whiteCount is 7, or 1 for the closing C6, which has no sharps. styles.css lays the
	// keys out from --whites, the white-key count, and each black key's --slot (.octave-keys, .key.black).
	function buildOctave(octave, whiteCount) {
		const group = document.createElement("div");
		group.className = "octave";
		group.dataset.octave = String(octave);
		group.setAttribute("role", "group");
		group.setAttribute("aria-label", `Octave ${octave}`);

		const label = document.createElement("div");
		label.className = "octave-label";
		label.setAttribute("aria-hidden", "true");
		label.textContent = `C${octave}`;
		group.appendChild(label);

		const keys = document.createElement("div");
		keys.className = "octave-keys";
		keys.style.setProperty("--whites", String(whiteCount));

		// DOM order is chromatic so Tab moves up the keyboard in pitch order.
		for (let step = 0; step < whiteCount; step += 1) {
			keys.appendChild(makeKey({ step, alter: 0, octave }, "white", WHITE_HINTS[step]));
			if (whiteCount === 7 && BLACK_AFTER.includes(step)) {
				const black = makeKey({ step, alter: 1, octave }, "black", BLACK_HINTS[step]);
				black.style.setProperty("--slot", String(step + 1)); // on the gap after white key `step`
				keys.appendChild(black);
			}
		}
		group.appendChild(keys);
		return group;
	}

	function buildPiano() {
		ui.piano.innerHTML = "";
		for (const octave of OCTAVES) {
			ui.piano.appendChild(buildOctave(octave, 7));
		}
		// The range closes on C6: a one-key group, labelled like the others.
		ui.piano.appendChild(buildOctave(6, 1));

		ui.octaveTabs.innerHTML = "";
		for (const octave of OCTAVES) {
			const tab = document.createElement("button");
			tab.type = "button";
			tab.className = "octave-tab";
			tab.dataset.octave = String(octave);
			tab.textContent = `C${octave}`;
			tab.setAttribute("aria-label", `Octave ${octave}`);
			tab.addEventListener("click", () => setOctave(octave, { scroll: true, announce: true }));
			ui.octaveTabs.appendChild(tab);
		}
	}

	function scrollToOctave(octave, smooth) {
		const group = ui.piano.querySelector(`.octave[data-octave="${octave}"]`);
		if (!group) {
			return;
		}
		const frame = ui.piano;
		const maxScroll = frame.scrollWidth - frame.clientWidth;
		if (maxScroll <= 0) {
			return;
		}
		// Centre the octave, clamped to the scroll range.
		const target = group.offsetLeft - frame.offsetLeft - (frame.clientWidth - group.offsetWidth) / 2;
		frame.scrollTo({
			left: clamp(target, 0, maxScroll),
			behavior: smooth && !reduceMotion.matches ? "smooth" : "auto",
		});
	}

	/**
	 * Sets the octave the computer keyboard plays (clamped to OCTAVES) and everything that shows it: the active group,
	 * the K hint on the next C, the tabs and the arrows. options.scroll brings it into view and options.announce
	 * reports it in the status line. Saves.
	 */
	function setOctave(octave, options) {
		const opts = options || {};
		const next = clamp(octave, OCTAVES[0], OCTAVES[OCTAVES.length - 1]);
		state.octave = next;
		ui.piano.querySelectorAll(".octave").forEach((group) => {
			const n = Number(group.dataset.octave);
			const active = n === next;
			group.classList.toggle("active", active);
			// The K key reaches next octave's C: show its hint there.
			group.classList.toggle("reach", n === next + 1);
			const cHint = group.querySelector(".key.white .hint");
			if (cHint) {
				cHint.textContent = n === next + 1 ? "K" : "A";
			}
		});
		ui.octaveTabs.querySelectorAll(".octave-tab").forEach((tab) => {
			tab.setAttribute("aria-pressed", Number(tab.dataset.octave) === next ? "true" : "false");
		});
		ui.octaveDownBtn.disabled = next === OCTAVES[0];
		ui.octaveUpBtn.disabled = next === OCTAVES[OCTAVES.length - 1];
		if (opts.scroll) {
			scrollToOctave(next, true);
		}
		if (opts.announce) {
			setStatus(`Keyboard octave C${next}–H${next}.`);
		}
		saveToStorage();
	}

	// Shows the edge shadow on a side only while there is more keyboard that way; 2 px of slack for fractional
	// scroll positions.
	function updateKeyboardFades() {
		const frame = ui.piano;
		const max = frame.scrollWidth - frame.clientWidth;
		ui.keyboardFrame.classList.toggle("fade-start", frame.scrollLeft > 2);
		ui.keyboardFrame.classList.toggle("fade-end", frame.scrollLeft < max - 2);
	}

	// ── Engraving layout ─────────────────────────────────────────────────────
	// Column width for a length in beats: each doubling of length widens it by √2 (a quarter is BEAT_WIDTH), the
	// usual engraving compromise, so sixteenths stay legible and whole notes don't sprawl. engrave adds room for
	// accidentals, displaced heads and dots on top.
	function bodyWidth(beats) {
		return BEAT_WIDTH * Math.sqrt(beats);
	}

	function beamCount(duration) {
		return BEAM_COUNT[duration] || 0;
	}

	// A length in units as written values, longest first (greedy: 2½ beats is a half and an eighth).
	function splitUnits(units) {
		const values = [];
		let left = units;
		while (left > 0) {
			const value = WRITTEN_VALUES.find((entry) => entry.units <= left);
			values.push(value);
			left -= value.units;
		}
		return values;
	}

	/**
	 * How a note from `start` lasting `length` (both in units) is written: [{ start, units, duration, dotted }].
	 * One value when it fits in its measure; otherwise it is cut at every bar line and each piece written as tied
	 * values. The piece before the first bar line puts its short values first, so the long one lands on a beat (an
	 * eighth then a dotted half from the "and" of one); pieces after a bar line put the long one first, on the
	 * downbeat.
	 */
	function writtenPieces(start, length) {
		const pieces = [];
		const end = start + length;
		let at = start;
		while (at < end) {
			const pieceEnd = Math.min(end, (Math.floor(at / MEASURE_UNITS) + 1) * MEASURE_UNITS);
			const values = splitUnits(pieceEnd - at);
			if (at % MEASURE_UNITS !== 0 && pieceEnd < end) {
				values.reverse();
			}
			for (const value of values) {
				pieces.push({ start: at, units: value.units, duration: value.duration, dotted: value.dotted });
				at += value.units;
			}
		}
		return pieces;
	}

	/**
	 * Gives every segment its heads, by staff (segment.staves: { treble?, bass? } of [{ pitch, accidental }]), with
	 * the accidental to print or null. Accidentals hold for the rest of the measure at that staff position: with no
	 * key signature every position starts the measure natural, so a sign is printed whenever a note's alter
	 * differs from the last one there. A tied continuation prints none and doesn't count as the new measure's own:
	 * a later note there restates its sign, and a natural after a tied-over sharp or flat is printed as a reminder.
	 */
	function spellAccidentals(segments) {
		let measureOf = -1;
		let held = new Map(); // "octave:step" → the alter a note in this measure left there
		let carried = new Map(); // "octave:step" → the alter a tie carried over this measure's bar line
		for (const segment of segments) {
			if (segment.measure !== measureOf) {
				measureOf = segment.measure;
				held = new Map();
				carried = new Map();
			}
			for (const id of segment.event.note.pitches) {
				const pitch = parsePitch(id);
				const key = `${pitch.octave}:${pitch.step}`;
				let accidental = null;
				if (!segment.tied) {
					const current = held.has(key) ? held.get(key) : 0;
					const reminder = !held.has(key) && carried.has(key) && carried.get(key) !== pitch.alter;
					accidental = pitch.alter !== current || reminder ? pitch.alter : null;
					held.set(key, pitch.alter);
				} else if (segment.start % MEASURE_UNITS === 0) {
					carried.set(key, pitch.alter);
				}
				const staff = staffPlacement(pitch).staff;
				(segment.staves[staff] = segment.staves[staff] || []).push({ pitch, accidental });
			}
		}
	}

	/**
	 * Beam groups, one staff at a time: runs of eighths and shorter, one after another, that start in the same beat
	 * and have heads on that staff. A rest, a quarter or longer, or a note with nothing on that staff ends a run, so
	 * each hand of a chord across both staves gets its own beam. Runs of two or more are beamed: [{ staff, members
	 * (segments), stemDown }]. One stem direction for the group, from the head farthest from the middle line, as
	 * for a chord; engrave turns it if the beam would leave its staff's band.
	 */
	function beamGroups(segments) {
		const groups = [];
		for (const staff of ["treble", "bass"]) {
			let run = [];
			const close = () => {
				if (run.length > 1) {
					groups.push({ staff, members: run });
				}
				run = [];
			};
			for (const segment of segments) {
				if (!segment.staves[staff] || !beamCount(segment.duration)) {
					close();
					continue;
				}
				if (run.length && Math.floor(run[0].start / UNITS_PER_BEAT) !== Math.floor(segment.start / UNITS_PER_BEAT)) {
					close();
				}
				run.push(segment);
			}
			close();
		}
		for (const group of groups) {
			let above = -Infinity;
			let below = -Infinity;
			for (const segment of group.members) {
				for (const head of segment.staves[group.staff]) {
					const position = staffPlacement(head.pitch).position;
					above = Math.max(above, position - 4);
					below = Math.max(below, 4 - position);
				}
				segment.beams[group.staff] = group;
			}
			group.stemDown = above >= below;
		}
		return groups;
	}

	/**
	 * One staff's share of a segment: its heads (low to high, with y, position, the accidental to print and its
	 * column, and offset: how far the head sits left or right of the centre, for seconds), the stem direction (the
	 * beam group's, if it has one), and how far the drawing reaches left and right of the centre. heads: [{ pitch,
	 * accidental }] for this staff.
	 */
	function engravePart(staff, heads, segment, beam) {
		const placed = heads.map(({ pitch, accidental }) => {
			const place = staffPlacement(pitch);
			return { pitch, accidental, position: place.position, y: place.y, offset: 0, column: 0 };
		}).sort((a, b) => a.position - b.position);
		const low = placed[0].position;
		const high = placed[placed.length - 1].position;
		// The note farthest from the middle line (position 4) decides: stem down if it is above, up if below.
		const stemDown = beam ? beam.stemDown : high - 4 >= 4 - low;

		// Seconds: two heads a step apart can't share a side of the stem. Going from the stem's end of the chord, a
		// head a step (or none) from the one before moves across the stem, unless that one already moved.
		const order = stemDown ? [...placed].reverse() : placed;
		order.forEach((head, i) => {
			const prev = order[i - 1];
			if (prev && Math.abs(head.position - prev.position) <= 1 && prev.offset === 0) {
				head.offset = stemDown ? -SECOND_SHIFT : SECOND_SHIFT;
			}
		});

		// Accidentals, top down: each takes the first column with no accidental within a sixth of it.
		const columns = [];
		placed.filter((head) => head.accidental !== null).reverse().forEach((head) => {
			let c = 0;
			while (columns[c] && columns[c].some((position) => Math.abs(position - head.position) < 6)) {
				c += 1;
			}
			(columns[c] = columns[c] || []).push(head.position);
			head.column = c;
		});

		const headLeft = Math.min(...placed.map((head) => head.offset)) - HEAD_RX;
		const headRight = Math.max(...placed.map((head) => head.offset)) + HEAD_RX;
		const left = columns.length ? -(headLeft - ACC_GAP - (columns.length - 1) * ACC_COLUMN - 4.5) : -headLeft;
		const flag = beamCount(segment.duration) && !beam && !stemDown ? STEM_X + 9 : 0;
		const dot = segment.dotted ? headRight + 7 : 0;
		return {
			staff,
			bottom: staff === "treble" ? TREBLE_BOTTOM : BASS_BOTTOM,
			heads: placed,
			stemDown,
			beam: beam || null,
			stemTip: null, // set by layBeam for a beamed part
			headLeft,
			headRight,
			left,
			right: Math.max(headRight, flag, dot),
		};
	}

	// Which way a broken beam on stem i points at `level` (2 for sixteenths): right on the group's first note, left
	// on its last; between, right from a note on the grid of the level above (a sixteenth on an eighth's place
	// starts that eighth), left otherwise, toward the note it shares that eighth with.
	function stubPointsRight(stems, i, level) {
		if (i === 0) {
			return true;
		}
		if (i === stems.length - 1) {
			return false;
		}
		return stems[i].segment.start % (UNITS_PER_BEAT / 2 ** (level - 1)) === 0;
	}

	/**
	 * Places a beam group's beam once the columns have their x, sets each part's stemTip on it, and returns the
	 * bars to draw: [{ staff, measure, x1, y1, x2, y2, thick, level, partial }], y on the bar's edge toward the stem
	 * tips and thick signed toward the heads. The slope follows the outer notes at half their interval, at most a
	 * staff space and BEAM_SLOPE, and is level when an inner note reaches further toward the beam than both outer
	 * ones. The beam then moves out until the shortest stem is long enough for its bars and every stem reaches the
	 * middle line. The primary bar joins every stem; a deeper bar joins neighbours that both have it, and a note
	 * that has it alone gets a broken (partial) bar.
	 */
	function layBeam(group) {
		const down = group.stemDown;
		const stems = group.members.map((segment) => {
			const part = segment.parts.find((p) => p.staff === group.staff);
			const near = down ? part.heads[0] : part.heads[part.heads.length - 1]; // the head nearest the beam
			return { segment, part, x: segment.centerX + (down ? -STEM_X : STEM_X), y: near.y, bars: beamCount(segment.duration) };
		});
		const first = stems[0];
		const last = stems[stems.length - 1];
		const most = Math.max(...stems.map((stem) => stem.bars));
		const toward = down ? 1 : -1; // y direction from the heads out to the beam
		const run = last.x - first.x;
		const concave = stems.slice(1, -1).some((stem) => (down ? stem.y > Math.max(first.y, last.y) : stem.y < Math.min(first.y, last.y)));
		const rise = concave ? 0 : clamp(clamp((last.y - first.y) / 2, -SPACE, SPACE), -run * BEAM_SLOPE, run * BEAM_SLOPE);
		const slope = run > 0 ? rise / run : 0;
		const middle = first.part.bottom - 4 * LINE_GAP;
		const shortest = BEAM_STEM + (most - 1) * BEAM_STEM_EXTRA;
		let origin = down ? -Infinity : Infinity; // the beam's y at the first stem
		for (const stem of stems) {
			const reach = down ? Math.max(stem.y + shortest, middle) : Math.min(stem.y - shortest, middle);
			const at = reach - slope * (stem.x - first.x);
			origin = down ? Math.max(origin, at) : Math.min(origin, at);
		}
		const yAt = (x) => origin + slope * (x - first.x);
		stems.forEach((stem) => {
			stem.part.stemTip = yAt(stem.x);
		});

		// Each level in runs: stems in a row that all have that bar share one; a run of one gets a broken bar.
		const bars = [];
		for (let level = 1; level <= most; level += 1) {
			const inset = -toward * (level - 1) * BEAM_STEP;
			for (let i = 0; i < stems.length; i += 1) {
				if (stems[i].bars < level) {
					continue;
				}
				let end = i;
				while (end + 1 < stems.length && stems[end + 1].bars >= level) {
					end += 1;
				}
				let x1 = stems[i].x;
				let x2 = stems[end].x;
				if (end === i) {
					const right = stubPointsRight(stems, i, level);
					const length = Math.min(BEAM_STUB, Math.abs(stems[right ? i + 1 : i - 1].x - x1) / 2);
					[x1, x2] = right ? [x1, x1 + length] : [x1 - length, x1];
				}
				bars.push({
					staff: group.staff,
					measure: first.segment.measure, // a group lies within one beat, so within one measure
					x1,
					y1: yAt(x1) + inset,
					x2,
					y2: yAt(x2) + inset,
					thick: -toward * BEAM_THICK,
					level,
					partial: end === i,
				});
				i = end;
			}
		}
		return bars;
	}

	// Whether a beam's bars (layBeam) stay in their staff's band: the treble's from below the ruler to just above the
	// middle of the gap between the staves, the bass's from just below it to the bottom of the drawing. The stems end
	// on the primary bar, so they stay in the band too.
	function beamFits(group, bars) {
		const [top, bottom] = group.staff === "treble"
			? [RULER_HEIGHT + BEAM_CLEAR, GAP_MIDDLE - BEAM_CLEAR]
			: [GAP_MIDDLE + BEAM_CLEAR, STAFF_HEIGHT - BEAM_CLEAR];
		return bars.every((bar) => [bar.y1, bar.y2, bar.y1 + bar.thick, bar.y2 + bar.thick].every((y) => y >= top && y <= bottom));
	}

	/**
	 * Gives every segment its parts (engravePart, with the stem direction of its beam group if it has one) and its
	 * column: startX, width and centerX, left to right from STAFF_LEFT; then each event its span over its segments.
	 * Returns the x where the music ends.
	 */
	function placeColumns(segments, events) {
		let x = STAFF_LEFT;
		for (const segment of segments) {
			// A chord can span both staves; each staff's share gets its own stem, as in piano music.
			segment.parts = [];
			for (const staff of ["treble", "bass"]) {
				if (segment.staves[staff]) {
					segment.parts.push(engravePart(staff, segment.staves[staff], segment, segment.beams[staff]));
				}
			}
			// What the drawing needs either side of the centre: the parts' reach, or a rest's (with its dot). The left
			// margin keeps an accidental clear of a cursor line in the gap before it, and leaves a tie room to arc.
			const { parts } = segment;
			const tieRoom = segment.tied && parts.length ? TIE_ROOM : 0;
			const left = parts.length ? Math.max(...parts.map((part) => part.left)) + tieRoom : 11;
			const right = parts.length ? Math.max(...parts.map((part) => part.right)) : segment.dotted ? 19 : 11;
			const body = bodyWidth(segment.units / UNITS_PER_BEAT);
			const lead = Math.max(0, left + CURSOR_NUDGE + 4 - body / 2);
			segment.startX = x;
			segment.width = lead + body + Math.max(0, right + 3 - body / 2);
			segment.centerX = x + lead + body / 2;
			x += segment.width;
		}
		for (const event of events) {
			const first = event.segments[0];
			const last = event.segments[event.segments.length - 1];
			event.startX = first.startX;
			event.width = last.startX + last.width - first.startX;
			event.centerX = first.centerX;
		}
		return x;
	}

	/**
	 * Lays out a list of notes for drawing, clicks and playback, left to right from STAFF_LEFT. Returns { events,
	 * segments, beams, contentEnd, totalBeats }:
	 *   - events, one per note: { note, index, beat (start, in beats), beats, measure, rest, segments, startX,
	 *     width, centerX (its first segment's) }. The cursor, the current note and playback work on these.
	 *   - segments, every written piece in order (writtenPieces), each its own column: { event, index, start and
	 *     units (in 32nds), beat, measure, duration and dotted (its written value), tied (continues the one before),
	 *     staves, beams, parts (engravePart, one per staff it uses), startX, width, centerX }. A note that crosses a
	 *     bar line has several, tied (rests: split, untied), so no measure overflows and bar lines (barX) fall at
	 *     the true measure boundaries.
	 *   - beams: the bars of every beam group (layBeam), and the x where the music ends.
	 * The order matters: accidentals and beam groups only need the rhythm, the stem directions the groups decide
	 * change the columns' widths, and a beam needs its columns' x (and may turn its stems, so columns run again).
	 */
	function engrave(notes) {
		const events = [];
		const segments = [];
		let units = 0;
		notes.forEach((note, index) => {
			const length = Math.round(noteBeats(note) * UNITS_PER_BEAT);
			const event = {
				note,
				index,
				beat: units / UNITS_PER_BEAT,
				beats: length / UNITS_PER_BEAT,
				measure: Math.floor(units / MEASURE_UNITS),
				rest: !note.pitches.length,
				segments: [],
			};
			for (const piece of writtenPieces(units, length)) {
				const segment = {
					event,
					index,
					start: piece.start,
					units: piece.units,
					beat: piece.start / UNITS_PER_BEAT,
					measure: Math.floor(piece.start / MEASURE_UNITS),
					duration: piece.duration,
					dotted: piece.dotted,
					tied: event.segments.length > 0,
					staves: {},
					beams: {},
					parts: [],
				};
				event.segments.push(segment);
				segments.push(segment);
			}
			events.push(event);
			units += length;
		});
		spellAccidentals(segments);
		const groups = beamGroups(segments);

		// Columns, then beams. A beam that leaves its staff's band (beamFits) turns its stems around; if it doesn't
		// fit that way either, its notes keep their flags. Both change stems, and so the columns, which are then laid
		// out again. Each group only ever moves on a step (its own direction, the other, flags), so this ends.
		let contentEnd;
		let beams;
		let settled = false;
		while (!settled) {
			contentEnd = placeColumns(segments, events);
			beams = [];
			settled = true;
			for (const group of groups.filter((g) => !g.flags)) {
				const bars = layBeam(group);
				if (beamFits(group, bars)) {
					beams.push(...bars);
					continue;
				}
				settled = false;
				if (group.turned) {
					group.flags = true;
					group.members.forEach((segment) => delete segment.beams[group.staff]);
				} else {
					group.turned = true;
					group.stemDown = !group.stemDown;
				}
			}
		}
		return { events, segments, beams, contentEnd, totalBeats: units / UNITS_PER_BEAT };
	}

	// The x of the bar line that starts measure `measure` (0 is the first). No segment crosses a bar line, so inside
	// the music it is the start of the first segment on the measure's first beat; past the music, empty measures
	// follow at BEAT_WIDTH a beat.
	function barX(layout, measure) {
		if (measure === 0) {
			return STAFF_LEFT;
		}
		const start = measure * MEASURE_UNITS;
		const segment = layout.segments.find((s) => s.start >= start);
		if (segment) {
			return segment.startX;
		}
		return layout.contentEnd + Math.max(0, measure * BEATS_PER_MEASURE - layout.totalBeats) * BEAT_WIDTH;
	}

	// The x of cursor gap `index`: the start of note `index`, or the end of the music.
	function gapX(layout, index) {
		return index < layout.events.length ? layout.events[index].startX : layout.contentEnd;
	}

	// The gap nearest to x, for clicks and drags along the ruler.
	function nearestGap(layout, x) {
		let best = 0;
		for (let i = 1; i <= layout.events.length; i += 1) {
			if (Math.abs(gapX(layout, i) - x) < Math.abs(gapX(layout, best) - x)) {
				best = i;
			}
		}
		return best;
	}

	// ── Staff drawing ────────────────────────────────────────────────────────
	// The line above the staff: notes (chords and rests count one each), measures used, beats and seconds.
	function updateMeta() {
		const layout = state.layout;
		const count = state.notes.length;
		const measures = Math.ceil(layout.totalBeats / BEATS_PER_MEASURE - 1e-9);
		const seconds = (layout.totalBeats * 60) / state.bpm;
		ui.noteCount.textContent = `${count} ${count === 1 ? "note" : "notes"} · ${measures} ${measures === 1 ? "measure" : "measures"} · ${layout.totalBeats.toFixed(1)} beats · ${seconds.toFixed(1)} s`;
	}

	// A sharp (alter 1), flat (-1) or natural (0), drawn as paths at (x, y): left of the head, on the note's line or
	// space.
	function drawAccidental(group, alter, x, y) {
		const g = createSvgEl("g", { class: "accidental", transform: `translate(${x} ${y})` });
		if (alter === 1) {
			g.appendChild(createSvgEl("path", { class: "acc-thin", d: "M-2 -9V9M2 -10V8" }));
			g.appendChild(createSvgEl("path", { class: "acc-thick", d: "M-4.2 -2.2L4.2 -4.4M-4.2 4.4L4.2 2.2" }));
		} else if (alter === -1) {
			g.appendChild(createSvgEl("path", { class: "acc-thin", d: "M-3 -14V4" }));
			g.appendChild(createSvgEl("path", { class: "acc-bowl", d: "M-3 4C3 1 5 -4 1 -4.5C-1 -4.8 -2.5 -3 -3 -1.5" }));
		} else {
			g.appendChild(createSvgEl("path", { class: "acc-thin", d: "M-2.5 -10V3.5M2.5 -3.5V10" }));
			g.appendChild(createSvgEl("path", { class: "acc-thick", d: "M-2.5 -1.8L2.5 -3.3M-2.5 3.3L2.5 1.8" }));
		}
		group.appendChild(g);
	}

	// The F clef, drawn here (the G clef is an image, assets/g-clef.svg): a head on the F3 line, its curl, and the
	// two dots in the spaces either side of that line.
	function drawBassClef(parent) {
		const x = 22;
		const f = BASS_TOP + SPACE; // the F3 line the clef is named for
		const g = createSvgEl("g", { class: "bass-clef" });
		g.appendChild(createSvgEl("circle", { class: "clef-fill", cx: x + 4, cy: f, r: 4 }));
		g.appendChild(createSvgEl("path", {
			class: "clef-stroke",
			d: `M${x + 1} ${f - 1}C${x + 1} ${f - 11} ${x + 22} ${f - 13} ${x + 23} ${f + 1}C${x + 24} ${f + 15} ${x + 12} ${f + 27} ${x + 1} ${f + 33}`,
		}));
		g.appendChild(createSvgEl("circle", { class: "clef-fill", cx: x + 30, cy: f - LINE_GAP, r: 2.2 }));
		g.appendChild(createSvgEl("circle", { class: "clef-fill", cx: x + 30, cy: f + LINE_GAP, r: 2.2 }));
		parent.appendChild(g);
	}

	// 4/4 on both staves, between the clefs and the first bar line: one digit in each half of the staff.
	function drawTimeSignature(parent) {
		const g = createSvgEl("g", { class: "time-sig", "aria-hidden": "true" });
		for (const top of [TREBLE_TOP, BASS_TOP]) {
			for (const centre of [top + SPACE, top + SPACE * 3]) {
				const digit = createSvgEl("text", { x: 71, y: centre + 8 });
				digit.textContent = String(BEATS_PER_MEASURE);
				g.appendChild(digit);
			}
		}
		parent.appendChild(g);
	}

	// Dots at x, one per y given (repeats drawn once).
	function drawDots(group, ys, x) {
		for (const y of new Set(ys)) {
			group.appendChild(createSvgEl("circle", { class: "note-dot", cx: x, cy: y, r: 2.1 }));
		}
	}

	// Where a chord's dots go: always in spaces. A head in a space keeps its own; a head on a line takes the space
	// above it, or the one below when another head's dot has that (D5–E5: E5's dot is above D5, so D5's goes below).
	function dotYs(heads) {
		const taken = new Set(heads.filter((head) => head.position % 2 !== 0).map((head) => head.position));
		for (const head of [...heads].reverse().filter((h) => h.position % 2 === 0)) {
			taken.add(taken.has(head.position + 1) ? head.position - 1 : head.position + 1);
		}
		return [...taken].map((position) => heads[0].y - (position - heads[0].position) * LINE_GAP);
	}

	// A rest segment: one written value of a rest (a rest that crosses a bar line is several, untied).
	function drawRest(group, segment) {
		const { duration } = segment;
		const centerX = segment.centerX;
		if (segment.dotted) {
			drawDots(group, [TREBLE_TOP + SPACE * 1.5], centerX + 14);
		}
		// Whole rest hangs from the 4th treble line; half rest sits on the middle line.
		if (duration === 1) {
			group.appendChild(createSvgEl("rect", { class: "note-head rest", x: centerX - 7, y: TREBLE_TOP + SPACE, width: 14, height: LINE_GAP }));
			return;
		}
		if (duration === 2) {
			group.appendChild(createSvgEl("rect", { class: "note-head rest", x: centerX - 7, y: TREBLE_TOP + SPACE * 2 - LINE_GAP, width: 14, height: LINE_GAP }));
			return;
		}
		// Shorter rests: a stylised block on the middle line (the Rest button's glyph), with one dot above it per flag
		// the note would have: one for an eighth, two for a sixteenth, three for a 32nd.
		const restY = TREBLE_TOP + SPACE * 2;
		group.appendChild(createSvgEl("rect", {
			class: "note-head rest",
			x: centerX - 10,
			y: restY - 4,
			width: 20,
			height: 8,
			rx: 2,
		}));
		const flags = { 8: [0], 16: [-3.5, 3.5], 32: [-6, 0, 6] }[duration] || [];
		flags.forEach((dx) => group.appendChild(createSvgEl("circle", { class: "rest-dot", cx: centerX + dx, cy: restY - 9, r: 2 })));
	}

	/**
	 * One staff's share of a note or chord in one segment (see engravePart): ledger lines, accidentals, heads, the
	 * stem from the far head to past the near one, flags and dots. A beamed part's stem runs to its beam (stemTip)
	 * and has no flags; otherwise a sixteenth has two flags and a 32nd three, each on a stem a LINE_GAP longer.
	 */
	function drawPart(group, part, segment) {
		const cx = segment.centerX;
		const { duration, dotted } = segment;
		const heads = part.heads;
		const lowest = heads[0];
		const highest = heads[heads.length - 1];

		// Ledger lines: every line position between the staff and the farthest head, as wide as the heads.
		const x1 = cx + part.headLeft - 4.5;
		const x2 = cx + part.headRight + 4.5;
		for (let p = -2; p >= lowest.position; p -= 2) {
			const y = part.bottom - p * LINE_GAP;
			group.appendChild(createSvgEl("line", { class: "ledger-line", x1, y1: y, x2, y2: y }));
		}
		for (let p = 10; p <= highest.position; p += 2) {
			const y = part.bottom - p * LINE_GAP;
			group.appendChild(createSvgEl("line", { class: "ledger-line", x1, y1: y, x2, y2: y }));
		}

		for (const head of heads) {
			if (head.accidental !== null) {
				drawAccidental(group, head.accidental, cx + part.headLeft - ACC_GAP - head.column * ACC_COLUMN, head.y);
			}
		}

		// Whole and half notes have open heads.
		const open = duration <= 2;
		for (const head of heads) {
			const hx = cx + head.offset;
			group.appendChild(createSvgEl("ellipse", {
				class: open ? "note-head open" : "note-head",
				cx: hx,
				cy: head.y,
				rx: HEAD_RX,
				ry: HEAD_RY,
				transform: `rotate(-20 ${hx} ${head.y})`,
			}));
		}

		if (dotted) {
			drawDots(group, dotYs(heads), cx + part.headRight + 5);
		}

		if (duration === 1) {
			return; // a whole note has no stem
		}

		// The stem runs from the head at its far end past the one at its near end, and reaches at least the middle
		// line.
		const flags = part.beam ? 0 : beamCount(duration);
		const middleY = part.bottom - 4 * LINE_GAP;
		const length = STEM_LENGTH + Math.max(0, flags - 1) * LINE_GAP;
		const stemX = part.stemDown ? cx - STEM_X : cx + STEM_X;
		const stemY1 = part.stemDown ? highest.y + 2 : lowest.y - 2;
		let stemY2 = part.stemDown ? Math.max(lowest.y + length, middleY) : Math.min(highest.y - length, middleY);
		if (part.beam) {
			stemY2 = part.stemTip;
		}
		group.appendChild(createSvgEl("line", { class: part.beam ? "note-stem beamed" : "note-stem", x1: stemX, y1: stemY1, x2: stemX, y2: stemY2 }));

		for (let i = 0; i < flags; i += 1) {
			const y = part.stemDown ? stemY2 - i * 7 : stemY2 + i * 7;
			const d = part.stemDown
				? `M${stemX} ${y}c0.5 -7 9 -9 8 -20`
				: `M${stemX} ${y}c0.5 7 9 9 8 20`;
			group.appendChild(createSvgEl("path", { class: "note-flag", d }));
		}
	}

	/**
	 * Which way the tie from head h of `part` curves, -1 over or 1 under: away from the stem (under a stem-up note,
	 * over a stem-down one), and over when the two ends' stems disagree. In a chord the upper half curve over and
	 * the lower half under; a middle head follows the single-note rule.
	 */
	function tieDirection(part, next, h) {
		const single = part.stemDown === next.stemDown && !part.stemDown ? 1 : -1;
		const n = part.heads.length;
		if (n === 1 || (n % 2 === 1 && h === (n - 1) / 2)) {
			return single;
		}
		return h >= n / 2 ? -1 : 1;
	}

	/**
	 * The ties of a note written as several segments: an arc from every head of each segment to the same pitch in
	 * the next, staff by staff. A chord's ties start together past its rightmost head (and past the dot of a dotted
	 * segment) and end together before the next chord's leftmost, so heads set across the stem for a second don't
	 * cross them; the inner ones are flatter, so ties a step apart don't touch. Each is a filled crescent, thicker
	 * in the middle, as engraved ties are. With a system (sheetSystems), only the ties that touch its measures are
	 * drawn: one that runs out of it hangs to its last bar line, and one that runs in starts after its clefs, as a
	 * printed tie crosses from one line of music to the next.
	 */
	function drawTies(group, event, system) {
		event.segments.slice(0, -1).forEach((segment, s) => {
			const after = event.segments[s + 1];
			const fromShown = inSystem(segment, system);
			const toShown = inSystem(after, system);
			if (!fromShown && !toShown) {
				return;
			}
			for (const part of segment.parts) {
				const next = after.parts.find((other) => other.staff === part.staff);
				const x1 = fromShown ? segment.centerX + part.headRight + (segment.dotted ? 9.5 : 1.5) : system.left + 2;
				const x2 = toShown ? after.centerX + next.headLeft - 1.5 : system.right - 2;
				const span = Math.max(1, x2 - x1);
				part.heads.forEach((head, h) => {
					const dir = tieDirection(part, next, h);
					const outer = h === 0 || h === part.heads.length - 1;
					const y = head.y + dir * 2.5;
					const bow = (outer ? clamp(span * 0.22, 4, 9) : clamp(span * 0.1, 2, 3.5)) * dir;
					const c1 = x1 + span * 0.2;
					const c2 = x2 - span * 0.2;
					const back = y + bow + dir * 2.2;
					group.appendChild(createSvgEl("path", {
						class: "note-tie",
						d: `M${x1} ${y}C${c1} ${y + bow} ${c2} ${y + bow} ${x2} ${y}C${c2} ${back} ${c1} ${back} ${x1} ${y}Z`,
					}));
				});
			}
		});
	}

	// Whether a segment is drawn in `system`. Without one (the screen's single long line) every segment is.
	function inSystem(segment, system) {
		return !system || (segment.measure >= system.from && segment.measure < system.to);
	}

	/**
	 * One note, chord or rest as <g class="note-group" data-index="i">, every segment of it inside, ties included,
	 * so the current-note tint, playback's highlight (found by that index) and the tooltip cover it all. A chord
	 * CHORD_TYPES knows gets its symbol above the treble staff, over its first segment. options.className adds a
	 * class ("current"); options.system draws only the segments in that system's measures (sheetSystems), and
	 * nothing if it has none there.
	 */
	function drawEvent(parent, event, options) {
		const opts = options || {};
		const segments = event.segments.filter((segment) => inSystem(segment, opts.system));
		if (!segments.length) {
			return;
		}
		const group = createSvgEl("g", {
			class: opts.className ? `note-group ${opts.className}` : "note-group",
			"data-index": event.index,
		});
		for (const segment of segments) {
			if (event.rest) {
				drawRest(group, segment);
			} else {
				segment.parts.forEach((part) => drawPart(group, part, segment));
			}
		}
		if (!event.rest) {
			drawTies(group, event, opts.system);
			const symbol = chordName(event.note.pitches);
			if (symbol && inSystem(event.segments[0], opts.system)) {
				const text = createSvgEl("text", { class: "chord-symbol", x: event.centerX, y: CHORD_SYMBOL_Y });
				text.textContent = symbol;
				group.appendChild(text);
			}
		}
		const title = createSvgEl("title", {});
		const split = event.segments.length > 1 ? (event.rest ? ", split at the bar line" : ", tied over the bar line") : "";
		title.textContent = `Note ${event.index + 1}: ${describeNote(event.note)}${split}`;
		group.appendChild(title);
		parent.appendChild(group);
	}

	// Beam bars (engrave's layout.beams) as parallelograms, a little wider than the stems they join so their ends
	// are covered. One layer over the notes: a beam belongs to several notes, so no note's group holds it. With a
	// system, only the bars in its measures (a beam never crosses a bar line).
	function drawBeams(parent, bars, system) {
		const g = createSvgEl("g", { class: "beams", "aria-hidden": "true" });
		for (const bar of bars) {
			if (system && (bar.measure < system.from || bar.measure >= system.to)) {
				continue;
			}
			const half = 0.8; // half the stem's stroke
			const points = [
				[bar.x1 - half, bar.y1],
				[bar.x2 + half, bar.y2],
				[bar.x2 + half, bar.y2 + bar.thick],
				[bar.x1 - half, bar.y1 + bar.thick],
			].map(([px, py]) => `${px.toFixed(2)},${py.toFixed(2)}`).join(" ");
			g.appendChild(createSvgEl("polygon", {
				class: bar.partial ? "note-beam partial" : "note-beam",
				"data-level": bar.level,
				"data-staff": bar.staff,
				points,
			}));
		}
		parent.appendChild(g);
	}

	// The ruler: a strip along the top with each measure's number at its bar line. Its band is the hit area for
	// moving the cursor and, with Shift, selecting (styles.css gives it the ew-resize pointer); its tooltip says so.
	function drawRuler(parent, layout, width) {
		const g = createSvgEl("g", { class: "ruler" });
		const band = createSvgEl("rect", { class: "ruler-band", x: 0, y: 0, width, height: RULER_HEIGHT });
		const tip = createSvgEl("title", {});
		tip.textContent = "Click or drag to move the cursor; Shift+click or Shift+drag to select";
		band.appendChild(tip);
		g.appendChild(band);
		g.appendChild(createSvgEl("line", { class: "ruler-edge", x1: 0, y1: RULER_HEIGHT - 0.5, x2: width, y2: RULER_HEIGHT - 0.5 }));
		for (let measure = 0; measure < layout.measureCount; measure += 1) {
			const label = createSvgEl("text", { class: "ruler-number", x: barX(layout, measure) + 5, y: 15 });
			label.textContent = String(measure + 1);
			g.appendChild(label);
		}
		parent.appendChild(g);
	}

	// The cursor: a line through both staves in its gap, and a handle on the ruler showing the length the next note
	// will get, so where and how long read together.
	function drawCursor(parent, layout) {
		const x = gapX(layout, state.caret) + CURSOR_NUDGE;
		const g = createSvgEl("g", { class: "cursor", "aria-hidden": "true" });
		g.appendChild(createSvgEl("line", { class: "cursor-line", x1: x, y1: RULER_HEIGHT, x2: x, y2: BASS_BOTTOM + 34 }));
		g.appendChild(createSvgEl("rect", { class: "cursor-handle", x: x - 19, y: 3, width: 38, height: 16, rx: 8 }));
		const label = createSvgEl("text", { class: "cursor-label", x, y: 14.5 });
		label.textContent = `${durationLabel(state.selectedDuration)}${state.dotted ? "·" : ""}`;
		g.appendChild(label);
		parent.appendChild(g);
	}

	/**
	 * The selection: one tinted region over all its columns, from the gap before its first note to the gap after
	 * its last, edged in the accent and carried up through the ruler, so the notes read as one block (common
	 * region), apart from the current note's softer, borderless band. Drawn before the ruler, whose translucent
	 * band lets the tint through under the measure numbers.
	 */
	function drawSelection(parent, layout, range) {
		const x1 = gapX(layout, range.start);
		const x2 = gapX(layout, range.end);
		const width = x2 - x1;
		parent.appendChild(createSvgEl("rect", { class: "selection-ruler", x: x1, y: 0, width, height: RULER_HEIGHT }));
		parent.appendChild(createSvgEl("rect", {
			class: "selection-band",
			x: x1 + 1,
			y: RULER_HEIGHT + 2,
			width: Math.max(0, width - 2),
			height: STAFF_HEIGHT - RULER_HEIGHT - 4,
			rx: 6,
		}));
	}

	/**
	 * The grand staff from x 14 to `end`: both staves' lines, the system line and brace that join them, both clefs
	 * and, with `time`, the time signature. Bar lines are the caller's: they follow the music.
	 */
	function drawGrandStaff(parent, end, time) {
		const staffLines = createSvgEl("g", { class: "staff-lines" });
		for (const top of [TREBLE_TOP, BASS_TOP]) {
			for (let i = 0; i < 5; i += 1) {
				const y = top + i * SPACE;
				staffLines.appendChild(createSvgEl("line", { class: "staff-line", x1: 14, y1: y, x2: end, y2: y }));
			}
		}
		parent.appendChild(staffLines);

		// System line and brace-side join the two staves into one grand staff.
		const middle = (TREBLE_TOP + BASS_BOTTOM) / 2;
		parent.appendChild(createSvgEl("line", { class: "system-line", x1: 14, y1: TREBLE_TOP, x2: 14, y2: BASS_BOTTOM }));
		parent.appendChild(createSvgEl("path", {
			class: "brace",
			d: `M9 ${TREBLE_TOP}C2 ${TREBLE_TOP + 30} 10 ${middle - 20} 3 ${middle}`
				+ `C10 ${middle + 20} 2 ${BASS_BOTTOM - 30} 9 ${BASS_BOTTOM}`,
		}));

		parent.appendChild(createSvgEl("image", {
			class: "g-clef",
			href: CLEF_HREF,
			x: 24,
			y: TREBLE_TOP - 18,
			width: 34,
			height: 58,
		}));
		drawBassClef(parent);
		if (time) {
			drawTimeSignature(parent);
		}
	}

	function drawBarLine(parent, x, final) {
		const attrs = { class: final ? "bar-line final" : "bar-line", x1: x, y1: TREBLE_TOP, x2: x, y2: BASS_BOTTOM };
		parent.appendChild(createSvgEl("line", attrs));
	}

	/**
	 * Rebuilds the whole SVG from state.notes and stores the layout in state.layout: paper, the selection's region
	 * or the current note's band, ruler, both staves, brace, clefs, time signature and bar lines, then one group
	 * per note (drawEvent), the beams, the cursor, the #playhead line and the #ghost layer for hover previews. The
	 * staff runs on past the music by at least ROOM_AFTER and fills the visible width. Scrolling is left to the
	 * caller (revealCursor).
	 */
	function drawStaff() {
		const layout = engrave(state.notes);
		state.layout = layout;
		const svg = ui.staffSvg;
		const viewWidth = ui.staffScroll.clientWidth;
		layout.measureCount = Math.max(2, Math.ceil(layout.totalBeats / BEATS_PER_MEASURE - 1e-9));
		while (barX(layout, layout.measureCount) < Math.max(layout.contentEnd + ROOM_AFTER, viewWidth - 24)) {
			layout.measureCount += 1;
		}
		const staffEnd = barX(layout, layout.measureCount);
		const width = Math.max(staffEnd + 24, viewWidth);
		const height = STAFF_HEIGHT;

		// A touch's events go on to the element it came down on even once that has left the page, and from there they
		// no longer reach the staff's listeners: a long-press drag, which redraws as it goes, would scroll the page
		// instead of selecting. So that one element is kept, out of sight, in the new drawing.
		const kept = state.touchTarget;
		const touched = kept && kept !== svg && svg.contains(kept) ? kept : null;
		svg.innerHTML = "";
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));

		const defs = createSvgEl("defs", {});
		const pattern = createSvgEl("pattern", {
			id: "staffPaper",
			patternUnits: "userSpaceOnUse",
			width: 12,
			height: 12,
		});
		pattern.appendChild(createSvgEl("rect", { width: 12, height: 12, fill: "#fffef8" }));
		pattern.appendChild(createSvgEl("path", { d: "M12 0L0 12", stroke: "#f1efe4", "stroke-width": 0.6 }));
		defs.appendChild(pattern);
		svg.appendChild(defs);

		svg.appendChild(createSvgEl("rect", { x: 0, y: 0, width, height, fill: "url(#staffPaper)" }));

		// The selection, or else the current note's columns (all its segments), tinted behind everything: what
		// chord tones, ↑ ↓, a length change and Delete will act on.
		const range = selection();
		const current = range ? null : layout.events[state.caret - 1];
		if (range) {
			drawSelection(svg, layout, range);
		} else if (current) {
			svg.appendChild(createSvgEl("rect", {
				class: "current-band",
				x: current.startX + 1,
				y: RULER_HEIGHT + 4,
				width: Math.max(0, current.width - 2),
				height: STAFF_HEIGHT - RULER_HEIGHT - 8,
				rx: 6,
			}));
		}
		drawRuler(svg, layout, width);
		drawGrandStaff(svg, staffEnd, true);
		for (let measure = 0; measure <= layout.measureCount; measure += 1) {
			drawBarLine(svg, barX(layout, measure), measure === layout.measureCount);
		}

		layout.events.forEach((event) => drawEvent(svg, event, { className: event === current ? "current" : "" }));
		drawBeams(svg, layout.beams);
		drawCursor(svg, layout);

		svg.appendChild(createSvgEl("line", {
			id: "playhead",
			class: "playhead",
			x1: STAFF_LEFT,
			y1: TREBLE_TOP - 30,
			x2: STAFF_LEFT,
			y2: BASS_BOTTOM + 30,
		}));
		svg.appendChild(createSvgEl("g", { id: "ghost", class: "ghost", "aria-hidden": "true" }));
		if (touched) {
			const keep = createSvgEl("g", { class: "touch-kept", display: "none", "aria-hidden": "true" });
			keep.appendChild(touched);
			svg.appendChild(keep);
		}

		const count = state.notes.length;
		const where = range
			? `${notesLabel(range)} selected`
			: `cursor ${state.caret === count ? "at the end" : `before note ${state.caret + 1}`}`;
		svg.setAttribute("aria-label", count
			? `Sheet music, grand staff: ${countLabel(count)}, ${where}.`
			: "Sheet music, grand staff, empty.");
		updateMeta();
		// The keyboard and the length picker show the same current note (or selection) as the staff.
		markHeldKeys();
		markHeldLength();
		if (state.hover) {
			showGhost(hitTest(state.hover.x, state.hover.y, state.hover.shift));
		}
		if (state.playing && state.sounding) {
			highlight(state.sounding, false);
		}
	}

	// ── Sheets: printing and image export ───────────────────────────────────
	/**
	 * Breaks a layout into systems of whole measures that fit `width`: [{ from, to (measures; to is exclusive),
	 * left and right (the x of its first and last bar lines in the layout), dx (how far its music moves to sit after
	 * its clefs), width }]. Each takes as many measures as fit after its clefs (on the first, after the time
	 * signature too). A measure too wide for any system gets one to itself, wider than the rest, so it is printed
	 * smaller rather than cut. Systems are left ragged, not stretched to the full width (todo.md).
	 */
	function sheetSystems(layout, width) {
		const measures = Math.max(1, Math.ceil(layout.totalBeats / BEATS_PER_MEASURE - 1e-9));
		const systems = [];
		let from = 0;
		while (from < measures) {
			const start = from === 0 ? STAFF_LEFT : SYSTEM_LEFT;
			const left = barX(layout, from);
			const room = (to) => start + barX(layout, to) - left + SHEET_MARGIN;
			let to = from + 1;
			while (to < measures && room(to + 1) <= width) {
				to += 1;
			}
			systems.push({ from, to, left, right: barX(layout, to), dx: start - left, width: Math.max(width, room(to)) });
			from = to;
		}
		return systems;
	}

	/**
	 * One system of a sheet into `parent`, in system units (x from 0 at the left edge, y as on the screen's staff):
	 * the grand staff to its last bar line, clefs, on the first system (options.first) the time signature and the
	 * tempo, then its bar lines (the piece's last one final, options.last) and its measures' music, moved along by
	 * system.dx. The music is drawn by the screen's own drawEvent and drawBeams from the same layout, so a sheet is
	 * engraved exactly as the staff is; the start of each system has no bar line, as in print.
	 */
	function drawSystem(parent, layout, system, options) {
		drawGrandStaff(parent, system.dx + system.right, options.first);
		if (options.first) {
			// The tempo's quarter note is drawn like the staff's own heads, not the ♩ character, which few fonts have
			// (and which a PNG export would draw in whatever font stands in).
			const base = TREBLE_TOP - 32;
			const head = base - 3.5;
			const tempo = createSvgEl("g", { class: "tempo-mark" });
			const transform = `rotate(-20 20 ${head})`;
			tempo.appendChild(createSvgEl("ellipse", { class: "tempo-note", cx: 20, cy: head, rx: 4.6, ry: 3.4, transform }));
			tempo.appendChild(createSvgEl("line", { class: "tempo-stem", x1: 24.1, y1: head - 1, x2: 24.1, y2: base - 19 }));
			const text = createSvgEl("text", { class: "tempo-text", x: 30, y: base });
			text.textContent = `= ${state.bpm}`;
			tempo.appendChild(text);
			parent.appendChild(tempo);
		}
		const music = createSvgEl("g", { class: "system-music", transform: `translate(${system.dx} 0)` });
		for (let measure = system.from + 1; measure <= system.to; measure += 1) {
			drawBarLine(music, barX(layout, measure), options.last && measure === system.to);
		}
		layout.events.forEach((event) => drawEvent(music, event, { system }));
		drawBeams(music, layout.beams, system);
		parent.appendChild(music);
	}

	/**
	 * The composition as one SVG element for image export: its systems stacked down a white sheet SHEET_WIDTH wide
	 * (wider if one measure needs it), SYSTEM_GAP apart. Returns { svg, width, height, systems }; the SVG is not in
	 * the document yet and still styled by class (standaloneSvg finishes it).
	 */
	function buildSheet() {
		const layout = engrave(state.notes);
		const systems = sheetSystems(layout, SHEET_WIDTH);
		const width = Math.max(...systems.map((system) => system.width));
		const height = SHEET_MARGIN * 2 + systems.length * SYSTEM_HEIGHT + (systems.length - 1) * SYSTEM_GAP;
		const svg = createSvgEl("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "sheet" });
		const title = createSvgEl("title", {});
		title.textContent = `Notar: ${countLabel(state.notes.length)} at ${state.bpm} BPM`;
		svg.appendChild(title);
		svg.appendChild(createSvgEl("rect", { class: "sheet-paper", x: 0, y: 0, width, height }));
		systems.forEach((system, i) => {
			const y = SHEET_MARGIN + i * (SYSTEM_HEIGHT + SYSTEM_GAP) - RULER_HEIGHT;
			const g = createSvgEl("g", { class: "system", transform: `translate(0 ${y})` });
			drawSystem(g, layout, system, { first: i === 0, last: i === systems.length - 1 });
			svg.appendChild(g);
		});
		return { svg, width, height, systems };
	}

	/**
	 * Fills #printSheet with the composition, one <svg> per system so a page break never cuts a system in half
	 * (the print stylesheet scales each to the page width and hides everything else). Runs on beforeprint, so the
	 * browser's own Print command and Save as PDF get it too; afterprint empties it again.
	 */
	function buildPrintSheet() {
		const layout = engrave(state.notes);
		const systems = sheetSystems(layout, SHEET_WIDTH);
		ui.printSheet.innerHTML = "";
		systems.forEach((system, i) => {
			const svg = createSvgEl("svg", {
				class: "print-system",
				viewBox: `0 ${RULER_HEIGHT} ${system.width} ${SYSTEM_HEIGHT}`,
				role: "img",
				"aria-label": `Measures ${system.from + 1} to ${system.to}`,
				"data-from": system.from,
				"data-to": system.to,
			});
			drawSystem(svg, layout, system, { first: i === 0, last: i === systems.length - 1 });
			ui.printSheet.appendChild(svg);
		});
	}

	// Scrolls the staff (if needed) so the cursor is in view, with room ahead of it for the next note.
	function revealCursor() {
		const scroll = ui.staffScroll;
		const x = gapX(state.layout, state.caret);
		if (x < scroll.scrollLeft + 40 || x > scroll.scrollLeft + scroll.clientWidth - 120) {
			scroll.scrollLeft = Math.max(0, x - scroll.clientWidth * 0.6);
		}
	}

	function setPlayhead(x, visible) {
		const playhead = ui.staffSvg.querySelector("#playhead");
		if (!playhead) {
			return;
		}
		playhead.setAttribute("x1", x);
		playhead.setAttribute("x2", x);
		playhead.classList.toggle("shown", visible);
	}

	function clearActiveNotes() {
		ui.staffSvg.querySelectorAll(".note-group.active").forEach((node) => {
			node.classList.remove("active");
		});
		ui.piano.querySelectorAll(".key.sounding").forEach((node) => node.classList.remove("sounding"));
	}

	// ── Staff interaction ────────────────────────────────────────────────────
	// The natural pitch whose line or space is nearest y (sharps and flats come from the keys, or ↑ ↓ after). null
	// more than two steps beyond C6 or C2.
	function pitchAtY(y) {
		let best = NATURAL_PITCHES[0];
		for (const entry of NATURAL_PITCHES) {
			if (Math.abs(entry.y - y) < Math.abs(best.y - y)) {
				best = entry;
			}
		}
		const top = NATURAL_PITCHES[NATURAL_PITCHES.length - 1].y;
		const bottom = NATURAL_PITCHES[0].y;
		return y < top - SPACE || y > bottom + SPACE ? null : best.pitch;
	}

	/**
	 * What a click at staff point (x, y) would do, for the click itself and for the hover preview:
	 *   - on the ruler: { kind: "cursor", index }, move the cursor to the nearest gap;
	 *   - near the cursor line, when it is inside the music: { kind: "insert", pitch, x }, a new note there, unless
	 *     the pointer is on a head (a short note's head can sit inside that target, wider on touch);
	 *   - on a note's column (any of its segments, if tied) at a pitch it has: "remove" that pitch if it is the
	 *     current chord, else "select" the note (the cursor moves after it); at a pitch it hasn't: "chord", add it
	 *     as a chord tone;
	 *   - past the music: { kind: "append", pitch, x }, a new note at the end.
	 * pitch is from the line or space under the pointer (pitchAtY); x is where the preview head goes. null if none.
	 * With extend (Shift held), every point selects instead (extendTarget): { kind: "extend", index }.
	 */
	function hitTest(x, y, extend) {
		const layout = state.layout;
		if (extend) {
			return { kind: "extend", index: extendTarget(x, y) };
		}
		if (y < RULER_HEIGHT) {
			return { kind: "cursor", index: nearestGap(layout, x) };
		}
		const pitch = pitchAtY(y);
		if (!pitch || x < STAFF_LEFT - 4) {
			return null;
		}
		// Any segment of a tied note stands for the whole note: a head in it selects or removes, its column adds.
		const segment = layout.segments.find((s) => x >= s.startX && x < s.startX + s.width);
		const event = segment ? segment.event : null;
		let head = null;
		for (const part of segment ? segment.parts : []) {
			head = head || part.heads.find((h) => diatonic(h.pitch) === diatonic(pitch));
		}
		const onHead = head && Math.abs(x - (segment.centerX + head.offset)) <= HEAD_RX + 3;
		const cursor = gapX(layout, state.caret) + CURSOR_NUDGE;
		if (!onHead && state.caret < layout.events.length && Math.abs(x - cursor) <= (coarsePointer.matches ? 16 : 9)) {
			return { kind: "insert", pitch, x: cursor };
		}
		if (event && head) {
			const current = event.index === state.caret - 1;
			return {
				kind: current && event.note.pitches.length > 1 ? "remove" : "select",
				index: event.index,
				pitch: head.pitch,
				x: segment.centerX + head.offset,
			};
		}
		if (event) {
			return { kind: "chord", index: event.index, pitch, x: segment.centerX };
		}
		if (x >= layout.contentEnd) {
			const beats = noteBeats({ duration: state.selectedDuration, dotted: state.dotted });
			return { kind: "append", pitch, x: layout.contentEnd + Math.max(bodyWidth(beats) / 2, 20) };
		}
		return null;
	}

	/**
	 * Where a Shift+click or Shift+drag at (x, y) takes the cursor, extending the selection from its anchor (or the
	 * cursor): on the ruler, the nearest gap, as a plain click there moves the cursor; on a note's column, the gap
	 * that takes that note in, whichever side of the anchor it is; past the music, the end.
	 */
	function extendTarget(x, y) {
		const layout = state.layout;
		if (y < RULER_HEIGHT) {
			return nearestGap(layout, x);
		}
		const segment = layout.segments.find((s) => x >= s.startX && x < s.startX + s.width);
		if (!segment) {
			return x >= layout.contentEnd ? layout.events.length : 0;
		}
		const from = state.anchor === null ? state.caret : state.anchor;
		return segment.index >= from ? segment.index + 1 : segment.index;
	}

	/**
	 * Draws the hover preview for a hitTest result into #ghost: a faint head with its ledger lines and a label
	 * ("E4", "+ E4" for a chord tone, "− E4" in red for one that would go), a dashed cursor line over the ruler, or
	 * with Shift a dashed outline of the selection a click would make. null, or a click that only selects the note
	 * as the current one, shows nothing.
	 */
	function showGhost(hit) {
		const layer = ui.staffSvg.querySelector("#ghost");
		if (!layer) {
			return;
		}
		layer.innerHTML = "";
		layer.setAttribute("class", hit && hit.kind === "remove" ? "ghost remove" : "ghost");
		if (!hit || hit.kind === "select") {
			return;
		}
		if (hit.kind === "extend") {
			const from = state.anchor === null ? state.caret : state.anchor;
			if (hit.index !== from) {
				const x1 = gapX(state.layout, Math.min(from, hit.index));
				const x2 = gapX(state.layout, Math.max(from, hit.index));
				layer.appendChild(createSvgEl("rect", {
					class: "ghost-selection",
					x: x1 + 1,
					y: RULER_HEIGHT + 2,
					width: Math.max(0, x2 - x1 - 2),
					height: STAFF_HEIGHT - RULER_HEIGHT - 4,
					rx: 6,
				}));
			}
			return;
		}
		if (hit.kind === "cursor") {
			const x = gapX(state.layout, hit.index) + CURSOR_NUDGE;
			layer.appendChild(createSvgEl("line", { class: "ghost-cursor", x1: x, y1: RULER_HEIGHT, x2: x, y2: BASS_BOTTOM + 34 }));
			return;
		}
		const place = staffPlacement(hit.pitch);
		for (let p = -2; p >= place.position; p -= 2) {
			const y = place.bottom - p * LINE_GAP;
			layer.appendChild(createSvgEl("line", { class: "ghost-ledger", x1: hit.x - 12, y1: y, x2: hit.x + 12, y2: y }));
		}
		for (let p = 10; p <= place.position; p += 2) {
			const y = place.bottom - p * LINE_GAP;
			layer.appendChild(createSvgEl("line", { class: "ghost-ledger", x1: hit.x - 12, y1: y, x2: hit.x + 12, y2: y }));
		}
		layer.appendChild(createSvgEl("ellipse", {
			class: "ghost-head",
			cx: hit.x,
			cy: place.y,
			rx: HEAD_RX,
			ry: HEAD_RY,
			transform: `rotate(-20 ${hit.x} ${place.y})`,
		}));
		const label = createSvgEl("text", { class: "ghost-label", x: hit.x + 12, y: place.y - 8 });
		label.textContent = `${hit.kind === "chord" ? "+ " : hit.kind === "remove" ? "− " : ""}${pitchLabel(hit.pitch)}`;
		layer.appendChild(label);
	}

	// Carries out a click on the staff (a hitTest result).
	function applyHit(hit) {
		if (!hit) {
			return;
		}
		const id = hit.pitch ? pitchId(hit.pitch) : null;
		switch (hit.kind) {
			case "cursor":
				moveCursor(hit.index);
				break;
			case "extend":
				moveCursor(hit.index, true, true);
				break;
			case "insert":
				insertNote([id]);
				break;
			case "append":
				insertNote([id], state.notes.length);
				break;
			case "chord":
				stackPitch(hit.index, hit.pitch);
				flashKeys([id]);
				break;
			case "remove":
				stackPitch(hit.index, hit.pitch);
				break;
			case "select":
				moveCursor(hit.index + 1, false);
				setStatus(`Note ${hit.index + 1}: ${describeNote(state.notes[hit.index])}. Click the staff above or below it to add chord tones; Apply gives it the picked length; Delete removes it.`);
				break;
			default:
		}
	}

	// A pointer event's position in staff (SVG user) units.
	function staffPoint(event) {
		const matrix = ui.staffSvg.getScreenCTM();
		if (!matrix) {
			return null;
		}
		const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
		return { x: point.x, y: point.y };
	}

	/**
	 * Clicks on the staff edit it (applyHit), or with Shift select (extendTarget); a mouse hovering over it gets the
	 * preview (showGhost), Shift's included. A mouse press on the ruler is handled from pointerdown to pointerup
	 * instead: it moves the cursor live (with Shift, the selection's end) and announces on release, and the click
	 * that may follow is swallowed, wherever it lands (swallowClick; the next pointerdown resets it, as a redraw
	 * during the drag can mean no click comes). Touch uses click alone, so a swipe still scrolls the staff and a tap
	 * on the ruler moves the cursor; only a long-press (touchSelect) is followed from down to up.
	 */
	function bindStaff() {
		const svg = ui.staffSvg;
		let swallowClick = false;
		let press = null; // a touch held on the staff: { id, x, y (client), point (staff), timer, selecting, held }
		svg.addEventListener("click", (event) => {
			if (swallowClick) {
				swallowClick = false;
				return;
			}
			const point = staffPoint(event);
			if (point) {
				applyHit(hitTest(point.x, point.y, event.shiftKey));
			}
		});
		svg.addEventListener("pointermove", (event) => {
			if (event.pointerType === "touch") {
				if (press && event.pointerId === press.id) {
					touchMove(event);
				}
				return;
			}
			const point = staffPoint(event);
			if (!point) {
				return;
			}
			state.hover = { x: point.x, y: point.y, shift: event.shiftKey };
			if (state.dragging && !(event.buttons & 1)) {
				endDrag(); // the release went elsewhere (a context menu, say): don't drag on with no button held
			}
			if (state.dragging) {
				moveCursor(nearestGap(state.layout, point.x), false, state.dragExtend);
				return;
			}
			showGhost(hitTest(point.x, point.y, event.shiftKey));
		});
		svg.addEventListener("pointerleave", () => {
			state.hover = null;
			showGhost(null);
		});
		// Shift pressed or let go over the staff turns the preview into the selection's, or back, without a move.
		for (const type of ["keydown", "keyup"]) {
			window.addEventListener(type, (event) => {
				if (event.key === "Shift" && state.hover && !state.dragging) {
					state.hover.shift = event.shiftKey;
					showGhost(hitTest(state.hover.x, state.hover.y, event.shiftKey));
				}
			});
		}
		svg.addEventListener("pointerdown", (event) => {
			const point = staffPoint(event);
			swallowClick = false;
			if (event.pointerType === "touch") {
				touchStart(event, point);
				return;
			}
			if (event.pointerType !== "mouse" || event.button !== 0 || !point || point.y >= RULER_HEIGHT) {
				return;
			}
			swallowClick = true;
			state.dragging = true;
			state.dragExtend = event.shiftKey;
			svg.setPointerCapture(event.pointerId);
			moveCursor(nearestGap(state.layout, point.x), false, state.dragExtend);
		});
		function endDrag() {
			if (state.dragging) {
				state.dragging = false;
				state.dragExtend = false;
				setStatus(selection() ? describeSelection() : describeCursor());
			}
		}
		svg.addEventListener("pointerup", (event) => {
			if (press && event.pointerId === press.id) {
				touchEnd();
			}
			endDrag();
		});
		svg.addEventListener("pointercancel", (event) => {
			if (press && event.pointerId === press.id) {
				touchEnd();
			}
			endDrag();
		});

		// A long-press: a touch that stays put for LONG_PRESS_MS starts a selection (touchSelect), and dragging on
		// stretches it, the page held still (only a listener that isn't passive may prevent touchmove's scroll). A
		// touch that moves first is a scroll, and a short one a tap (a click), as without this.
		function touchStart(event, point) {
			cancelPress();
			if (!point) {
				return;
			}
			press = { id: event.pointerId, x: event.clientX, y: event.clientY, point, selecting: false, held: null };
			press.timer = window.setTimeout(touchSelect, LONG_PRESS_MS);
			state.touchTarget = event.target;
		}
		function touchMove(event) {
			if (!press.selecting) {
				if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) {
					cancelPress();
				}
				return;
			}
			const point = staffPoint(event);
			if (!point) {
				return;
			}
			const gap = nearestGap(state.layout, point.x);
			const held = press.held; // what the long-press took, which the drag keeps in whichever way it goes
			if (!held) {
				moveCursor(gap, false, true);
			} else if (gap <= held.start) {
				select(held.end, gap, false);
			} else {
				select(held.start, Math.max(gap, held.end), false);
			}
		}
		function touchEnd() {
			if (press.selecting) {
				swallowClick = true; // the click a touch ends with would otherwise write a note
				state.dragging = false;
				setStatus(selection() ? describeSelection() : describeCursor());
			}
			cancelPress();
		}
		function cancelPress() {
			if (press) {
				window.clearTimeout(press.timer);
			}
			press = null;
			state.touchTarget = null;
		}
		/**
		 * The long-press itself: the note under the finger is selected or, if there is a selection already, the
		 * selection stretches to take it in, as a Shift+click does; on the ruler or past the music, the selection
		 * starts at that gap, to be dragged out. state.dragging keeps the staff from scrolling under the finger. A
		 * short buzz confirms it where the device can.
		 */
		function touchSelect() {
			const { x, y } = press.point;
			const layout = state.layout;
			const segment = y >= RULER_HEIGHT ? layout.segments.find((s) => x >= s.startX && x < s.startX + s.width) : null;
			press.selecting = true;
			state.dragging = true;
			if (segment && selection()) {
				moveCursor(extendTarget(x, y), true, true);
			} else if (segment) {
				press.held = { start: segment.index, end: segment.index + 1 };
				select(segment.index, segment.index + 1);
			} else {
				const gap = y >= RULER_HEIGHT && x >= layout.contentEnd ? layout.events.length : nearestGap(layout, x);
				press.held = { start: gap, end: gap };
				select(gap, gap);
				setStatus("Drag along the staff to select.");
			}
			if (navigator.vibrate) {
				navigator.vibrate(12);
			}
		}
		svg.addEventListener("touchmove", (event) => {
			if (press && press.selecting) {
				event.preventDefault();
			}
		}, { passive: false });
		// A long-press on Android also asks for a context menu; while a finger is down on the staff, there is none.
		svg.addEventListener("contextmenu", (event) => {
			if (press) {
				event.preventDefault();
			}
		});
	}

	// ── Playback ─────────────────────────────────────────────────────────────
	/**
	 * Ends a run: bumping playbackToken makes its pending highlight timers and its loop return, and silence() fades
	 * out every voice already scheduled. startPlayback calls it too, to clear any earlier run. Tells pwa.js
	 * (notar:playback) that playback has stopped.
	 */
	function stopPlayback() {
		state.playbackToken += 1;
		state.playing = false;
		state.pass = null;
		state.sounding = null;
		state.soundingSegment = 0;
		silence();
		document.dispatchEvent(new CustomEvent("notar:playback", { detail: { playing: false } }));
		ui.playBtn.disabled = false;
		ui.stopBtn.disabled = true;
		clearActiveNotes();
		setPlayhead(STAFF_LEFT, false);
	}

	/**
	 * Lights the note playing: its group on the staff (every segment of a tied note), every key of it, and the
	 * playhead, on the segment state.soundingSegment; scroll keeps that about a third of the way into the view. The
	 * note is found by identity when this runs, so notes inserted or deleted before it during playback don't shift
	 * the light onto a neighbour; drawStaff calls it again (unscrolled) after a redraw mid-note, so the light and
	 * the playhead survive the rebuild.
	 */
	function highlight(note, scroll) {
		state.sounding = note;
		clearActiveNotes();
		for (const id of note.pitches) {
			const key = keyFor(parsePitch(id));
			if (key) {
				key.classList.add("sounding");
			}
		}
		const index = state.notes.indexOf(note);
		const event = state.layout.events[index];
		if (!event) {
			return; // deleted while playing: it still sounds, but has no place on the staff
		}
		const group = ui.staffSvg.querySelector(`.note-group[data-index="${index}"]`);
		if (group) {
			group.classList.add("active");
		}
		const segment = event.segments[state.soundingSegment] || event.segments[0];
		setPlayhead(segment.centerX, true);
		if (scroll) {
			ui.staffScroll.scrollLeft = Math.max(0, segment.centerX - ui.staffScroll.clientWidth * 0.35);
		}
	}

	/**
	 * Plays state.notes from the cursor (from the start when the cursor is at the end), or only the selection when
	 * there is one. Each pass schedules all its notes on the audio clock at once (playPitches), and the metronome's
	 * clicks if it is on; the staff and key highlights follow on main-thread timers, which may fire a little late
	 * but never move the sound. A tied note is one note: it sounds once, for its whole length, while the playhead
	 * steps onto each of its segments in time. Loop is read once, at Play; a loop's later passes start from the
	 * beginning (of the selection, if one is playing), and notes added while playing join the next pass.
	 */
	async function startPlayback() {
		if (!state.notes.length) {
			setStatus("Add some notes before playing.", true);
			return;
		}

		await ensureAudio();
		stopPlayback();
		state.playing = true;
		document.dispatchEvent(new CustomEvent("notar:playback", { detail: { playing: true } }));
		ui.playBtn.disabled = true;
		ui.stopBtn.disabled = false;

		const token = state.playbackToken;
		const loop = state.loop;
		const range = selection();
		const first = range ? range.start : state.caret < state.notes.length ? state.caret : 0;
		const restart = range ? range.start : 0;
		const stop = range ? range.end : Infinity; // the pass ends before note `stop`

		async function runPass(from) {
			const notes = state.notes.slice();
			const until = Math.min(stop, notes.length);
			let audioTime = state.audioContext.currentTime + 0.08; // a little ahead, so no note starts in the past
			if (from < until) {
				const events = state.layout.events;
				const last = events[until - 1];
				state.pass = { start: audioTime, first: events[from].beat, last: last.beat + last.beats };
				if (state.metronome) {
					scheduleClicks(state.pass, audioTime);
				}
			}

			for (let index = from; index < until; index += 1) {
				const note = notes[index];
				const seconds = noteSeconds(note);
				playPitches(note.pitches, audioTime, seconds);
				const highlightAt = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);
				const event = state.layout.events[index];
				event.segments.forEach((segment, k) => {
					const at = highlightAt + ((segment.beat - event.beat) * 60000) / state.bpm;
					window.setTimeout(() => {
						// A later segment only moves the light along while its note is still the one sounding.
						if (token === state.playbackToken && (k === 0 || state.sounding === note)) {
							state.soundingSegment = k;
							highlight(note, true);
						}
					}, at);
				});
				audioTime += seconds;
			}

			// Wait out the pass. A loop's next pass is scheduled only then, from the current audio time, so a gap of
			// at least 120 ms (this 40 ms plus the 80 ms lead) separates the passes.
			const totalMs = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);
			await new Promise((resolve) => window.setTimeout(resolve, totalMs + 40));

			if (token !== state.playbackToken) {
				return;
			}

			if (loop) {
				await runPass(restart);
				return;
			}

			stopPlayback();
			setStatus("Playback finished.");
		}

		if (range) {
			setStatus(`Playing the selection, ${notesLabel(range)}…`);
		} else {
			setStatus(first ? `Playing from note ${first + 1}…` : "Playing…");
		}
		runPass(first);
	}

	/**
	 * The metronome's clicks for a pass (state.pass: { start, its audio time; first and last, the beats it covers }):
	 * one on every beat, on the measure's grid (a pass from the middle of a beat clicks first on the next beat), the
	 * first beat of each measure higher. Only those from audio time `from` on: turned on mid-pass, the metronome
	 * joins in at the next beat.
	 */
	function scheduleClicks(pass, from) {
		for (let beat = Math.ceil(pass.first - 1e-9); beat < pass.last - 1e-9; beat += 1) {
			const time = pass.start + ((beat - pass.first) * 60) / state.bpm;
			if (time >= from) {
				scheduleClick(time, beat % BEATS_PER_MEASURE === 0);
			}
		}
	}

	/**
	 * Turns the metronome on or off, at once even mid-pass: on, the rest of the pass's clicks are scheduled from a
	 * moment ahead (no click in the past); off, the ones still queued are stopped.
	 */
	function setMetronome(on) {
		state.metronome = on;
		ui.metronomeBtn.setAttribute("aria-pressed", on ? "true" : "false");
		saveToStorage();
		if (!state.playing || !state.pass) {
			return;
		}
		if (on) {
			scheduleClicks(state.pass, state.audioContext.currentTime + 0.05);
		} else {
			stopClicks();
		}
	}

	// ── Import / export ──────────────────────────────────────────────────────
	// Saves a blob as a download called `name`. The URL is revoked on the next tick, once the click has started it.
	function download(blob, name) {
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = name;
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
	}

	// Every export is named notar_<date>, its format's extension after it.
	function fileStem() {
		return `notar_${new Date().toISOString().slice(0, 10)}`;
	}

	// Exports that need music refuse an empty composition, and say so. Returns whether there is something to export.
	function hasMusic() {
		if (!state.notes.length) {
			setStatus("Write something first: there is nothing to export yet.", true);
			return false;
		}
		return true;
	}

	// Downloads { version: 3, bpm, notes } as notar_<date>.json, the file importComposition reads. Version 3 notes
	// carry a pitches list (chords; [] for a rest) and dotted; versions 1 and 2 had one pitch per note.
	function exportComposition() {
		const payload = {
			version: 3,
			bpm: state.bpm,
			notes: state.notes,
		};
		download(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }), `${fileStem()}.json`);
		setStatus("Composition exported.");
	}

	// ── MIDI export ──────────────────────────────────────────────────────────
	const MIDI_PPQ = 480; // ticks per quarter note: the shortest written value, a 32nd, is 60
	const MIDI_VELOCITY = 80; // mezzo forte, for every note: Notar has no dynamics

	// A MIDI variable-length quantity: seven bits a byte, most significant first, every byte but the last with its
	// top bit set (0 → 00, 127 → 7F, 128 → 81 00, 1920 → 8F 00).
	function midiVarLen(value) {
		const bytes = [value & 0x7f];
		for (let rest = value >>> 7; rest > 0; rest >>>= 7) {
			bytes.unshift((rest & 0x7f) | 0x80);
		}
		return bytes;
	}

	/**
	 * A composition as a Standard MIDI File, format 0: one track that holds everything, since one instrument's part
	 * needs no more, and every player, DAW and notation program reads it (format 1 would add a separate tempo
	 * track for nothing). The track opens with its name, the tempo, 4/4, C major and the General MIDI program,
	 * then each note is one note-on and one note-off on channel 1: a chord's together, a tied note once for its
	 * whole length, a rest only the wait before the next note. At a shared tick the note-offs go first, so a
	 * repeated pitch strikes again cleanly. MIDI has no spelling (C♯ and D♭ are one key), so a chord that holds
	 * both sounds the key once. Returns the bytes.
	 */
	function midiFile(notes, bpm, program) {
		const timed = []; // [tick, order (0 off, 1 on), bytes]
		let tick = 0;
		for (const note of notes) {
			const length = Math.round(noteBeats(note) * MIDI_PPQ);
			for (const key of new Set(note.pitches.map((id) => pitchMidi(parsePitch(id))))) {
				timed.push([tick, 1, [0x90, key, MIDI_VELOCITY]]);
				timed.push([tick + length, 0, [0x80, key, 0]]);
			}
			tick += length;
		}
		timed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
		// Microseconds per quarter note, in three bytes: the tempo is normalised again here, so no caller can wrap it.
		const tempo = Math.round(60000000 / (normalizeBpm(bpm) || 96));
		const name = Array.from("Notar", (c) => c.charCodeAt(0));
		const track = [
			0, 0xff, 0x03, name.length, ...name, // track name
			0, 0xff, 0x51, 3, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff, // tempo
			0, 0xff, 0x58, 4, 4, 2, 24, 8, // 4/4: four beats of 2^-2, a click every 24 clocks, eight 32nds a quarter
			0, 0xff, 0x59, 2, 0, 0, // C major
			0, 0xc0, program, // the instrument, channel 1
		];
		let last = 0;
		for (const [at, , bytes] of timed) {
			track.push(...midiVarLen(at - last), ...bytes);
			last = at;
		}
		// End of track, after a final rest too, so the file lasts as long as the music.
		track.push(...midiVarLen(tick - last), 0xff, 0x2f, 0);
		const size = [24, 16, 8, 0].map((shift) => (track.length >>> shift) & 0xff);
		const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, MIDI_PPQ >> 8, MIDI_PPQ & 0xff]; // MThd, 0, 1
		return Uint8Array.from([...header, 0x4d, 0x54, 0x72, 0x6b, ...size, ...track]); // MTrk
	}

	function exportMidi() {
		if (!hasMusic()) {
			return;
		}
		const instrument = INSTRUMENTS[state.instrument] || INSTRUMENTS[DEFAULT_INSTRUMENT];
		const bytes = midiFile(state.notes, state.bpm, instrument.midi);
		download(new Blob([bytes], { type: "audio/midi" }), `${fileStem()}.mid`);
		const what = `${countLabel(state.notes.length)} at ${state.bpm} BPM`;
		setStatus(`Exported a MIDI file: ${what}, for ${instrument.label.toLowerCase()}.`);
	}

	// ── Share links ──────────────────────────────────────────────────────────
	// A share link carries the notes and tempo in its hash: "#n=", a letter for how the bytes are packed (D: zlib
	// deflate, from CompressionStream; R: raw, where that is missing or deflate would be longer), then the bytes in
	// base64url. The bytes (packComposition) are a format version, the tempo, the note count, and per note a byte
	// for its length and chord size and a byte per pitch.
	const SHARE_PREFIX = "#n=";
	const SHARE_VERSION = 1;
	const SHARE_DIATONIC_BASE = 13; // H♯1, the lowest spelling in the range (it sounds C2): a pitch byte's 0
	// The most bytes a link of MAX_NOTES chords of ten can hold, about 22 KB: a link that inflates past it holds too
	// many notes, and is refused without being inflated further (a small link must not unpack into gigabytes).
	const SHARE_MAX_BYTES = 8 + MAX_NOTES * (1 + MAX_CHORD);

	// A share link that can't be opened, and why: "damaged" (the default: tampered with, cut short, or not a link),
	// "too-long" (more than MAX_NOTES notes) or "unsupported" (compressed, in a browser without DecompressionStream).
	function shareError(reason, message) {
		const error = new Error(message);
		error.reason = reason;
		return error;
	}

	function pushVarint(bytes, value) {
		let rest = value;
		while (rest > 0x7f) {
			bytes.push((rest & 0x7f) | 0x80);
			rest >>>= 7;
		}
		bytes.push(rest);
	}

	/**
	 * Packs notes and a tempo into bytes: [version, bpm, note count (LEB128: seven bits a byte, least significant
	 * first)], then per note one byte, its length's index in DURATIONS in bits 0–2, dotted in bit 3, its pitch
	 * count in bits 4–7, followed by one byte per pitch: its staff step above H♯1 in bits 2–7 and its alter + 1 in
	 * bits 0–1, so a spelling (C♯ or D♭) survives the trip. Two or three bytes for most notes.
	 */
	function packComposition(notes, bpm) {
		// The slider's range, which unpacking insists on: an imported file may have set any tempo.
		const bytes = [SHARE_VERSION, clamp(Math.round(bpm), Number(ui.bpm.min), Number(ui.bpm.max))];
		pushVarint(bytes, notes.length);
		for (const note of notes) {
			const pitches = note.pitches.map(parsePitch);
			const length = DURATIONS.findIndex((entry) => entry.value === note.duration);
			bytes.push(length | (note.dotted ? 8 : 0) | (pitches.length << 4));
			for (const pitch of pitches) {
				bytes.push(((diatonic(pitch) - SHARE_DIATONIC_BASE) << 2) | (pitch.alter + 1));
			}
		}
		return Uint8Array.from(bytes);
	}

	/**
	 * Reads packComposition's bytes back into { notes, bpm }, strictly: a version it doesn't know, a length, chord
	 * size or pitch that can't be, a pitch twice in a chord, or bytes missing or left over all throw, so a damaged or
	 * tampered link loads nothing rather than something wrong; more than MAX_NOTES notes throws "too-long". Only the
	 * tempo is mended rather than refused: brought into the slider's range (normalizeBpm), as from a file.
	 */
	function unpackComposition(bytes) {
		let at = 0;
		const next = () => {
			if (at >= bytes.length) {
				throw new Error("The link ends too soon.");
			}
			return bytes[at++];
		};
		if (next() !== SHARE_VERSION) {
			throw new Error("A link format this version of Notar doesn't know.");
		}
		const bpm = normalizeBpm(next());
		let count = 0;
		for (let shift = 0, byte = 0x80; byte & 0x80; shift += 7) {
			if (shift > 21) {
				throw new Error("A note count too large.");
			}
			byte = next();
			count += (byte & 0x7f) * 2 ** shift;
		}
		if (count > MAX_NOTES) {
			throw shareError("too-long", `${count} notes`);
		}
		const notes = [];
		for (let n = 0; n < count; n += 1) {
			const head = next();
			const length = DURATIONS[head & 7];
			const size = head >> 4;
			if (!length || size > MAX_CHORD) {
				throw new Error("A note that can't be.");
			}
			const pitches = [];
			for (let p = 0; p < size; p += 1) {
				const byte = next();
				const step = (byte >> 2) + SHARE_DIATONIC_BASE;
				const pitch = { step: step % 7, alter: (byte & 3) - 1, octave: Math.floor(step / 7) };
				if (pitch.alter > 1 || !inRange(pitch)) {
					throw new Error("A pitch out of range.");
				}
				pitches.push(pitch);
			}
			const note = { pitches: canonicalPitches(pitches), duration: length.value };
			if (note.pitches.length !== size) {
				throw new Error("A pitch twice in one chord.");
			}
			if (head & 8) {
				note.dotted = true;
			}
			notes.push(note);
		}
		if (at !== bytes.length) {
			throw new Error("Bytes left over.");
		}
		return { notes, bpm };
	}

	// base64url (RFC 4648 §5, no padding): base64 with - and _ for + and /, safe in a URL as it is.
	function bytesToBase64Url(bytes) {
		let binary = "";
		for (let i = 0; i < bytes.length; i += 0x8000) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
		}
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	function base64UrlToBytes(text) {
		if (!/^[A-Za-z0-9_-]*$/.test(text)) {
			throw new Error("Not base64url.");
		}
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/")); // throws on a length that can't be base64
		return Uint8Array.from(binary, (c) => c.charCodeAt(0));
	}

	// Whether this browser has CompressionStream with zlib's deflate (Chrome 80, Safari 16.4, Firefox 113 on).
	function canDeflate() {
		try {
			return typeof CompressionStream === "function" && Boolean(new CompressionStream("deflate"));
		} catch (error) {
			return false;
		}
	}

	async function deflate(bytes) {
		const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}

	// Inflates zlib data, refusing to go past SHARE_MAX_BYTES ("too-long"). zlib's checksum makes the browser reject a
	// tampered or cut-off stream, which rejects this promise.
	async function inflate(bytes) {
		const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")).getReader();
		const chunks = [];
		let size = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.length;
			if (size > SHARE_MAX_BYTES) {
				reader.cancel();
				throw shareError("too-long", "Inflates past SHARE_MAX_BYTES.");
			}
			chunks.push(value);
		}
		const out = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.length;
		}
		return out;
	}

	// The page's own address without its hash: what a share link is built on.
	function pageAddress() {
		return window.location.href.split("#")[0];
	}

	/**
	 * The share link for the composition now. Built synchronously, so the Share click can hand it to
	 * navigator.share or the clipboard while it still counts as the user's gesture (Safari is strict about that):
	 * the deflated form when prepareShareLink has it ready for exactly these notes and tempo, else the raw form,
	 * which is just as valid, only longer.
	 */
	function shareLink() {
		const bytes = packComposition(state.notes, state.bpm);
		const key = bytes.join();
		if (shareCache.key === key) {
			return shareCache.url;
		}
		return `${pageAddress()}${SHARE_PREFIX}R${bytesToBase64Url(bytes)}`;
	}

	// The deflated link, made ahead (when the pointer reaches the Share button, or it gets focus), for shareLink.
	let shareCache = { key: "", url: "" };
	function prepareShareLink() {
		const bytes = packComposition(state.notes, state.bpm);
		const key = bytes.join();
		if (shareCache.key === key || !canDeflate()) {
			return;
		}
		deflate(bytes).then((packed) => {
			const kind = packed.length < bytes.length ? "D" : "R";
			const payload = bytesToBase64Url(kind === "D" ? packed : bytes);
			shareCache = { key, url: `${pageAddress()}${SHARE_PREFIX}${kind}${payload}` };
		}).catch(() => {}); // shareLink falls back to the raw form
	}

	/**
	 * Shares the composition as a link: on a phone or tablet through the system's share sheet (navigator.share),
	 * otherwise by copying it to the clipboard, and says which. If the share sheet fails it copies instead, and if
	 * the clipboard refuses too, the link is offered in a prompt to copy by hand.
	 */
	function shareComposition() {
		if (!state.notes.length) {
			setStatus("Write something first: there is nothing to share yet.", true);
			return;
		}
		const url = shareLink();
		const what = `${countLabel(state.notes.length)} at ${state.bpm} BPM`;
		const copy = () => writeSystemClipboard(url).then((copied) => {
			if (copied) {
				setStatus(`Link copied: whoever opens it gets these ${what}. It holds the notes and tempo, nothing else.`);
				return;
			}
			setStatus("The browser wouldn't let Notar copy the link, so here it is to copy yourself.", true);
			window.prompt("Copy this link to share your composition:", url);
		});
		if (navigator.share && coarsePointer.matches) {
			navigator.share({ title: "Notar", text: "A composition written in Notar", url }).then(
				() => setStatus(`Shared a link to these ${what}.`),
				(error) => (error && error.name === "AbortError" ? setStatus("Sharing cancelled.") : copy()),
			);
			return;
		}
		copy();
	}

	// Reads a share link's hash (after "#n=") into { notes, bpm }; rejects for anything that can't be opened, with the
	// reason (shareError) on the error.
	async function readShareHash(payload) {
		const kind = payload.charAt(0);
		const bytes = base64UrlToBytes(payload.slice(1));
		if (kind === "R") {
			return unpackComposition(bytes);
		}
		if (kind !== "D") {
			throw new Error("Not a share link.");
		}
		if (typeof DecompressionStream !== "function") {
			throw shareError("unsupported", "No DecompressionStream.");
		}
		if (bytes.length > SHARE_MAX_BYTES) {
			throw shareError("too-long", "Longer than SHARE_MAX_BYTES before inflating.");
		}
		return unpackComposition(await inflate(bytes));
	}

	// What the status says about a share link that couldn't be opened, by its reason (shareError).
	const SHARE_FAILURES = {
		damaged: "That share link is damaged or incomplete, so it opened nothing. Your composition is unchanged.",
		"too-long": `That share link holds more than the ${MAX_NOTES} notes a piece in Notar can have, so it opened nothing. Your composition is unchanged.`,
		unsupported: "This browser can't open compressed share links (it lacks DecompressionStream). Open the link in an up-to-date browser; your composition is unchanged.",
	};

	// Takes the hash off the address, so a reload doesn't open the link again (and the address bar is just the app).
	function clearHash() {
		try {
			window.history.replaceState(window.history.state, "", pageAddress());
		} catch (error) {
			window.location.hash = ""; // leaves a bare "#", which opens nothing
		}
	}

	/**
	 * Opens a share link in the address (at launch, and when the hash changes in an open tab): its notes and tempo
	 * replace the composition as one undoable edit, and the status says that Undo brings back what was there. The
	 * piece it replaces is also kept in localStorage (writeBackup), so no reload can lose it: not one the user makes,
	 * and not one pwa.js would make to apply an update, which it doesn't do once a link has opened (linkOpened, read
	 * through window.Notar.editedSinceLaunch). After a reload, the Bring back bar restores it. The hash is cleared
	 * first, whatever the link holds, so a reload neither opens it again nor repeats an error. A link that can't be
	 * opened changes nothing and says why. Another hash is left alone.
	 */
	async function openShareLink() {
		const hash = window.location.hash;
		if (!hash.startsWith(SHARE_PREFIX)) {
			return;
		}
		linkOpened = true;
		clearHash();
		let shared;
		try {
			shared = await readShareHash(hash.slice(SHARE_PREFIX.length));
		} catch (error) {
			setStatus(SHARE_FAILURES[error && error.reason] || SHARE_FAILURES.damaged, true);
			return;
		}
		stopPlayback();
		const had = state.notes.length;
		const backup = readBackup();
		const sharedKey = pieceKey(shared.notes, shared.bpm);
		const made = edit(() => {
			if (JSON.stringify(state.notes) === JSON.stringify(shared.notes) && state.bpm === shared.bpm) {
				return null;
			}
			// The draft may be the last link's piece, untouched: then the piece before that is the one to keep, and stays
			// kept (only its replacedBy moves on). Otherwise the draft itself is kept.
			const untouched = backup && backup.replacedBy === pieceKey(state.notes, state.bpm);
			let kept = false;
			if (untouched) {
				writeBackup({ ...backup, replacedBy: sharedKey });
			} else if (had) {
				kept = writeBackup({ notes: state.notes.map(cloneNote), bpm: state.bpm, replacedBy: sharedKey });
			}
			state.notes = shared.notes;
			state.caret = shared.notes.length;
			setBpm(shared.bpm);
			const undo = had ? ` Undo brings back the ${countLabel(had)} you had${kept ? ", even after a reload" : ""}.` : "";
			const what = `${countLabel(shared.notes.length)} at ${shared.bpm} BPM`;
			return { message: `Opened a shared link: ${what}.${undo}`, tempo: true, backup: kept };
		});
		if (!made) {
			setStatus("Opened a shared link: it holds the composition you already have.");
		}
	}

	// Whether a share link has opened since launch (or is opening): pwa.js then leaves an update for later.
	let linkOpened = false;

	// A piece's identity for the backup: its packed bytes, joined (packComposition).
	function pieceKey(notes, bpm) {
		return packComposition(notes, bpm).join();
	}

	/**
	 * The piece a share link replaced, in localStorage under BACKUP_KEY, so no reload can lose it: { notes, bpm,
	 * replacedBy (the pieceKey of the shared piece that replaced it) }. Undo of that opening brings the piece back
	 * and forgets the copy (undo); redo keeps it again (redo). After a reload, the Bring back bar offers it
	 * (updateRestoreBar). readBackup gives null when there is none, or none readable; writeBackup says whether it
	 * could write.
	 */
	function readBackup() {
		try {
			const backup = JSON.parse(window.localStorage.getItem(BACKUP_KEY));
			if (backup && Array.isArray(backup.notes)) {
				const notes = normalizeNotes(backup.notes.slice(0, MAX_NOTES));
				return notes.length ? { notes, bpm: normalizeBpm(backup.bpm) || state.bpm, replacedBy: String(backup.replacedBy || "") } : null;
			}
		} catch (error) {
			// Unreadable or blocked: as if there were none.
		}
		return null;
	}

	function writeBackup(backup) {
		try {
			window.localStorage.setItem(BACKUP_KEY, JSON.stringify(backup));
			return true;
		} catch (error) {
			return false;
		}
	}

	function clearBackup() {
		try {
			window.localStorage.removeItem(BACKUP_KEY);
		} catch (error) {
			// Blocked: nothing was kept there either.
		}
	}

	/**
	 * Shows the Bring back bar (above the status line) when a piece a share link replaced is kept and Undo can't
	 * reach it any more (a reload has emptied the history, or it has run past HISTORY_LIMIT steps) and it isn't the
	 * composition already. The bar says what it is and offers Bring it back (restoreBackup) or Forget (for good).
	 */
	function updateRestoreBar() {
		const backup = readBackup();
		const reachable = state.past.some((step) => step.backup);
		const same = backup && JSON.stringify(backup.notes) === JSON.stringify(state.notes);
		const show = Boolean(backup) && !reachable && !same;
		ui.restoreBar.hidden = !show;
		if (show) {
			ui.restoreText.textContent = `A shared link replaced your previous piece (${countLabel(backup.notes.length)} at ${backup.bpm} BPM). It is kept:`;
		}
	}

	// Brings back the piece a share link replaced, as one undoable edit (Undo returns to the shared one), and forgets
	// the copy: it is the composition again, saved like any other.
	function restoreBackup() {
		const backup = readBackup();
		if (!backup) {
			updateRestoreBar();
			return;
		}
		stopPlayback();
		edit(() => {
			state.notes = backup.notes;
			state.caret = backup.notes.length;
			setBpm(backup.bpm);
			return { message: `Brought back your previous piece: ${countLabel(backup.notes.length)} at ${backup.bpm} BPM. Undo returns to the shared one.`, tempo: true };
		});
		clearBackup();
		updateRestoreBar();
	}

	// ── Image export and printing ────────────────────────────────────────────
	// What an exported SVG's drawn elements take from styles.css (standaloneSvg), each with its initial value: a
	// declaration that only restates it is left out, since nothing in the file styles a parent, so an element left
	// without one inherits the initial value anyway. The font properties only matter on text (font-family always).
	const EXPORT_STYLES = {
		fill: "rgb(0, 0, 0)",
		"fill-opacity": "1",
		stroke: "none",
		"stroke-width": "1px",
		"stroke-opacity": "1",
		"stroke-linecap": "butt",
		"stroke-linejoin": "miter",
		"stroke-dasharray": "none",
		opacity: "1",
	};
	const EXPORT_TEXT_STYLES = {
		"font-family": "",
		"font-size": "16px",
		"font-weight": "400",
		"font-style": "normal",
		"font-variant-numeric": "normal",
		"text-anchor": "start",
		"paint-order": "normal",
	};
	const XLINK = "http://www.w3.org/1999/xlink";

	// The G clef as a data: URL, so an exported image carries it inside (fetched once, from the service worker's
	// cache offline). If it can't be fetched (a file:// page), its absolute URL, which an SVG file can still reach.
	let clefData = "";
	async function clefHref() {
		if (!clefData) {
			try {
				const response = await fetch(CLEF_HREF);
				if (!response.ok) {
					throw new Error(response.statusText);
				}
				const bytes = new Uint8Array(await response.arrayBuffer());
				clefData = `data:image/svg+xml;base64,${btoa(String.fromCharCode.apply(null, bytes))}`;
			} catch (error) {
				return new URL(CLEF_HREF, window.location.href).href;
			}
		}
		return clefData;
	}

	/**
	 * Makes a sheet (buildSheet) stand alone as SVG text. It goes into the document out of sight, so styles.css
	 * applies, and each drawn element's computed paint and font are written into one <style> block: a short class
	 * per distinct set ("s1", "s2", …) beside the element's own classes. Reading computed values rather than
	 * copying rules resolves the custom properties and the rules that depend on a parent, and works where a page
	 * can't read its own stylesheet (file://). The G clef is embedded (clefHref).
	 */
	async function standaloneSvg(svg) {
		const holder = document.createElement("div");
		holder.setAttribute("aria-hidden", "true");
		holder.style.cssText = "position: fixed; left: 0; top: 0; width: 0; height: 0; overflow: hidden;"
			+ " visibility: hidden";
		holder.appendChild(svg);
		document.body.appendChild(holder);
		try {
			const classes = new Map(); // declarations → class
			for (const el of svg.querySelectorAll("path, line, rect, ellipse, circle, polygon, text")) {
				const computed = window.getComputedStyle(el);
				const wanted = el.tagName === "text" ? { ...EXPORT_STYLES, ...EXPORT_TEXT_STYLES } : EXPORT_STYLES;
				const declarations = Object.entries(wanted)
					.map(([name, initial]) => [name, computed.getPropertyValue(name), initial])
					.filter(([, value, initial]) => value !== initial)
					.map(([name, value]) => `${name}:${value}`)
					.join(";");
				if (!classes.has(declarations)) {
					classes.set(declarations, `s${classes.size + 1}`);
				}
				el.classList.add(classes.get(declarations));
			}
			const style = createSvgEl("style", {});
			style.textContent = [...classes].map(([declarations, name]) => `.${name}{${declarations}}`).join("\n");
			svg.insertBefore(style, svg.firstChild);
			// The clef image once, in <defs>, and a <use> of it on every system. Both kinds of href, for older editors
			// that only read xlink:href.
			const href = await clefHref();
			const defs = createSvgEl("defs", {});
			const clef = createSvgEl("image", { id: "g-clef", width: 34, height: 58, href });
			clef.setAttributeNS(XLINK, "xlink:href", href);
			defs.appendChild(clef);
			style.after(defs);
			svg.querySelectorAll("image:not(#g-clef)").forEach((image) => {
				const use = createSvgEl("use", { href: "#g-clef", x: image.getAttribute("x"), y: image.getAttribute("y") });
				use.setAttributeNS(XLINK, "xlink:href", "#g-clef");
				image.replaceWith(use);
			});
			return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}`;
		} finally {
			holder.remove();
		}
	}

	// Exports the whole composition, broken into systems as on paper, as an SVG file that needs nothing else.
	async function exportSvg() {
		if (!hasMusic()) {
			return;
		}
		const sheet = buildSheet();
		const text = await standaloneSvg(sheet.svg);
		download(new Blob([text], { type: "image/svg+xml" }), `${fileStem()}.svg`);
		const lines = sheet.systems.length;
		setStatus(`Exported the sheet as an SVG image: ${lines} ${lines === 1 ? "line" : "lines"} of music.`);
	}

	function loadImage(src) {
		return new Promise((resolve, reject) => {
			const image = new Image();
			image.onload = () => resolve(image);
			image.onerror = () => reject(new Error("The image didn't load."));
			image.src = src;
		});
	}

	/**
	 * Exports the same sheet as a PNG at twice its size, for screens that need the sharpness; a very long piece is
	 * drawn smaller, to stay inside MAX_CANVAS_PIXELS. The SVG is drawn on a canvas from a data: URL (not a blob:
	 * one, so download's object URL is the only one made).
	 */
	async function exportPng() {
		if (!hasMusic()) {
			return;
		}
		const sheet = buildSheet();
		const text = await standaloneSvg(sheet.svg);
		try {
			const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`);
			const scale = Math.min(2, Math.sqrt(MAX_CANVAS_PIXELS / (sheet.width * sheet.height)));
			const canvas = document.createElement("canvas");
			canvas.width = Math.floor(sheet.width * scale);
			canvas.height = Math.floor(sheet.height * scale);
			canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
			const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
			if (!blob) {
				throw new Error("No PNG.");
			}
			download(blob, `${fileStem()}.png`);
			setStatus(`Exported the sheet as a PNG image, ${canvas.width} × ${canvas.height} pixels.`);
		} catch (error) {
			setStatus("This browser couldn't draw the PNG. Try the SVG export instead.", true);
		}
	}

	// Print, or Save as PDF from the print dialog: the sheet is laid out first, in case beforeprint doesn't come.
	function printSheet() {
		buildPrintSheet();
		setStatus("Printing the sheet. To make a PDF, choose Save as PDF as the printer.");
		window.print();
	}

	/**
	 * Replaces the composition (and the tempo, if the file has one) with the file's notes, as one undoable edit.
	 * Notes that can't be read are skipped and counted; a file with notes but none readable, or more than MAX_NOTES,
	 * is refused and changes nothing. A tempo outside 40–220 is brought inside it (normalizeBpm), and one that isn't
	 * a number is left out; the status says which.
	 */
	function importComposition(file) {
		const reader = new FileReader();
		reader.onload = () => {
			let payload = null;
			try {
				payload = JSON.parse(reader.result);
			} catch (error) {
				// not JSON: refused below
			}
			if (!payload || !Array.isArray(payload.notes)) {
				setStatus("Could not import that file: it isn't a Notar file.", true);
				return;
			}
			if (payload.notes.length > MAX_NOTES) {
				setStatus(tooManyNotes("That file", payload.notes.length), true);
				return;
			}
			const notes = normalizeNotes(payload.notes);
			if (payload.notes.length && !notes.length) {
				setStatus("Could not import that file: none of its notes can be read.", true);
				return;
			}
			stopPlayback();
			const skipped = payload.notes.length - notes.length;
			const hasTempo = payload.bpm !== undefined && payload.bpm !== null;
			const bpm = hasTempo ? normalizeBpm(payload.bpm) : null;
			let tempo = "";
			if (hasTempo && bpm === null) {
				tempo = "; its tempo isn't a number, so the tempo stays as it was";
			} else if (hasTempo && bpm !== Number(payload.bpm)) {
				tempo = `; its tempo of ${payload.bpm} became ${bpm} BPM, the nearest Notar plays`;
			}
			edit(() => {
				state.notes = notes;
				state.caret = notes.length;
				if (bpm !== null) {
					setBpm(bpm);
				}
				return {
					message: `Imported ${countLabel(notes.length)}${skipped ? ` (skipped ${skipped} outside C2–C6)` : ""}${tempo}.`,
					tempo: bpm !== null,
				};
			});
		};
		reader.readAsText(file);
	}

	// ── Controls and shortcuts ───────────────────────────────────────────────
	// The segmented note-length control mirrors the (hidden) #duration slider,
	// which remains the single source of truth the rest of the app reads.
	function syncDurationPicker() {
		if (!ui.durationPicker) {
			return;
		}
		const radio = ui.durationPicker.querySelector(`input[value="${ui.duration.value}"]`);
		if (radio) {
			radio.checked = true;
		}
	}

	// Picks the length for new notes by its index in DURATIONS (radios, number keys).
	function setLength(index) {
		ui.duration.value = String(index);
		ui.duration.dispatchEvent(new Event("input", { bubbles: true }));
	}

	function setDotted(on) {
		state.dotted = on;
		ui.dotBtn.setAttribute("aria-pressed", on ? "true" : "false");
		drawStaff(); // the cursor's handle shows the dot
		saveToStorage();
	}

	function setChordMode(on) {
		state.chordMode = on;
		ui.chordBtn.setAttribute("aria-pressed", on ? "true" : "false");
		saveToStorage();
	}

	// Sets the tempo and the slider showing it. Anything not a tempo (normalizeBpm) leaves it as it is.
	function setBpm(bpm) {
		const value = normalizeBpm(bpm);
		if (value === null) {
			return;
		}
		state.bpm = value;
		ui.bpm.value = String(value);
		ui.bpmLabel.textContent = `${value} BPM`;
	}

	/**
	 * A tempo as Notar keeps it: a whole number of beats per minute within the Tempo slider's range (40–220),
	 * rounded and clamped; null for something that isn't a number at all. Every tempo from outside (a file, a saved
	 * draft, a share link) comes through here, so MIDI export and share links never meet one they can't write.
	 */
	function normalizeBpm(raw) {
		const number = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
		if (typeof number !== "number" || !Number.isFinite(number)) {
			return null;
		}
		return clamp(Math.round(number), Number(ui.bpm.min), Number(ui.bpm.max));
	}

	function bindControls() {
		if (ui.durationPicker) {
			ui.durationPicker.addEventListener("change", (event) => {
				if (event.target.name === "durationPick") {
					setLength(Number(event.target.value));
				}
			});
		}

		ui.volume.addEventListener("input", () => {
			state.volume = Number(ui.volume.value);
			ui.volumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
			if (state.masterGain && state.audioContext) {
				state.masterGain.gain.setValueAtTime(state.volume, state.audioContext.currentTime);
			}
			saveToStorage();
		});

		ui.duration.addEventListener("input", () => {
			const index = clamp(Number(ui.duration.value), 0, DURATIONS.length - 1);
			state.selectedDuration = DURATIONS[index].value;
			ui.durationLabel.textContent = DURATIONS[index].label;
			syncDurationPicker();
			drawStaff(); // the cursor's handle shows the length
			saveToStorage();
		});

		ui.bpm.addEventListener("input", () => {
			setBpm(Number(ui.bpm.value));
			updateMeta();
			saveToStorage();
		});

		ui.restBtn.addEventListener("click", () => insertNote([]));
		// Apply: the picker's length and dot, given to the current note or the selection (Shift+1–5 and Shift+. on
		// the keyboard).
		ui.applyLengthBtn.addEventListener("click", () => {
			if (selection()) {
				setSelectionLength(state.selectedDuration, state.dotted);
			} else {
				setCurrentLength(state.selectedDuration, state.dotted);
			}
		});
		ui.dotBtn.addEventListener("click", () => {
			setDotted(!state.dotted);
			setStatus(state.dotted ? "Dotted: new notes are half as long again." : "Dotted off.");
		});
		ui.chordBtn.addEventListener("click", () => {
			setChordMode(!state.chordMode);
			setStatus(state.chordMode
				? "Chord on: keys stack onto the highlighted note. Turn it off to write the next one."
				: "Chord off: each key is a new note.");
		});
		ui.octaveDownBtn.addEventListener("click", () => setOctave(state.octave - 1, { scroll: true, announce: true }));
		ui.octaveUpBtn.addEventListener("click", () => setOctave(state.octave + 1, { scroll: true, announce: true }));
		ui.piano.addEventListener("scroll", updateKeyboardFades, { passive: true });
		// The staff fills the visible width, so a resize redraws it, at most once a frame.
		let resizeFrame = 0;
		window.addEventListener("resize", () => {
			updateKeyboardFades();
			window.cancelAnimationFrame(resizeFrame);
			resizeFrame = window.requestAnimationFrame(drawStaff);
		});

		ui.playBtn.addEventListener("click", startPlayback);
		ui.stopBtn.addEventListener("click", stopPlayback);
		ui.undoBtn.addEventListener("click", undo);
		ui.redoBtn.addEventListener("click", redo);
		ui.deleteBtn.addEventListener("click", () => {
			if (selection()) {
				deleteSelection();
			} else {
				deleteNote(state.caret - 1);
			}
		});
		ui.clearBtn.addEventListener("click", clearNotes);
		ui.cutBtn.addEventListener("click", () => copySelection(true));
		ui.copyBtn.addEventListener("click", () => copySelection(false));
		// The Paste button reads Notar's own clipboard only: reading the system one from a button asks the user for
		// permission in most browsers. ⌘V / Ctrl+V reads the system clipboard without asking (bindClipboard).
		ui.pasteBtn.addEventListener("click", () => pasteNotes(storedClipboard()));
		ui.loopBtn.addEventListener("click", () => {
			state.loop = !state.loop;
			ui.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
			saveToStorage();
			setStatus(state.loop ? "Loop enabled." : "Loop disabled.");
		});
		ui.metronomeBtn.addEventListener("click", () => {
			setMetronome(!state.metronome);
			setStatus(state.metronome
				? `Metronome on: a click on every beat${state.playing ? ", from the next one" : " while playing"}.`
				: "Metronome off.");
		});
		ui.instrumentPicker.addEventListener("change", (event) => {
			if (event.target.name === "instrument") {
				setInstrument(event.target.value);
				const current = state.notes[state.caret - 1];
				audition(current && current.pitches.length ? current : { pitches: ["C4", "E4", "G4"], duration: 4 });
				setStatus(`Sound: ${INSTRUMENTS[state.instrument].label.toLowerCase()}.`);
			}
		});
		ui.exportBtn.addEventListener("click", exportComposition);
		ui.midiBtn.addEventListener("click", exportMidi);
		ui.svgBtn.addEventListener("click", exportSvg);
		ui.pngBtn.addEventListener("click", exportPng);
		ui.printBtn.addEventListener("click", printSheet);
		ui.shareBtn.addEventListener("click", shareComposition);
		// The deflated link takes a moment (a promise): it is made while the pointer is on its way or focus arrives.
		["pointerenter", "pointerdown", "focus"].forEach((type) => ui.shareBtn.addEventListener(type, prepareShareLink));
		ui.importBtn.addEventListener("click", () => ui.importInput.click());
		ui.importInput.addEventListener("change", () => {
			const file = ui.importInput.files && ui.importInput.files[0];
			if (file) {
				importComposition(file);
			}
			ui.importInput.value = ""; // so choosing the same file again still fires change
		});
		bindMenu(ui.exportMenuBtn, ui.exportMenu);
		ui.restoreBtn.addEventListener("click", restoreBackup);
		ui.forgetBtn.addEventListener("click", () => {
			clearBackup();
			updateRestoreBar();
			setStatus("Forgot the previous piece.");
		});

		window.addEventListener("beforeprint", buildPrintSheet);
		window.addEventListener("afterprint", () => {
			ui.printSheet.innerHTML = ""; // so nothing else on the page ever sees a second copy of the notes
		});
		window.addEventListener("hashchange", openShareLink);
		// Another tab's copy fills this tab's Paste button.
		window.addEventListener("storage", (event) => {
			if (event.key === CLIPBOARD_KEY) {
				updateEditButtons();
			}
		});

		bindStaff();
		bindClipboard();
		window.addEventListener("keydown", onKeydown);
	}

	function setInstrument(name) {
		state.instrument = Object.prototype.hasOwnProperty.call(INSTRUMENTS, name) ? name : DEFAULT_INSTRUMENT;
		const radio = ui.instrumentPicker.querySelector(`input[value="${state.instrument}"]`);
		if (radio) {
			radio.checked = true;
		}
		saveToStorage();
	}

	/**
	 * A menu button and its menu (the Export formats): the button toggles it (aria-expanded), and opening it moves
	 * focus to the first item. ↑ ↓ (and Home, End) move between the items; Esc, or choosing an item, closes it and
	 * gives focus back to the button (a hidden item can't keep it, and focus dropped to the page would make the next
	 * Enter play); Tab, or a click anywhere else, closes it. Every key pressed in the menu stops there, so none
	 * reaches the composition's shortcuts (a letter would write a note).
	 */
	function bindMenu(button, menu) {
		const items = () => [...menu.querySelectorAll("button")];
		const open = (focusFirst) => {
			menu.hidden = false;
			button.setAttribute("aria-expanded", "true");
			if (focusFirst) {
				items()[0].focus();
			}
		};
		const close = (refocus) => {
			if (menu.hidden) {
				return;
			}
			menu.hidden = true;
			button.setAttribute("aria-expanded", "false");
			if (refocus) {
				button.focus();
			}
		};
		button.addEventListener("click", () => (menu.hidden ? open(true) : close(false)));
		button.addEventListener("keydown", (event) => {
			if (event.key === "ArrowDown" || event.key === "ArrowUp") {
				event.preventDefault();
				event.stopPropagation();
				open(true);
			}
		});
		menu.addEventListener("click", (event) => {
			if (event.target.closest("button")) {
				close(true);
			}
		});
		menu.addEventListener("keydown", (event) => {
			event.stopPropagation();
			const list = items();
			const at = list.indexOf(document.activeElement);
			const moves = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 };
			if (event.key in moves) {
				event.preventDefault();
				list[(moves[event.key] + list.length) % list.length].focus();
			} else if (event.key === "Escape") {
				event.preventDefault();
				close(true);
			} else if (event.key === "Tab") {
				close(false); // and focus moves on, as Tab does
			}
			// Enter and Space press the item, whose click closes the menu; other keys do nothing here.
		});
		document.addEventListener("pointerdown", (event) => {
			if (!menu.contains(event.target) && !button.contains(event.target)) {
				close(false);
			}
		});
	}

	// ⌘V's stand-in for a paste event that never comes (bindClipboard): its timer, and when it last pasted.
	let pasteTimer = 0;
	let pastedByTimerAt = -Infinity;
	function expectPaste() {
		window.clearTimeout(pasteTimer);
		pasteTimer = window.setTimeout(() => {
			pasteTimer = 0;
			pastedByTimerAt = performance.now();
			pasteNotes(storedClipboard());
		}, 150);
	}

	// A field you type in keeps the clipboard, and so does text selected on the page; a length chip, a Sound radio
	// or a button doesn't.
	const TEXT_ENTRY = "textarea, select, [contenteditable], "
		+ "input:not([type=radio]):not([type=checkbox]):not([type=range]):not([type=button])";
	function clipboardIsOurs(event) {
		const target = event.target;
		const editable = target && target.matches && target.matches(TEXT_ENTRY);
		const text = window.getSelection && String(window.getSelection());
		return !editable && !text;
	}

	/**
	 * The system clipboard, for ⌘C ⌘X ⌘V (Ctrl on other systems) and the browser's own Edit menu. A copy or cut
	 * of a selection is handled on keydown (onKeydown), where writeText is allowed; the copy and cut events here
	 * catch the Edit menu, writing the notes as text into the event. Paste is the paste event's, which hands over
	 * the clipboard's text without a permission prompt: notes copied in another tab, or an exported file's JSON;
	 * text that holds no notes pastes Notar's own clipboard instead. Safari sends no paste event to a page with
	 * nothing editable focused, so ⌘V also starts a short timer (expectPaste) that pastes Notar's own clipboard if
	 * no paste event has come; a paste event just after that timer is ignored, so nothing pastes twice. A text
	 * field, or text selected on the page, keeps the clipboard to itself.
	 */
	function bindClipboard() {
		for (const type of ["copy", "cut"]) {
			document.addEventListener(type, (event) => {
				if (!clipboardIsOurs(event) || !selection() || !event.clipboardData) {
					return;
				}
				event.preventDefault();
				event.clipboardData.setData("text/plain", clipboardText(selectedNotes()));
				copySelection(type === "cut", true); // Notar's own clipboard, the status, and for cut the edit
			});
		}
		document.addEventListener("paste", (event) => {
			if (!clipboardIsOurs(event)) {
				return;
			}
			event.preventDefault();
			if (pasteTimer) {
				window.clearTimeout(pasteTimer);
				pasteTimer = 0;
			} else if (performance.now() - pastedByTimerAt < 1000) {
				return; // the timer has pasted this ⌘V already
			}
			const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
			pasteNotes(clipboardNotes(text) || storedClipboard());
		});
	}

	/**
	 * Shortcuts (listed in index.html's footer). None while a field or slider has focus (a length radio doesn't
	 * count, though it keeps its arrow keys), and none with Alt; with Ctrl or Cmd only undo and redo, select all,
	 * and copy, cut and paste (bindClipboard), so the browser's own shortcuts keep working. A digit or the full stop
	 * sets the length for new notes; with Shift it changes the current note's (or the selection's) instead. With
	 * Shift the arrows, Home and End select; with a selection, ↑ ↓, Delete and Backspace act on it, and Esc lets it
	 * go once playback has stopped (stopping comes first: it is what you hear).
	 */
	function onKeydown(event) {
		if (event.target.matches("input:not([type=radio]), textarea, select")) {
			return;
		}
		const key = event.key;
		const lower = key.toLowerCase();
		const range = selection();
		if ((event.ctrlKey || event.metaKey) && !event.altKey && (lower === "z" || lower === "y")) {
			event.preventDefault();
			if (lower === "y" || event.shiftKey) {
				redo();
			} else {
				undo();
			}
			return;
		}
		if ((event.ctrlKey || event.metaKey) && !event.altKey) {
			if (lower === "a") {
				event.preventDefault();
				selectAll();
			} else if ((lower === "c" || lower === "x") && range && clipboardIsOurs(event)) {
				event.preventDefault(); // handled here, where writeText is allowed: no copy event follows
				copySelection(lower === "x");
			} else if (lower === "v" && clipboardIsOurs(event)) {
				expectPaste(); // the paste event, if the browser sends one, brings the system clipboard's text
			}
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return;
		}
		const onRadio = event.target.matches("input[type=radio]");
		const mapped = KEY_MAP[lower];
		if (mapped) {
			event.preventDefault();
			if (event.repeat) {
				return; // a held key enters one note
			}
			const id = pitchId({ step: mapped.step, alter: mapped.alter, octave: state.octave + mapped.shift });
			if (event.shiftKey || state.chordMode) {
				enterChordTone(id);
			} else {
				insertNote([id]);
			}
			return;
		}
		if (/^[1-5]$/.test(key)) {
			event.preventDefault();
			setLength(Number(key) - 1);
			setStatus(`New notes: ${lengthLabel(state.selectedDuration, state.dotted)}.`);
			return;
		}
		if (key === ".") {
			event.preventDefault();
			setDotted(!state.dotted);
			setStatus(`New notes: ${lengthLabel(state.selectedDuration, state.dotted)}.`);
			return;
		}
		// Shift+1–5 and Shift+. are matched on event.code, since Shift turns those keys into symbols that differ
		// between layouts ("!", "@", ">", ":"). Where a layout needs Shift to type a digit (AZERTY), the digit itself
		// was read just above and keeps setting the length for new notes, as it always did; where the key types a
		// letter (Period is V on Dvorak, Ç on Turkish Q; Lithuanian's digit row is Ą Č Ę …), it is that letter, not a
		// shortcut. A held key changes the note once, as a held note key enters one note.
		const shiftedCode = event.shiftKey && !/^\p{L}$/u.test(key);
		if (shiftedCode && (/^Digit[1-5]$/.test(event.code) || event.code === "Period")) {
			event.preventDefault();
			if (event.repeat) {
				return;
			}
			const current = state.notes[state.caret - 1];
			const duration = event.code === "Period" ? undefined : DURATIONS[Number(event.code.slice(-1)) - 1].value;
			if (range) {
				// Shift+. dots every selected note, or, when all of them are dotted already, takes the dots off.
				const dotted = event.code === "Period" ? !selectedNotes().every((note) => note.dotted) : undefined;
				setSelectionLength(duration, dotted);
			} else if (event.code === "Period") {
				setCurrentLength(undefined, current ? !current.dotted : undefined);
			} else {
				setCurrentLength(duration);
			}
			return;
		}
		if (key === " ") {
			// Space enters a rest, except on a focused control (not a piano key),
			// where it keeps its native "activate" meaning.
			const control = event.target.closest && event.target.closest("button, a, label");
			if (control && !control.classList.contains("key")) {
				return;
			}
			event.preventDefault();
			insertNote([]);
			return;
		}
		if (lower === "z" || lower === "x") {
			event.preventDefault();
			setOctave(state.octave + (lower === "z" ? -1 : 1), { scroll: true, announce: true });
			return;
		}
		if ((key === "ArrowLeft" || key === "ArrowRight") && !onRadio) {
			event.preventDefault();
			const step = key === "ArrowLeft" ? -1 : 1;
			if (event.shiftKey) {
				moveCursor(state.caret + step, true, true);
			} else if (range) {
				moveCursor(step < 0 ? range.start : range.end); // as in a text field: to that end of the selection
			} else {
				moveCursor(state.caret + step);
			}
			return;
		}
		if (key === "Home" || key === "End") {
			event.preventDefault();
			moveCursor(key === "Home" ? 0 : state.notes.length, true, event.shiftKey);
			return;
		}
		if ((key === "ArrowUp" || key === "ArrowDown") && !onRadio && range) {
			event.preventDefault();
			transposeSelection((key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1));
			return;
		}
		if ((key === "ArrowUp" || key === "ArrowDown") && !onRadio) {
			const current = state.notes[state.caret - 1];
			if (!current || !current.pitches.length) {
				return; // nothing to transpose: let the page scroll
			}
			event.preventDefault();
			transposeCurrent((key === "ArrowUp" ? 1 : -1) * (event.shiftKey ? 12 : 1));
			return;
		}
		if ((key === "Backspace" || key === "Delete") && range) {
			event.preventDefault();
			deleteSelection();
			return;
		}
		if (key === "Backspace") {
			event.preventDefault();
			deleteNote(state.caret - 1);
			return;
		}
		if (key === "Delete") {
			event.preventDefault();
			deleteNote(state.caret);
			return;
		}
		if (key === "Enter") {
			// On a focused button or link Enter activates it as usual; anywhere else it plays.
			if (event.target.closest && event.target.closest("button, a")) {
				return;
			}
			event.preventDefault();
			startPlayback();
			return;
		}
		if (key === "Escape") {
			event.preventDefault();
			if (state.playing || !clearSelection()) {
				stopPlayback();
			}
		}
	}

	// ── Start-up ─────────────────────────────────────────────────────────────
	// The keys are built before setOctave marks one, and the draft is loaded before the controls are set from state.
	function init() {
		buildPiano();
		bindControls();
		loadFromStorage();

		const durationIndex = DURATIONS.findIndex((entry) => entry.value === state.selectedDuration);
		ui.duration.value = String(durationIndex >= 0 ? durationIndex : QUARTER_INDEX);
		ui.durationLabel.textContent = durationLabel(state.selectedDuration);
		syncDurationPicker();
		ui.dotBtn.setAttribute("aria-pressed", state.dotted ? "true" : "false");
		ui.chordBtn.setAttribute("aria-pressed", state.chordMode ? "true" : "false");
		ui.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
		ui.metronomeBtn.setAttribute("aria-pressed", state.metronome ? "true" : "false");
		setInstrument(state.instrument);
		ui.volume.value = String(state.volume);
		ui.volumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
		setBpm(state.bpm);
		ui.stopBtn.disabled = true;
		setOctave(state.octave, { scroll: false, announce: false });
		scrollToOctave(state.octave, false);
		updateKeyboardFades();
		drawStaff();
		revealCursor();
		updateEditButtons();
		updateRestoreBar();
		if (state.trimmedFrom) {
			setStatus(`Your draft had ${state.trimmedFrom} notes, more than the ${MAX_NOTES} a piece can have: these are the first ${MAX_NOTES}.`, true);
		} else {
			setStatus(state.notes.length
				? `Restored ${countLabel(state.notes.length)} from your last session.`
				: "Tap the keys or click the staff to write notes; hold Shift (or turn on Chord) to stack them into chords.");
		}
		// A share link in the address opens over the draft just restored, as one undoable edit.
		openShareLink();
	}

	// Test hook: pure helpers and read-only views of state, no mutation. isPlaying is read by pwa.js (no update
	// while playing); cursor, selection and voices let the tests check where the cursor is, what is selected and
	// that Stop silences everything, and layout how notes are written (ties, bar lines).
	window.Notar = {
		isPlaying: () => state.playing,
		// pwa.js applies an update at launch only if this is false: a share link has opened (or is opening), or
		// something has been edited, and a reload would take the undo history with it.
		editedSinceLaunch: () => linkOpened || state.past.length > 0,
		cursor: () => state.caret,
		selection: () => selection(),
		instrument: () => state.instrument,
		voices: () => voices.size,
		// The engraving as plain data: every bar line's x, and each note's written segments (a tied note has several).
		layout: () => ({
			bars: Array.from({ length: state.layout.measureCount + 1 }, (_, measure) => barX(state.layout, measure)),
			events: state.layout.events.map((event) => ({
				index: event.index,
				beat: event.beat,
				beats: event.beats,
				segments: event.segments.map((segment) => ({
					beat: segment.beat,
					beats: segment.units / UNITS_PER_BEAT,
					measure: segment.measure,
					duration: segment.duration,
					dotted: segment.dotted,
					x: segment.startX,
				})),
			})),
		}),
		parsePitch,
		pitchId,
		pitchMidi,
		pitchFrequency,
		staffPlacement,
		normalizeNote,
		chordName,
		range: { low: "C2", high: "C6" },
	};

	init();
})();
