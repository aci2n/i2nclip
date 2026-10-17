import { get, writable } from "svelte/store";
import type { LibraryApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { canPreview } from "../media/format.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { normalizeTag } from "../protocol/tags.ts";
import type { MediaItem, MediaOptions, MediaState } from "./media-item.ts";
import { createMediaItem } from "./media-item.ts";
import type { SessionReader } from "./session.ts";
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
	onChange?: () => unknown;
	confirm?: (message: string) => boolean;
}
export type Library = ReturnType<typeof createLibrary>;

export function createLibrary(
	session: SessionReader,
	{
		http = api,
		mediaOptions = {},
		onChange = () => {},
		confirm = (message: string) => globalThis.confirm(message),
	}: LibraryOptions = {},
) {
	const state = writable<LibraryState>({
		cards: [],
		query: [],
		searchDraft: "",
		next: null,
		loading: false,
		empty: null,
		status: "",
		selected: null,
	});
	const cards = new Map<
		string,
		{ media: MediaItem; value: MediaState; unsubscribe: () => void }
	>();
	let disposed = false;
	let searchController: AbortController | undefined;
	let previewController: AbortController | null = null;
	let revision = 0;
	let lastEpoch = session.epoch;
	function publishCards() {
		state.update((v) => ({
			...v,
			cards: [...cards.values()].map((row) => row.value),
		}));
	}
	function clearCards() {
		for (const row of cards.values()) {
			row.unsubscribe();
			row.media.dispose();
		}
		cards.clear();
		publishCards();
	}
	function add(item: api.Media) {
		if (cards.has(item.id)) {
			return;
		}
		const media = createMediaItem(item, session, { http, ...mediaOptions });
		const row = { media, value: get(media), unsubscribe: () => {} };
		cards.set(item.id, row);
		row.unsubscribe = media.subscribe((value) => {
			row.value = value;
			if (!disposed) {
				publishCards();
			}
		});
	}
	function closePreview() {
		previewController?.abort();
		previewController = null;
		state.update((v) => ({ ...v, selected: null }));
	}
	function reset() {
		revision++;
		closePreview();
		searchController?.abort();
		clearCards();
		state.update((v) => ({
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
	async function search(
		query = get(state).query,
		{ more = false, clearDraft = false } = {},
	) {
		if (
			disposed ||
			!get(session).configured ||
			!get(session).unlocked ||
			get(session).busy
		) {
			return false;
		}
		const previous = get(state);
		if (more && (previous.loading || !previous.next)) {
			return false;
		}
		let submitted: string[];
		try {
			const seen = new Set();
			submitted = (more ? previous.query : query)
				.filter((tag) => {
					const normalized = normalizeTag(tag);
					if (seen.has(normalized)) {
						return false;
					}
					seen.add(normalized);
					return true;
				})
				.map((tag) => tag.trim());
			if (submitted.length > 64) {
				throw new Error("Too many search tags (maximum 64).");
			}
		} catch (error) {
			state.update((v) => ({ ...v, status: errorMessage(error) }));
			return false;
		}
		searchController?.abort();
		searchController = new AbortController();
		const signal = AbortSignal.any([searchController.signal, session.signal]);
		const own = ++revision;
		if (!more) {
			closePreview();
			clearCards();
		}
		state.update((v) => ({
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
			const page = await http.list({
				...session.credentials(),
				tags: submitted,
				after: more ? previous.next : null,
				signal,
			});
			if (disposed || signal.aborted || own !== revision) {
				return false;
			}
			for (const item of page.items) {
				add(item);
			}
			state.update((v) => ({
				...v,
				next: page.next,
				empty: cards.size ? null : submitted.length ? "search" : "library",
			}));
			return true;
		} catch (error) {
			if (!disposed && own === revision && !signal.aborted) {
				state.update((v) => ({ ...v, status: errorMessage(error) }));
			}
			return false;
		} finally {
			if (!disposed && own === revision) {
				state.update((v) => ({ ...v, loading: false }));
			}
		}
	}
	const unsubscribe = session.subscribe((value) => {
		if (disposed) {
			return;
		}
		if (value.epoch !== lastEpoch) {
			lastEpoch = value.epoch;
			reset();
		}
		if (
			value.configured &&
			value.unlocked &&
			!value.busy &&
			!get(state).loading &&
			!cards.size &&
			get(state).empty === null &&
			!get(state).status
		) {
			void search(get(state).query);
		}
	});
	function reveal(id: string, opener?: HTMLElement) {
		const row = cards.get(id);
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
		previewController?.abort();
		previewController = new AbortController();
		state.update((v) => ({
			...v,
			selected: { id, opener: v.selected?.opener || opener },
		}));
		return row.media.reveal(previewController.signal).then(Boolean);
	}

	return {
		subscribe: state.subscribe,
		editDraft: (searchDraft: string) =>
			state.update((v) => ({ ...v, searchDraft })),
		addTag: (tag: string) =>
			search([...get(state).query, tag], { clearDraft: true }),
		removeTag: (tag: string) =>
			search(get(state).query.filter((existing) => existing !== tag)),
		clearSearch: () => search([], { clearDraft: true }),
		search,
		more: () => search(get(state).query, { more: true }),
		refresh: () => search(get(state).query),
		reveal,
		closePreview,
		download: (id: string) => cards.get(id)?.media.download(),
		async updateMetadata(id: string, patch: Metadata) {
			const saved = await cards.get(id)?.media.updateMetadata(patch);
			if (saved) {
				void onChange();
			}
			return saved;
		},
		async remove(id: string) {
			const row = cards.get(id);
			if (
				!row ||
				row.value.busy ||
				row.value.deleted ||
				!confirm(
					`Delete ${row.value.metadata?.name || id}? This cannot be undone.`,
				)
			) {
				return false;
			}
			if (await row.media.remove()) {
				void onChange();
				closePreview();
				return true;
			}
			return false;
		},
		dispose() {
			disposed = true;
			unsubscribe();
			reset();
		},
	};
}
