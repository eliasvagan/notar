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
 * shortcuts, staff, undo, tempo/volume/length, import/export and playback.
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
			assert.deepStrictEqual((await notes()).map((n) => n.pitch), ["C2", "F#3", "C6"]);
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
			const list = (await notes()).map((n) => n.pitch);
			assert.deepStrictEqual(list.slice(3), ["C4", "C#4", "H5", "C6", "E3", "rest"]);
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
		await check("Backspace undo and Undo button remove notes", async () => {
			const before = (await notes()).length;
			await page.keyboard.press("Backspace");
			await page.click("#undoBtn");
			assert.strictEqual((await notes()).length, before - 2);
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
			assert.deepStrictEqual(r.saved.notes[r.saved.notes.length - 1], { pitch: "G2", duration: 8 });
		});
		await check("export writes version 2 with octave pitches", async () => {
			// Read the export instead of downloading it: a one-shot createObjectURL stub hands over the blob's text,
			// and anchor clicks do nothing.
			const text = await page.evaluate(() => new Promise((resolve) => {
				const original = URL.createObjectURL;
				URL.createObjectURL = (blob) => { blob.text().then(resolve); URL.createObjectURL = original; return "blob:stub"; };
				HTMLAnchorElement.prototype.click = function () {};
				document.getElementById("exportBtn").click();
			}));
			const payload = JSON.parse(text);
			assert.strictEqual(payload.version, 2);
			assert.strictEqual(payload.bpm, 120);
			assert.ok(payload.notes.some((n) => n.pitch === "C2"));
		});
		await check("importing a version-1 file maps C…H to octave 4", async () => {
			const file = path.join(os.tmpdir(), `notar-v1-${process.pid}.json`);
			fs.writeFileSync(file, JSON.stringify({ version: 1, bpm: 90, notes: [{ pitch: "C", duration: 4 }, { pitch: "H", duration: 2 }, { pitch: "rest", duration: 4 }] }));
			const input = await page.$("#importInput");
			await input.uploadFile(file);
			await page.waitForFunction(() => /Imported/.test(document.getElementById("status").textContent));
			fs.unlinkSync(file);
			assert.deepStrictEqual((await notes()).map((n) => n.pitch), ["C4", "H4", "rest"]);
		});
		await check("playback highlights notes and keys, Stop ends it", async () => {
			await page.click("#playBtn");
			await page.waitForSelector(".note-group.active", { timeout: 3000 });
			await page.waitForSelector(".key.sounding", { timeout: 3000 });
			await page.click("#stopBtn");
			const r = await page.evaluate(() => ({ active: document.querySelectorAll(".note-group.active").length, play: document.getElementById("playBtn").disabled }));
			assert.deepStrictEqual(r, { active: 0, play: false });
		});
		await check("Clear empties the composition", async () => {
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
