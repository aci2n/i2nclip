import { get, writable } from "svelte/store";
import { createLibraryClient } from "../service/scope.js";
import { createLibrary } from "./library.js";
import { createPairing } from "./pairing.js";
import { createPendingUpload } from "./pending-upload.js";
import { createSession } from "./session.js";
import { createSettings } from "./settings.js";
import { createSetup } from "./setup.js";
import { createVault } from "./vault.js";

// The application owns workflows across view changes; views only render them.
export function createApplication(platform, initialPage, browser = window) {
	const root = platform.createService();
	const vault = createVault(root, platform);
	const initialLibrary = new URLSearchParams(browser.location.search).get(
		"library",
	);
	const client = createLibraryClient(
		root,
		initialLibrary,
		(id) => {
			const url = new URL(
				browser.location.href ||
					`http://local${browser.location.pathname}${browser.location.search}`,
			);
			url.searchParams.set("library", id);
			browser.history.replaceState?.({}, "", `${url.pathname}${url.search}`);
		},
		new URLSearchParams(browser.location.search).get("id"),
	);
	const session = createSession(client, platform);
	const pairing = createPairing(client, {
		beforeReceive: async () => {
			const id = client.id();
			const captured = get(client);
			await root.command("libraries.rename", {
				libraryId: id,
				name: get(settings).libraryName,
			});
			const latest = get(client);
			if (
				client.id() !== id ||
				latest.instanceId !== captured.instanceId ||
				latest.session.epoch !== captured.session.epoch
			) {
				throw new Error("Library changed. Start pairing again.");
			}
		},
	});
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
		? createPendingUpload(client, platform, params.get("id"), { auto })
		: null;
	const searchDrafts = new Map();
	const newLibrary = () =>
		createLibrary(client, platform, searchDrafts.get(client.id()));
	let library = ["library", "options"].includes(page) ? newLibrary() : null;
	const state = writable({
		page,
		library,
		pending,
		auto,
		popupPage,
		catalog: [],
		libraryId: initialLibrary,
	});
	let lastSelection;
	function disposeLibrary() {
		if (library) {
			if (lastSelection) {
				searchDrafts.set(lastSelection, {
					query: library.query(),
					draft: library.draft(),
				});
			}
			library.dispose();
		}
	}
	let vaultWasUnlocked = false;
	const unsubscribeCatalog = root.subscribe((value) => {
		const isUnlocked = !value.vault || value.vault.status === "unlocked";
		if (vaultWasUnlocked && !isUnlocked) {
			disposeLibrary();
			library = null;
			searchDrafts.clear();
			settings.resetDraft();
		}
		if (
			!vaultWasUnlocked &&
			isUnlocked &&
			!library &&
			["library", "options"].includes(get(state).page)
		) {
			library = newLibrary();
		}
		vaultWasUnlocked = isUnlocked;
		const id = client.id();
		if (id !== lastSelection && lastSelection) {
			disposeLibrary();
			library = ["library", "options"].includes(get(state).page)
				? newLibrary()
				: null;
		}
		lastSelection = id;
		state.update((value) => ({
			...value,
			library,
			catalog: get(root).catalog || [],
			libraryId: id,
			transientUpload: (get(root).transientUploads || []).find(
				(entry) => entry.id === params.get("id"),
			),
		}));
	});
	let disposed = false;
	const href = (name) => {
		const query = new URLSearchParams();
		if (standalone) {
			query.set("page", name);
		}
		if (client.id()) {
			query.set("library", client.id());
		}
		if (popupPage && params.has("id")) {
			query.set("id", params.get("id"));
		}
		if (popupPage && auto) {
			query.set("auto", "");
		}
		const path = standalone ? "" : `${name}.html`;
		return query.size ? `${path}?${query}` : path;
	};
	function show(page) {
		if (disposed) {
			return;
		}
		if (["library", "options"].includes(page)) {
			library ??= newLibrary();
		}
		library?.closePreview();
		state.update((value) => ({
			...value,
			page,
			library,
			pending,
			auto,
			popupPage,
		}));
	}
	function selectLibrary(id) {
		disposeLibrary();
		client.select(id);
		library = ["library", "options"].includes(get(state).page)
			? newLibrary()
			: null;
		lastSelection = id;
		state.update((value) => ({ ...value, library, libraryId: id }));
	}
	const setup = createSetup(
		root,
		platform,
		() => client.id(),
		(id) => {
			selectLibrary(id);
			settings.edit("feedback", {
				scope: "library",
				text: "Library saved. Download your recovery file before uploading.",
				error: false,
			});
		},
	);
	const restore = () => {
		const id = new URLSearchParams(browser.location.search).get("library");
		if (id && id !== client.id()) {
			selectLibrary(id);
		}
		show(pageAtLocation());
	};
	browser.addEventListener("popstate", restore);
	return {
		subscribe: state.subscribe,
		vault,
		root,
		session,
		pairing,
		settings,
		setup,
		href,
		selectLibrary,
		restoredLibrary(id, result) {
			if (disposed || get(vault).status !== "unlocked") {
				return;
			}
			selectLibrary(id);
			settings.edit("feedback", {
				scope: "library",
				text: `Restored ${result.imported.length} libraries. ${result.skipped} already saved.`,
				error: false,
			});
		},
		async acceptContextUpload(libraryId) {
			await root.command("vault.contextUpload", {
				libraryId,
				id: params.get("id"),
			});
			selectLibrary(libraryId);
		},
		async renameLibrary(name) {
			await root.command("libraries.rename", { libraryId: client.id(), name });
		},
		async forgetLibrary() {
			if (
				platform.confirm(
					"Forget this library and its unfinished uploads? Server files stay saved. Keep a recovery file first.",
				)
			) {
				await root.command("libraries.forget", { libraryId: client.id() });
			}
		},
		navigate(event, page) {
			if (
				disposed ||
				event.button !== 0 ||
				event.metaKey ||
				event.ctrlKey ||
				event.shiftKey ||
				event.altKey
			) {
				return;
			}
			event.preventDefault();
			if (get(state).page === page) {
				return;
			}
			browser.history.pushState({}, "", href(page));
			show(page);
		},
		dispose() {
			if (disposed) {
				return;
			}
			disposed = true;
			browser.removeEventListener("popstate", restore);
			pending?.dispose();
			disposeLibrary();
			settings.dispose();
			setup.dispose();
			pairing.dispose();
			session.dispose();
			unsubscribeCatalog();
			client.dispose();
			vault.dispose();
			root.dispose();
		},
	};
}
