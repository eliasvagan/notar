/*
 * Notar itself: the pitch model, the on-screen keyboard, the grand staff (drawn as SVG), Web Audio playback,
 * persistence and import/export, in one IIFE with no dependencies. index.html loads it before pwa.js and supplies
 * every element in `ui` below.
 *
 *   - A composition is state.notes: [{ pitch, duration }]. pitch is "rest" or a pitch id like "C4", "F#3", "Eb5"
 *     (C2–C6); duration is the note value's denominator (1 whole, 2 half, 4 quarter, 8 eighth).
 *   - The staff is redrawn in full whenever state.notes changes; playback finds note i by its data-index="i".
 *   - Every change is saved to localStorage at once, so a reload (pwa.js applying an update) loses nothing.
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

	// Note lengths, each the denominator of a whole note (4 = quarter). A length's index in this list is the value
	// of the hidden #duration slider and of its radio in #durationPicker.
	const DURATIONS = [
		{ label: "1/1", value: 1 },
		{ label: "1/2", value: 2 },
		{ label: "1/4", value: 4 },
		{ label: "1/8", value: 8 },
	];
	const VALID_DURATIONS = DURATIONS.map((entry) => entry.value);

	// ── Staff geometry (grand staff) ─────────────────────────────────────────
	// SVG user units; drawStaff sizes the SVG to its viewBox, so one unit is one CSS px. Notes are spaced by
	// length (noteWidth), so x is proportional to the beat. Each staff places its notes from its own bottom line
	// (staffPlacement): the gap between the two staves is layout, not pitch.
	const MEASURE_WIDTH = 240; // one 4/4 measure: 60 per beat
	const STAFF_LEFT = 84; // x of the first bar line; brace and clefs sit to its left
	const LINE_GAP = 6; // half a staff space: one diatonic step
	const SPACE = LINE_GAP * 2;
	const TREBLE_TOP = 54; // F5 line
	const TREBLE_BOTTOM = TREBLE_TOP + SPACE * 4; // E4 line
	const BASS_TOP = TREBLE_BOTTOM + 66; // A3 line
	const BASS_BOTTOM = BASS_TOP + SPACE * 4; // G2 line
	const STAFF_HEIGHT = BASS_BOTTOM + 60;
	const BEATS_PER_MEASURE = 4; // 4/4 throughout, a beat is a quarter note; no time signature is drawn

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
	// localStorage key of the saved draft (saveToStorage). Version-1 drafts, whose pitches have no octave, still
	// load: parsePitch reads them as octave 4.
	const STORAGE_KEY = "notar-composition-v1";

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
		clearBtn: document.getElementById("clearBtn"),
		loopBtn: document.getElementById("loopBtn"),
		exportBtn: document.getElementById("exportBtn"),
		importBtn: document.getElementById("importBtn"),
		importInput: document.getElementById("importInput"),
		piano: document.getElementById("piano"),
		keyboardFrame: document.getElementById("keyboardFrame"),
		restBtn: document.getElementById("restBtn"),
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

	// notes: the composition (see the header). selectedDuration: the length new notes get. volume: the master gain,
	// 0–1. bpm: quarter-note beats per minute. octave: the one the computer keyboard plays, from OCTAVES.
	// playbackToken: bumped by stopPlayback; a run that sees it change has been cancelled. audioContext and
	// masterGain are created on the first Play (ensureAudio).
	const state = {
		notes: [],
		selectedDuration: 4,
		volume: 0.35,
		bpm: 96,
		loop: false,
		octave: DEFAULT_OCTAVE,
		playing: false,
		playbackToken: 0,
		audioContext: null,
		masterGain: null,
	};

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
		const midi = pitchMidi(pitch);
		if (midi < LOWEST_MIDI || midi > HIGHEST_MIDI) {
			return null;
		}
		return pitch;
	}

	// Three spellings of a pitch. pitchId is the stored form and each key's data-pitch (ASCII # and b); pitchLabel
	// is for the status line (♯ ♭); pitchSpoken is for accessible names and staff tooltips ("C sharp 4").
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

	function pitchLabel(pitch) {
		if (pitch.rest) {
			return "rest";
		}
		const accidental = pitch.alter === 1 ? "♯" : pitch.alter === -1 ? "♭" : "";
		return `${STEPS[pitch.step]}${accidental}${pitch.octave}`;
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

	// The canonical { pitch, duration } of a stored or imported note, or null if its pitch can't be read. An unknown
	// duration becomes a quarter note.
	function normalizeNote(note) {
		if (!note || typeof note !== "object") {
			return null;
		}
		const pitch = parsePitch(note.pitch);
		if (!pitch) {
			return null;
		}
		const duration = VALID_DURATIONS.includes(Number(note.duration)) ? Number(note.duration) : 4;
		return { pitch: pitchId(pitch), duration };
	}

	function normalizeNotes(list) {
		return list.map(normalizeNote).filter(Boolean);
	}

	// ── Utilities ────────────────────────────────────────────────────────────
	function setStatus(message, isError) {
		ui.status.textContent = message;
		ui.status.classList.toggle("error", Boolean(isError));
	}

	function durationLabel(value) {
		const match = DURATIONS.find((entry) => entry.value === value);
		return match ? match.label : `1/${value}`;
	}

	// Seconds a 1/denominator note lasts at the current tempo.
	function noteDurationSeconds(denominator) {
		const beatSeconds = 60 / state.bpm;
		return beatSeconds * (BEATS_PER_MEASURE / denominator);
	}

	// Staff width of a 1/denominator note: proportional to its beats, so bar lines fall every MEASURE_WIDTH.
	function noteWidth(denominator) {
		return (MEASURE_WIDTH / BEATS_PER_MEASURE) * (BEATS_PER_MEASURE / denominator);
	}

	// For pitch ids in attribute selectors. Without CSS.escape, the fallback escapes "#", the one character in a
	// pitch id that is not a letter or digit.
	function cssEscape(value) {
		return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[#]/g, "\\$&");
	}

	// ── Audio ────────────────────────────────────────────────────────────────
	/**
	 * Creates the AudioContext and master gain on first use, resumes the context and sets the volume. Browsers, iOS
	 * Safari above all, start audio only from a user gesture: startPlayback calls this first thing, so the context
	 * is created and resume() called synchronously inside the click or keypress that pressed Play.
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
	 * startTime is AudioContext time and both arguments are in seconds; a rest schedules nothing. The envelope rises
	 * over 20 ms, holds, and falls over the last 80 ms; a note too short for that rises over its first fifth and
	 * falls over its last quarter.
	 */
	function scheduleNote(pitchString, startTime, durationSeconds) {
		const pitch = parsePitch(pitchString);
		if (!pitch || pitch.rest) {
			return;
		}

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
		const peak = Math.max(state.volume * tilt, 0.0002);

		osc.type = "triangle";
		osc.frequency.setValueAtTime(frequency, startTime);
		gain.gain.setValueAtTime(0.0001, startTime);
		gain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
		gain.gain.setValueAtTime(peak, Math.max(startTime + attack, end - release));
		gain.gain.exponentialRampToValueAtTime(0.0001, end);

		osc.connect(gain);
		gain.connect(state.masterGain);
		osc.start(startTime);
		osc.stop(end + 0.05); // once the envelope has faded out
	}

	// ── Persistence ──────────────────────────────────────────────────────────
	// Called after every change, so a reload (pwa.js applying an update) loses nothing. Export keeps less: only the
	// notes and tempo (exportComposition).
	function saveToStorage() {
		const payload = {
			bpm: state.bpm,
			notes: state.notes,
			selectedDuration: state.selectedDuration,
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

	// Restores the draft into state and the controls it sets; init() brings the rest of the UI in line. Each field is
	// checked on its own, so a partial or older draft loads what it can.
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
			if (payload.bpm) {
				state.bpm = payload.bpm;
				ui.bpm.value = String(state.bpm);
				ui.bpmLabel.textContent = `${state.bpm} BPM`;
			}
			if (payload.selectedDuration) {
				state.selectedDuration = payload.selectedDuration;
				const durationIndex = DURATIONS.findIndex((entry) => entry.value === state.selectedDuration);
				if (durationIndex >= 0) {
					ui.duration.value = String(durationIndex);
					ui.durationLabel.textContent = DURATIONS[durationIndex].label;
				}
			}
			if (typeof payload.volume === "number") {
				state.volume = payload.volume;
				ui.volume.value = String(state.volume);
				ui.volumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
			}
			if (typeof payload.loop === "boolean") {
				state.loop = payload.loop;
				ui.loopBtn.setAttribute("aria-pressed", state.loop ? "true" : "false");
			}
			if (OCTAVES.includes(payload.octave)) {
				state.octave = payload.octave;
			}
		} catch (error) {
			// Ignore corrupt drafts.
		}
	}

	// ── Keyboard (piano) ─────────────────────────────────────────────────────
	// The short press animation (.struck) for a note entered by tap or computer key; the Rest button stands in for
	// a rest. With reduced motion the class comes straight off again.
	function flashPianoKey(pitchString) {
		const button = pitchString === "rest"
			? ui.restBtn
			: ui.piano.querySelector(`[data-pitch="${cssEscape(pitchString)}"]`);
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
		button.addEventListener("click", () => {
			if (OCTAVES.includes(pitch.octave) && pitch.octave !== state.octave) {
				setOctave(pitch.octave, { scroll: false, announce: false });
			}
			addNote(id);
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
			left: Math.max(0, Math.min(maxScroll, target)),
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
		const next = Math.max(OCTAVES[0], Math.min(OCTAVES[OCTAVES.length - 1], octave));
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
		ui.keyboardFrame.classList.toggle("scrollable", max > 2);
	}

	// ── Staff drawing ────────────────────────────────────────────────────────
	// The line above the staff: notes (rests count), beats (quarter notes) and seconds at the current tempo.
	function updateMeta() {
		const beatTotal = state.notes.reduce((sum, note) => sum + BEATS_PER_MEASURE / note.duration, 0);
		const seconds = state.notes.reduce((sum, note) => sum + noteDurationSeconds(note.duration), 0);
		ui.noteCount.textContent = `${state.notes.length} notes · ${beatTotal.toFixed(1)} beats · ${seconds.toFixed(1)} s`;
	}

	function createSvgEl(name, attrs) {
		const el = document.createElementNS("http://www.w3.org/2000/svg", name);
		for (const [key, value] of Object.entries(attrs)) {
			el.setAttribute(key, String(value));
		}
		return el;
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

	function drawRest(group, duration, centerX) {
		// Whole rest hangs from the 4th treble line; half rest sits on the middle line.
		if (duration === 1) {
			group.appendChild(createSvgEl("rect", { class: "note-head rest", x: centerX - 7, y: TREBLE_TOP + SPACE, width: 14, height: LINE_GAP }));
			return;
		}
		if (duration === 2) {
			group.appendChild(createSvgEl("rect", { class: "note-head rest", x: centerX - 7, y: TREBLE_TOP + SPACE * 2 - LINE_GAP, width: 14, height: LINE_GAP }));
			return;
		}
		// Quarter and eighth rests: a stylised block on the middle line (the Rest button's glyph), the eighth with a
		// dot above it.
		const restY = TREBLE_TOP + SPACE * 2;
		group.appendChild(createSvgEl("rect", {
			class: "note-head rest",
			x: centerX - 10,
			y: restY - 4,
			width: 20,
			height: 8,
			rx: 2,
		}));
		if (duration === 8) {
			group.appendChild(createSvgEl("circle", { class: "rest-dot", cx: centerX, cy: restY - 9, r: 2 }));
		}
	}

	// One note: ledger lines, accidental, head, stem and flag. accidental is the alter to print (a natural is 0), or
	// null for none; drawStaff decides it from the measure.
	function drawNote(group, pitch, duration, centerX, accidental) {
		const place = staffPlacement(pitch);
		const y = place.y;

		// Ledger lines: every line position between the staff and the note.
		for (let p = -2; p >= place.position; p -= 2) {
			const ly = place.bottom - p * LINE_GAP;
			group.appendChild(createSvgEl("line", { class: "ledger-line", x1: centerX - 12, y1: ly, x2: centerX + 12, y2: ly }));
		}
		for (let p = 10; p <= place.position; p += 2) {
			const ly = place.bottom - p * LINE_GAP;
			group.appendChild(createSvgEl("line", { class: "ledger-line", x1: centerX - 12, y1: ly, x2: centerX + 12, y2: ly }));
		}

		if (accidental !== null) {
			drawAccidental(group, accidental, centerX - 17, y);
		}

		// Whole and half notes have open heads. A head is an ellipse tilted 20°, as engraved; a whole note has no stem.
		const open = duration <= 2;
		group.appendChild(createSvgEl("ellipse", {
			class: open ? "note-head open" : "note-head",
			cx: centerX,
			cy: y,
			rx: 7.5,
			ry: 5.5,
			transform: `rotate(-20 ${centerX} ${y})`,
		}));

		if (duration === 1) {
			return;
		}

		// Stem down from the middle line up, up below it; reach at least the middle line.
		const stemUp = place.position < 4;
		const middleY = place.bottom - 4 * LINE_GAP;
		const stemX = stemUp ? centerX + 6.8 : centerX - 6.8;
		const stemY1 = stemUp ? y - 2 : y + 2;
		let stemY2 = stemUp ? y - 36 : y + 36; // three staff spaces
		stemY2 = stemUp ? Math.min(stemY2, middleY) : Math.max(stemY2, middleY);
		group.appendChild(createSvgEl("line", { class: "note-stem", x1: stemX, y1: stemY1, x2: stemX, y2: stemY2 }));

		if (duration === 8) {
			const d = stemUp
				? `M${stemX} ${stemY2}c0.5 7 9 9 8 20`
				: `M${stemX} ${stemY2}c0.5 -7 9 -9 8 -20`;
			group.appendChild(createSvgEl("path", { class: "note-flag", d }));
		}
	}

	/**
	 * Rebuilds the whole SVG from state.notes: paper, both staves, brace, clefs and bar lines, then one
	 * <g class="note-group" data-index="i"> per note (playback highlights it by that index) and the #playhead line.
	 * Ends scrolled to the end, where the newest note is.
	 */
	function drawStaff() {
		const beatTotal = state.notes.reduce((sum, note) => sum + BEATS_PER_MEASURE / note.duration, 0);
		// Fill the visible width with empty measures so wide screens show a full
		// staff instead of a short one floating in the middle.
		const visibleMeasures = Math.floor((ui.staffScroll.clientWidth - STAFF_LEFT - 24) / MEASURE_WIDTH);
		const measureCount = Math.max(2, visibleMeasures, Math.ceil(Math.max(beatTotal, BEATS_PER_MEASURE) / BEATS_PER_MEASURE));
		const staffEnd = STAFF_LEFT + measureCount * MEASURE_WIDTH;
		const width = Math.max(staffEnd + 24, ui.staffScroll.clientWidth);
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

		for (let measure = 0; measure <= measureCount; measure += 1) {
			const x = STAFF_LEFT + measure * MEASURE_WIDTH;
			ui.staffSvg.appendChild(createSvgEl("line", {
				class: measure === measureCount ? "bar-line final" : "bar-line",
				x1: x,
				y1: TREBLE_TOP,
				x2: x,
				y2: BASS_BOTTOM,
			}));
		}

		let cursorX = STAFF_LEFT;
		let beat = 0;
		let currentMeasure = -1;
		let measureAccidentals = new Map();
		state.notes.forEach((note, index) => {
			const group = createSvgEl("g", { class: "note-group", "data-index": index });
			const widthPx = noteWidth(note.duration);
			const centerX = cursorX + widthPx / 2;
			const pitch = parsePitch(note.pitch) || { rest: true };

			// A note belongs to the measure it starts in; one that runs past a bar line is not split or tied.
			const measure = Math.floor(beat / BEATS_PER_MEASURE + 1e-9);
			if (measure !== currentMeasure) {
				currentMeasure = measure;
				measureAccidentals = new Map();
			}

			if (pitch.rest) {
				drawRest(group, note.duration, centerX);
			} else {
				// Accidentals hold for the rest of the measure at that staff position.
				// With no key signature every position starts the measure natural, so a sign is printed whenever a
				// note's alter differs from the last one there: a sharp or flat, or a natural that cancels one.
				const key = `${pitch.octave}:${pitch.step}`;
				const current = measureAccidentals.has(key) ? measureAccidentals.get(key) : 0;
				const accidental = pitch.alter !== current ? pitch.alter : null;
				measureAccidentals.set(key, pitch.alter);
				drawNote(group, pitch, note.duration, centerX, accidental);
			}

			const title = createSvgEl("title", {});
			title.textContent = `${pitchSpoken(pitch)}, ${durationLabel(note.duration)}`;
			group.appendChild(title);
			ui.staffSvg.appendChild(group);
			cursorX += widthPx;
			beat += BEATS_PER_MEASURE / note.duration;
		});

		const playhead = createSvgEl("line", {
			id: "playhead",
			class: "playhead",
			x1: STAFF_LEFT,
			y1: TREBLE_TOP - 30,
			x2: STAFF_LEFT,
			y2: BASS_BOTTOM + 30,
			opacity: 0,
		});
		ui.staffSvg.appendChild(playhead);

		ui.staffScroll.scrollLeft = ui.staffScroll.scrollWidth;
		updateMeta();
	}

	function setPlayhead(x, visible) {
		const playhead = ui.staffSvg.querySelector("#playhead");
		if (!playhead) {
			return;
		}
		playhead.setAttribute("x1", x);
		playhead.setAttribute("x2", x);
		playhead.setAttribute("opacity", visible ? 0.85 : 0);
	}

	function clearActiveNotes() {
		ui.staffSvg.querySelectorAll(".note-group.active").forEach((node) => {
			node.classList.remove("active");
		});
		ui.piano.querySelectorAll(".key.sounding").forEach((node) => node.classList.remove("sounding"));
	}

	// ── Editing ──────────────────────────────────────────────────────────────
	// Appends "rest" or a pitch id at the selected length; a pitch that can't be read is ignored.
	function addNote(pitchString) {
		const pitch = parsePitch(pitchString);
		if (!pitch) {
			return;
		}
		state.notes.push({ pitch: pitchId(pitch), duration: state.selectedDuration });
		drawStaff();
		saveToStorage();
		flashPianoKey(pitchId(pitch));
		setStatus(`Added ${pitchLabel(pitch)} (${durationLabel(state.selectedDuration)}).`);
	}

	function undoNote() {
		if (!state.notes.length) {
			return;
		}
		const removed = state.notes.pop();
		drawStaff();
		saveToStorage();
		setStatus(`Removed ${pitchLabel(parsePitch(removed.pitch) || { rest: true })}.`);
	}

	function clearNotes() {
		if (!state.notes.length) {
			return;
		}
		stopPlayback();
		state.notes = [];
		drawStaff();
		saveToStorage();
		setStatus("Composition cleared.");
	}

	// ── Playback ─────────────────────────────────────────────────────────────
	/**
	 * Ends a run: bumping playbackToken makes its pending highlight timers and its loop return. The audio graph is
	 * left alone, so voices already scheduled for the current pass still sound. startPlayback calls it too, to clear
	 * any earlier run. Tells pwa.js (notar:playback) that playback has stopped.
	 */
	function stopPlayback() {
		state.playbackToken += 1;
		state.playing = false;
		document.dispatchEvent(new CustomEvent("notar:playback", { detail: { playing: false } }));
		ui.playBtn.disabled = false;
		ui.stopBtn.disabled = true;
		clearActiveNotes();
		setPlayhead(STAFF_LEFT, false);
	}

	/**
	 * Plays state.notes from the start. Each pass schedules all its notes on the audio clock at once (scheduleNote);
	 * the staff and key highlights follow on main-thread timers, which may fire a little late but never move the
	 * sound. Loop is read once, at Play; notes added while playing join the next pass.
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

		async function runOnce() {
			let cursorX = STAFF_LEFT;
			let audioTime = state.audioContext.currentTime + 0.08; // a little ahead, so no note starts in the past

			for (let index = 0; index < state.notes.length; index += 1) {
				if (token !== state.playbackToken) {
					return;
				}

				const note = state.notes[index];
				const durationSeconds = noteDurationSeconds(note.duration);
				const widthPx = noteWidth(note.duration);
				const centerX = cursorX + widthPx / 2;

				scheduleNote(note.pitch, audioTime, durationSeconds);

				const noteGroup = ui.staffSvg.querySelector(`.note-group[data-index="${index}"]`);
				const key = note.pitch === "rest" ? null : ui.piano.querySelector(`[data-pitch="${cssEscape(note.pitch)}"]`);
				const highlightAt = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);

				window.setTimeout(() => {
					if (token !== state.playbackToken) {
						return;
					}
					clearActiveNotes();
					if (noteGroup) {
						noteGroup.classList.add("active");
					}
					if (key) {
						key.classList.add("sounding");
					}
					setPlayhead(centerX, true);
					// Keep the sounding note about a third of the way into the view.
					ui.staffScroll.scrollLeft = Math.max(0, centerX - ui.staffScroll.clientWidth * 0.35);
				}, highlightAt);

				cursorX += widthPx;
				audioTime += durationSeconds;
			}

			// Wait out the pass. A loop's next pass is scheduled only then, from the current audio time, so a gap of
			// at least 120 ms (this 40 ms plus the 80 ms lead) separates the passes.
			const totalMs = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);
			await new Promise((resolve) => window.setTimeout(resolve, totalMs + 40));

			if (token !== state.playbackToken) {
				return;
			}

			if (loop) {
				await runOnce();
				return;
			}

			stopPlayback();
			setStatus("Playback finished.");
		}

		setStatus("Playing…");
		runOnce();
	}

	// ── Import / export ──────────────────────────────────────────────────────
	// Downloads { version: 2, bpm, notes } as notar_<date>.json, the file importComposition reads. Version 2 pitches
	// carry an octave; version-1 files have none and import as octave 4.
	function exportComposition() {
		const payload = {
			version: 2,
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

	// Replaces the composition (and the tempo, if the file has one) with the file's notes. Notes that can't be read
	// are skipped and counted; a file with notes but none readable is refused and changes nothing.
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
				state.notes = notes;
				if (payload.bpm) {
					state.bpm = payload.bpm;
					ui.bpm.value = String(state.bpm);
					ui.bpmLabel.textContent = `${state.bpm} BPM`;
				}
				drawStaff();
				saveToStorage();
				const skipped = payload.notes.length - notes.length;
				setStatus(`Imported ${notes.length} notes${skipped ? ` (skipped ${skipped} outside C2–C6)` : ""}.`);
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

	function bindControls() {
		if (ui.durationPicker) {
			ui.durationPicker.addEventListener("change", (event) => {
				if (event.target.name !== "durationPick") {
					return;
				}
				ui.duration.value = event.target.value;
				ui.duration.dispatchEvent(new Event("input", { bubbles: true }));
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
			const index = Number(ui.duration.value);
			state.selectedDuration = DURATIONS[index].value;
			ui.durationLabel.textContent = DURATIONS[index].label;
			syncDurationPicker();
			saveToStorage();
		});

		ui.bpm.addEventListener("input", () => {
			state.bpm = Number(ui.bpm.value);
			ui.bpmLabel.textContent = `${state.bpm} BPM`;
			updateMeta();
			saveToStorage();
		});

		ui.restBtn.addEventListener("click", () => addNote("rest"));
		ui.octaveDownBtn.addEventListener("click", () => setOctave(state.octave - 1, { scroll: true, announce: true }));
		ui.octaveUpBtn.addEventListener("click", () => setOctave(state.octave + 1, { scroll: true, announce: true }));
		ui.piano.addEventListener("scroll", updateKeyboardFades, { passive: true });
		// The staff fills the visible width, so a resize redraws it, at most once a frame. Not while playing: a
		// redraw replaces the note groups that the pending highlight timers hold.
		let resizeFrame = 0;
		window.addEventListener("resize", () => {
			updateKeyboardFades();
			window.cancelAnimationFrame(resizeFrame);
			resizeFrame = window.requestAnimationFrame(() => {
				if (!state.playing) {
					drawStaff();
				}
			});
		});

		ui.playBtn.addEventListener("click", startPlayback);
		ui.stopBtn.addEventListener("click", stopPlayback);
		ui.undoBtn.addEventListener("click", undoNote);
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

		// Shortcuts (listed in index.html's footer). None while a field or slider has focus (a length radio doesn't
		// count), and none with Ctrl, Cmd or Alt, so the browser's own shortcuts keep working.
		window.addEventListener("keydown", (event) => {
			if (event.target.matches("input:not([type=radio]), textarea, select")) {
				return;
			}
			if (event.ctrlKey || event.metaKey || event.altKey) {
				return;
			}
			const key = event.key.toLowerCase();
			const mapped = KEY_MAP[key];
			if (mapped) {
				event.preventDefault();
				if (event.repeat) {
					return; // a held key enters one note
				}
				const octave = state.octave + mapped.shift;
				addNote(pitchId({ step: mapped.step, alter: mapped.alter, octave }));
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
				addNote("rest");
				return;
			}
			if (key === "z" || key === "x") {
				event.preventDefault();
				setOctave(state.octave + (key === "z" ? -1 : 1), { scroll: true, announce: true });
				return;
			}
			if (event.key === "Backspace") {
				event.preventDefault();
				undoNote();
				return;
			}
			if (event.key === "Enter") {
				// On a focused button or link Enter activates it as usual; anywhere else it plays.
				if (event.target.closest && event.target.closest("button, a")) {
					return;
				}
				event.preventDefault();
				startPlayback();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				stopPlayback();
			}
		});
	}

	// ── Start-up ─────────────────────────────────────────────────────────────
	// The keys are built before setOctave marks one, and the draft is loaded before the controls are set from state.
	function init() {
		buildPiano();
		bindControls();
		loadFromStorage();

		const durationIndex = DURATIONS.findIndex((entry) => entry.value === state.selectedDuration);
		ui.duration.value = String(durationIndex >= 0 ? durationIndex : 2); // 2: the quarter note
		ui.durationLabel.textContent = durationLabel(state.selectedDuration);
		syncDurationPicker();
		ui.volume.value = String(state.volume);
		ui.volumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
		ui.bpmLabel.textContent = `${state.bpm} BPM`;
		ui.stopBtn.disabled = true;
		setOctave(state.octave, { scroll: false, announce: false });
		scrollToOctave(state.octave, false);
		updateKeyboardFades();
		drawStaff();
		setStatus(state.notes.length
			? `Restored ${state.notes.length} notes from your last session.`
			: "Tap the keys, or type A–K (sharps W E T Y U, octave Z/X), to compose.");
	}

	// Test hook: pure helpers only, no state mutation. isPlaying is read by pwa.js (no update while playing).
	window.Notar = { isPlaying: () => state.playing, parsePitch, pitchId, pitchMidi, pitchFrequency, staffPlacement, normalizeNote, range: { low: "C2", high: "C6" } };

	init();
})();
