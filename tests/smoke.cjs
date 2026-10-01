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
 * ties across bar lines, beams, and changing an existing note's length.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

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
