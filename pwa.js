/*
 * The installable app: registers the service worker (sw.js) and applies updates without breaking a session.
 * A new version downloads in the background and waits. It is applied (one reload into the new version) only:
 *   - at launch, before anything has been pressed or played; or
 *   - when the quiet "update ready" hint in the header is tapped. The hint never shows while playing.
 * The composition and settings are saved on every change, so that reload loses nothing. Playback and editing
 * are never interrupted; worst case the update waits for the next launch.
 */
(function () {
	"use strict";
	const hint = document.getElementById("updateBtn");
	if (!("serviceWorker" in navigator) || !window.isSecureContext) {
		return;
	}
	const sw = navigator.serviceWorker;
	let registration = null;
	let applying = false;
	let touched = false; // anything pressed, typed or played since launch

	const playing = () => !!(window.Notar && window.Notar.isPlaying && window.Notar.isPlaying());
	const waiting = () => (registration && registration.waiting && sw.controller ? registration.waiting : null);

	function refresh() {
		if (hint) {
			hint.hidden = !waiting() || playing();
		}
	}

	// Tells the waiting worker to activate now (sw.js calls skipWaiting); the controllerchange handler below then
	// reloads into the new version.
	function apply() {
		const worker = waiting();
		if (!worker || playing()) {
			return;
		}
		applying = true;
		worker.postMessage("skip-waiting");
	}

	["pointerdown", "keydown"].forEach((type) => addEventListener(type, () => { touched = true; }, { capture: true, passive: true }));
	document.addEventListener("notar:playback", refresh);
	if (hint) {
		hint.addEventListener("click", apply);
	}

	// Only a switch this page asked for reloads it; the first install (clients.claim) never does.
	sw.addEventListener("controllerchange", () => {
		if (applying) {
			location.reload();
		}
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
		if (waiting() && !touched && !playing()) {
			apply();
		} else {
			refresh();
		}
		// A long-open app still hears about new versions.
		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState === "visible") {
				registration.update().catch(() => {});
			}
		});
	});
})();
