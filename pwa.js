/*
 * The installable app: registers the service worker (sw.js) and keeps Notar on the newest version without breaking
 * a session. Updates are checked on load and whenever the app comes back (visibilitychange, focus, pageshow: an
 * installed app on iOS resumes without a load). A waiting worker is applied by itself (SKIP_WAITING, then one
 * reload on controllerchange) whenever Notar is idle: nothing playing, and nothing edited since launch (a reload
 * would take the undo history; a share link opening at launch is an edit too, its Undo brings back the draft it
 * replaced). Otherwise the quiet "update ready" hint shows (never while playing), and a tap applies it. The
 * composition and settings are saved on every change, so a reload loses nothing else. A reload guard (one per
 * 10 s) stops any update loop.
 */
(function () {
	"use strict";

	/**
	 * The deferral rule. auto: may an update reload the page by itself now? manual: may the hint apply it?
	 * @param {{ playing: boolean, edited: boolean }} s
	 */
	const policy = (s) => ({ auto: !s.playing && !s.edited, manual: !s.playing });
	window.NotarUpdate = { policy };

	const hint = document.getElementById("updateBtn");
	if (!("serviceWorker" in navigator) || !window.isSecureContext) {
		return;
	}
	const RELOAD_KEY = "notar-sw-reload";
	const sw = navigator.serviceWorker;
	let registration = null;
	let applying = false;

	const now = () => policy({
		playing: !!(window.Notar && window.Notar.isPlaying && window.Notar.isPlaying()),
		edited: !!(window.Notar && window.Notar.editedSinceLaunch && window.Notar.editedSinceLaunch()),
	});
	const waiting = () => (registration && registration.waiting && sw.controller ? registration.waiting : null);

	// Tells the waiting worker to activate now (sw.js calls skipWaiting); the controllerchange handler below then
	// reloads into the new version.
	function apply() {
		const worker = waiting();
		if (!worker || !now().manual) {
			return;
		}
		applying = true;
		worker.postMessage({ type: "SKIP_WAITING" });
	}

	/** Apply a waiting worker if Notar is idle; otherwise show the hint when it may be used. */
	function refresh() {
		const p = now();
		if (waiting() && p.auto) {
			apply();
		} else if (hint) {
			hint.hidden = !waiting() || !p.manual;
		}
	}

	function check() {
		if (registration) {
			registration.update().catch(() => {}).finally(refresh);
		}
	}

	document.addEventListener("notar:playback", refresh);
	if (hint) {
		hint.addEventListener("click", apply);
	}

	// Only a switch this page asked for reloads it (the first install claims silently), and only once per 10 s.
	sw.addEventListener("controllerchange", () => {
		if (!applying) {
			return;
		}
		const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
		if (Date.now() - last < 10000) {
			return;
		}
		sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
		location.reload();
	});

	addEventListener("load", async () => {
		try {
			registration = await sw.register("sw.js", { scope: "./" });
		} catch (error) {
			return; // no worker: Notar works as a plain page
		}
		const watch = (worker) => worker && worker.addEventListener("statechange", () => {
			if (worker.state === "installed") {
				refresh();
			}
		});
		watch(registration.installing);
		registration.addEventListener("updatefound", () => watch(registration.installing));
		refresh();
		check();
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				check();
			}
		});
		addEventListener("focus", check);
		addEventListener("pageshow", check);
	});
})();
