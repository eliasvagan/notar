#!/usr/bin/env node
/*
 * The installable app, end to end (puppeteer; found like tests/smoke.cjs does):
 *
 *   node tests/e2e-pwa.cjs
 *
 * Serves this directory at /projects/notar/ (as on eliasv.com) and checks: Chrome reports no installability or
 * manifest errors; the service worker controls the page; a new version waits, shows the quiet hint only when
 * not playing, and applies from it (old cache deleted); and an offline reload still composes and plays.
 * BASE=https://eliasv.com/projects/notar/ runs the installability, control and offline checks against a live site.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const MOUNT = "/projects/notar/";

function loadPuppeteer() {
	for (const c of [process.env.PUPPETEER_MODULE, "puppeteer", path.join(ROOT, "node_modules", "puppeteer"), path.join(ROOT, "..", "..", "node_modules", "puppeteer")].filter(Boolean)) {
		try {
			return require(c);
		} catch (error) {
			// next
		}
	}
	throw new Error("puppeteer not found; set PUPPETEER_MODULE to its path");
}

const TYPES = {
	".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json",
	".png": "image/png", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json",
};

let swOverride = null; // simulate a deploy: serve sw.js with another VERSION

function serve() {
	const server = http.createServer((req, res) => {
		const urlPath = decodeURIComponent(req.url.split("?")[0]);
		if (!urlPath.startsWith(MOUNT)) {
			res.writeHead(404);
			res.end();
			return;
		}
		const rel = urlPath.slice(MOUNT.length) || "index.html";
		const file = path.join(ROOT, rel.endsWith("/") ? rel + "index.html" : rel);
		if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
		if (rel === "sw.js" && swOverride) {
			res.end(swOverride);
			return;
		}
		fs.createReadStream(file).pipe(res);
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

let failed = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`  ok   ${name}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${name}\n       ${error.message}`);
	}
}

const controlled = (page) => page.waitForFunction(() => navigator.serviceWorker.controller && navigator.serviceWorker.controller.state === "activated", { timeout: 15000 });

async function main() {
	const puppeteer = loadPuppeteer();
	const live = process.env.BASE;
	const server = live ? null : await serve();
	const base = live || `http://127.0.0.1:${server.address().port}${MOUNT}`;
	const args = ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"];
	if (process.env.HOST_RULES) {
		args.push(`--host-resolver-rules=${process.env.HOST_RULES}`);
	}
	const browser = await puppeteer.launch({ args });
	const errors = [];
	try {
		const page = await browser.newPage();
		page.on("pageerror", (e) => errors.push(e.message));
		await page.setViewport({ width: 1280, height: 900 });
		const client = await page.createCDPSession();
		console.log(`\n${base}`);
		await page.goto(base, { waitUntil: "networkidle0" });

		await check("the service worker controls the page", async () => {
			await controlled(page);
			const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope);
			assert.strictEqual(new URL(scope).pathname, new URL(base).pathname);
		});

		await check("Chrome reports no manifest or installability errors", async () => {
			const manifest = await client.send("Page.getAppManifest");
			assert.deepStrictEqual(manifest.errors, [], JSON.stringify(manifest.errors));
			const { installabilityErrors } = await client.send("Page.getInstallabilityErrors");
			assert.deepStrictEqual(installabilityErrors, [], JSON.stringify(installabilityErrors));
		});

		await check("the page's icons are the new ones", async () => {
			const icons = await page.evaluate(() => [...document.querySelectorAll("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]")].map((l) => l.getAttribute("href")));
			assert.deepStrictEqual(icons, ["manifest.webmanifest", "favicon.ico", "favicon.svg", "icons/apple-touch-icon.png"]);
			const ok = await page.evaluate(async () => (await Promise.all(["favicon.svg", "favicon.ico", "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"].map((u) => fetch(u, { cache: "no-store" }).then((r) => r.ok)))).every(Boolean));
			assert.ok(ok);
		});

		if (!live) {
			await check("a new version waits, the hint stays hidden while playing, and applying it swaps caches", async () => {
				const before = await page.evaluate(async () => caches.keys());
				assert.strictEqual(before.length, 1, before.join());
				await page.evaluate(() => document.querySelector('.key[data-pitch="C4"]').click());
				swOverride = fs.readFileSync(path.join(ROOT, "sw.js"), "utf8").replace(/const VERSION = '[0-9a-f]*';/, "const VERSION = 'e2e000000000';");
				// Loop, so playback is still going when the update lands.
				await page.evaluate(() => { document.getElementById("loopBtn").click(); document.getElementById("playBtn").click(); });
				await page.waitForFunction(() => window.Notar.isPlaying());
				await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
				await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting, { timeout: 15000 });
				await new Promise((r) => setTimeout(r, 300));
				assert.ok(await page.$eval("#updateBtn", (b) => b.hidden), "hint shown during playback");
				assert.ok(await page.evaluate(() => window.Notar.isPlaying()), "playback was interrupted");
				await page.evaluate(() => { document.getElementById("stopBtn").click(); document.getElementById("loopBtn").click(); });
				await page.waitForFunction(() => !document.getElementById("updateBtn").hidden, { timeout: 5000 });
				const notes = await page.$eval("#noteCount", (n) => n.textContent);
				// The reload is the page's own (controllerchange -> location.reload), so watch for the marker to vanish.
				await page.evaluate(() => { window.__beforeUpdate = true; });
				await page.click("#updateBtn");
				await page.waitForFunction(() => !window.__beforeUpdate && document.readyState === "complete", { timeout: 15000 });
				await controlled(page);
				const version = await page.evaluate(() => new Promise((resolve) => {
					navigator.serviceWorker.addEventListener("message", (e) => resolve(e.data.version), { once: true });
					navigator.serviceWorker.controller.postMessage("version");
				}));
				assert.strictEqual(version, "e2e000000000");
				await page.waitForFunction(async () => (await caches.keys()).length === 1);
				assert.deepStrictEqual(await page.evaluate(async () => caches.keys()), ["notar-shell-e2e000000000"]);
				assert.strictEqual(await page.$eval("#noteCount", (n) => n.textContent), notes, "composition lost on update");
				assert.ok(await page.$eval("#updateBtn", (b) => b.hidden));
			});
		}

		await check("offline: a reload still loads, composes and plays", async () => {
			await page.setOfflineMode(true);
			await client.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
			await page.reload({ waitUntil: "load" });
			const state = await page.evaluate(() => ({
				controlled: !!navigator.serviceWorker.controller,
				keys: document.querySelectorAll(".key").length,
				styled: getComputedStyle(document.querySelector(".panel")).borderTopStyle === "solid",
				clef: document.querySelector("#staffSvg image") ? true : false,
			}));
			assert.ok(state.controlled, "not controlled");
			assert.strictEqual(state.keys, 49);
			assert.ok(state.styled, "styles.css missing");
			await page.evaluate(() => { document.querySelector('.key[data-pitch="E4"]').click(); document.getElementById("playBtn").click(); });
			await page.waitForFunction(() => window.Notar.isPlaying() || /Playing|finished/.test(document.getElementById("status").textContent), { timeout: 5000 })
				.catch(async (e) => { throw new Error(`${e.message}; status: ${await page.$eval("#status", (n) => n.textContent)}`); });
			const clef = await page.evaluate(() => fetch("assets/g-clef.svg").then((r) => r.ok));
			assert.ok(clef, "clef not cached");
			await page.setOfflineMode(false);
		});

		await check("no page errors", () => assert.deepStrictEqual(errors, []));
	} finally {
		await browser.close();
		if (server) {
			server.close();
		}
	}
	console.log(failed ? `\n${failed} failed` : "\nall passed");
	process.exit(failed ? 1 : 0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
