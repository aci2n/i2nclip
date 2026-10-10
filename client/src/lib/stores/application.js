import { get, writable } from "svelte/store";
import { createLibrary } from "./library.js";
import { createPendingUpload } from "./pending-upload.js";
import { createSession } from "./session.js";
import { createSettings } from "./settings.js";

// The application owns workflows across view changes; views only render them.
export function createApplication(platform, initialPage, browser = window) {
	const session = createSession(platform);
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
	function popup(page) {
		if (!["upload", "unlock"].includes(page))
			return { pending: null, auto: false };
		const params = new URLSearchParams(browser.location.search);
		const auto = page === "unlock" || params.has("auto");
		return {
			pending: createPendingUpload(
				session,
				platform,
				params.get("id"),
				undefined,
				{ auto },
			),
			auto,
		};
	}
	let library = ["library", "options"].includes(page)
		? createLibrary(session, platform)
		: null;
	let { pending, auto } = popup(page);
	const state = writable({ page, library, pending, auto });
	let disposed = false;
	const href = (name) =>
		standalone
			? `?page=${name}`
			: `${name === "options" ? "options" : "library"}.html`;
	function show(page) {
		if (disposed) return;
		pending?.dispose();
		({ pending, auto } = popup(page));
		if (["library", "options"].includes(page))
			library ??= createLibrary(session, platform);
		library?.closePreview();
		state.set({ page, library, pending, auto });
	}
	const restore = () => show(pageAtLocation());
	browser.addEventListener("popstate", restore);
	return {
		subscribe: state.subscribe,
		session,
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
			session.dispose();
		},
	};
}
