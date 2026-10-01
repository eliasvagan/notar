#!/usr/bin/env node
/*
 * Notar smoke test (puppeteer). No dependencies of its own: it looks for
 * puppeteer in this repo, then in the portfolio checkout this repo is a
 * submodule of (../../node_modules), then at $PUPPETEER_MODULE.
 *
 *   node tests/smoke.cjs
 *
 * Starts a static server on a free port, loads the app at phone, iPad
 * (portrait + landscape) and desktop sizes and exercises the keyboard,
 * shortcuts, chords, the cursor, clicks on the staff, undo/redo,
 * tempo/volume/length, import/export and playback; then the notation:
 * ties across bar lines, beams, and changing an existing note's length;
 * then share links (opened in a new page, tampered with), MIDI (parsed
 * back), SVG and PNG export, print systems and the Export menu; then
 * selection by keyboard, mouse and long-press, the clipboard, playing a
 * selection, the metronome and the instruments.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");

function loadPuppeteer() {
	const candidates = [
		"puppeteer",
		path.join(ROOT, "node_modules", "puppeteer"),
		path.join(ROOT, "..", "..", "node_modules", "puppeteer"),
		process.env.PUPPETEER_MODULE,
	].filter(Boolean);
	for (const candidate of candidates) {
		try {
			return require(candidate);
		} catch (error) {
			// try the next one
		}
	}
	throw new Error("puppeteer not found; set PUPPETEER_MODULE to its path");
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

function serve() {
	const server = http.createServer((req, res) => {
		const urlPath = decodeURIComponent(req.url.split("?")[0]);
		const file = path.join(ROOT, urlPath.endsWith("/") ? urlPath + "index.html" : urlPath);
		if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
		fs.createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const VIEWPORTS = [
	{ name: "phone 390", width: 390, height: 844, touch: true },
	{ name: "iPad portrait 768x1024", width: 768, height: 1024, touch: true },
	{ name: "iPad landscape 1024x768", width: 1024, height: 768, touch: true },
	{ name: "iPad Pro portrait 1024x1366", width: 1024, height: 1366, touch: true },
	{ name: "iPad Pro landscape 1366x1024", width: 1366, height: 1024, touch: true },
	{ name: "desktop 1440", width: 1440, height: 900, touch: false },
];

let passed = 0;
let failed = 0;
async function check(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name}\n       ${error.message}`);
	}
}

async function openPage(browser, base, vp, errors) {
	const page = await browser.newPage();
	page.on("console", (msg) => {
		if (msg.type() === "error") {
			errors.push(msg.text());
		}
	});
	page.on("pageerror", (err) => errors.push(err.message));
	await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.touch, hasTouch: vp.touch });
	// Clear the saved draft and reload, so every page starts from an empty composition (app.js reads it at load).
	await page.goto(base, { waitUntil: "networkidle0" });
	await page.evaluate(() => localStorage.clear());
	await page.reload({ waitUntil: "networkidle0" });
	return page;
}

async function main() {
	const puppeteer = loadPuppeteer();
	const server = await serve();
	const base = `http://127.0.0.1:${server.address().port}/`;
	// The autoplay flag lets headless Chrome start Web Audio without a real user gesture.
	const browser = await puppeteer.launch({ args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"] });

	try {
		// ── Layout at every viewport ────────────────────────────────────────
		for (const vp of VIEWPORTS) {
			console.log(`\n${vp.name}`);
			const errors = [];
			const page = await openPage(browser, base, vp, errors);
			const layout = await page.evaluate(() => {
				const piano = document.getElementById("piano");
				const octaves = [...piano.querySelectorAll(".octave")];
				const whites = [...piano.querySelectorAll(".key.white")];
				const blacks = [...piano.querySelectorAll(".key.black")];
				return {
					labels: octaves.map((o) => o.querySelector(".octave-label").textContent),
					tops: [...new Set(octaves.map((o) => Math.round(o.getBoundingClientRect().top)))],
					whiteCount: whites.length,
					blackCount: blacks.length,
					minWhite: Math.min(...whites.map((k) => k.getBoundingClientRect().width)),
					minBlack: Math.min(...blacks.map((k) => k.getBoundingClientRect().width)),
					scrollable: piano.scrollWidth > piano.clientWidth + 2,
					docOverflow: document.documentElement.scrollWidth - window.innerWidth,
					activeVisible: (() => {
						const a = piano.querySelector(".octave.active").getBoundingClientRect();
						const f = piano.getBoundingClientRect();
						return a.left >= f.left - 1 && a.right <= f.right + 1;
					})(),
					staffAbovePiano: document.getElementById("staffSvg").getBoundingClientRect().bottom <= piano.getBoundingClientRect().top,
				};
			});
			// 29 white keys: four octaves of 7 and the closing C6; 20 black: four octaves of 5.
			await check("keyboard spans C2–C6 in octave groups", () => {
				assert.deepStrictEqual(layout.labels, ["C2", "C3", "C4", "C5", "C6"]);
				assert.strictEqual(layout.whiteCount, 29);
				assert.strictEqual(layout.blackCount, 20);
			});
			await check("keyboard is one row, never wraps", () => assert.strictEqual(layout.tops.length, 1, `rows at ${layout.tops}`));
			await check("keys keep a minimum width (white >= 40px, black >= 25px)", () => {
				assert.ok(layout.minWhite >= 40, `white ${layout.minWhite}`);
				assert.ok(layout.minBlack >= 25, `black ${layout.minBlack}`);
			});
			await check("page has no horizontal overflow", () => assert.ok(layout.docOverflow <= 0, `${layout.docOverflow}px`));
			await check("active octave is fully in view", () => assert.ok(layout.activeVisible));
			await check("staff sits above the keyboard", () => assert.ok(layout.staffAbovePiano));
			if (vp.width === 1440) {
				await check("desktop shows every octave without scrolling", () => assert.ok(!layout.scrollable));
			}
			if (vp.width === 390) {
				await check("phone keyboard scrolls horizontally", () => assert.ok(layout.scrollable));
			}
			await check("no console errors", () => assert.deepStrictEqual(errors, []));
			await page.close();
		}

		// ── Behaviour (desktop) ─────────────────────────────────────────────
		console.log("\nbehaviour");
		const errors = [];
		const page = await openPage(browser, base, VIEWPORTS[VIEWPORTS.length - 1], errors);
		const notes = () => page.evaluate(() => JSON.parse(localStorage.getItem("notar-composition-v1") || "{\"notes\":[]}").notes);
		// Each saved note as one string: its pitches joined by "+" (a chord), or "rest".
		const ids = async () => (await notes()).map((n) => (n.pitches.length ? n.pitches.join("+") : "rest"));
		const cursor = () => page.evaluate(() => window.Notar.cursor());
		// A click on the staff at SVG user coordinates (one unit is one CSS px; see the geometry in app.js), sent as a
		// synthetic event so the point needn't be scrolled into view.
		const clickStaff = (x, y) => page.evaluate((sx, sy) => {
			const svg = document.getElementById("staffSvg");
			const p = new DOMPoint(sx, sy).matrixTransform(svg.getScreenCTM());
			svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: p.x, clientY: p.y }));
		}, x, y);
		// y of a natural pitch on the treble staff: E4 is its bottom line, TREBLE_BOTTOM = 126, a step is 6 units.
		const trebleY = (stepsAboveE4) => 126 - stepsAboveE4 * 6;

		await check("frequencies follow equal temperament across the range", async () => {
			const f = await page.evaluate(() => ["C2", "A2", "C4", "A4", "H4", "C6"].map((p) => window.Notar.pitchFrequency(window.Notar.parsePitch(p))));
			const expected = [65.41, 110, 261.63, 440, 493.88, 1046.5];
			f.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 0.02, `${value} vs ${expected[i]}`));
		});
		await check("out-of-range pitches are rejected", async () => {
			const r = await page.evaluate(() => [window.Notar.parsePitch("H1"), window.Notar.parsePitch("C#6"), window.Notar.parsePitch("C6")]);
			assert.strictEqual(r[0], null);
			assert.strictEqual(r[1], null);
			assert.ok(r[2]);
		});
		await check("staff placement: C4 on treble ledger, H3 on bass, C2 two ledgers below bass", async () => {
			const r = await page.evaluate(() => ["C4", "H3", "C2", "C6"].map((p) => window.Notar.staffPlacement(window.Notar.parsePitch(p))));
			assert.deepStrictEqual(r.map((x) => [x.staff, x.position]), [["treble", -2], ["bass", 9], ["bass", -4], ["treble", 12]]);
		});

		await page.click('[data-pitch="C2"]');
		await page.click('[data-pitch="F#3"]');
		await page.click('[data-pitch="C6"]');
		await check("clicking keys adds notes across octaves", async () => {
			assert.deepStrictEqual(await ids(), ["C2", "F#3", "C6"]);
		});
		await check("C2 draws two ledger lines, F#3 draws a sharp", async () => {
			const r = await page.evaluate(() => ({
				ledgers: document.querySelectorAll('.note-group[data-index="0"] .ledger-line').length,
				sharp: document.querySelectorAll('.note-group[data-index="1"] .accidental').length,
			}));
			assert.strictEqual(r.ledgers, 2);
			assert.strictEqual(r.sharp, 1);
		});

		await check("tapping a key moves the shortcut octave to it", async () => {
			assert.strictEqual(await page.evaluate(() => document.querySelector(".octave.active").dataset.octave), "3");
		});
		await page.click('.octave-tab[data-octave="4"]');
		// Blur the tab: on a focused button Space keeps its native meaning instead of entering a rest.
		await page.evaluate(() => document.activeElement && document.activeElement.blur());
		await page.keyboard.press("a");
		await page.keyboard.press("w");
		await page.keyboard.press("x");
		await page.keyboard.press("j");
		await page.keyboard.press("k");
		await page.keyboard.press("z");
		await page.keyboard.press("z");
		await page.keyboard.press("d");
		await page.keyboard.press(" ");
		await check("shortcuts: A/W/J/K notes, Z/X octave shift, Space rest", async () => {
			assert.deepStrictEqual((await ids()).slice(3), ["C4", "C#4", "H5", "C6", "E3", "rest"]);
		});
		await check("accidental carries through the measure; natural sign restores", async () => {
			// C#4 then C4 in the same measure: the second needs a natural.
			await page.keyboard.press("Backspace");
			await page.keyboard.press("Backspace");
			await page.keyboard.press("Backspace");
			await page.keyboard.press("Backspace");
			// now: C2 F#3 C6 C4 C#4 ; add C#4 (no sign) and C4 (natural)
			await page.keyboard.press("x");
			await page.keyboard.press("w");
			await page.keyboard.press("a");
			const r = await page.evaluate(() => [...document.querySelectorAll(".note-group")].map((g) => g.querySelectorAll(".accidental").length));
			assert.deepStrictEqual(r, [0, 1, 0, 0, 1, 0, 1]);
		});
		await check("Backspace deletes the note before the cursor; Undo and Redo step through it", async () => {
			const before = await ids();
			await page.keyboard.press("Backspace");
			assert.deepStrictEqual(await ids(), before.slice(0, -1));
			await page.click("#undoBtn");
			assert.deepStrictEqual(await ids(), before);
			await page.click("#redoBtn");
			assert.deepStrictEqual(await ids(), before.slice(0, -1));
			await page.keyboard.down("Meta");
			await page.keyboard.press("z");
			await page.keyboard.up("Meta");
			assert.deepStrictEqual(await ids(), before);
		});
		await check("octave switcher updates active octave and buttons", async () => {
			await page.click('.octave-tab[data-octave="2"]');
			const r = await page.evaluate(() => ({
				active: document.querySelector(".octave.active").dataset.octave,
				down: document.getElementById("octaveDownBtn").disabled,
			}));
			assert.deepStrictEqual(r, { active: "2", down: true });
		});
		await check("note length, tempo and volume still work", async () => {
			await page.click('#durationPicker input[value="3"]');
			await page.evaluate(() => {
				const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); };
				set("bpm", "120");
				set("volume", "0.5");
			});
			await page.click('[data-pitch="G2"]');
			const r = await page.evaluate(() => ({
				bpm: document.getElementById("bpmLabel").textContent,
				vol: document.getElementById("volumeLabel").textContent,
				saved: JSON.parse(localStorage.getItem("notar-composition-v1")),
			}));
			assert.strictEqual(r.bpm, "120 BPM");
			assert.strictEqual(r.vol, "50%");
			assert.deepStrictEqual(r.saved.notes[r.saved.notes.length - 1], { pitches: ["G2"], duration: 8 });
		});
		await check("Shift stacks keys into a chord, named above the staff, held on the keyboard", async () => {
			await page.click('.octave-tab[data-octave="4"]');
			await page.evaluate(() => document.activeElement && document.activeElement.blur());
			await page.keyboard.press("2"); // half notes
			await page.keyboard.press("a");
			await page.keyboard.down("Shift");
			await page.keyboard.press("d");
			await page.keyboard.press("g");
			await page.keyboard.up("Shift");
			const r = await page.evaluate(() => ({
				symbol: [...document.querySelectorAll(".chord-symbol")].map((t) => t.textContent).pop(),
				held: [...document.querySelectorAll(".key.held")].map((k) => k.dataset.pitch),
				stems: document.querySelector(".note-group.current").querySelectorAll(".note-stem").length,
				ties: document.querySelector(".note-group.current").querySelectorAll(".note-tie").length,
			}));
			assert.strictEqual((await ids()).pop(), "C4+E4+G4");
			// The half note starts on beat 7½, so it crosses the bar line: an eighth tied to a dotted quarter, one stem
			// each, and a tie from every head.
			assert.deepStrictEqual(r, { symbol: "C", held: ["C4", "E4", "G4"], stems: 2, ties: 3 });
		});
		await check("the Chord toggle stacks without Shift, and a second press takes a tone out", async () => {
			await page.click("#chordBtn");
			await page.evaluate(() => document.activeElement && document.activeElement.blur());
			await page.keyboard.press("j"); // H4: C–E–G–H is Cmaj7
			const symbol = await page.evaluate(() => [...document.querySelectorAll(".chord-symbol")].map((t) => t.textContent).pop());
			await page.keyboard.press("j");
			await page.click("#chordBtn");
			assert.strictEqual(symbol, "Cmaj7");
			assert.strictEqual((await ids()).pop(), "C4+E4+G4");
		});
		await check("chord names: inversions, sevenths and too few notes", async () => {
			const r = await page.evaluate(() => [["E4", "G4", "C5"], ["G3", "H3", "D4", "F4"], ["A3", "C4", "E4", "G4"], ["C4", "E4"], ["C4", "C#4", "D4"]]
				.map((chord) => window.Notar.chordName(chord)));
			assert.deepStrictEqual(r, ["C/E", "G7", "Am7", null, null]);
		});
		await check("number keys and . set the length: a dotted sixteenth is written", async () => {
			await page.evaluate(() => document.activeElement && document.activeElement.blur());
			await page.keyboard.press("5");
			await page.keyboard.press(".");
			await page.keyboard.press("f");
			const last = (await notes()).pop();
			const dots = await page.evaluate(() => document.querySelector(".note-group.current").querySelectorAll(".note-dot, .note-flag").length);
			await page.keyboard.press(".");
			await page.keyboard.press("3");
			assert.deepStrictEqual(last, { pitches: ["F4"], duration: 16, dotted: true });
			assert.strictEqual(dots, 3); // one dot, two flags
		});
		await check("arrow keys transpose the current note: a semitone, or an octave with Shift", async () => {
			await page.keyboard.press("ArrowUp");
			const up = (await ids()).pop();
			await page.keyboard.down("Shift");
			await page.keyboard.press("ArrowUp");
			await page.keyboard.up("Shift");
			const octave = (await ids()).pop();
			await page.keyboard.press("ArrowDown");
			assert.deepStrictEqual([up, octave, (await ids()).pop()], ["F#4", "F#5", "F5"]);
		});
		await check("the cursor moves with ← → Home End, and new notes go in there", async () => {
			const before = await ids();
			await page.keyboard.press("Home");
			assert.strictEqual(await cursor(), 0);
			await page.keyboard.press("s"); // D4 at the very start
			await page.keyboard.press("ArrowRight");
			await page.keyboard.press(" "); // a rest after the old first note
			const after = await ids();
			assert.deepStrictEqual(after.slice(0, 3), ["D4", before[0], "rest"]);
			assert.strictEqual(await cursor(), 3);
			await page.keyboard.press("End");
			assert.strictEqual(await cursor(), after.length);
		});
		await check("Delete removes the note after the cursor", async () => {
			const before = await ids();
			await page.keyboard.press("Home");
			await page.keyboard.press("Delete");
			assert.deepStrictEqual(await ids(), before.slice(1));
			assert.strictEqual(await cursor(), 0);
			await page.keyboard.press("End");
		});
		await check("clicking the staff appends a note, stacks a chord tone and takes one out", async () => {
			const width = await page.evaluate(() => document.getElementById("staffSvg").viewBox.baseVal.width);
			await page.keyboard.press("4"); // eighths
			await clickStaff(width - 60, trebleY(3)); // past the music, on the A4 space
			assert.strictEqual((await ids()).pop(), "A4");
			const x = await page.evaluate(() => Number(document.querySelector(".note-group.current .note-head").getAttribute("cx")));
			await clickStaff(x, trebleY(5)); // C5, same column: a chord tone
			assert.strictEqual((await ids()).pop(), "A4+C5");
			await clickStaff(x, trebleY(3)); // the A4 head of the current chord: out
			assert.strictEqual((await ids()).pop(), "C5");
			assert.deepStrictEqual((await notes()).pop(), { pitches: ["C5"], duration: 8 });
		});
		await check("the ruler moves the cursor; a click on the cursor line inserts there", async () => {
			const before = await ids();
			await clickStaff(86, 10); // the ruler, by the first bar line
			assert.strictEqual(await cursor(), 0);
			await clickStaff(87, trebleY(0)); // the cursor line, on the E4 line
			assert.deepStrictEqual((await ids()).slice(0, 2), ["E4", before[0]]);
			assert.strictEqual(await cursor(), 1);
			await page.keyboard.press("End");
		});
		await check("Undo after a click past the music puts the cursor back where it was", async () => {
			const width = await page.evaluate(() => document.getElementById("staffSvg").viewBox.baseVal.width);
			await page.keyboard.press("Home");
			await page.keyboard.press("ArrowRight");
			await clickStaff(width - 60, trebleY(2));
			await page.click("#undoBtn");
			assert.strictEqual(await cursor(), 1);
			await page.keyboard.press("End");
		});
		await check("a mouse press on the ruler that ends on the staff writes nothing", async () => {
			const before = await ids();
			const at = await page.evaluate(() => {
				const svg = document.getElementById("staffSvg");
				const line = document.querySelector(".cursor-line");
				const scroll = document.getElementById("staffScroll");
				// A real mouse needs the point on screen: earlier page.click calls may have scrolled the page.
				scroll.scrollIntoView({ block: "center" });
				scroll.scrollLeft = Math.max(0, Number(line.getAttribute("x1")) - 200);
				const m = svg.getScreenCTM();
				const p = (x, y) => {
					const q = new DOMPoint(x, y).matrixTransform(m);
					return { x: q.x, y: q.y };
				};
				const x = Number(line.getAttribute("x1"));
				return { down: p(x, 10), up: p(x + 30, 110) };
			});
			await page.mouse.move(at.down.x, at.down.y);
			await page.mouse.down();
			await page.mouse.move(at.up.x, at.up.y, { steps: 4 });
			await page.mouse.up();
			assert.deepStrictEqual(await ids(), before);
		});
		await check("export writes version 3: pitches lists, chords included", async () => {
			// Read the export instead of downloading it: a one-shot createObjectURL stub hands over the blob's text,
			// and anchor clicks do nothing.
			const text = await page.evaluate(() => new Promise((resolve) => {
				const original = URL.createObjectURL;
				URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = original; return "blob:stub"; };
				HTMLAnchorElement.prototype.click = function () {};
				document.getElementById("exportBtn").click();
			}));
			const payload = JSON.parse(text);
			assert.strictEqual(payload.version, 3);
			assert.strictEqual(payload.bpm, 120);
			assert.ok(payload.notes.some((n) => n.pitches.join() === "C2"));
			assert.ok(payload.notes.some((n) => n.pitches.join() === "C4,E4,G4"));
		});
		await check("importing a version-1 file maps C…H to octave 4", async () => {
			const file = path.join(os.tmpdir(), `notar-v1-${process.pid}.json`);
			fs.writeFileSync(file, JSON.stringify({ version: 1, bpm: 90, notes: [{ pitch: "C", duration: 4 }, { pitch: "H", duration: 2 }, { pitch: "rest", duration: 4 }] }));
			const input = await page.$("#importInput");
			await input.uploadFile(file);
			await page.waitForFunction(() => /Imported/.test(document.getElementById("status").textContent));
			fs.unlinkSync(file);
			assert.deepStrictEqual(await ids(), ["C4", "H4", "rest"]);
		});
		await check("importing a version-3 file keeps chords and dots; Undo brings the old notes back", async () => {
			const before = await ids();
			const file = path.join(os.tmpdir(), `notar-v3-${process.pid}.json`);
			const v3 = [{ pitches: ["G3", "D4", "H4"], duration: 2, dotted: true }, { pitches: [], duration: 4 }, { pitches: ["C4", "Q9"], duration: 4 }];
			fs.writeFileSync(file, JSON.stringify({ version: 3, bpm: 100, notes: v3 }));
			await (await page.$("#importInput")).uploadFile(file);
			await page.waitForFunction(() => /Imported 3/.test(document.getElementById("status").textContent));
			fs.unlinkSync(file);
			assert.deepStrictEqual(await notes(), [v3[0], v3[1], { pitches: ["C4"], duration: 4 }]);
			await page.click("#undoBtn");
			assert.deepStrictEqual(await ids(), before);
			await page.click("#redoBtn");
		});
		await check("playback lights every key of a chord; Stop silences it and hides the playhead", async () => {
			await page.click("#playBtn");
			await page.waitForSelector(".note-group.active", { timeout: 3000 });
			const sounding = await page.evaluate(() => [...document.querySelectorAll(".key.sounding")].map((k) => k.dataset.pitch));
			const queued = await page.evaluate(() => window.Notar.voices());
			await page.click("#stopBtn");
			const r = await page.evaluate(() => ({
				active: document.querySelectorAll(".note-group.active").length,
				play: document.getElementById("playBtn").disabled,
				voices: window.Notar.voices(),
				playhead: getComputedStyle(document.getElementById("playhead")).opacity,
			}));
			assert.deepStrictEqual(sounding, ["G3", "D4", "H4"]);
			assert.strictEqual(queued, 4, "every voice of the pass is queued at once (3 + rest + 1)");
			assert.deepStrictEqual(r, { active: 0, play: false, voices: 0, playhead: "0" });
		});
		await check("Clear empties the composition, and Undo brings it back", async () => {
			const before = await ids();
			await page.click("#clearBtn");
			assert.strictEqual((await notes()).length, 0);
			await page.click("#undoBtn");
			assert.deepStrictEqual(await ids(), before);
			await page.click("#clearBtn");
			assert.strictEqual((await notes()).length, 0);
		});
		await check("no console errors during behaviour run", () => assert.deepStrictEqual(errors, []));
		await page.close();

		// ── Notation: ties, beams, changing a note's length (desktop) ──────
		console.log("\nnotation");
		const nErrors = [];
		const np = await openPage(browser, base, VIEWPORTS[VIEWPORTS.length - 1], nErrors);
		// Loads a composition as the saved draft (app.js reads it at load); the cursor goes after the last note unless
		// given. n() is a note: one pitch or a chord ("C4+E4"), "rest" for a rest, a length denominator and a dot.
		const load = async (list, caret) => {
			await np.evaluate((draft) => localStorage.setItem("notar-composition-v1", JSON.stringify(draft)), { notes: list, caret: caret === undefined ? list.length : caret });
			await np.reload({ waitUntil: "networkidle0" });
		};
		const n = (pitch, duration, dotted) => ({ pitches: pitch === "rest" ? [] : pitch.split("+"), duration, ...(dotted ? { dotted: true } : {}) });
		const three = [n("C4", 4), n("D4", 4), n("E4", 4)]; // fills a measure up to its last beat
		const saved = () => np.evaluate(() => JSON.parse(localStorage.getItem("notar-composition-v1")).notes);
		const engraved = () => np.evaluate(() => window.Notar.layout());
		// What note group i draws: counts of its heads, ties, accidentals, stems (beamed ones apart), flags and rests.
		const drawn = (i) => np.evaluate((index) => {
			const g = document.querySelector(`.note-group[data-index="${index}"]`);
			const count = (selector) => g.querySelectorAll(selector).length;
			return {
				heads: count(".note-head:not(.rest)"),
				rests: count(".note-head.rest"),
				ties: count(".note-tie"),
				accidentals: count(".accidental"),
				stems: count(".note-stem"),
				beamed: count(".note-stem.beamed"),
				flags: count(".note-flag"),
			};
		}, i);
		// The beams drawn: primary bars (level 1), deeper full bars, and broken (partial) ones.
		const beams = () => np.evaluate(() => {
			const bars = [...document.querySelectorAll(".beams .note-beam")];
			return {
				primary: bars.filter((b) => b.dataset.level === "1").length,
				secondary: bars.filter((b) => b.dataset.level !== "1" && !b.classList.contains("partial")).length,
				partial: bars.filter((b) => b.classList.contains("partial")).length,
			};
		});
		const shift = async (code) => {
			await np.keyboard.down("Shift");
			await np.keyboard.press(code);
			await np.keyboard.up("Shift");
		};

		await check("ties: a note across a bar line is drawn as tied segments, and stays one note", async () => {
			await load([...three, n("F4", 2)]);
			const segments = (await engraved()).events[3].segments.map((s) => [s.beat, s.beats, s.duration]);
			assert.deepStrictEqual(segments, [[3, 1, 4], [4, 1, 4]]);
			assert.deepStrictEqual(await drawn(3), { heads: 2, rests: 0, ties: 1, accidentals: 0, stems: 2, beamed: 0, flags: 0 });
			assert.deepStrictEqual(await saved(), [...three, { pitches: ["F4"], duration: 2 }]);
		});
		await check("ties: bar lines fall at the true measure boundaries, so no measure overflows", async () => {
			await load([n("C4", 4, true), n("D4", 2, true), n("E4", 8), n("F4", 1), n("G4", 16), n("A4", 2, true), n("H4", 1, true), n("rest", 2, true)]);
			const { bars, events } = await engraved();
			const segments = events.flatMap((e) => e.segments);
			const total = segments.reduce((sum, s) => sum + s.beats, 0);
			for (let m = 0; m * 4 < total; m += 1) {
				const inside = segments.filter((s) => s.measure === m);
				assert.ok(inside.every((s) => s.beat >= m * 4 && s.beat + s.beats <= m * 4 + 4 + 1e-9), `a segment leaves measure ${m + 1}`);
				if ((m + 1) * 4 <= total) {
					assert.strictEqual(inside.reduce((sum, s) => sum + s.beats, 0), 4, `measure ${m + 1} holds 4 beats`);
				}
				assert.strictEqual(bars[m], inside[0].x, `bar line ${m + 1} at the measure's first segment`);
			}
		});
		await check("ties: 2½ beats after a bar line are a half and an eighth; a rest splits with no tie", async () => {
			await load([...three, n("F4", 8), n("G4", 2, true)]); // G4 from beat 3½: an eighth, then 2½ beats
			assert.deepStrictEqual((await engraved()).events[4].segments.map((s) => s.duration), [8, 2, 8]);
			assert.strictEqual((await drawn(4)).ties, 2);
			await load([...three, n("rest", 2)]);
			assert.deepStrictEqual(await drawn(3), { heads: 0, rests: 2, ties: 0, accidentals: 0, stems: 0, beamed: 0, flags: 0 });
		});
		await check("ties: dotted notes and sixteenths split into standard values", async () => {
			const split = async (list) => {
				await load(list);
				const { events } = await engraved();
				return events[events.length - 1].segments.map((s) => `${s.duration}${s.dotted ? "." : ""}`);
			};
			assert.deepStrictEqual(await split([...three, n("F4", 8), n("G4", 4, true)]), ["8", "4"]);
			assert.deepStrictEqual(await split([...three, n("F4", 16), n("G4", 16), n("A4", 16), n("H4", 8)]), ["16", "16"]);
			assert.deepStrictEqual(await split([...three, n("F4", 8), n("G4", 16, true), n("A4", 8)]), ["32", "16."]);
		});
		await check("ties: a tied chord ties every head; the continuation repeats no accidental", async () => {
			await load([...three, n("F#4+A4+C5", 2), n("F4", 4), n("F#4", 4)]);
			const chord = await drawn(3);
			assert.deepStrictEqual([chord.heads, chord.ties, chord.accidentals], [6, 3, 1]);
			// The tie carried F♯ into the new measure: F4 after it gets a natural, and F♯4 after that its sharp again.
			assert.deepStrictEqual([(await drawn(4)).accidentals, (await drawn(5)).accidentals], [1, 1]);
			await load([...three, n("F#4", 2), n("F#4", 4)]);
			assert.strictEqual((await drawn(4)).accidentals, 1, "a later F♯ in the new measure restates its sharp");
		});
		await check("ties: the cursor, transposing, clicks on either segment and Delete treat it as one note", async () => {
			await load([...three, n("F4", 2)]);
			await np.keyboard.press("ArrowLeft");
			assert.strictEqual(await np.evaluate(() => window.Notar.cursor()), 3);
			await np.keyboard.press("ArrowRight");
			await np.keyboard.press("ArrowUp");
			assert.deepStrictEqual((await saved())[3], { pitches: ["F#4"], duration: 2 });
			const heads = await np.evaluate(() => [...document.querySelectorAll('.note-group[data-index="3"] .note-head')]
				.map((h) => ({ x: Number(h.getAttribute("cx")), y: Number(h.getAttribute("cy")) })));
			assert.strictEqual(heads[0].y, heads[1].y, "both segments moved");
			await np.keyboard.press("Home");
			const click = (x, y) => np.evaluate((sx, sy) => {
				const svg = document.getElementById("staffSvg");
				const p = new DOMPoint(sx, sy).matrixTransform(svg.getScreenCTM());
				svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: p.x, clientY: p.y }));
			}, x, y);
			await click(heads[1].x, heads[1].y); // the second segment's head selects the note
			assert.strictEqual(await np.evaluate(() => window.Notar.cursor()), 4);
			await click(heads[1].x, 126 - 5 * 6); // its column at C5: a chord tone for the whole note
			assert.deepStrictEqual((await saved())[3].pitches, ["F#4", "C5"]);
			assert.strictEqual((await drawn(3)).ties, 2);
			await np.keyboard.press("Backspace");
			assert.deepStrictEqual(await saved(), three);
		});
		await check("ties: playback sounds a tied note once and lights every segment", async () => {
			await load([...three, n("F4+A4", 2)], 3); // Play from the cursor: the tied chord only
			await np.click("#playBtn");
			await np.waitForSelector(".note-group.active", { timeout: 3000 });
			const r = await np.evaluate(() => ({
				voices: window.Notar.voices(),
				heads: document.querySelectorAll(".note-group.active .note-head").length,
				ties: document.querySelectorAll(".note-group.active .note-tie").length,
			}));
			await np.click("#stopBtn");
			assert.deepStrictEqual(r, { voices: 2, heads: 4, ties: 2 });
		});
		await check("beams: eighths are beamed by beat, with no flags", async () => {
			await load([n("C4", 8), n("D4", 8), n("E4", 8), n("F4", 8)]);
			assert.deepStrictEqual(await beams(), { primary: 2, secondary: 0, partial: 0 });
			assert.deepStrictEqual(await np.evaluate(() => [document.querySelectorAll(".note-flag").length, document.querySelectorAll(".note-stem.beamed").length]), [0, 4]);
		});
		await check("beams: a group shares the stem direction of its farthest note, and its stems meet the beam", async () => {
			await load([n("G4", 8), n("C6", 8)]); // G4 alone would be stem up; C6, farther from the middle line, decides
			const r = await np.evaluate(() => {
				const stems = [...document.querySelectorAll(".note-stem.beamed")].map((s) => ({ x: Number(s.getAttribute("x1")), tip: Number(s.getAttribute("y2")) }));
				const heads = [...document.querySelectorAll(".note-group .note-head")].map((h) => Number(h.getAttribute("cx")));
				const [a, b] = document.querySelector('.note-beam[data-level="1"]').getAttribute("points").split(" ").map((p) => p.split(",").map(Number));
				const edge = (x) => a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]);
				return { down: stems.map((s, i) => s.x < heads[i]), off: stems.map((s) => Math.abs(s.tip - edge(s.x))) };
			});
			assert.deepStrictEqual(r.down, [true, true]);
			r.off.forEach((off) => assert.ok(off < 0.5, `stem ends ${off} from the beam`));
		});
		await check("beams: sixteenths get a second beam, mixed and dotted rhythms a broken one", async () => {
			await load([n("C4", 8), n("D4", 16), n("E4", 16)]);
			assert.deepStrictEqual(await beams(), { primary: 1, secondary: 1, partial: 0 });
			await load([n("E4", 8, true), n("F4", 16), n("G4", 16), n("A4", 8), n("H4", 16)]);
			assert.deepStrictEqual(await beams(), { primary: 2, secondary: 0, partial: 3 });
		});
		await check("beams: a rest or a quarter breaks a group, and a lone eighth keeps its flag", async () => {
			await load([n("C4", 8), n("rest", 8), n("D4", 8), n("E4", 8), n("F4", 8), n("G4", 4), n("A4", 8)]);
			assert.deepStrictEqual(await beams(), { primary: 1, secondary: 0, partial: 0 });
			assert.deepStrictEqual([(await drawn(0)).flags, (await drawn(4)).flags, (await drawn(6)).flags], [1, 1, 1]);
		});
		await check("beams: chords are beamed, each staff with its own beam", async () => {
			await load([n("C3+E4+G4", 8), n("D3+F4+A4", 8)]);
			assert.deepStrictEqual(await beams(), { primary: 2, secondary: 0, partial: 0 });
			assert.strictEqual((await drawn(0)).beamed + (await drawn(1)).beamed, 4);
		});
		await check("beams: each staff's beams and beamed stems stay on its side of the gap between the staves", async () => {
			// Chords across both staves: D4–A5 would beam stems down into the gap, A3–D2 stems up out of the bass.
			await load([n("A3+D4", 8), n("D2+A5", 8), n("H3+E4", 8), n("E2+G5", 8)]);
			const r = await np.evaluate(() => {
				const middle = (126 + 192) / 2; // between the treble staff's bottom line and the bass staff's top line
				const ys = (bar) => bar.getAttribute("points").split(" ").map((p) => Number(p.split(",")[1]));
				const bars = [...document.querySelectorAll(".beams .note-beam")];
				const stems = [...document.querySelectorAll(".note-stem.beamed")].map((s) => [Number(s.getAttribute("y1")), Number(s.getAttribute("y2"))]);
				return {
					treble: bars.filter((b) => b.dataset.staff === "treble").length,
					crossing: bars.filter((b) => (b.dataset.staff === "treble" ? ys(b).some((y) => y > middle) : ys(b).some((y) => y < middle))).length,
					// A beamed stem that runs across the middle belongs to a beam that crossed it.
					stemsAcross: stems.filter(([a, b]) => Math.min(a, b) < middle && Math.max(a, b) > middle).length,
				};
			});
			assert.strictEqual(r.crossing, 0, "a beam crosses the middle of the gap");
			assert.strictEqual(r.stemsAcross, 0, "a beamed stem crosses the middle of the gap");
			assert.ok(r.treble >= 2, "the treble groups keep their beams (the first turns its stems up)");
		});
		await check("beams and ties together: a tied eighth joins the beam of its beat", async () => {
			await load([...three, n("F4", 8), n("G4", 4, true)]);
			assert.deepStrictEqual(await beams(), { primary: 1, secondary: 0, partial: 0 });
			assert.deepStrictEqual(await drawn(4), { heads: 2, rests: 0, ties: 1, accidentals: 0, stems: 2, beamed: 1, flags: 0 });
		});
		await check("length: Shift+1–5 and Shift+. change the current note, plain keys only new notes; Undo restores", async () => {
			await load([n("C4", 4), n("D4", 4)]);
			await shift("Digit2");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 2 });
			await shift("Period");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 2, dotted: true });
			assert.match(await np.evaluate(() => document.getElementById("status").textContent), /^Changed note 2 to D4 \(dotted 1\/2\)/);
			assert.strictEqual(await np.evaluate(() => document.querySelector("#durationPicker input:checked").value), "2", "new notes stay 1/4");
			await np.click("#undoBtn");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 2 });
			await np.click("#undoBtn");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 4 });
		});
		await check("length: a held Shift+. or Shift+digit changes the note once; a key that types a letter is no shortcut", async () => {
			await load([n("C4", 4), n("D4", 4)]);
			const hold = async (code) => {
				await np.keyboard.down("Shift");
				for (let i = 0; i < 4; i += 1) {
					await np.keyboard.down(code); // after the first, these are auto-repeats (event.repeat)
				}
				await np.keyboard.up(code);
				await np.keyboard.up("Shift");
			};
			await hold("Period");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 4, dotted: true }, "toggled once, not four times");
			await hold("Digit4"); // the fourth length, 1/8
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 8, dotted: true });
			await np.click("#undoBtn");
			await np.click("#undoBtn");
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 4 });
			assert.strictEqual(await np.evaluate(() => document.getElementById("undoBtn").disabled), true, "two holds, two undo steps");
			// Dvorak's Period key types V: Shift+V there is a letter, not Shift+.
			await np.evaluate(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "V", code: "Period", shiftKey: true, bubbles: true })));
			assert.deepStrictEqual((await saved())[1], { pitches: ["D4"], duration: 4 });
		});
		await check("length: Apply gives the current note the picked length and dot; the picker marks the note's", async () => {
			await load([n("C4", 4), n("D4", 4)], 1);
			const held = () => np.evaluate(() => [...document.querySelectorAll("#durationPicker label.held input")].map((i) => i.value)
				.concat(document.getElementById("dotBtn").classList.contains("held") ? ["dot"] : []));
			assert.deepStrictEqual(await held(), ["2"]);
			await np.click('#durationPicker input[value="3"]');
			await np.click("#dotBtn");
			await np.click("#applyLengthBtn");
			assert.deepStrictEqual(await saved(), [n("C4", 8, true), n("D4", 4)]);
			assert.deepStrictEqual(await held(), ["3", "dot"]);
			assert.strictEqual(await np.evaluate(() => window.Notar.cursor()), 1, "the cursor stays after the note");
			await np.click("#undoBtn");
			assert.deepStrictEqual(await saved(), [n("C4", 4), n("D4", 4)]);
			await np.evaluate(() => document.activeElement && document.activeElement.blur());
			await np.keyboard.press("Home");
			assert.strictEqual(await np.evaluate(() => document.getElementById("applyLengthBtn").disabled), true, "no note before the cursor");
		});
		await check("length: a change that makes a note cross a bar line ties it, and says so", async () => {
			await load([...three, n("F4", 4)]);
			await shift("Digit2");
			assert.match(await np.evaluate(() => document.getElementById("status").textContent), /tied over the bar line/);
			assert.strictEqual((await engraved()).events[3].segments.length, 2);
		});
		await check("no console errors during notation run", () => assert.deepStrictEqual(nErrors, []));
		await np.close();

		// ── Sharing, MIDI, images and print (desktop) ──────────────────────
		console.log("\nshare, MIDI, images, print");
		const sErrors = [];
		const sp = await openPage(browser, base, VIEWPORTS[VIEWPORTS.length - 1], sErrors);
		const sLoad = async (target, list, extra) => {
			const draft = { notes: list, caret: list.length, ...extra };
			await target.evaluate((d) => localStorage.setItem("notar-composition-v1", JSON.stringify(d)), draft);
			await target.reload({ waitUntil: "networkidle0" });
		};
		const sSaved = (target) => target.evaluate(() => JSON.parse(localStorage.getItem("notar-composition-v1")));
		const status = (target) => target.$eval("#status", (s) => s.textContent);
		// Share copies to the clipboard on a desktop: the stub keeps what was written. The pointer reaching the button
		// first lets the deflated link be made (prepareShareLink); a click alone gets the raw one.
		const shareLinkOf = async (target) => {
			await target.evaluate(() => {
				window.__copied = null;
				navigator.clipboard.writeText = (text) => {
					window.__copied = text;
					return Promise.resolve();
				};
			});
			await target.hover("#shareBtn");
			await new Promise((r) => setTimeout(r, 150));
			await target.click("#shareBtn");
			await target.waitForFunction(() => window.__copied);
			return target.evaluate(() => window.__copied);
		};
		// Opens a link with a full page load, as a new tab does, over the draft given (a different composition).
		const openLink = async (target, link, draft) => {
			await target.goto(base, { waitUntil: "networkidle0" });
			await target.evaluate((d) => localStorage.setItem("notar-composition-v1", JSON.stringify(d)), draft);
			await target.goto("about:blank");
			await target.goto(link, { waitUntil: "networkidle0" });
			await target.waitForFunction(() => /shared? links?/.test(document.getElementById("status").textContent));
		};
		// Every download as { name, type, bytes }: object URLs and anchor clicks are stubbed, as in the export check.
		const captureDownloads = (target) => target.evaluate(() => {
			window.__downloads = [];
			URL.createObjectURL = (blob) => {
				window.__downloads.push({ blob });
				return "blob:stub";
			};
			HTMLAnchorElement.prototype.click = function () {
				window.__downloads[window.__downloads.length - 1].name = this.download;
			};
		});
		const lastDownload = async (target, count) => {
			await target.waitForFunction((n) => window.__downloads.length >= n && window.__downloads[n - 1].name, {}, count);
			return target.evaluate(async (n) => {
				const { blob, name } = window.__downloads[n - 1];
				return { name, type: blob.type, bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) };
			}, count);
		};
		// A second tab for a check, always closed afterwards, even when the check fails: one left open would keep the
		// main page in the background, where requestAnimationFrame never runs and every later waitForFunction stalls.
		const withTab = async (fn) => {
			const tab = await browser.newPage();
			await tab.setViewport({ width: 1440, height: 900 });
			try {
				return await fn(tab);
			} finally {
				await tab.close();
			}
		};
		const piece = [n("C4+E4+G4", 4), n("rest", 8), n("Db4", 8, true), n("F#3+D4", 16), n("A4", 2), n("H4", 4), n("C2", 1)];
		const other = { notes: [n("G3", 2), n("A3", 2)], caret: 2, bpm: 80 };

		await check("share: the link carries the notes and tempo; opened in a new page it loads them, clears the hash, and Undo brings the draft back", async () => {
			await sLoad(sp, piece, { bpm: 132 });
			const link = await shareLinkOf(sp);
			assert.ok(link.startsWith(`${base}#n=`), link);
			assert.match(await status(sp), /^Link copied/);
			await withTab(async (tab) => {
				await openLink(tab, link, other);
				const opened = await sSaved(tab);
				assert.deepStrictEqual(opened.notes, piece, "Db4 keeps its spelling, dots and rests survive");
				assert.strictEqual(opened.bpm, 132);
				assert.match(await status(tab), /^Opened a shared link: 7 notes at 132 BPM\. Undo brings back the 2 notes you had, even after a reload\./);
				assert.strictEqual(await tab.evaluate(() => location.hash), "", "the hash is cleared, so a reload doesn't open it again");
				await tab.click("#undoBtn");
				const undone = await sSaved(tab);
				assert.deepStrictEqual([undone.notes, undone.bpm], [other.notes, 80]);
				await tab.reload({ waitUntil: "networkidle0" });
				assert.deepStrictEqual((await sSaved(tab)).notes, other.notes, "a reload after Undo keeps the draft");
			});
		});
		await check("share: a long piece gets a deflated (D) link, a short one the raw (R) form; both open", async () => {
			const long = Array.from({ length: 64 }, (_, i) => n(["C4", "E4", "G4", "C5"][i % 4], 8));
			await sLoad(sp, long);
			const deflated = await shareLinkOf(sp);
			assert.ok(deflated.includes("#n=D"), deflated);
			assert.ok(deflated.length - base.length < 60, `64 notes in ${deflated.length - base.length} characters`);
			await sLoad(sp, [n("C4", 4)]);
			assert.ok((await shareLinkOf(sp)).includes("#n=R"), "deflate would be longer for one note");
			await withTab(async (tab) => {
				await openLink(tab, deflated, other);
				assert.deepStrictEqual((await sSaved(tab)).notes, long);
			});
		});
		await check("share: without CompressionStream the link is raw and still opens", async () => {
			await sLoad(sp, piece);
			await sp.evaluate(() => {
				window.CompressionStream = undefined;
			});
			const link = await shareLinkOf(sp);
			assert.ok(link.includes("#n=R"), link);
			await withTab(async (tab) => {
				await openLink(tab, link, other);
				assert.deepStrictEqual((await sSaved(tab)).notes, piece);
			});
			await sp.reload({ waitUntil: "networkidle0" });
		});
		await check("share: damaged or tampered links open nothing, say so, keep the draft and clear the hash", async () => {
			await sLoad(sp, Array.from({ length: 40 }, (_, i) => n(["C4", "D4", "E4"][i % 3], 8)));
			const deflated = await shareLinkOf(sp);
			const payload = deflated.split("#n=D")[1];
			const middle = Math.floor(payload.length / 2);
			const flipped = payload.slice(0, middle) + (payload[middle] === "A" ? "B" : "A") + payload.slice(middle + 1);
			// A raw link cut short (version 1, bpm 96, two notes, but only one there), and one with a pitch byte past C6.
			const cut = Buffer.from([1, 96, 2, 0x12, 0x50]).toString("base64url");
			const high = Buffer.from([1, 96, 1, 0x12, 0x7f]).toString("base64url");
			for (const hash of [`D${flipped}`, `D${payload.slice(0, -6)}`, `R${cut}`, `R${high}`, "R!!", "Xabc", "D"]) {
				await withTab(async (tab) => {
					const tabErrors = [];
					tab.on("pageerror", (e) => tabErrors.push(e.message));
					await openLink(tab, `${base}#n=${hash}`, other);
					assert.match(await status(tab), /^That share link is damaged or incomplete/, `#n=${hash}`);
					assert.deepStrictEqual((await sSaved(tab)).notes, other.notes, `#n=${hash} changed the draft`);
					assert.strictEqual(await tab.evaluate(() => location.hash), "");
					assert.strictEqual(await tab.evaluate(() => document.getElementById("undoBtn").disabled), true, "no undo step");
					assert.deepStrictEqual(tabErrors, []);
				});
			}
		});
		await check("share: a link pasted into an open tab (a hash change) opens as one undoable edit", async () => {
			await sLoad(sp, piece, { bpm: 110 });
			const link = await shareLinkOf(sp);
			await sLoad(sp, other.notes);
			await sp.evaluate((hash) => {
				location.hash = hash;
			}, link.slice(link.indexOf("#")));
			await sp.waitForFunction(() => /Opened a shared link/.test(document.getElementById("status").textContent));
			assert.deepStrictEqual((await sSaved(sp)).notes, piece);
			await sp.click("#undoBtn");
			assert.deepStrictEqual((await sSaved(sp)).notes, other.notes);
		});

		// A minimal Standard MIDI File reader: chunks, variable-length deltas, running status, meta and channel events.
		const parseMidi = (bytes) => {
			let at = 0;
			const u32 = () => ((bytes[at++] << 24) | (bytes[at++] << 16) | (bytes[at++] << 8) | bytes[at++]) >>> 0;
			const u16 = () => (bytes[at++] << 8) | bytes[at++];
			const tag = () => String.fromCharCode(...bytes.slice(at, (at += 4)));
			const vlq = () => {
				let value = 0;
				let byte;
				do {
					byte = bytes[at++];
					value = value * 128 + (byte & 0x7f);
				} while (byte & 0x80);
				return value;
			};
			assert.strictEqual(tag(), "MThd");
			assert.strictEqual(u32(), 6);
			const header = { format: u16(), tracks: u16(), division: u16() };
			const tracks = [];
			for (let t = 0; t < header.tracks; t += 1) {
				assert.strictEqual(tag(), "MTrk");
				const end = u32() + at;
				const events = [];
				let tick = 0;
				let running = 0;
				while (at < end) {
					tick += vlq();
					if (bytes[at] & 0x80) {
						running = bytes[at++];
					}
					if (running === 0xff) {
						const type = bytes[at++];
						const length = vlq();
						events.push({ tick, meta: type, data: bytes.slice(at, at + length) });
						at += length;
					} else {
						const kind = running & 0xf0;
						const size = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
						const data = bytes.slice(at, at + size);
						at += size;
						events.push({ tick, kind: kind === 0x90 && data[1] === 0 ? 0x80 : kind, channel: running & 15, data });
					}
				}
				assert.strictEqual(at, end, "the track's length matches its events");
				tracks.push(events);
			}
			assert.strictEqual(at, bytes.length, "nothing after the last track");
			return { ...header, tracks };
		};
		await check("MIDI: format 0 with tempo, 4/4 and program; chords, rests, dots and a tied note as one note-on/off", async () => {
			// At 480 ticks a quarter: chord 0–480, rest to 720, D4 dotted quarter 720–1440, F4 half from beat 3 (tied over
			// the bar line on the staff) 1440–2400, G4 sixteenth to 2520, A4 whole to 4440 (a 1920-tick delta: 8F 00),
			// C♯4 and D♭4 in one chord (one key, 61) to 4920, and a closing eighth rest the track still lasts through.
			const list = [n("C4+E4+G4", 4), n("rest", 8), n("D4", 4, true), n("F4", 2), n("G4", 16), n("A4", 1), n("C#4+Db4", 4), n("rest", 8)];
			await sLoad(sp, list, { bpm: 120 });
			assert.strictEqual((await sp.evaluate(() => window.Notar.layout().events[3].segments.length)), 2, "F4 is tied on the staff");
			await captureDownloads(sp);
			await sp.evaluate(() => document.getElementById("midiBtn").click());
			const file = await lastDownload(sp, 1);
			assert.match(file.name, /^notar_\d{4}-\d\d-\d\d\.mid$/);
			assert.strictEqual(file.type, "audio/midi");
			const midi = parseMidi(file.bytes);
			assert.deepStrictEqual([midi.format, midi.tracks.length, midi.division], [0, 1, 480]);
			const track = midi.tracks[0];
			const meta = (type) => track.find((e) => e.meta === type);
			assert.deepStrictEqual(meta(0x51).data, [0x07, 0xa1, 0x20], "500000 µs a quarter: 120 BPM");
			assert.deepStrictEqual(meta(0x58).data, [4, 2, 24, 8], "4/4");
			assert.deepStrictEqual(track.find((e) => e.kind === 0xc0).data, [0], "piano, General MIDI program 1");
			const notesOf = track.filter((e) => e.kind === 0x90 || e.kind === 0x80)
				.map((e) => [e.tick, e.kind === 0x90 ? "on" : "off", e.data[0]]);
			assert.deepStrictEqual(notesOf, [
				[0, "on", 60], [0, "on", 64], [0, "on", 67],
				[480, "off", 60], [480, "off", 64], [480, "off", 67],
				[720, "on", 62], [1440, "off", 62],
				[1440, "on", 65], [2400, "off", 65],
				[2400, "on", 67], [2520, "off", 67],
				[2520, "on", 69], [4440, "off", 69],
				[4440, "on", 61], [4920, "off", 61],
			]);
			assert.ok(track.filter((e) => e.kind === 0x90).every((e) => e.data[1] === 80 && e.channel === 0));
			assert.deepStrictEqual([track[track.length - 1].meta, track[track.length - 1].tick], [0x2f, 5160], "end of track after the last rest");
		});
		let sheetLines = 0; // systems in the SVG export, which the PNG export draws too
		await check("images: the SVG export is the whole sheet in systems, with its styles and the clef inside it", async () => {
			const measure = (m) => [n("C4+E4+G4", 4), n("D4", 8), n("E4", 8), n("F#4", 4), n(m % 2 ? "G4" : "A4", 4)];
			const twelve = Array.from({ length: 12 }, (_, m) => measure(m)).flat();
			await sLoad(sp, twelve);
			await captureDownloads(sp);
			await sp.evaluate(() => document.getElementById("svgBtn").click());
			const file = await lastDownload(sp, 1);
			assert.match(file.name, /\.svg$/);
			assert.strictEqual(file.type, "image/svg+xml");
			const text = Buffer.from(file.bytes).toString("utf8");
			const r = await sp.evaluate((svgText) => {
				const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
				const svg = doc.documentElement;
				return {
					error: doc.querySelectorAll("parsererror").length,
					width: svg.getAttribute("width"),
					systems: doc.querySelectorAll("g.system").length,
					clefs: doc.querySelectorAll("use").length,
					clefData: (doc.querySelector("#g-clef").getAttribute("href") || "").startsWith("data:image/svg+xml;base64,"),
					rules: (doc.querySelector("style").textContent.match(/\{/g) || []).length,
					indices: new Set([...doc.querySelectorAll(".note-group")].map((g) => g.getAttribute("data-index"))).size,
					stray: doc.querySelectorAll(".cursor, .ruler, .current-band, .selection-band, #playhead, #ghost").length,
				};
			}, text);
			sheetLines = r.systems;
			assert.deepStrictEqual(r, { error: 0, width: "1200", systems: r.systems, clefs: r.systems, clefData: true, rules: r.rules, indices: 60, stray: 0 });
			assert.ok(r.systems >= 3, `12 measures in ${r.systems} systems`);
			assert.ok(r.rules > 5, "a style block");
			const left = await sp.evaluate(() => document.querySelectorAll(".print-sheet *, body > div[aria-hidden] svg").length);
			assert.strictEqual(left, 0, "nothing left behind on the page");
		});
		await check("images: the PNG export is the same sheet at twice the size", async () => {
			await captureDownloads(sp);
			await sp.evaluate(() => document.getElementById("pngBtn").click());
			const file = await lastDownload(sp, 1);
			assert.strictEqual(file.type, "image/png");
			const png = Buffer.from(file.bytes);
			assert.strictEqual(png.subarray(1, 4).toString(), "PNG");
			// IHDR: width and height, big-endian, from byte 16. The sheet is 1200 wide and, for its systems, 262 each, 24
			// between them and 16 above and below, tall.
			const height = 2 * (sheetLines * 262 + (sheetLines - 1) * 24 + 32);
			assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [2400, height]);
			assert.match(await status(sp), new RegExp(`PNG image, 2400 × ${height} pixels`));
		});
		const bar13 = [
			n("C4+E4+G4", 4), n("D4", 8), n("E4", 8), n("F#4", 4), n("G4", 2), n("A4", 8), n("H4", 8), n("C5", 4), n("rest", 4),
			n("C3+G3", 2, true), n("E5", 16), n("D5", 16), n("C5", 8),
		];
		await check("print: whole measures in systems that fit the page, ties carried across a break, controls hidden", async () => {
			// The bar of 13 notes from the screenshots, four times: 12 measures, where a half note ties measure 4 to 5.
			await sLoad(sp, [...bar13, ...bar13, ...bar13, ...bar13]);
			await sp.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
			const systems = await sp.evaluate(() => [...document.querySelectorAll(".print-system")].map((svg) => ({
				from: Number(svg.dataset.from),
				to: Number(svg.dataset.to),
				width: svg.viewBox.baseVal.width,
				right: Math.max(...[...svg.querySelectorAll(".staff-line")].map((l) => Number(l.getAttribute("x2")))),
			})));
			assert.ok(systems.length >= 3, `${systems.length} systems`);
			systems.forEach((system, i) => {
				assert.strictEqual(system.from, i ? systems[i - 1].to : 0, "systems follow on, measure by measure");
				assert.strictEqual(system.width, 1200);
				assert.ok(system.right <= 1200 - 16, `system ${i + 1} fits: its staff ends at ${system.right}`);
			});
			assert.strictEqual(systems[systems.length - 1].to, 12);
			const tied = await sp.evaluate(() => [...document.querySelectorAll(".print-system")]
				.map((svg) => svg.querySelectorAll('.note-group[data-index="17"] .note-tie').length));
			assert.deepStrictEqual(tied.filter(Boolean), [1, 1], "the tie hangs off one system and comes in on the next");
			await sp.emulateMediaType("print");
			const shown = await sp.evaluate(() => ({
				page: getComputedStyle(document.querySelector(".page")).display,
				sheet: getComputedStyle(document.getElementById("printSheet")).display,
				width: Math.round(document.querySelector(".print-system").getBoundingClientRect().width),
				body: Math.round(document.body.getBoundingClientRect().width),
			}));
			await sp.emulateMediaType("screen");
			assert.deepStrictEqual([shown.page, shown.sheet], ["none", "block"]);
			assert.strictEqual(shown.width, shown.body, "a system spans the page width");
			await sp.evaluate(() => window.dispatchEvent(new Event("afterprint")));
			assert.strictEqual(await sp.evaluate(() => document.getElementById("printSheet").children.length), 0);
		});
		await check("the Export menu: opens on its button, ↑ ↓ move, Esc closes it, and an item exports and closes it", async () => {
			await sp.evaluate(() => document.activeElement && document.activeElement.blur());
			await sp.click("#exportMenuBtn");
			const menu = () => sp.evaluate(() => [document.getElementById("exportMenu").hidden, document.activeElement.id]);
			const opened = [...(await menu()), await sp.$eval("#exportMenuBtn", (b) => b.getAttribute("aria-expanded"))];
			assert.deepStrictEqual(opened, [false, "exportBtn", "true"]);
			await sp.keyboard.press("ArrowDown");
			assert.strictEqual(await sp.evaluate(() => document.activeElement.id), "midiBtn");
			await sp.keyboard.press("ArrowUp");
			await sp.keyboard.press("ArrowUp");
			assert.strictEqual(await sp.evaluate(() => document.activeElement.id), "printBtn", "↑ from the first wraps to the last");
			await sp.keyboard.press("Escape");
			assert.deepStrictEqual(await menu(), [true, "exportMenuBtn"]);
			assert.deepStrictEqual((await sSaved(sp)).notes.slice(0, 13), bar13, "the menu's arrows never transposed a note");
			await captureDownloads(sp);
			await sp.click("#exportMenuBtn");
			await sp.keyboard.press("ArrowDown");
			await sp.keyboard.press("Enter");
			assert.match((await lastDownload(sp, 1)).name, /\.mid$/);
			assert.strictEqual(await sp.evaluate(() => document.getElementById("exportMenu").hidden), true);
			await sp.click("#exportMenuBtn");
			await sp.click(".staff-toolbar");
			assert.strictEqual(await sp.evaluate(() => document.getElementById("exportMenu").hidden), true, "a click elsewhere closes it");
		});
		await check("no console errors during the share, MIDI, image and print run", () => assert.deepStrictEqual(sErrors, []));
		await sp.close();

		// ── Selection, the clipboard and sound (desktop, then a touch screen) ─
		console.log("\nselection, clipboard, sound");
		const qErrors = [];
		const qp = await openPage(browser, base, VIEWPORTS[VIEWPORTS.length - 1], qErrors);
		const six = [n("C4", 4), n("D4", 4), n("E4", 4), n("F4", 4), n("G4", 4), n("A4", 4)];
		const qLoad = (list, caret) => sLoad(qp, list, caret === undefined ? {} : { caret });
		const qIds = async () => (await sSaved(qp)).notes.map((note) => (note.pitches.length ? note.pitches.join("+") : "rest"));
		const sel = () => qp.evaluate(() => window.Notar.selection());
		const withShift = async (fn) => {
			await qp.keyboard.down("Shift");
			await fn();
			await qp.keyboard.up("Shift");
		};
		const withMeta = async (key) => {
			await qp.keyboard.down("Meta");
			await qp.keyboard.press(key);
			await qp.keyboard.up("Meta");
		};
		const bands = () => qp.evaluate(() => ({
			selection: document.querySelectorAll("#staffSvg .selection-band").length,
			current: document.querySelectorAll("#staffSvg .current-band").length,
		}));

		await check("selection: Shift+← → extend it from the cursor, Shift+Home End too; ← → let it go at its ends", async () => {
			await qLoad(six, 2);
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			assert.deepStrictEqual(await sel(), { start: 2, end: 4 });
			assert.deepStrictEqual(await bands(), { selection: 1, current: 0 }, "one region, and no current-note band");
			assert.match(await status(qp), /^Selected notes 3–4, 2 beats\./);
			const region = await qp.evaluate(() => {
				const band = document.querySelector(".selection-band");
				const groups = [2, 3].map((i) => document.querySelector(`.note-group[data-index="${i}"]`).getBBox());
				const x = Number(band.getAttribute("x"));
				const right = x + Number(band.getAttribute("width"));
				return { covers: groups.every((g) => g.x >= x && g.x + g.width <= right), keys: document.querySelectorAll(".key.held").length };
			});
			assert.deepStrictEqual(region, { covers: true, keys: 0 });
			await withShift(() => qp.keyboard.press("End"));
			assert.deepStrictEqual(await sel(), { start: 2, end: 6 });
			await withShift(() => qp.keyboard.press("Home"));
			assert.deepStrictEqual(await sel(), { start: 0, end: 2 }, "the anchor stays where the selection began");
			await qp.keyboard.press("ArrowRight");
			assert.deepStrictEqual([await sel(), await qp.evaluate(() => window.Notar.cursor())], [null, 2]);
			assert.deepStrictEqual(await bands(), { selection: 0, current: 1 });
			await withMeta("a");
			assert.deepStrictEqual(await sel(), { start: 0, end: 6 }, "⌘A selects every note");
			await qp.keyboard.press("Escape");
			assert.deepStrictEqual([await sel(), await status(qp)], [null, "Selection cleared."]);
		});
		await check("selection: ↑ ↓ transpose it (Shift: an octave), one undo step each, and it stays selected", async () => {
			await qLoad(six, 2);
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			await qp.keyboard.press("ArrowUp");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "F4", "F#4", "G4", "A4"]);
			await withShift(() => qp.keyboard.press("ArrowUp"));
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "F5", "F#5", "G4", "A4"]);
			assert.deepStrictEqual(await sel(), { start: 2, end: 4 });
			await qp.click("#undoBtn");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "F4", "F#4", "G4", "A4"]);
			assert.deepStrictEqual(await sel(), { start: 2, end: 4 }, "undo keeps the selection");
			await qp.evaluate(() => document.activeElement.blur());
			await qp.keyboard.press("ArrowDown");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4"]);
			await qLoad([n("C6", 4), n("rest", 4)], 0);
			await withShift(() => qp.keyboard.press("End"));
			await qp.keyboard.press("ArrowUp");
			assert.deepStrictEqual(await qIds(), ["C6", "rest"], "refused as a whole past C6");
			assert.match(await status(qp), /outside C2–C6/);
		});
		await check("selection: Delete and Backspace delete it as one step; Undo brings it back, selected", async () => {
			await qLoad(six, 1);
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			await qp.keyboard.press("Backspace");
			assert.deepStrictEqual(await qIds(), ["C4", "G4", "A4"]);
			assert.deepStrictEqual([await sel(), await qp.evaluate(() => window.Notar.cursor())], [null, 1]);
			await qp.click("#undoBtn");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4"]);
			assert.deepStrictEqual(await sel(), { start: 1, end: 4 });
			await qp.evaluate(() => document.activeElement.blur());
			await qp.keyboard.press("Delete");
			assert.deepStrictEqual(await qIds(), ["C4", "G4", "A4"]);
			await qp.click("#undoBtn");
			await qp.click("#deleteBtn");
			assert.deepStrictEqual(await qIds(), ["C4", "G4", "A4"], "the Delete button deletes the selection too");
		});
		await check("selection: Apply, Shift+1–5 and Shift+. set its length, one undo step each", async () => {
			await qLoad([n("C4", 4), n("D4", 4, true), n("rest", 4), n("F4", 4)], 0);
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			await qp.click('#durationPicker input[value="3"]');
			await qp.click("#applyLengthBtn");
			const lengths = async () => (await sSaved(qp)).notes.map((note) => `${note.duration}${note.dotted ? "." : ""}`);
			assert.deepStrictEqual(await lengths(), ["8", "8", "8", "4"], "Apply gives the picked length (no dot) to all three, the rest too");
			await qp.evaluate(() => document.activeElement.blur());
			await withShift(() => qp.keyboard.press("Digit2"));
			assert.deepStrictEqual(await lengths(), ["2", "2", "2", "4"]);
			await withShift(() => qp.keyboard.press("Period"));
			assert.deepStrictEqual(await lengths(), ["2.", "2.", "2.", "4"]);
			await withShift(() => qp.keyboard.press("Period"));
			assert.deepStrictEqual(await lengths(), ["2", "2", "2", "4"], "dotted all: the next Shift+. takes the dots off");
			assert.deepStrictEqual(await sel(), { start: 0, end: 3 });
			for (let i = 0; i < 4; i += 1) {
				await qp.click("#undoBtn");
			}
			assert.deepStrictEqual(await lengths(), ["4", "4.", "4", "4"]);
		});
		await check("selection: Shift+click a note extends to it; Shift+drag on the ruler selects; a plain ruler click lets go", async () => {
			await qLoad(six, 1);
			const heads = await qp.evaluate(() => [...document.querySelectorAll(".note-group .note-head")]
				.map((h) => ({ x: Number(h.getAttribute("cx")), y: Number(h.getAttribute("cy")) })));
			const clickAt = (x, y, shiftKey) => qp.evaluate((sx, sy, shift) => {
				const svg = document.getElementById("staffSvg");
				const p = new DOMPoint(sx, sy).matrixTransform(svg.getScreenCTM());
				svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: p.x, clientY: p.y, shiftKey: shift }));
			}, x, y, shiftKey);
			await clickAt(heads[3].x, heads[3].y, true);
			assert.deepStrictEqual(await sel(), { start: 1, end: 4 }, "from the cursor through the clicked note");
			await clickAt(heads[0].x, heads[0].y, true);
			assert.deepStrictEqual(await sel(), { start: 0, end: 1 }, "back past the anchor: the clicked note and up to the anchor");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4"], "a Shift+click writes nothing");
			await clickAt(heads[1].x - 20, 10, false);
			assert.deepStrictEqual([await sel(), await qp.evaluate(() => window.Notar.cursor())], [null, 1], "a plain click on the ruler lets go");
			// A real Shift+drag along the ruler, from the cursor (the gap before note 2) to the gap after note 5.
			const at = await qp.evaluate((xs) => {
				document.getElementById("staffScroll").scrollIntoView({ block: "center" });
				const svg = document.getElementById("staffSvg");
				const m = svg.getScreenCTM();
				return xs.map((x) => new DOMPoint(x, 10).matrixTransform(m)).map((p) => ({ x: p.x, y: p.y }));
			}, [heads[1].x - 20, heads[5].x - 20]);
			await qp.keyboard.down("Shift");
			await qp.mouse.move(at[0].x, at[0].y);
			await qp.mouse.down();
			await qp.mouse.move(at[1].x, at[1].y, { steps: 5 });
			await qp.mouse.up();
			await qp.keyboard.up("Shift");
			assert.deepStrictEqual(await sel(), { start: 1, end: 5 });
			assert.match(await status(qp), /^Selected notes 2–5/);
		});
		await check("selection: on a touch screen a long-press selects the note, dragging stretches it, and the tap writes nothing", async () => {
			await qLoad(six, 6);
			const columns = await qp.evaluate(() => window.Notar.layout().events.map((e) => e.segments[0].x));
			const touch = (type, x, y) => qp.evaluate((t, sx, sy) => {
				const svg = document.getElementById("staffSvg");
				const p = new DOMPoint(sx, sy).matrixTransform(svg.getScreenCTM());
				const init = { bubbles: true, pointerId: 9, pointerType: "touch", isPrimary: true, clientX: p.x, clientY: p.y };
				svg.dispatchEvent(new PointerEvent(t, init));
				if (t === "pointerup") {
					svg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: p.x, clientY: p.y }));
				}
			}, type, x, y);
			await touch("pointerdown", columns[2] + 25, 100);
			await new Promise((r) => setTimeout(r, 600));
			assert.deepStrictEqual(await sel(), { start: 2, end: 3 }, "the held note alone");
			await touch("pointermove", columns[4] + 50, 100);
			assert.deepStrictEqual(await sel(), { start: 2, end: 5 });
			await touch("pointermove", columns[0] + 5, 100);
			assert.deepStrictEqual(await sel(), { start: 0, end: 3 }, "dragged back, it keeps the held note");
			await touch("pointerup", columns[0] + 5, 100);
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4"], "the click that ends the touch writes nothing");
			// A short tap is still a tap: on a note's column it adds a chord tone, and the selection goes.
			await touch("pointerdown", columns[5] + 25, 126 - 2 * 6);
			await touch("pointerup", columns[5] + 25, 126 - 2 * 6);
			assert.deepStrictEqual([(await qIds())[5], await sel()], ["G4+A4", null]);
		});
		await check("selection: a real long-press and drag on a phone selects, and neither scrolls nor writes", async () => {
			// Real touch events, whose target is the element the finger came down on: the redraw as the selection grows
			// must keep that element, or the touchmoves stop reaching the staff and the browser pans instead.
			await withTab(async (phone) => {
				await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
				await phone.goto(base, { waitUntil: "networkidle0" });
				await sLoad(phone, ["C4", "D4", "E4", "F4", "G4", "A4", "H4", "C5"].map((p) => n(p, 4)), { caret: 0 });
				const pts = await phone.evaluate(() => {
					document.getElementById("staffScroll").scrollIntoView({ block: "center" });
					const m = document.getElementById("staffSvg").getScreenCTM();
					const events = window.Notar.layout().events;
					const at = (x) => new DOMPoint(x, 110).matrixTransform(m);
					return [at(events[1].segments[0].x + 25), at(events[3].segments[0].x + 45)].map((p) => ({ x: p.x, y: p.y }));
				});
				const scrolled = () => phone.evaluate(() => [document.getElementById("staffScroll").scrollLeft, window.scrollY]);
				const before = await scrolled();
				await phone.touchscreen.touchStart(pts[0].x, pts[0].y);
				await new Promise((r) => setTimeout(r, 650));
				assert.deepStrictEqual(await phone.evaluate(() => window.Notar.selection()), { start: 1, end: 2 });
				for (let i = 1; i <= 6; i += 1) {
					await phone.touchscreen.touchMove(pts[0].x + ((pts[1].x - pts[0].x) * i) / 6, pts[0].y);
				}
				await phone.touchscreen.touchEnd();
				assert.deepStrictEqual(await phone.evaluate(() => window.Notar.selection()), { start: 1, end: 4 });
				assert.deepStrictEqual(await scrolled(), before, "the page and the staff stay put");
				assert.strictEqual((await sSaved(phone)).notes.length, 8, "nothing written");
				assert.match(await status(phone), /^Selected notes 2–4, 3 beats\. Copy, Cut, Delete and Apply act on it/);
			});
		});
		await check("clipboard: ⌘C copies (in Notar and as text), ⌘V pastes once at the cursor, ⌘X cuts; each one undo step", async () => {
			await qLoad(six, 1);
			await qp.evaluate(() => {
				window.__copied = null;
				navigator.clipboard.writeText = (text) => {
					window.__copied = text;
					return Promise.resolve();
				};
			});
			assert.strictEqual(await qp.$eval("#pasteBtn", (b) => b.getAttribute("aria-disabled")), "true");
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			await withMeta("c");
			const copied = JSON.parse(await qp.evaluate(() => window.__copied));
			assert.deepStrictEqual(copied, { version: 3, notes: [n("D4", 4), n("E4", 4)] }, "the system clipboard gets the Export format");
			assert.match(await status(qp), /^Copied 2 notes/);
			assert.strictEqual(await qp.$eval("#pasteBtn", (b) => b.getAttribute("aria-disabled")), "false");
			await qp.keyboard.press("End");
			await withMeta("v");
			await new Promise((r) => setTimeout(r, 400)); // past the timer that stands in for a missing paste event
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4", "D4", "E4"], "pasted once");
			await qp.click("#undoBtn");
			assert.deepStrictEqual((await qIds()).length, 6);
			// Cut the last two, paste them at the start.
			await qp.evaluate(() => document.activeElement.blur());
			await withShift(async () => {
				await qp.keyboard.press("ArrowLeft");
				await qp.keyboard.press("ArrowLeft");
			});
			await withMeta("x");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4"]);
			await qp.keyboard.press("Home");
			await qp.click("#pasteBtn");
			assert.deepStrictEqual(await qIds(), ["G4", "A4", "C4", "D4", "E4", "F4"]);
			await qp.click("#undoBtn");
			await qp.click("#undoBtn");
			assert.deepStrictEqual(await qIds(), ["C4", "D4", "E4", "F4", "G4", "A4"]);
		});
		await check("clipboard: a paste replaces the selection; text from elsewhere pastes; another tab pastes the copy", async () => {
			await qLoad(six, 0);
			await withShift(() => qp.keyboard.press("ArrowRight"));
			await withMeta("c"); // C4
			await withShift(() => qp.keyboard.press("End"));
			await qp.click("#pasteBtn"); // over C4 … A4: the whole piece becomes C4
			assert.deepStrictEqual(await qIds(), ["C4"]);
			assert.match(await status(qp), /over the 6 notes that were selected/);
			// A paste event (as the system clipboard sends one) with notes as text from another app: they go in.
			await qp.evaluate(() => {
				const data = new DataTransfer();
				data.setData("text/plain", JSON.stringify({ version: 3, notes: [{ pitches: ["E4", "G4"], duration: 2 }] }));
				document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
			});
			assert.deepStrictEqual(await qIds(), ["C4", "E4+G4"]);
			// A ⌘V that the browser answers with a paste event (Chrome and Firefox do; headless Chrome above does not):
			// the event's text pastes, and the timer that stands in for a missing event stands down, so it pastes once.
			await qp.keyboard.down("Meta");
			await qp.keyboard.press("v");
			await qp.evaluate(() => {
				const data = new DataTransfer();
				data.setData("text/plain", JSON.stringify([{ pitches: ["A4"], duration: 8 }]));
				document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
			});
			await qp.keyboard.up("Meta");
			await new Promise((r) => setTimeout(r, 400));
			assert.deepStrictEqual(await qIds(), ["C4", "E4+G4", "A4"], "pasted once, from the event");
			await withTab(async (tab) => {
				await tab.goto(base, { waitUntil: "networkidle0" });
				await tab.click("#pasteBtn");
				assert.deepStrictEqual((await sSaved(tab)).notes.slice(-1), [n("C4", 4)], "Notar's own clipboard reaches another tab");
			});
			await qLoad(six, 0);
			await qp.click("#copyBtn");
			assert.match(await status(qp), /^Select notes first/, "Copy with nothing selected says how to select");
		});
		await check("selection: Play plays only the selection; Esc stops first, then lets the selection go", async () => {
			await qLoad([n("C4+E4", 4), n("D4", 4), n("E4", 4), n("F4+A4+C5", 4)], 1);
			await withShift(async () => {
				await qp.keyboard.press("ArrowRight");
				await qp.keyboard.press("ArrowRight");
			});
			await qp.click("#playBtn");
			await qp.waitForSelector(".note-group.active", { timeout: 3000 });
			const r = await qp.evaluate(() => ({
				voices: window.Notar.voices(),
				active: document.querySelector(".note-group.active").dataset.index,
				status: document.getElementById("status").textContent,
			}));
			assert.deepStrictEqual(r, { voices: 2, active: "1", status: "Playing the selection, notes 2–3…" }, "D4 and E4 only");
			await qp.keyboard.press("Escape");
			const after = await qp.evaluate(() => [window.Notar.isPlaying(), window.Notar.voices()]);
			assert.deepStrictEqual([after, await sel()], [[false, 0], { start: 1, end: 3 }], "stopped, still selected");
			await qp.keyboard.press("Escape");
			assert.strictEqual(await sel(), null);
		});
		await check("metronome: a click on every beat the pass covers, silenced by Stop; persisted", async () => {
			await qLoad([n("C4", 2), n("D4", 4), n("E4", 8)], 0);
			await qp.click("#metronomeBtn");
			await qp.click("#playBtn");
			// Read as soon as the pass is scheduled: a click lasts 80 ms and leaves `voices` when it ends.
			await qp.waitForFunction(() => window.Notar.isPlaying());
			const voices = await qp.evaluate(() => window.Notar.voices());
			await qp.click("#stopBtn");
			assert.strictEqual(voices, 3 + 4, "three notes and four clicks (3½ beats)");
			assert.strictEqual(await qp.evaluate(() => window.Notar.voices()), 0);
			assert.strictEqual((await sSaved(qp)).metronome, true);
			await qp.reload({ waitUntil: "networkidle0" });
			assert.strictEqual(await qp.$eval("#metronomeBtn", (b) => b.getAttribute("aria-pressed")), "true");
			await qp.click("#metronomeBtn");
		});
		await check("sound: the instrument is chosen in Playback and persisted; every one plays a voice per pitch and stops clean", async () => {
			await qLoad([n("C4+E4+G4", 4), n("C5", 4)], 0);
			assert.strictEqual(await qp.evaluate(() => window.Notar.instrument()), "piano", "piano by default");
			for (const instrument of ["epiano", "tone", "piano"]) {
				await qp.click(`#instrumentPicker input[value="${instrument}"]`);
				await qp.click("#playBtn");
				await qp.waitForSelector(".note-group.active", { timeout: 3000 });
				const voices = await qp.evaluate(() => window.Notar.voices());
				await qp.click("#stopBtn");
				assert.deepStrictEqual([voices, await qp.evaluate(() => window.Notar.voices())], [4, 0], instrument);
			}
			await qp.click('#instrumentPicker input[value="epiano"]');
			assert.match(await status(qp), /^Sound: electric piano\./);
			await qp.reload({ waitUntil: "networkidle0" });
			const r = await qp.evaluate(() => ({
				state: window.Notar.instrument(),
				checked: document.querySelector("#instrumentPicker input:checked").value,
				saved: JSON.parse(localStorage.getItem("notar-composition-v1")).instrument,
			}));
			assert.deepStrictEqual(r, { state: "epiano", checked: "epiano", saved: "epiano" });
			await captureDownloads(qp);
			await qp.evaluate(() => document.getElementById("midiBtn").click());
			const midi = parseMidi((await lastDownload(qp, 1)).bytes);
			assert.deepStrictEqual(midi.tracks[0].find((e) => e.kind === 0xc0).data, [4], "MIDI names Electric Piano 1");
		});
		await check("no console errors during the selection, clipboard and sound run", () => assert.deepStrictEqual(qErrors, []));
		await qp.close();

		// ── Review fixes: drafts kept, size limits, tempo, the menu, chords, the metronome, sound (rendered offline) ─
		console.log("\nsafety: drafts, limits, tempo, menu, chords, metronome, sound");
		const fErrors = [];
		const fp = await openPage(browser, base, VIEWPORTS[VIEWPORTS.length - 1], fErrors);
		const fIds = async (target) => (await sSaved(target)).notes.map((note) => (note.pitches.length ? note.pitches.join("+") : "rest"));
		// Share-link bytes built here, as packComposition does: version 1, tempo, note count (LEB128), then per note
		// its head byte and pitch bytes; quarterC4s(n) is n quarter-note C4s (head 0x12, pitch 0x3d).
		const varint = (value) => {
			const out = [];
			let rest = value;
			while (rest > 0x7f) {
				out.push((rest & 0x7f) | 0x80);
				rest >>>= 7;
			}
			return [...out, rest];
		};
		const quarterC4s = (count, bpm = 96) => Buffer.from([1, bpm, ...varint(count), ...new Array(count).fill([0x12, 0x3d]).flat()]);
		const linkOf = (bytes, deflated) => `${base}#n=${deflated ? "D" : "R"}${(deflated ? zlib.deflateSync(bytes) : bytes).toString("base64url")}`;
		const importFile = async (target, payload, pattern) => {
			const file = path.join(os.tmpdir(), `notar-fix-${process.pid}-${Date.now()}.json`);
			fs.writeFileSync(file, JSON.stringify(payload));
			await (await target.$("#importInput")).uploadFile(file);
			await target.waitForFunction((source) => new RegExp(source).test(document.getElementById("status").textContent), {}, pattern.source);
			fs.unlinkSync(file);
		};
		const pasteText = (target, text) => target.evaluate((t) => {
			const data = new DataTransfer();
			data.setData("text/plain", t);
			document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
		}, text);
		const backupStored = (target) => target.evaluate(() => localStorage.getItem("notar-before-link-v1") !== null);
		const bar = (target) => target.evaluate(() => [document.getElementById("restoreBar").hidden, document.getElementById("restoreText").textContent]);
		const keptText = "A shared link replaced your previous piece (2 notes at 80 BPM). It is kept:";

		await check("drafts: the piece a link replaced is kept through a reload; the bar brings it back, or forgets it", async () => {
			const link = linkOf(quarterC4s(3, 120));
			await openLink(fp, link, other);
			assert.strictEqual(await fp.evaluate(() => window.Notar.editedSinceLaunch()), true, "pwa.js must not reload into an update now");
			assert.match(await status(fp), /Undo brings back the 2 notes you had, even after a reload\./);
			assert.deepStrictEqual((await bar(fp))[0], true, "while Undo can reach it, no bar");
			await fp.reload({ waitUntil: "networkidle0" });
			assert.deepStrictEqual(await bar(fp), [false, keptText]);
			await fp.click("#restoreBtn");
			const back = await sSaved(fp);
			assert.deepStrictEqual([back.notes, back.bpm], [other.notes, 80]);
			assert.match(await status(fp), /^Brought back your previous piece: 2 notes at 80 BPM\. Undo returns to the shared one\./);
			assert.deepStrictEqual([(await bar(fp))[0], await backupStored(fp)], [true, false]);
			await fp.click("#undoBtn");
			assert.deepStrictEqual(await fIds(fp), ["C4", "C4", "C4"]);
			// Forget: gone for good.
			await openLink(fp, link, other);
			await fp.reload({ waitUntil: "networkidle0" });
			await fp.click("#forgetBtn");
			assert.deepStrictEqual([(await bar(fp))[0], await backupStored(fp), await status(fp)], [true, false, "Forgot the previous piece."]);
			// Undo of the opening brings the draft back, and with it there is nothing left to keep.
			await openLink(fp, link, other);
			await fp.click("#undoBtn");
			assert.deepStrictEqual([await fIds(fp), await backupStored(fp)], [["G3", "A3"], false]);
			await fp.click("#redoBtn");
			assert.strictEqual(await backupStored(fp), true, "redo keeps it again");
			// A second link over the first, untouched: the piece before both is the one kept.
			await openLink(fp, link, other);
			await fp.evaluate((hash) => {
				location.hash = hash;
			}, linkOf(quarterC4s(1, 100)).split(base)[1]);
			await fp.waitForFunction(() => /1 note at 100 BPM/.test(document.getElementById("status").textContent));
			await fp.reload({ waitUntil: "networkidle0" });
			assert.deepStrictEqual(await bar(fp), [false, keptText]);
			await fp.click("#forgetBtn");
		});
		await check("limits: links, files, pastes and typing stop at 2000 notes, each saying so; a failed save is reported", async () => {
			for (const [bytes, deflated] of [[quarterC4s(2001), true], [quarterC4s(100000), true], [quarterC4s(2001), false]]) {
				await openLink(fp, linkOf(bytes, deflated), other);
				assert.match(await status(fp), /^That share link holds more than the 2000 notes a piece in Notar can have/);
				assert.deepStrictEqual((await sSaved(fp)).notes, other.notes);
			}
			await openLink(fp, linkOf(quarterC4s(2000), true), other);
			assert.strictEqual((await sSaved(fp)).notes.length, 2000, "2000 is allowed");
			await fp.keyboard.press("a");
			assert.match(await status(fp), /^A piece in Notar can have at most 2000 notes/);
			await pasteText(fp, JSON.stringify([n("D4", 4)]));
			assert.match(await status(fp), /^Pasting those notes would take the piece past the 2000 notes/);
			assert.strictEqual((await sSaved(fp)).notes.length, 2000);
			await sLoad(fp, other.notes);
			await importFile(fp, { version: 3, notes: new Array(2001).fill(n("C4", 8)) }, /notes, more than/);
			assert.match(await status(fp), /^That file has 2001 notes, more than the 2000 a piece in Notar can have, so nothing changed\./);
			await pasteText(fp, JSON.stringify(new Array(2500).fill(n("C4", 8))));
			assert.match(await status(fp), /past the 2000 notes/);
			assert.deepStrictEqual((await sSaved(fp)).notes, other.notes);
			// A draft past the limit (none can be made now) loads its first 2000, and says so.
			await sLoad(fp, new Array(2100).fill(n("E4", 16)));
			const trimmed = [(await sSaved(fp)).notes.length, await fp.evaluate(() => document.querySelectorAll("#staffSvg .note-group").length)];
			assert.deepStrictEqual(trimmed, [2000, 2000], "kept and drawn: the first 2000");
			assert.match(await status(fp), /^Your draft had 2100 notes, more than the 2000 a piece can have: these are the first 2000\./);
			// Storage that refuses: the edit is made, and the status says it isn't saved.
			await sLoad(fp, other.notes);
			await fp.evaluate(() => {
				Storage.prototype.setItem = () => {
					throw new DOMException("full", "QuotaExceededError");
				};
			});
			await fp.keyboard.press("a");
			assert.match(await status(fp), /Not saved: the browser's storage is full or blocked/);
			assert.strictEqual(await fp.$eval("#status", (s) => s.classList.contains("error")), true);
			await fp.reload({ waitUntil: "networkidle0" });
		});
		await check("tempo: files, drafts and links are brought into 40–220 BPM; a tempo that isn't a number is left out", async () => {
			await openLink(fp, linkOf(Buffer.from([1, 250, 1, 0x12, 0x3d])), other);
			assert.strictEqual((await sSaved(fp)).bpm, 220, "a link's tempo byte of 250");
			await sLoad(fp, other.notes, { bpm: 80 });
			const one = [n("C4", 4)];
			await importFile(fp, { version: 3, bpm: "fast", notes: one }, /Imported/);
			assert.deepStrictEqual([(await sSaved(fp)).bpm, await status(fp)], [80, "Imported 1 note; its tempo isn't a number, so the tempo stays as it was."]);
			await importFile(fp, { version: 3, bpm: 2, notes: one }, /Imported/);
			assert.deepStrictEqual([(await sSaved(fp)).bpm, await status(fp)], [40, "Imported 1 note; its tempo of 2 became 40 BPM, the nearest Notar plays."]);
			await captureDownloads(fp);
			await fp.evaluate(() => document.getElementById("midiBtn").click());
			const midi = parseMidi((await lastDownload(fp, 1)).bytes);
			assert.deepStrictEqual(midi.tracks[0].find((e) => e.meta === 0x51).data, [0x16, 0xe3, 0x60], "1500000 µs a quarter: 40 BPM");
			await importFile(fp, { version: 3, bpm: 1000, notes: one }, /Imported/);
			assert.strictEqual((await sSaved(fp)).bpm, 220);
			await sLoad(fp, other.notes, { bpm: 1000 });
			assert.deepStrictEqual([(await sSaved(fp)).bpm, await fp.$eval("#bpmLabel", (l) => l.textContent)], [220, "220 BPM"]);
			await sLoad(fp, other.notes, { bpm: "x" });
			assert.strictEqual(await fp.$eval("#bpmLabel", (l) => l.textContent), "96 BPM", "a draft's tempo that isn't one is left out");
		});
		await check("share: a compressed link where the browser lacks DecompressionStream says so, rather than 'damaged'", async () => {
			await withTab(async (tab) => {
				await tab.evaluateOnNewDocument(() => {
					window.DecompressionStream = undefined;
				});
				await openLink(tab, linkOf(quarterC4s(3), true), other);
				assert.match(await status(tab), /^This browser can't open compressed share links/);
				assert.deepStrictEqual((await sSaved(tab)).notes, other.notes);
			});
		});
		await check("the Export menu: a keyboard choice gives focus back to Export, and keys in the menu stay in it", async () => {
			await sLoad(fp, [n("C4", 4)]);
			await captureDownloads(fp);
			const where = () => fp.evaluate(() => [document.getElementById("exportMenu").hidden, document.activeElement.id, window.Notar.isPlaying()]);
			await fp.focus("#exportMenuBtn");
			await fp.keyboard.press("Enter");
			await fp.keyboard.press("a");
			await fp.keyboard.press("Backspace");
			assert.deepStrictEqual(await fIds(fp), ["C4"], "a letter or Backspace in the menu never reaches the composition");
			await fp.keyboard.press("ArrowDown");
			await fp.keyboard.press("Enter");
			assert.match((await lastDownload(fp, 1)).name, /\.mid$/);
			assert.deepStrictEqual(await where(), [true, "exportMenuBtn", false]);
			await fp.keyboard.press("Enter");
			assert.deepStrictEqual(await where(), [false, "exportBtn", false], "the next Enter opens the menu again; it doesn't play");
			await fp.keyboard.press("Escape");
		});
		await check("selection: Shift+key or Chord adds that pitch to every selected note, and takes it out of all again", async () => {
			await sLoad(fp, ["C4", "D4", "E4", "F4", "G4"].map((p) => n(p, 4)), { caret: 4 });
			await fp.keyboard.down("Shift");
			await fp.keyboard.press("ArrowLeft");
			await fp.keyboard.press("ArrowLeft");
			await fp.keyboard.press("KeyH"); // A4, on a backward selection of notes 3–4
			await fp.keyboard.up("Shift");
			assert.deepStrictEqual(await fIds(fp), ["C4", "D4", "E4+A4", "F4+A4", "G4"], "notes 3 and 4, not note 2");
			assert.deepStrictEqual(await fp.evaluate(() => window.Notar.selection()), { start: 2, end: 4 });
			assert.match(await status(fp), /^Added A4 to notes 3–4\./);
			await fp.click("#chordBtn");
			await fp.evaluate(() => document.activeElement.blur());
			await fp.keyboard.press("h"); // Chord on: the same, without Shift; all have A4 now, so it comes out of all
			assert.deepStrictEqual(await fIds(fp), ["C4", "D4", "E4", "F4", "G4"]);
			assert.match(await status(fp), /^Took A4 out of notes 3–4\./);
			await fp.click("#chordBtn");
			await fp.click("#undoBtn");
			assert.deepStrictEqual(await fIds(fp), ["C4", "D4", "E4+A4", "F4+A4", "G4"], "one undo step each");
		});
		await check("metronome: off mid-pass stops the queued clicks at once; on mid-pass clicks the rest of the pass", async () => {
			await sLoad(fp, new Array(8).fill(n("C4", 4)), { caret: 0 });
			await fp.click("#metronomeBtn");
			await fp.click("#playBtn");
			await fp.waitForFunction(() => window.Notar.isPlaying());
			const counts = [await fp.evaluate(() => window.Notar.voices())];
			await fp.click("#metronomeBtn");
			counts.push(await fp.evaluate(() => window.Notar.voices()));
			assert.match(await status(fp), /^Metronome off\./);
			await fp.click("#metronomeBtn");
			counts.push(await fp.evaluate(() => window.Notar.voices()));
			assert.match(await status(fp), /^Metronome on: a click on every beat, from the next one\./);
			await fp.click("#stopBtn");
			counts.push(await fp.evaluate(() => window.Notar.voices()));
			assert.strictEqual(counts[0], 16, "eight notes and eight clicks");
			assert.ok(counts[1] <= 9, `after Off, ${counts[1]} voices: the notes, and at most the one click sounding`);
			assert.ok(counts[2] >= counts[1] + 5, `after On again, ${counts[2]}: the rest of the pass's clicks`);
			assert.strictEqual(counts[3], 0);
			await fp.click("#metronomeBtn");
		});

		// The app's own audio rendered offline: AudioContext is an OfflineAudioContext (48 kHz) before app.js runs, so
		// Play schedules into it, and rendering it gives the samples the speakers would get. One page for every render
		// (each load of it is a fresh context), closed after the last.
		let audioPage = null;
		const offlinePage = async (draft) => {
			if (!audioPage) {
				audioPage = await browser.newPage();
				audioPage.on("pageerror", (e) => fErrors.push(e.message));
				await audioPage.evaluateOnNewDocument(() => {
					const Offline = window.OfflineAudioContext;
					window.AudioContext = class extends Offline {
						constructor() {
							super(1, 48000 * 3, 48000);
							window.__offline = this;
						}
						resume() {
							return Promise.resolve();
						}
						get state() {
							return "running";
						}
					};
					window.__resumeOffline = () => Offline.prototype.resume.call(window.__offline);
				});
			}
			const page = audioPage;
			await page.goto(base, { waitUntil: "networkidle0" });
			await page.evaluate((d) => localStorage.setItem("notar-composition-v1", JSON.stringify(d)), draft);
			await page.reload({ waitUntil: "networkidle0" });
			await page.click("#playBtn");
			await page.waitForFunction(() => window.Notar.isPlaying());
			return page;
		};
		await check("sound: at full volume a piano note stays nearly linear and a chord is rounded, never cut (rendered offline)", async () => {
			// The soft clipper is linear to 0.6 and only nears 1 four times past full scale. Before, a single piano C4
			// at full volume went past the clipper's ±1 range and was cut flat at its ceiling.
			for (const pitches of ["C4", "C2", "C4+E4+G4", "C3+E3+G3"]) {
				const page = await offlinePage({ notes: [n(pitches, 2)], caret: 0, volume: 1, instrument: "piano" });
				const peak = await page.evaluate(async () => {
					const data = (await window.__offline.startRendering()).getChannelData(0);
					let max = 0;
					for (const x of data) {
						max = Math.max(max, Math.abs(x));
					}
					return max;
				});
				const limit = pitches.includes("+") ? 0.99 : 0.95;
				assert.ok(peak > 0.3 && peak < limit, `${pitches} at full volume peaks at ${peak.toFixed(3)}`);
			}
		});
		await check("sound: Stop at the very instant a note starts fades out, with no burst (rendered offline)", async () => {
			// At 60 BPM the second note starts at 1.08 s, on a render quantum, where Stop lands too.
			const page = await offlinePage({ notes: [n("C4", 4), n("E4", 4)], caret: 0, bpm: 60, instrument: "piano" });
			const r = await page.evaluate(async () => {
				const ctx = window.__offline;
				ctx.suspend(1.08).then(() => {
					document.getElementById("stopBtn").click();
					window.__resumeOffline();
				});
				const data = (await ctx.startRendering()).getChannelData(0);
				const peak = (from, to) => {
					let max = 0;
					for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i += 1) {
						max = Math.max(max, Math.abs(data[i]));
					}
					return max;
				};
				return { strike: peak(0.08, 0.3), before: peak(1.03, 1.08), after: peak(1.08, 1.4), voices: window.Notar.voices() };
			});
			assert.ok(r.after <= r.before * 1.05 + 1e-4, `after Stop ${r.after.toFixed(4)}, just before ${r.before.toFixed(4)}`);
			assert.ok(r.after < r.strike * 0.5, `after Stop ${r.after.toFixed(4)}, the first strike ${r.strike.toFixed(4)}`);
			assert.strictEqual(r.voices, 0);
		});
		await check("no console errors during the safety run", () => assert.deepStrictEqual(fErrors, []));
		if (audioPage) {
			await audioPage.close();
		}
		await fp.close();
	} finally {
		await browser.close();
		server.close();
	}

	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
