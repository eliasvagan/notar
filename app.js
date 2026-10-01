/*
 * Notar itself: the pitch model, the on-screen keyboard, the grand staff (engraved as SVG) and editing on it, Web
 * Audio playback, undo history, persistence and import/export, in one IIFE with no dependencies. index.html loads
 * it before pwa.js and supplies every element in `ui` below.
 *
 *   - A composition is state.notes: [{ pitches, duration, dotted? }]. pitches lists pitch ids like "C4", "F#3",
 *     "Eb5" (C2–C6), low to high: one is a note, several a chord, none a rest. duration is the note value's
 *     denominator (1 whole … 16 sixteenth); dotted makes a note half as long again.
 *   - state.caret is the cursor: the gap before note `caret`, from 0 to notes.length. New notes go in there. The
 *     note just before it is the current note, which chord tones, transposing and Delete act on.
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
	const HISTORY_LIMIT = 200; // undo steps kept

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
		chordBtn: document.getElementById("chordBtn"),
		octaveTabs: document.getElementById("octaveTabs"),
		octaveDownBtn: document.getElementById("octaveDownBtn"),
		octaveUpBtn: document.getElementById("octaveUpBtn"),
		staffSvg: document.getElementById("staffSvg"),
		staffScroll: document.getElementById("staffScroll"),
		noteCount: document.getElementById("noteCount"),
		status: document.getElementById("status"),
		durationPicker: document.getElementById("durationPicker"),
	};

	// Read live (.matches) at each use, so a change to the OS setting applies without a reload.
	const reduceMotion = window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: { matches: false };
	// A finger is less precise than a mouse: the insert target around the cursor line is wider on touch screens.
	const coarsePointer = window.matchMedia ? window.matchMedia("(pointer: coarse)") : { matches: false };

	// notes and caret: the composition and the cursor (see the header). selectedDuration and dotted: the length new
	// notes get. chordMode: keys stack onto the current note, as if Shift were held. volume: the master gain, 0–1.
	// bpm: quarter-note beats per minute. octave: the one the computer keyboard plays, from OCTAVES. playbackToken:
	// bumped by stopPlayback; a run that sees it change has been cancelled. audioContext and masterGain are created
	// on first use (ensureAudio). layout: the last engrave() result, which drawing, clicks and playback share.
	// past and future: undo and redo steps (snapshots). hover: the pointer's last staff position while a mouse is
	// over it; dragging: the cursor is being dragged along the ruler. sounding: the note lit during playback.
	const state = {
		notes: [],
		caret: 0,
		selectedDuration: 4,
		dotted: false,
		chordMode: false,
		volume: 0.35,
		bpm: 96,
		loop: false,
		octave: DEFAULT_OCTAVE,
		playing: false,
		playbackToken: 0,
		audioContext: null,
		masterGain: null,
		layout: null,
		past: [],
		future: [],
		hover: null,
		dragging: false,
		sounding: null,
	};

	// Every oscillator scheduled and not yet ended, so Stop can silence what is already queued on the audio clock.
	const voices = new Set();

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
	 * the context is created and resume() called synchronously inside the click or keypress.
	 */
	async function ensureAudio() {
		if (!state.audioContext) {
			state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
			state.masterGain = state.audioContext.createGain();
			state.masterGain.gain.value = state.volume;
			state.masterGain.connect(state.audioContext.destination);
		}
		// "interrupted" is iOS after the app was backgrounded; both resume on this (user-gesture) call.
		if (state.audioContext.state !== "running") {
			await state.audioContext.resume();
		}
		state.masterGain.gain.setValueAtTime(state.volume, state.audioContext.currentTime);
	}

	/**
	 * Schedules one voice on the audio clock: a triangle oscillator through its own envelope into the master gain.
	 * startTime is AudioContext time and both times are in seconds; share scales the peak (a chord's voices split
	 * the loudness). The envelope rises over 20 ms, holds, and falls over the last 80 ms; a note too short for that
	 * rises over its first fifth and falls over its last quarter.
	 */
	function scheduleVoice(pitch, startTime, durationSeconds, share) {
		const frequency = pitchFrequency(pitch);
		const osc = state.audioContext.createOscillator();
		const gain = state.audioContext.createGain();
		const end = startTime + durationSeconds;
		const attack = Math.min(0.02, durationSeconds * 0.2);
		const release = Math.min(0.08, durationSeconds * 0.25);
		// Gentle equal-loudness tilt: low triangle tones read quieter, the top
		// octave brighter. Scales from ~1.23 at C2 through 1 at middle C to ~0.81 at C6.
		const tilt = Math.min(1.3, Math.max(0.8, Math.pow(261.63 / frequency, 0.15)));
		// Exponential ramps can't reach 0: the envelope runs from and to 0.0001, and the peak stays above that even
		// at volume 0.
		const peak = Math.max(state.volume * tilt * share, 0.0002);

		osc.type = "triangle";
		osc.frequency.setValueAtTime(frequency, startTime);
		gain.gain.setValueAtTime(0.0001, startTime);
		gain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
		gain.gain.setValueAtTime(peak, Math.max(startTime + attack, end - release));
		gain.gain.exponentialRampToValueAtTime(0.0001, end);

		osc.connect(gain);
		gain.connect(state.masterGain);
		const voice = { osc, gain, start: startTime };
		voices.add(voice);
		osc.addEventListener("ended", () => voices.delete(voice));
		osc.start(startTime);
		osc.stop(end + 0.05); // once the envelope has faded out
	}

	// Schedules every pitch of a note (ids; none for a rest) together. Each voice gets 1/√n of the loudness, so a
	// chord sounds about as loud as a single note instead of n times louder.
	function playPitches(ids, startTime, durationSeconds) {
		const pitches = ids.map(parsePitch).filter((pitch) => pitch && !pitch.rest);
		const share = 1 / Math.sqrt(Math.max(1, pitches.length));
		pitches.forEach((pitch) => scheduleVoice(pitch, startTime, durationSeconds, share));
	}

	// Silences every voice: one still queued is stopped before its start, so it never sounds; one sounding fades
	// out over 40 ms from where its envelope is. (Ramping a queued voice instead would start it from the gain's
	// default of 1, a loud click.)
	function silence() {
		if (!state.audioContext) {
			return;
		}
		const now = state.audioContext.currentTime;
		for (const { osc, gain, start } of voices) {
			if (start > now) {
				osc.stop(now);
				continue;
			}
			gain.gain.cancelScheduledValues(now);
			gain.gain.setValueAtTime(gain.gain.value, now);
			gain.gain.linearRampToValueAtTime(0, now + 0.04);
			osc.stop(now + 0.05);
		}
		voices.clear();
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
		};
		try {
			window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
		} catch (error) {
			// Ignore storage failures in private browsing modes.
		}
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
				state.notes = normalizeNotes(payload.notes);
			}
			// A draft from before the cursor existed had every note entered at the end: put the cursor there.
			state.caret = Number.isInteger(payload.caret) ? clamp(payload.caret, 0, state.notes.length) : state.notes.length;
			if (payload.bpm) {
				state.bpm = payload.bpm;
			}
			if (VALID_DURATIONS.includes(payload.selectedDuration)) {
				state.selectedDuration = payload.selectedDuration;
			}
			if (typeof payload.volume === "number") {
				state.volume = payload.volume;
			}
			for (const flag of ["dotted", "chordMode", "loop"]) {
				if (typeof payload[flag] === "boolean") {
					state[flag] = payload[flag];
				}
			}
			if (OCTAVES.includes(payload.octave)) {
				state.octave = payload.octave;
			}
		} catch (error) {
			// Ignore corrupt drafts.
		}
	}

	// ── History and editing ──────────────────────────────────────────────────
	// A copy of the notes, the cursor and the tempo, deep enough that later edits to state.notes leave it alone.
	function snapshot() {
		return { notes: state.notes.map((note) => ({ ...note, pitches: [...note.pitches] })), caret: state.caret, bpm: state.bpm };
	}

	/**
	 * Runs one edit. change() changes state.notes and state.caret and returns { message, sound?, tempo? }, or returns
	 * null before changing anything when there is nothing to do. A made edit becomes one undo step (labelled with its
	 * message) and clears the redo steps; then the staff is redrawn and the draft saved, the message shown and, with
	 * sound (a note), heard. tempo marks an edit that also set the tempo (an import): only its undo and redo touch
	 * the tempo, so undoing a note never reverts the Tempo slider. Returns whether the edit was made.
	 */
	function edit(change) {
		const before = snapshot();
		const result = change();
		if (!result) {
			return false;
		}
		before.message = result.message;
		before.tempo = Boolean(result.tempo);
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
		saveToStorage();
		updateEditButtons();
		setStatus(message);
	}

	function undo() {
		const step = state.past.pop();
		if (!step) {
			setStatus("Nothing to undo.");
			return;
		}
		state.future.push({ ...snapshot(), message: step.message, tempo: step.tempo });
		restore(step);
		refresh(`Undone: ${step.message}`);
	}

	function redo() {
		const step = state.future.pop();
		if (!step) {
			setStatus("Nothing to redo.");
			return;
		}
		state.past.push({ ...snapshot(), message: step.message, tempo: step.tempo });
		restore(step);
		refresh(`Redone: ${step.message}`);
	}

	function restore(step) {
		state.notes = step.notes;
		state.caret = step.caret;
		if (step.tempo) {
			setBpm(step.bpm);
		}
	}

	/**
	 * Enables the Edit actions that can act now. A button that disables itself while focused (the last Undo, say)
	 * hands focus to the next one that still works, so keyboard users aren't dropped back to the top of the page.
	 */
	function updateEditButtons() {
		const focused = document.activeElement;
		ui.undoBtn.disabled = !state.past.length;
		ui.redoBtn.disabled = !state.future.length;
		ui.deleteBtn.disabled = state.caret === 0;
		ui.clearBtn.disabled = !state.notes.length;
		const actions = [ui.undoBtn, ui.redoBtn, ui.deleteBtn, ui.clearBtn];
		if (focused && focused.disabled && actions.includes(focused)) {
			const next = actions.find((button) => !button.disabled);
			if (next) {
				next.focus();
			}
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
		edit(() => {
			const index = at === undefined ? state.caret : at;
			const note = makeNote(pitches);
			const atEnd = index === state.notes.length;
			state.notes.splice(index, 0, note);
			state.caret = index + 1;
			return { message: `${atEnd ? "Added" : "Inserted"} ${describeNote(note)}.`, sound: note };
		});
		flashKeys(pitches.length ? pitches : ["rest"]);
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

	// A pitch from the keyboard or a key with Shift held or chord mode on: a chord tone for the current note, or a
	// first note when the cursor is at the very beginning.
	function enterChordTone(id) {
		if (state.caret === 0) {
			insertNote([id]);
			return;
		}
		stackPitch(state.caret - 1, parsePitch(id), true);
		flashKeys([id]);
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
	 * Puts the cursor in gap `index` (clamped). Not an edit: no undo step. announce reports where it is (a status
	 * message read by screen readers); a drag along the ruler passes false and announces once, at the end. While
	 * dragging the staff doesn't scroll: the cursor follows the pointer, and scrolling under a pointer that hasn't
	 * moved would carry the cursor away with it.
	 */
	function moveCursor(index, announce) {
		const next = clamp(index, 0, state.notes.length);
		if (next !== state.caret) {
			state.caret = next;
			drawStaff();
			saveToStorage();
			updateEditButtons();
		}
		if (!state.dragging) {
			revealCursor();
		}
		if (announce !== false) {
			setStatus(describeCursor());
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
	// where you press.
	function markHeldKeys() {
		ui.piano.querySelectorAll(".key.held").forEach((key) => key.classList.remove("held"));
		const current = state.notes[state.caret - 1];
		for (const id of current ? current.pitches : []) {
			const key = keyFor(parsePitch(id));
			if (key) {
				key.classList.add("held");
			}
		}
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

	/**
	 * One staff's share of a note: its heads (low to high, with y, position, the accidental to print and its column,
	 * and offset: how far the head sits left or right of the note's centre, for seconds), the stem direction, and
	 * how far the drawing reaches left and right of the centre. heads: [{ pitch, accidental }] for this staff.
	 */
	function engravePart(staff, heads, note) {
		const placed = heads.map(({ pitch, accidental }) => {
			const place = staffPlacement(pitch);
			return { pitch, accidental, position: place.position, y: place.y, offset: 0, column: 0 };
		}).sort((a, b) => a.position - b.position);
		const low = placed[0].position;
		const high = placed[placed.length - 1].position;
		// The note farthest from the middle line (position 4) decides: stem down if it is above, up if below.
		const stemDown = high - 4 >= 4 - low;

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
		const flag = note.duration >= 8 && !stemDown ? STEM_X + 9 : 0;
		const dot = note.dotted ? headRight + 7 : 0;
		return {
			staff,
			bottom: staff === "treble" ? TREBLE_BOTTOM : BASS_BOTTOM,
			heads: placed,
			stemDown,
			headLeft,
			headRight,
			left,
			right: Math.max(headRight, flag, dot),
		};
	}

	/**
	 * Lays out a list of notes for drawing, clicks and playback, left to right from STAFF_LEFT. Returns { events,
	 * contentEnd, totalBeats }: one event per note with { note, index, beat (start, in beats), beats, measure, rest,
	 * parts (engravePart, one per staff it uses), startX, width, centerX }, and the x where the music ends.
	 *
	 * A note belongs to the measure it starts in; one that runs past a bar line is not split or tied. Accidentals
	 * hold for the rest of the measure at that staff position: with no key signature every position starts the
	 * measure natural, so a sign is printed whenever a note's alter differs from the last one there.
	 */
	function engrave(notes) {
		const events = [];
		let x = STAFF_LEFT;
		let beat = 0;
		let measureOf = -1;
		let accidentals = new Map();
		notes.forEach((note, index) => {
			const beats = noteBeats(note);
			const measure = Math.floor(beat / BEATS_PER_MEASURE + 1e-9);
			if (measure !== measureOf) {
				measureOf = measure;
				accidentals = new Map();
			}
			const heads = note.pitches.map((id) => {
				const pitch = parsePitch(id);
				const key = `${pitch.octave}:${pitch.step}`;
				const current = accidentals.has(key) ? accidentals.get(key) : 0;
				return { pitch, key, accidental: pitch.alter !== current ? pitch.alter : null };
			});
			heads.forEach((head) => accidentals.set(head.key, head.pitch.alter));
			// A chord can span both staves; each staff's share gets its own stem, as in piano music.
			const parts = [];
			for (const staff of ["treble", "bass"]) {
				const own = heads.filter((head) => staffPlacement(head.pitch).staff === staff);
				if (own.length) {
					parts.push(engravePart(staff, own, note));
				}
			}

			// What the drawing needs either side of the centre: the parts' reach, or a rest's (with its dot). The left
			// margin keeps an accidental clear of a cursor line in the gap before it.
			const left = parts.length ? Math.max(...parts.map((part) => part.left)) : 11;
			const right = parts.length ? Math.max(...parts.map((part) => part.right)) : note.dotted ? 19 : 11;
			const body = bodyWidth(beats);
			const lead = Math.max(0, left + CURSOR_NUDGE + 4 - body / 2);
			const width = lead + body + Math.max(0, right + 3 - body / 2);
			events.push({ note, index, beat, beats, measure, rest: !parts.length, parts, startX: x, width, centerX: x + lead + body / 2 });
			x += width;
			beat += beats;
		});
		return { events, contentEnd: x, totalBeats: beat };
	}

	// The x of the bar line that starts measure `measure` (0 is the first). Inside the music it falls before the
	// first note at or after the measure's first beat, so a note that runs past a bar line stays whole before it;
	// past the music, empty measures follow at BEAT_WIDTH a beat.
	function barX(layout, measure) {
		const beat = measure * BEATS_PER_MEASURE;
		if (measure === 0) {
			return STAFF_LEFT;
		}
		const next = layout.events.find((event) => event.beat >= beat - 1e-9);
		if (next) {
			return next.startX;
		}
		return layout.contentEnd + Math.max(0, beat - layout.totalBeats) * BEAT_WIDTH;
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

	function drawRest(group, note, centerX) {
		const { duration } = note;
		if (note.dotted) {
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
		// the note would have: one for an eighth, two for a sixteenth.
		const restY = TREBLE_TOP + SPACE * 2;
		group.appendChild(createSvgEl("rect", {
			class: "note-head rest",
			x: centerX - 10,
			y: restY - 4,
			width: 20,
			height: 8,
			rx: 2,
		}));
		const flags = duration === 8 ? [0] : duration === 16 ? [-3.5, 3.5] : [];
		flags.forEach((dx) => group.appendChild(createSvgEl("circle", { class: "rest-dot", cx: centerX + dx, cy: restY - 9, r: 2 })));
	}

	/**
	 * One staff's share of a note or chord (see engravePart): ledger lines, accidentals, heads, the stem from the
	 * far head to past the near one, flags and dots. Two flags for a sixteenth, on a stem one LINE_GAP longer.
	 */
	function drawPart(group, part, event) {
		const cx = event.centerX;
		const { duration, dotted } = event.note;
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
		const middleY = part.bottom - 4 * LINE_GAP;
		const length = STEM_LENGTH + (duration === 16 ? LINE_GAP : 0);
		const stemX = part.stemDown ? cx - STEM_X : cx + STEM_X;
		const stemY1 = part.stemDown ? highest.y + 2 : lowest.y - 2;
		const stemY2 = part.stemDown ? Math.max(lowest.y + length, middleY) : Math.min(highest.y - length, middleY);
		group.appendChild(createSvgEl("line", { class: "note-stem", x1: stemX, y1: stemY1, x2: stemX, y2: stemY2 }));

		const flags = duration === 8 ? 1 : duration === 16 ? 2 : 0;
		for (let i = 0; i < flags; i += 1) {
			const y = part.stemDown ? stemY2 - i * 7 : stemY2 + i * 7;
			const d = part.stemDown
				? `M${stemX} ${y}c0.5 -7 9 -9 8 -20`
				: `M${stemX} ${y}c0.5 7 9 9 8 20`;
			group.appendChild(createSvgEl("path", { class: "note-flag", d }));
		}
	}

	// One note, chord or rest as <g class="note-group" data-index="i">: playback highlights it by that index. A chord
	// CHORD_TYPES knows gets its symbol above the treble staff.
	function drawEvent(event) {
		const current = event.index === state.caret - 1;
		const group = createSvgEl("g", { class: current ? "note-group current" : "note-group", "data-index": event.index });
		if (event.rest) {
			drawRest(group, event.note, event.centerX);
		} else {
			event.parts.forEach((part) => drawPart(group, part, event));
			const symbol = chordName(event.note.pitches);
			if (symbol) {
				const text = createSvgEl("text", { class: "chord-symbol", x: event.centerX, y: CHORD_SYMBOL_Y });
				text.textContent = symbol;
				group.appendChild(text);
			}
		}
		const title = createSvgEl("title", {});
		title.textContent = `Note ${event.index + 1}: ${describeNote(event.note)}`;
		group.appendChild(title);
		ui.staffSvg.appendChild(group);
	}

	// The ruler: a strip along the top with each measure's number at its bar line. Its band is the hit area for
	// moving the cursor (styles.css gives it the ew-resize pointer).
	function drawRuler(layout, width) {
		const g = createSvgEl("g", { class: "ruler" });
		g.appendChild(createSvgEl("rect", { class: "ruler-band", x: 0, y: 0, width, height: RULER_HEIGHT }));
		g.appendChild(createSvgEl("line", { class: "ruler-edge", x1: 0, y1: RULER_HEIGHT - 0.5, x2: width, y2: RULER_HEIGHT - 0.5 }));
		for (let measure = 0; measure < layout.measureCount; measure += 1) {
			const x = barX(layout, measure);
			if (barX(layout, measure + 1) - x < 14) {
				continue; // bar lines together (a long note crossed both): the music after them is the later measure's
			}
			const label = createSvgEl("text", { class: "ruler-number", x: x + 5, y: 15 });
			label.textContent = String(measure + 1);
			g.appendChild(label);
		}
		ui.staffSvg.appendChild(g);
	}

	// The cursor: a line through both staves in its gap, and a handle on the ruler showing the length the next note
	// will get, so where and how long read together.
	function drawCursor(layout) {
		const x = gapX(layout, state.caret) + CURSOR_NUDGE;
		const g = createSvgEl("g", { class: "cursor", "aria-hidden": "true" });
		g.appendChild(createSvgEl("line", { class: "cursor-line", x1: x, y1: RULER_HEIGHT, x2: x, y2: BASS_BOTTOM + 34 }));
		g.appendChild(createSvgEl("rect", { class: "cursor-handle", x: x - 19, y: 3, width: 38, height: 16, rx: 8 }));
		const label = createSvgEl("text", { class: "cursor-label", x, y: 14.5 });
		label.textContent = `${durationLabel(state.selectedDuration)}${state.dotted ? "·" : ""}`;
		g.appendChild(label);
		ui.staffSvg.appendChild(g);
	}

	/**
	 * Rebuilds the whole SVG from state.notes and stores the layout in state.layout: paper, ruler, the current note's
	 * band, both staves, brace, clefs, time signature and bar lines, then one group per note (drawEvent), the cursor,
	 * the #playhead line and the #ghost layer for hover previews. The staff runs on past the music by at least
	 * ROOM_AFTER and fills the visible width. Scrolling is left to the caller (revealCursor).
	 */
	function drawStaff() {
		const layout = engrave(state.notes);
		state.layout = layout;
		const viewWidth = ui.staffScroll.clientWidth;
		layout.measureCount = Math.max(2, Math.ceil(layout.totalBeats / BEATS_PER_MEASURE - 1e-9));
		while (barX(layout, layout.measureCount) < Math.max(layout.contentEnd + ROOM_AFTER, viewWidth - 24)) {
			layout.measureCount += 1;
		}
		const staffEnd = barX(layout, layout.measureCount);
		const width = Math.max(staffEnd + 24, viewWidth);
		const height = STAFF_HEIGHT;

		ui.staffSvg.innerHTML = "";
		ui.staffSvg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		ui.staffSvg.setAttribute("width", String(width));
		ui.staffSvg.setAttribute("height", String(height));

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
		ui.staffSvg.appendChild(defs);

		ui.staffSvg.appendChild(createSvgEl("rect", { x: 0, y: 0, width, height, fill: "url(#staffPaper)" }));
		drawRuler(layout, width);

		// The current note's column, tinted behind everything: what chord tones, ↑ ↓ and Delete will act on.
		const current = layout.events[state.caret - 1];
		if (current) {
			ui.staffSvg.appendChild(createSvgEl("rect", {
				class: "current-band",
				x: current.startX + 1,
				y: RULER_HEIGHT + 4,
				width: Math.max(0, current.width - 2),
				height: STAFF_HEIGHT - RULER_HEIGHT - 8,
				rx: 6,
			}));
		}

		const staffLines = createSvgEl("g", { class: "staff-lines" });
		for (const top of [TREBLE_TOP, BASS_TOP]) {
			for (let i = 0; i < 5; i += 1) {
				const y = top + i * SPACE;
				staffLines.appendChild(createSvgEl("line", { class: "staff-line", x1: 14, y1: y, x2: staffEnd, y2: y }));
			}
		}
		ui.staffSvg.appendChild(staffLines);

		// System line and brace-side join the two staves into one grand staff.
		ui.staffSvg.appendChild(createSvgEl("line", { class: "system-line", x1: 14, y1: TREBLE_TOP, x2: 14, y2: BASS_BOTTOM }));
		ui.staffSvg.appendChild(createSvgEl("path", {
			class: "brace",
			d: `M9 ${TREBLE_TOP}C2 ${TREBLE_TOP + 30} 10 ${(TREBLE_TOP + BASS_BOTTOM) / 2 - 20} 3 ${(TREBLE_TOP + BASS_BOTTOM) / 2}C10 ${(TREBLE_TOP + BASS_BOTTOM) / 2 + 20} 2 ${BASS_BOTTOM - 30} 9 ${BASS_BOTTOM}`,
		}));

		ui.staffSvg.appendChild(createSvgEl("image", {
			href: "assets/g-clef.svg",
			x: 24,
			y: TREBLE_TOP - 18,
			width: 34,
			height: 58,
		}));
		drawBassClef(ui.staffSvg);
		drawTimeSignature(ui.staffSvg);

		for (let measure = 0; measure <= layout.measureCount; measure += 1) {
			const x = barX(layout, measure);
			ui.staffSvg.appendChild(createSvgEl("line", {
				class: measure === layout.measureCount ? "bar-line final" : "bar-line",
				x1: x,
				y1: TREBLE_TOP,
				x2: x,
				y2: BASS_BOTTOM,
			}));
		}

		layout.events.forEach(drawEvent);
		drawCursor(layout);

		ui.staffSvg.appendChild(createSvgEl("line", {
			id: "playhead",
			class: "playhead",
			x1: STAFF_LEFT,
			y1: TREBLE_TOP - 30,
			x2: STAFF_LEFT,
			y2: BASS_BOTTOM + 30,
		}));
		ui.staffSvg.appendChild(createSvgEl("g", { id: "ghost", class: "ghost", "aria-hidden": "true" }));

		const count = state.notes.length;
		ui.staffSvg.setAttribute("aria-label", count
			? `Sheet music, grand staff: ${count} ${count === 1 ? "note" : "notes"}, cursor ${state.caret === count ? "at the end" : `before note ${state.caret + 1}`}.`
			: "Sheet music, grand staff, empty.");
		updateMeta();
		// The keyboard shows the same current note as the staff.
		markHeldKeys();
		if (state.hover) {
			showGhost(hitTest(state.hover.x, state.hover.y));
		}
		if (state.playing && state.sounding) {
			highlight(state.sounding, false);
		}
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
	 *   - on a note's column at a pitch it has: "remove" that pitch if it is the current chord, else "select" the
	 *     note (the cursor moves after it); at a pitch it hasn't: "chord", add it as a chord tone;
	 *   - past the music: { kind: "append", pitch, x }, a new note at the end.
	 * pitch is from the line or space under the pointer (pitchAtY); x is where the preview head goes. null if none.
	 */
	function hitTest(x, y) {
		const layout = state.layout;
		if (y < RULER_HEIGHT) {
			return { kind: "cursor", index: nearestGap(layout, x) };
		}
		const pitch = pitchAtY(y);
		if (!pitch || x < STAFF_LEFT - 4) {
			return null;
		}
		const event = layout.events.find((e) => x >= e.startX && x < e.startX + e.width);
		let head = null;
		for (const part of event ? event.parts : []) {
			head = head || part.heads.find((h) => diatonic(h.pitch) === diatonic(pitch));
		}
		const onHead = head && Math.abs(x - (event.centerX + head.offset)) <= HEAD_RX + 3;
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
				x: event.centerX + head.offset,
			};
		}
		if (event) {
			return { kind: "chord", index: event.index, pitch, x: event.centerX };
		}
		if (x >= layout.contentEnd) {
			const beats = noteBeats({ duration: state.selectedDuration, dotted: state.dotted });
			return { kind: "append", pitch, x: layout.contentEnd + Math.max(bodyWidth(beats) / 2, 20) };
		}
		return null;
	}

	/**
	 * Draws the hover preview for a hitTest result into #ghost: a faint head with its ledger lines and a label
	 * ("E4", "+ E4" for a chord tone, "− E4" in red for one that would go), or a dashed cursor line over the ruler.
	 * null, or a click that only selects, shows nothing.
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
				setStatus(`Note ${hit.index + 1}: ${describeNote(state.notes[hit.index])}. Click the staff above or below it to add chord tones; Delete removes it.`);
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
	 * Clicks on the staff edit it (applyHit); a mouse hovering over it gets the preview (showGhost). A mouse press
	 * on the ruler is handled from pointerdown to pointerup instead: it moves the cursor live and announces it on
	 * release, and the click that may follow is swallowed, wherever it lands (rulerPress; the next pointerdown
	 * resets it, as a redraw during the drag can mean no click comes). Touch uses click alone, so a swipe still
	 * scrolls the staff and a tap on the ruler moves the cursor.
	 */
	function bindStaff() {
		const svg = ui.staffSvg;
		let rulerPress = false;
		svg.addEventListener("click", (event) => {
			if (rulerPress) {
				rulerPress = false;
				return;
			}
			const point = staffPoint(event);
			if (point) {
				applyHit(hitTest(point.x, point.y));
			}
		});
		svg.addEventListener("pointermove", (event) => {
			if (event.pointerType === "touch") {
				return;
			}
			const point = staffPoint(event);
			if (!point) {
				return;
			}
			state.hover = point;
			if (state.dragging && !(event.buttons & 1)) {
				endDrag(); // the release went elsewhere (a context menu, say): don't drag on with no button held
			}
			if (state.dragging) {
				moveCursor(nearestGap(state.layout, point.x), false);
				return;
			}
			showGhost(hitTest(point.x, point.y));
		});
		svg.addEventListener("pointerleave", () => {
			state.hover = null;
			showGhost(null);
		});
		svg.addEventListener("pointerdown", (event) => {
			const point = staffPoint(event);
			rulerPress = event.pointerType === "mouse" && event.button === 0 && Boolean(point) && point.y < RULER_HEIGHT;
			if (!rulerPress) {
				return;
			}
			state.dragging = true;
			svg.setPointerCapture(event.pointerId);
			moveCursor(nearestGap(state.layout, point.x), false);
		});
		function endDrag() {
			if (state.dragging) {
				state.dragging = false;
				setStatus(describeCursor());
			}
		}
		svg.addEventListener("pointerup", endDrag);
		svg.addEventListener("pointercancel", endDrag);
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
		state.sounding = null;
		silence();
		document.dispatchEvent(new CustomEvent("notar:playback", { detail: { playing: false } }));
		ui.playBtn.disabled = false;
		ui.stopBtn.disabled = true;
		clearActiveNotes();
		setPlayhead(STAFF_LEFT, false);
	}

	/**
	 * Lights the note playing: its group on the staff, every key of it, and the playhead; scroll keeps it about a
	 * third of the way into the view. The note is found by identity when this runs, so notes inserted or deleted
	 * before it during playback don't shift the light onto a neighbour; drawStaff calls it again (unscrolled) after
	 * a redraw mid-note, so the light and the playhead survive the rebuild.
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
		setPlayhead(event.centerX, true);
		if (scroll) {
			ui.staffScroll.scrollLeft = Math.max(0, event.centerX - ui.staffScroll.clientWidth * 0.35);
		}
	}

	/**
	 * Plays state.notes from the cursor (from the start when the cursor is at the end). Each pass schedules all its
	 * notes on the audio clock at once (playPitches); the staff and key highlights follow on main-thread timers,
	 * which may fire a little late but never move the sound. Loop is read once, at Play; a loop's later passes start
	 * from the beginning, and notes added while playing join the next pass.
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
		const first = state.caret < state.notes.length ? state.caret : 0;

		async function runPass(from) {
			const notes = state.notes.slice();
			let audioTime = state.audioContext.currentTime + 0.08; // a little ahead, so no note starts in the past

			for (let index = from; index < notes.length; index += 1) {
				const note = notes[index];
				const seconds = noteSeconds(note);
				playPitches(note.pitches, audioTime, seconds);
				const highlightAt = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);
				window.setTimeout(() => {
					if (token === state.playbackToken) {
						highlight(note, true);
					}
				}, highlightAt);
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
				await runPass(0);
				return;
			}

			stopPlayback();
			setStatus("Playback finished.");
		}

		setStatus(first ? `Playing from note ${first + 1}…` : "Playing…");
		runPass(first);
	}

	// ── Import / export ──────────────────────────────────────────────────────
	// Downloads { version: 3, bpm, notes } as notar_<date>.json, the file importComposition reads. Version 3 notes
	// carry a pitches list (chords; [] for a rest) and dotted; versions 1 and 2 had one pitch per note.
	function exportComposition() {
		const payload = {
			version: 3,
			bpm: state.bpm,
			notes: state.notes,
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `notar_${new Date().toISOString().slice(0, 10)}.json`;
		anchor.click();
		window.setTimeout(() => URL.revokeObjectURL(url), 0); // next tick: the click has started the download
		setStatus("Composition exported.");
	}

	// Replaces the composition (and the tempo, if the file has one) with the file's notes, as one undoable edit.
	// Notes that can't be read are skipped and counted; a file with notes but none readable is refused and changes
	// nothing.
	function importComposition(file) {
		const reader = new FileReader();
		reader.onload = () => {
			try {
				const payload = JSON.parse(reader.result);
				if (!Array.isArray(payload.notes)) {
					throw new Error("Invalid file format.");
				}
				const notes = normalizeNotes(payload.notes);
				if (payload.notes.length && !notes.length) {
					throw new Error("No playable notes.");
				}
				stopPlayback();
				const skipped = payload.notes.length - notes.length;
				edit(() => {
					state.notes = notes;
					state.caret = notes.length;
					if (payload.bpm) {
						setBpm(payload.bpm);
					}
					return {
						message: `Imported ${notes.length} notes${skipped ? ` (skipped ${skipped} outside C2–C6)` : ""}.`,
						tempo: Boolean(payload.bpm),
					};
				});
			} catch (error) {
				setStatus("Could not import that file.", true);
			}
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

	function setBpm(bpm) {
		state.bpm = bpm;
		ui.bpm.value = String(bpm);
		ui.bpmLabel.textContent = `${bpm} BPM`;
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
		ui.deleteBtn.addEventListener("click", () => deleteNote(state.caret - 1));
		ui.clearBtn.addEventListener("click", clearNotes);
		ui.loopBtn.addEventListener("click", () => {
			state.loop = !state.loop;
			ui.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
			saveToStorage();
			setStatus(state.loop ? "Loop enabled." : "Loop disabled.");
		});
		ui.exportBtn.addEventListener("click", exportComposition);
		ui.importBtn.addEventListener("click", () => ui.importInput.click());
		ui.importInput.addEventListener("change", () => {
			const file = ui.importInput.files && ui.importInput.files[0];
			if (file) {
				importComposition(file);
			}
			ui.importInput.value = ""; // so choosing the same file again still fires change
		});

		bindStaff();
		window.addEventListener("keydown", onKeydown);
	}

	/**
	 * Shortcuts (listed in index.html's footer). None while a field or slider has focus (a length radio doesn't
	 * count, though it keeps its arrow keys), and none with Alt; with Ctrl or Cmd only undo and redo, so the
	 * browser's own shortcuts keep working.
	 */
	function onKeydown(event) {
		if (event.target.matches("input:not([type=radio]), textarea, select")) {
			return;
		}
		const key = event.key;
		const lower = key.toLowerCase();
		if ((event.ctrlKey || event.metaKey) && !event.altKey && (lower === "z" || lower === "y")) {
			event.preventDefault();
			if (lower === "y" || event.shiftKey) {
				redo();
			} else {
				undo();
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
			moveCursor(state.caret + (key === "ArrowLeft" ? -1 : 1));
			return;
		}
		if (key === "Home" || key === "End") {
			event.preventDefault();
			moveCursor(key === "Home" ? 0 : state.notes.length);
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
			stopPlayback();
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
		setStatus(state.notes.length
			? `Restored ${state.notes.length} notes from your last session.`
			: "Tap the keys or click the staff to write notes; hold Shift (or turn on Chord) to stack them into chords.");
	}

	// Test hook: pure helpers and read-only views of state, no mutation. isPlaying is read by pwa.js (no update
	// while playing); cursor and voices let the tests check where the cursor is and that Stop silences everything.
	window.Notar = {
		isPlaying: () => state.playing,
		cursor: () => state.caret,
		voices: () => voices.size,
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
