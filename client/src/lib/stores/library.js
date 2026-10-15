import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { canPreview } from "../media/format.js";
import { createMediaItem } from "./media-item.js";

export function createLibrary(
	session,
	{
		http = api,
		mediaOptions = {},
		confirm = (message) => globalThis.confirm(message),
	} = {},
) {
	const state = writable({
		cards: [],
		query: "",
		searchDraft: "",
		next: null,
		loading: false,
		empty: null,
		status: "",
		selected: null,
	});
	const cards = new Map();
	let disposed = false;
	let searchController;
	let previewController;
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
	function add(item) {
		if (cards.has(item.id)) {
			return;
		}
		const media = createMediaItem(item, session, { http, ...mediaOptions });
		const row = { media, value: get(media), unsubscribe: null };
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
		}));
	}
	async function search(query = get(state).searchDraft, more = false) {
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
		searchController?.abort();
		searchController = new AbortController();
		const signal = AbortSignal.any([searchController.signal, session.signal]);
		const own = ++revision;
		const submitted = more ? previous.query : query;
		if (!more) {
			closePreview();
			clearCards();
		}
		state.update((v) => ({
			...v,
			query: submitted,
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
				empty: cards.size ? null : submitted.trim() ? "search" : "library",
			}));
			return true;
		} catch (error) {
			if (!disposed && own === revision && !signal.aborted) {
				state.update((v) => ({ ...v, status: error.message }));
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
	function reveal(id, opener) {
		const row = cards.get(id);
		if (
			!row ||
			row.value.busy ||
			row.value.deleted ||
			!canPreview(row.value.metadata?.contentType, row.value.metadata?.name)
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
		editDraft: (searchDraft) => state.update((v) => ({ ...v, searchDraft })),
		search,
		more: () => search(get(state).query, true),
		refresh: () => search(get(state).query),
		reveal,
		closePreview,
		download: (id) => cards.get(id)?.media.download(),
		updateMetadata: (id, patch) => cards.get(id)?.media.updateMetadata(patch),
		async remove(id) {
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
