(function () {
	"use strict";

	// ── Pitch model ──────────────────────────────────────────────────────────
	// Nordic step names (H = B natural). A pitch is stored as a compact string:
	// step + optional accidental (# or b) + octave, e.g. "C4", "F#3", "Eb5".
	// Scientific octave numbering: C4 is middle C, A4 = 440 Hz.
	const STEPS = ["C", "D", "E", "F", "G", "A", "H"];
	const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, H: 11 };
	const OCTAVES = [2, 3, 4, 5];
	const LOWEST_MIDI = 36; // C2
	const HIGHEST_MIDI = 84; // C6
	const DEFAULT_OCTAVE = 4;
	// Black keys sit after these white-key indices (C, D, F, G, A).
	const BLACK_AFTER = [0, 1, 3, 4, 5];

	const DURATIONS = [
		{ label: "1/1", value: 1 },
		{ label: "1/2", value: 2 },
		{ label: "1/4", value: 4 },
		{ label: "1/8", value: 8 },
	];
	const VALID_DURATIONS = DURATIONS.map((entry) => entry.value);

	// ── Staff geometry (grand staff) ─────────────────────────────────────────
	const MEASURE_WIDTH = 240;
	const STAFF_LEFT = 84;
	const LINE_GAP = 6; // half a staff space: one diatonic step
	const SPACE = LINE_GAP * 2;
	const TREBLE_TOP = 54; // F5 line
	const TREBLE_BOTTOM = TREBLE_TOP + SPACE * 4; // E4 line
	const BASS_TOP = TREBLE_BOTTOM + 66; // A3 line
	const BASS_BOTTOM = BASS_TOP + SPACE * 4; // G2 line
	const STAFF_HEIGHT = BASS_BOTTOM + 60;
	const BEATS_PER_MEASURE = 4;

	// Computer keyboard: one piano octave laid out like a DAW (home row = white
	// keys, row above = sharps). K reaches the C of the next octave.
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
	const WHITE_HINTS = ["A", "S", "D", "F", "G", "H", "J"];
	const BLACK_HINTS = { 0: "W", 1: "E", 3: "T", 4: "Y", 5: "U" };

	const STORAGE_KEY = "notar-composition-v1";

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

	const reduceMotion = window.matchMedia
		? window.matchMedia("(prefers-reduced-motion: reduce)")
		: { matches: false };

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

	function pitchId(pitch) {
		if (pitch.rest) {
			return "rest";
		}
		const accidental = pitch.alter === 1 ? "#" : pitch.alter === -1 ? "b" : "";
		return `${STEPS[pitch.step]}${accidental}${pitch.octave}`;
	}

	function pitchMidi(pitch) {
		return 12 * (pitch.octave + 1) + STEP_SEMITONES[STEPS[pitch.step]] + pitch.alter;
	}

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

	const D_E4 = 4 * 7 + 2;
	const D_G2 = 2 * 7 + 4;
	const D_C4 = 4 * 7;

	// Middle C and up are written on the treble staff, below on the bass staff.
	function staffPlacement(pitch) {
		const d = diatonic(pitch);
		if (d >= D_C4) {
			const position = d - D_E4; // 0 = bottom line, 8 = top line
			return { staff: "treble", position, y: TREBLE_BOTTOM - position * LINE_GAP, bottom: TREBLE_BOTTOM };
		}
		const position = d - D_G2;
		return { staff: "bass", position, y: BASS_BOTTOM - position * LINE_GAP, bottom: BASS_BOTTOM };
	}

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

	function noteDurationSeconds(denominator) {
		const beatSeconds = 60 / state.bpm;
		return beatSeconds * (BEATS_PER_MEASURE / denominator);
	}

	function noteWidth(denominator) {
		return (MEASURE_WIDTH / BEATS_PER_MEASURE) * (BEATS_PER_MEASURE / denominator);
	}

	function cssEscape(value) {
		return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[#]/g, "\\$&");
	}

	// ── Audio ────────────────────────────────────────────────────────────────
	async function ensureAudio() {
		if (!state.audioContext) {
			state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
			state.masterGain = state.audioContext.createGain();
			state.masterGain.gain.value = state.volume;
			state.masterGain.connect(state.audioContext.destination);
		}
		if (state.audioContext.state === "suspended") {
			await state.audioContext.resume();
		}
		state.masterGain.gain.setValueAtTime(state.volume, state.audioContext.currentTime);
	}

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
		// octave brighter. Scales between ~1.25 at C2 and ~0.85 at C6.
		const tilt = Math.min(1.3, Math.max(0.8, Math.pow(261.63 / frequency, 0.15)));
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
		osc.stop(end + 0.05);
	}

	// ── Persistence ──────────────────────────────────────────────────────────
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
				black.style.setProperty("--slot", String(step + 1));
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

	function updateKeyboardFades() {
		const frame = ui.piano;
		const max = frame.scrollWidth - frame.clientWidth;
		ui.keyboardFrame.classList.toggle("fade-start", frame.scrollLeft > 2);
		ui.keyboardFrame.classList.toggle("fade-end", frame.scrollLeft < max - 2);
		ui.keyboardFrame.classList.toggle("scrollable", max > 2);
	}

	// ── Staff drawing ────────────────────────────────────────────────────────
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
		let stemY2 = stemUp ? y - 36 : y + 36;
		stemY2 = stemUp ? Math.min(stemY2, middleY) : Math.max(stemY2, middleY);
		group.appendChild(createSvgEl("line", { class: "note-stem", x1: stemX, y1: stemY1, x2: stemX, y2: stemY2 }));

		if (duration === 8) {
			const d = stemUp
				? `M${stemX} ${stemY2}c0.5 7 9 9 8 20`
				: `M${stemX} ${stemY2}c0.5 -7 9 -9 8 -20`;
			group.appendChild(createSvgEl("path", { class: "note-flag", d }));
		}
	}

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

			const measure = Math.floor(beat / BEATS_PER_MEASURE + 1e-9);
			if (measure !== currentMeasure) {
				currentMeasure = measure;
				measureAccidentals = new Map();
			}

			if (pitch.rest) {
				drawRest(group, note.duration, centerX);
			} else {
				// Accidentals hold for the rest of the measure at that staff position.
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
	function stopPlayback() {
		state.playbackToken += 1;
		state.playing = false;
		ui.playBtn.disabled = false;
		ui.stopBtn.disabled = true;
		clearActiveNotes();
		setPlayhead(STAFF_LEFT, false);
	}

	async function startPlayback() {
		if (!state.notes.length) {
			setStatus("Add some notes before playing.", true);
			return;
		}

		await ensureAudio();
		stopPlayback();
		state.playing = true;
		ui.playBtn.disabled = true;
		ui.stopBtn.disabled = false;

		const token = state.playbackToken;
		const loop = state.loop;

		async function runOnce() {
			let cursorX = STAFF_LEFT;
			let audioTime = state.audioContext.currentTime + 0.08;

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
					ui.staffScroll.scrollLeft = Math.max(0, centerX - ui.staffScroll.clientWidth * 0.35);
				}, highlightAt);

				cursorX += widthPx;
				audioTime += durationSeconds;
			}

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
		window.setTimeout(() => URL.revokeObjectURL(url), 0);
		setStatus("Composition exported.");
	}

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
			ui.importInput.value = "";
		});

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
					return;
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

	function init() {
		buildPiano();
		bindControls();
		loadFromStorage();

		const durationIndex = DURATIONS.findIndex((entry) => entry.value === state.selectedDuration);
		ui.duration.value = String(durationIndex >= 0 ? durationIndex : 2);
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

	// Test hook: pure helpers only, no state mutation.
	window.Notar = { parsePitch, pitchId, pitchMidi, pitchFrequency, staffPlacement, normalizeNote, range: { low: "C2", high: "C6" } };

	init();
})();
