(function () {
	"use strict";

	const PITCHES = ["C", "D", "E", "F", "G", "A", "H"];
	const FREQUENCIES = {
		C: 261.63,
		D: 293.66,
		E: 329.63,
		F: 349.23,
		G: 392.0,
		A: 440.0,
		H: 493.88,
		rest: 0,
	};

	// Vertical position on the staff (px). E4 sits on the bottom line.
	const PITCH_Y = {
		C: 126,
		D: 123,
		E: 120,
		F: 114,
		G: 108,
		A: 102,
		H: 96,
		rest: 114,
	};

	const DURATIONS = [
		{ label: "1/1", value: 1 },
		{ label: "1/2", value: 2 },
		{ label: "1/4", value: 4 },
		{ label: "1/8", value: 8 },
	];

	const MEASURE_WIDTH = 180;
	const STAFF_LEFT = 72;
	const STAFF_TOP = 72;
	const LINE_GAP = 6;
	const BEATS_PER_MEASURE = 4;

	const KEY_MAP = {
		a: "C",
		s: "D",
		d: "E",
		f: "F",
		g: "G",
		h: "A",
		j: "H",
		" ": "rest",
	};

	const KEY_HINTS = {
		C: "A",
		D: "S",
		E: "D",
		F: "F",
		G: "G",
		A: "H",
		H: "J",
		rest: "space",
	};

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
		staffSvg: document.getElementById("staffSvg"),
		staffScroll: document.getElementById("staffScroll"),
		noteCount: document.getElementById("noteCount"),
		status: document.getElementById("status"),
	};

	const state = {
		notes: [],
		selectedDuration: 4,
		volume: 0.35,
		bpm: 96,
		loop: false,
		playing: false,
		playbackToken: 0,
		audioContext: null,
		masterGain: null,
	};

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

	function scheduleNote(pitch, startTime, durationSeconds) {
		if (pitch === "rest" || !FREQUENCIES[pitch]) {
			return;
		}

		const osc = state.audioContext.createOscillator();
		const gain = state.audioContext.createGain();
		const end = startTime + durationSeconds;
		const attack = Math.min(0.02, durationSeconds * 0.2);
		const release = Math.min(0.08, durationSeconds * 0.25);

		osc.type = "triangle";
		osc.frequency.setValueAtTime(FREQUENCIES[pitch], startTime);
		gain.gain.setValueAtTime(0.0001, startTime);
		gain.gain.exponentialRampToValueAtTime(Math.max(state.volume, 0.0002), startTime + attack);
		gain.gain.setValueAtTime(Math.max(state.volume, 0.0002), Math.max(startTime + attack, end - release));
		gain.gain.exponentialRampToValueAtTime(0.0001, end);

		osc.connect(gain);
		gain.connect(state.masterGain);
		osc.start(startTime);
		osc.stop(end + 0.05);
	}

	function saveToStorage() {
		const payload = {
			bpm: state.bpm,
			notes: state.notes,
			selectedDuration: state.selectedDuration,
			volume: state.volume,
			loop: state.loop,
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
				state.notes = payload.notes;
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
		} catch (error) {
			// Ignore corrupt drafts.
		}
	}

	function flashPianoKey(pitch) {
		const button = ui.piano.querySelector(`[data-pitch="${pitch}"]`);
		if (!button) {
			return;
		}
		button.animate(
			[
				{ transform: "translateY(0)", backgroundColor: "#fff" },
				{ transform: "translateY(2px)", backgroundColor: "#dfe6ff" },
				{ transform: "translateY(0)", backgroundColor: "#fff" },
			],
			{ duration: 160, easing: "ease-out" }
		);
	}

	function buildPiano() {
		const entries = [
			...PITCHES.map((pitch) => ({ pitch, hint: KEY_HINTS[pitch] })),
			{ pitch: "rest", hint: KEY_HINTS.rest },
		];

		ui.piano.innerHTML = "";
		for (const entry of entries) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = entry.pitch === "rest" ? "rest" : "";
			button.dataset.pitch = entry.pitch;
			button.innerHTML = entry.pitch === "rest"
				? `<span class="pitch">&#9837;</span><span class="hint">pause</span>`
				: `<span class="pitch">${entry.pitch}</span><span class="hint">${entry.hint}</span>`;
			button.addEventListener("click", () => addNote(entry.pitch));
			ui.piano.appendChild(button);
		}
	}

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

	function drawStaff() {
		const beatTotal = state.notes.reduce((sum, note) => sum + BEATS_PER_MEASURE / note.duration, 0);
		const measureCount = Math.max(2, Math.ceil(Math.max(beatTotal, BEATS_PER_MEASURE) / BEATS_PER_MEASURE));
		const width = STAFF_LEFT + measureCount * MEASURE_WIDTH + 48;
		const height = 220;

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
		pattern.appendChild(createSvgEl("path", {
			d: "M12 0L0 12",
			stroke: "#f1efe4",
			"stroke-width": 0.6,
		}));
		defs.appendChild(pattern);
		ui.staffSvg.appendChild(defs);

		ui.staffSvg.appendChild(createSvgEl("rect", {
			x: 0,
			y: 0,
			width,
			height,
			fill: "url(#staffPaper)",
		}));

		const staffLines = createSvgEl("g", { class: "staff-lines" });
		for (let i = 0; i < 5; i += 1) {
			const y = STAFF_TOP + i * LINE_GAP * 2;
			staffLines.appendChild(createSvgEl("line", {
				class: "staff-line",
				x1: STAFF_LEFT,
				y1: y,
				x2: width - 24,
				y2: y,
			}));
		}
		ui.staffSvg.appendChild(staffLines);

		const clef = createSvgEl("image", {
			href: "assets/g-clef.svg",
			x: 18,
			y: STAFF_TOP - 18,
			width: 34,
			height: 58,
		});
		ui.staffSvg.appendChild(clef);

		for (let measure = 0; measure <= measureCount; measure += 1) {
			const x = STAFF_LEFT + measure * MEASURE_WIDTH;
			ui.staffSvg.appendChild(createSvgEl("line", {
				class: "bar-line",
				x1: x,
				y1: STAFF_TOP - 8,
				x2: x,
				y2: STAFF_TOP + LINE_GAP * 8 + 8,
			}));
		}

		let cursorX = STAFF_LEFT;
		state.notes.forEach((note, index) => {
			const group = createSvgEl("g", {
				class: "note-group",
				"data-index": index,
			});
			const widthPx = noteWidth(note.duration);
			const centerX = cursorX + widthPx / 2;
			const y = PITCH_Y[note.pitch];

			if (note.pitch === "rest") {
				const restY = STAFF_TOP + LINE_GAP * 4;
				group.appendChild(createSvgEl("rect", {
					class: "note-head rest",
					x: centerX - 10,
					y: restY - 4,
					width: 20,
					height: 8,
					rx: 2,
				}));
			} else {
				if (y > STAFF_TOP + LINE_GAP * 8) {
					group.appendChild(createSvgEl("line", {
						class: "ledger-line",
						x1: centerX - 12,
						y1: y,
						x2: centerX + 12,
						y2: y,
					}));
				}
				if (y === 123) {
					group.appendChild(createSvgEl("line", {
						class: "ledger-line",
						x1: centerX - 10,
						y1: 123,
						x2: centerX + 10,
						y2: 123,
					}));
				}

				group.appendChild(createSvgEl("ellipse", {
					class: "note-head",
					cx: centerX,
					cy: y,
					rx: 8.5,
					ry: 6,
				}));

				const stemUp = y > STAFF_TOP + LINE_GAP * 2;
				const stemX = stemUp ? centerX + 7.5 : centerX - 7.5;
				const stemY1 = stemUp ? y - 2 : y + 2;
				const stemY2 = stemUp ? y - 34 : y + 34;
				group.appendChild(createSvgEl("line", {
					class: "note-stem",
					x1: stemX,
					y1: stemY1,
					x2: stemX,
					y2: stemY2,
				}));
			}

			ui.staffSvg.appendChild(group);
			cursorX += widthPx;
		});

		const playhead = createSvgEl("line", {
			id: "playhead",
			class: "playhead",
			x1: STAFF_LEFT,
			y1: STAFF_TOP - 18,
			x2: STAFF_LEFT,
			y2: STAFF_TOP + LINE_GAP * 8 + 18,
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
	}

	function addNote(pitch) {
		state.notes.push({
			pitch,
			duration: state.selectedDuration,
		});
		drawStaff();
		saveToStorage();
		flashPianoKey(pitch);
		setStatus(`Added ${pitch === "rest" ? "rest" : pitch} (${durationLabel(state.selectedDuration)}).`);
	}

	function undoNote() {
		if (!state.notes.length) {
			return;
		}
		const removed = state.notes.pop();
		drawStaff();
		saveToStorage();
		setStatus(`Removed ${removed.pitch === "rest" ? "rest" : removed.pitch}.`);
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
				const highlightAt = Math.max(0, (audioTime - state.audioContext.currentTime) * 1000);

				window.setTimeout(() => {
					if (token !== state.playbackToken) {
						return;
					}
					clearActiveNotes();
					if (noteGroup) {
						noteGroup.classList.add("active");
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

	function exportComposition() {
		const payload = {
			version: 1,
			bpm: state.bpm,
			notes: state.notes,
		};
		const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `notar_${new Date().toISOString().slice(0, 10)}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
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
				stopPlayback();
				state.notes = payload.notes.map((note) => ({
					pitch: note.pitch,
					duration: note.duration,
				}));
				if (payload.bpm) {
					state.bpm = payload.bpm;
					ui.bpm.value = String(state.bpm);
					ui.bpmLabel.textContent = `${state.bpm} BPM`;
				}
				drawStaff();
				saveToStorage();
				setStatus(`Imported ${state.notes.length} notes.`);
			} catch (error) {
				setStatus("Could not import that file.", true);
			}
		};
		reader.readAsText(file);
	}

	function bindControls() {
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
			saveToStorage();
		});

		ui.bpm.addEventListener("input", () => {
			state.bpm = Number(ui.bpm.value);
			ui.bpmLabel.textContent = `${state.bpm} BPM`;
			updateMeta();
			saveToStorage();
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
			if (event.target.matches("input, textarea")) {
				return;
			}
			const pitch = KEY_MAP[event.key.toLowerCase()];
			if (pitch) {
				event.preventDefault();
				addNote(pitch);
				return;
			}
			if (event.key === "Backspace") {
				event.preventDefault();
				undoNote();
				return;
			}
			if (event.key === "Enter") {
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
		ui.volume.value = String(state.volume);
		ui.volumeLabel.textContent = `${Math.round(state.volume * 100)}%`;
		ui.bpmLabel.textContent = `${state.bpm} BPM`;
		ui.stopBtn.disabled = true;
		drawStaff();
		setStatus(state.notes.length
			? `Restored ${state.notes.length} notes from your last session.`
			: "Use the piano keys or keyboard shortcuts (A–J, space) to compose.");
	}

	init();
})();