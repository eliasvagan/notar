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
 * tempo/volume/length, import/export and playback.
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
			}));
			assert.strictEqual((await ids()).pop(), "C4+E4+G4");
			assert.deepStrictEqual(r, { symbol: "C", held: ["C4", "E4", "G4"], stems: 1 });
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
