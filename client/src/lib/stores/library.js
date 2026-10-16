import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { canPreview } from "../media/format.js";
import { normalizeTag } from "../protocol/crypto.js";
import { createMediaItem } from "./media-item.js";

export function createLibrary(
	session,
	{
		http = api,
		mediaOptions = {},
		onChange = () => {},
		confirm = (message) => globalThis.confirm(message),
	} = {},
) {
	const state = writable({
		cards: [],
		query: [],
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
			query: [],
			searchDraft: "",
		}));
	}
	async function search(query = get(state).query, more = false) {
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
		let submitted;
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
			state.update((v) => ({ ...v, status: error.message }));
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
		addTag(tag) {
			let normalized;
			try {
				normalized = normalizeTag(tag);
			} catch (error) {
				state.update((v) => ({ ...v, status: error.message }));
				return false;
			}
			const query = get(state).query;
			const next = query.some(
				(existing) => normalizeTag(existing) === normalized,
			)
				? query
				: [...query, tag.trim()];
			if (next.length > 64) {
				state.update((v) => ({
					...v,
					status: "Too many search tags (maximum 64).",
				}));
				return false;
			}
			state.update((v) => ({ ...v, searchDraft: "" }));
			return search(next);
		},
		removeTag: (tag) =>
			search(get(state).query.filter((existing) => existing !== tag)),
		clearSearch() {
			state.update((v) => ({ ...v, searchDraft: "" }));
			return search([]);
		},
		search,
		more: () => search(get(state).query, true),
		refresh: () => search(get(state).query),
		reveal,
		closePreview,
		download: (id) => cards.get(id)?.media.download(),
		async updateMetadata(id, patch) {
			const saved = await cards.get(id)?.media.updateMetadata(patch);
			if (saved) {
				void onChange();
			}
			return saved;
		},
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
