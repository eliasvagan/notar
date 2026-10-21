// licences-view.js: shows the app's licences.txt inside the app, as a Licences view with a Back control.
// Canonical copy: eliasv_com/tools/licences-view.js (with licences-view.d.ts). Every app vendors both files unchanged
// next to its other source files. Fix them there first, then copy them everywhere. No dependencies.
//
// Apps with a router give the view its own route and use fetchLicences and LABELS in their own component.
// Apps without one call bindLicences once: every link marked data-licences (href="licences.txt", so it still works
// without scripts) then opens the view as an overlay, and #licences in the address opens it too. mountLicences opens
// it directly and returns a function that closes it.

/** The notice tools/licences.mjs writes at the app root. */
export const LICENCES_FILE = 'licences.txt';

export const LABELS = {
	en: { title: 'Licences', back: 'Back', loading: 'Loading…', failed: 'The licences could not be loaded. Try again when you are online.' },
	nb: { title: 'Lisenser', back: 'Tilbake', loading: 'Laster…', failed: 'Lisensene kunne ikke lastes. Prøv igjen når du er på nett.' },
};

/** The text of licences.txt next to the app (resolved against the page's base URL). Rejects anything but plain text,
 * so an app shell served in its place never shows up as the notice. */
export async function fetchLicences(base = document.baseURI) {
	const res = await fetch(new URL(LICENCES_FILE, base), { cache: 'no-cache' });
	const type = res.headers.get('content-type') || '';
	if (!res.ok || !type.startsWith('text/plain')) throw new Error(`${LICENCES_FILE}: ${res.status} ${type}`);
	return res.text();
}

/** Opens the Licences view as an overlay in `host` (default document.body). Escape and Back close it.
 * Markup: section.licences-view > header > (h2, button.licences-back), pre.licences-text. Style it in the app. */
export function mountLicences({ host = document.body, lang = 'en', onClose } = {}) {
	const t = LABELS[lang] || LABELS.en;
	const view = document.createElement('section');
	view.className = 'licences-view';
	view.setAttribute('role', 'dialog');
	view.setAttribute('aria-modal', 'true');
	view.setAttribute('aria-label', t.title);
	const header = document.createElement('header');
	const title = document.createElement('h2');
	title.textContent = t.title;
	const back = document.createElement('button');
	back.type = 'button';
	back.className = 'licences-back';
	back.textContent = t.back;
	const text = document.createElement('pre');
	text.className = 'licences-text';
	text.tabIndex = 0;
	text.textContent = t.loading;
	header.append(title, back);
	view.append(header, text);
	const opener = document.activeElement;
	const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
	const close = () => {
		document.removeEventListener('keydown', onKey, true);
		view.remove();
		if (opener && typeof opener.focus === 'function') opener.focus();
		if (onClose) onClose();
	};
	back.addEventListener('click', close);
	document.addEventListener('keydown', onKey, true);
	host.append(view);
	back.focus();
	fetchLicences().then((s) => { text.textContent = s; }, () => { text.textContent = t.failed; });
	return close;
}

/** Opens the overlay from any link marked data-licences, and whenever the address ends in #licences. */
export function bindLicences({ host, lang = 'en' } = {}) {
	const HASH = '#licences';
	let close = null;
	const clearHash = () => { if (location.hash === HASH) history.replaceState(history.state, '', location.pathname + location.search); };
	const open = () => { if (!close) close = mountLicences({ host, lang, onClose: () => { close = null; clearHash(); } }); };
	document.addEventListener('click', (e) => {
		const link = e.target instanceof Element ? e.target.closest('[data-licences]') : null;
		if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		e.preventDefault();
		if (location.hash !== HASH) history.pushState(history.state, '', HASH);
		open();
	});
	window.addEventListener('hashchange', () => { if (location.hash === HASH) open(); else if (close) close(); });
	if (location.hash === HASH) open();
}
