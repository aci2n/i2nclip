import { get, writable } from "svelte/store";
import { createLibrary } from "./library.js";
import { createPairing } from "./pairing.js";
import { createPendingUpload } from "./pending-upload.js";
import { createSession } from "./session.js";
import { createSettings } from "./settings.js";

// The application owns workflows across view changes; views only render them.
export function createApplication(platform, initialPage, browser = window) {
	const session = createSession(platform);
	const pairing = createPairing(session);
	const settings = createSettings(session, platform);
	const standalone = !initialPage;
	const pageAtLocation = () => {
		const name = standalone
			? new URLSearchParams(browser.location.search).get("page")
			: browser.location.pathname
					.split("/")
					.pop()
					?.replace(/\.html$/, "");
		return ["library", "options", "upload", "unlock"].includes(name)
			? name
			: "library";
	};
	const page = initialPage || pageAtLocation();
	const params = new URLSearchParams(browser.location.search);
	const popupPage = ["upload", "unlock"].includes(page)
		? page
		: params.has("id")
			? "upload"
			: null;
	const auto = popupPage === "unlock" || params.has("auto");
	const pending = popupPage
		? createPendingUpload(session, platform, params.get("id"), undefined, {
				auto,
			})
		: null;
	let library = ["library", "options"].includes(page)
		? createLibrary(session, platform)
		: null;
	const state = writable({ page, library, pending, auto, popupPage });
	let disposed = false;
	const href = (name) => {
		const query = new URLSearchParams();
		if (standalone) query.set("page", name);
		if (popupPage && params.has("id")) query.set("id", params.get("id"));
		if (popupPage && auto) query.set("auto", "");
		const path = standalone ? "" : `${name}.html`;
		return query.size ? `${path}?${query}` : path;
	};
	function show(page) {
		if (disposed) return;
		if (["library", "options"].includes(page))
			library ??= createLibrary(session, platform);
		library?.closePreview();
		state.set({ page, library, pending, auto, popupPage });
	}
	const restore = () => show(pageAtLocation());
	browser.addEventListener("popstate", restore);
	return {
		subscribe: state.subscribe,
		session,
		pairing,
		settings,
		href,
		navigate(event, page) {
			if (
				disposed ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			)
				return;
			event.preventDefault();
			if (get(state).page === page) return;
			browser.history.pushState({}, "", href(page));
			show(page);
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			browser.removeEventListener("popstate", restore);
			pending?.dispose();
			library?.dispose();
			settings.dispose();
			pairing.dispose();
			session.dispose();
		},
	};
}
