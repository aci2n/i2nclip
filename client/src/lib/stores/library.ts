import { get, writable } from "svelte/store";
import type { LibraryApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { canPreview } from "../media/format.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { normalizeTag } from "../protocol/tags.ts";
import type { MediaItem, MediaOptions, MediaState } from "./media-item.ts";
import { createMediaItem } from "./media-item.ts";
import type { LibraryContext } from "./session.ts";
export interface LibraryState {
	cards: MediaState[];
	query: string[];
	searchDraft: string;
	next: string | null;
	loading: boolean;
	empty: "library" | "search" | null;
	status: string;
	selected: { id: string; opener?: HTMLElement } | null;
}
export interface LibraryOptions {
	http?: LibraryApi;
	mediaOptions?: MediaOptions;
	onChange?: () => void;
	confirm?: (message: string) => boolean;
}
export type Library = ReturnType<typeof createLibrary>;

interface LibraryDependencies {
	context: LibraryContext;
	http: LibraryApi;
	mediaOptions: MediaOptions;
	onChange: () => void;
	confirm: (message: string) => boolean;
	log: ReturnType<typeof createLog>;
}
interface LibraryCard {
	media: MediaItem;
	value: MediaState;
	unsubscribe: () => void;
}
interface LibraryRuntime {
	state: ReturnType<typeof writable<LibraryState>>;
	cards: Map<string, LibraryCard>;
	disposed: boolean;
	searchController?: AbortController;
	previewController: AbortController | null;
}

export function createLibrary(
	context: LibraryContext,
	{
		http = api,
		mediaOptions = {},
		onChange = () => {},
		confirm = (message: string) => globalThis.confirm(message),
	}: LibraryOptions = {},
) {
	const deps: LibraryDependencies = {
		context,
		http,
		mediaOptions,
		onChange,
		confirm,
		log: createLog("library"),
	};
	const runtime: LibraryRuntime = {
		state: writable<LibraryState>({
			cards: [],
			query: [],
			searchDraft: "",
			next: null,
			loading: false,
			empty: null,
			status: "",
			selected: null,
		}),
		cards: new Map(),
		disposed: false,
		previewController: null,
	};
	void searchLibrary(deps, runtime);

	return {
		subscribe: runtime.state.subscribe,
		editDraft: (searchDraft: string) =>
			runtime.state.update((v) => ({ ...v, searchDraft })),
		addTag: (tag: string) =>
			searchLibrary(deps, runtime, [...get(runtime.state).query, tag], {
				clearDraft: true,
			}),
		removeTag: (tag: string) =>
			searchLibrary(
				deps,
				runtime,
				get(runtime.state).query.filter((existing) => existing !== tag),
			),
		clearSearch: () => searchLibrary(deps, runtime, [], { clearDraft: true }),
		search: searchLibrary.bind(null, deps, runtime),
		more: () =>
			searchLibrary(deps, runtime, get(runtime.state).query, { more: true }),
		refresh: () => searchLibrary(deps, runtime, get(runtime.state).query),
		reveal: revealLibraryMedia.bind(null, runtime),
		closePreview: closePreview.bind(null, runtime),
		download: downloadLibraryMedia.bind(null, runtime),
		updateMetadata: updateLibraryMetadata.bind(null, deps, runtime),
		remove: removeLibraryMedia.bind(null, deps, runtime),
		dispose: disposeLibrary.bind(null, deps, runtime),
	};
}

function publishCards(runtime: LibraryRuntime) {
	runtime.state.update((v) => ({
		...v,
		cards: [...runtime.cards.values()].map((row) => row.value),
	}));
}

function clearCards(runtime: LibraryRuntime) {
	for (const row of runtime.cards.values()) {
		row.unsubscribe();
		row.media.dispose();
	}
	runtime.cards.clear();
	publishCards(runtime);
}

function addCard(
	deps: LibraryDependencies,
	runtime: LibraryRuntime,
	item: api.Media,
) {
	if (runtime.cards.has(item.id)) {
		return;
	}
	const media = createMediaItem(item, deps.context, {
		http: deps.http,
		...deps.mediaOptions,
	});
	const row = { media, value: get(media), unsubscribe: () => {} };
	runtime.cards.set(item.id, row);
	row.unsubscribe = media.subscribe((value) => updateCard(runtime, row, value));
}

function closePreview(runtime: LibraryRuntime) {
	runtime.previewController?.abort();
	runtime.previewController = null;
	runtime.state.update((v) => ({ ...v, selected: null }));
}

function resetLibrary(runtime: LibraryRuntime) {
	closePreview(runtime);
	runtime.searchController?.abort();
	clearCards(runtime);
	runtime.state.update((v) => ({
		...v,
		next: null,
		loading: false,
		empty: null,
		status: "",
		selected: null,
		query: [],
		searchDraft: "",
	}));
}

async function searchLibrary(
	deps: LibraryDependencies,
	runtime: LibraryRuntime,
	query = get(runtime.state).query,
	{ more = false, clearDraft = false } = {},
) {
	if (runtime.disposed || deps.context.signal.aborted) {
		deps.log.debug("search-rejected", { reason: "disposed" });
		return false;
	}
	const previous = get(runtime.state);
	if (more && (previous.loading || !previous.next)) {
		deps.log.debug("search-rejected", {
			reason: previous.loading ? "busy" : "no-next-page",
		});
		return false;
	}
	let submitted: string[];
	try {
		submitted = submittedTags(more ? previous.query : query);
	} catch (error) {
		deps.log.warn("search-invalid", failureFields(error));
		runtime.state.update((v) => ({ ...v, status: errorMessage(error) }));
		return false;
	}
	const operation = deps.log.operation();
	deps.log.debug("search-started", {
		operation,
		more,
		tagCount: submitted.length,
	});
	runtime.searchController?.abort();
	runtime.searchController = new AbortController();
	const signal = AbortSignal.any([
		runtime.searchController.signal,
		deps.context.signal,
	]);
	if (!more) {
		closePreview(runtime);
		clearCards(runtime);
	}
	runtime.state.update((v) => ({
		...v,
		query: submitted,
		searchDraft: clearDraft ? "" : v.searchDraft,
		loading: true,
		empty: null,
		status: "",
		selected: more ? v.selected : null,
		next: more ? v.next : null,
	}));
	try {
		const page = await deps.http.list({
			...deps.context,
			tags: submitted,
			after: more ? previous.next : null,
			signal,
		});
		if (signal.aborted) {
			deps.log.debug("search-stale", { operation });
			return false;
		}
		deps.log.debug("search-completed", {
			operation,
			count: page.items.length,
			hasNext: Boolean(page.next),
		});
		for (const item of page.items) {
			addCard(deps, runtime, item);
		}
		runtime.state.update((v) => ({
			...v,
			next: page.next,
			empty: runtime.cards.size
				? null
				: submitted.length
					? "search"
					: "library",
		}));
		return true;
	} catch (error) {
		if (signal.aborted) {
			deps.log.debug("search-cancelled", { operation });
		} else {
			deps.log.error("search-failed", { operation, ...failureFields(error) });
		}
		if (!signal.aborted) {
			runtime.state.update((v) => ({ ...v, status: errorMessage(error) }));
		}
		return false;
	} finally {
		if (!signal.aborted) {
			runtime.state.update((v) => ({ ...v, loading: false }));
		}
	}
}

async function revealLibraryMedia(
	runtime: LibraryRuntime,
	id: string,
	opener?: HTMLElement,
) {
	const row = runtime.cards.get(id);
	if (
		!row ||
		row.value.busy ||
		row.value.deleted ||
		!canPreview(
			row.value.metadata?.content_type || "",
			row.value.metadata?.name || "",
		)
	) {
		return false;
	}
	runtime.previewController?.abort();
	runtime.previewController = new AbortController();
	runtime.state.update((v) => ({
		...v,
		selected: { id, opener: v.selected?.opener || opener },
	}));
	return row.media.reveal(runtime.previewController.signal).then(Boolean);
}

async function downloadLibraryMedia(runtime: LibraryRuntime, id: string) {
	const row = runtime.cards.get(id);
	return row ? row.media.download() : false;
}

async function updateLibraryMetadata(
	deps: LibraryDependencies,
	runtime: LibraryRuntime,
	id: string,
	patch: Metadata,
) {
	const row = runtime.cards.get(id);
	if (!row) {
		return false;
	}
	const saved = await row.media.updateMetadata(patch);
	if (saved) {
		void deps.onChange();
	}
	return saved;
}

async function removeLibraryMedia(
	deps: LibraryDependencies,
	runtime: LibraryRuntime,
	id: string,
) {
	const row = runtime.cards.get(id);
	if (
		!row ||
		row.value.busy ||
		row.value.deleted ||
		!deps.confirm(
			`Delete ${row.value.metadata?.name || id}? This cannot be undone.`,
		)
	) {
		return false;
	}
	if (await row.media.remove()) {
		void deps.onChange();
		closePreview(runtime);
		return true;
	}
	return false;
}

function disposeLibrary(deps: LibraryDependencies, runtime: LibraryRuntime) {
	deps.log.debug("disposed");
	runtime.disposed = true;
	resetLibrary(runtime);
}

function updateCard(
	runtime: LibraryRuntime,
	row: LibraryCard,
	value: MediaState,
) {
	row.value = value;
	publishCards(runtime);
}

function submittedTags(tags: string[]) {
	const seen = new Set<string>();
	const submitted: string[] = [];
	for (const tag of tags) {
		const normalized = normalizeTag(tag);
		if (!seen.has(normalized)) {
			seen.add(normalized);
			submitted.push(tag.trim());
		}
	}
	if (submitted.length > 64) {
		throw new Error("Too many search tags (maximum 64).");
	}
	return submitted;
}
