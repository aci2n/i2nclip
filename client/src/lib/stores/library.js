import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { canPreview } from "../media/format.js";
import { sendUpload } from "../media/upload.js";
import { createMediaItem } from "./media-item.js";

export function createLibrary(
	session,
	{
		http = api,
		send = sendUpload,
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
		uploading: false,
		uploadProgress: null,
		uploadFailures: [],
		uploadCompleted: [],
		uploadStatus: "",
		selected: null,
	});
	const cards = new Map();
	let disposed = false;
	let searchController;
	let revision = 0;
	let uploadRevision = 0;
	let previewRevision = 0;
	let lastEpoch = session.epoch;
	let batchActive = false;
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
	function reset() {
		revision++;
		uploadRevision++;
		previewRevision++;
		searchController?.abort();
		clearCards();
		batchActive = false;
		state.update((v) => ({
			...v,
			next: null,
			loading: false,
			empty: null,
			status: "",
			selected: null,
			uploading: false,
			uploadProgress: null,
			uploadFailures: [],
			uploadCompleted: [],
			uploadStatus: "",
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
			previewRevision++;
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
	async function upload(files) {
		if (
			disposed ||
			batchActive ||
			!files.length ||
			!get(session).unlocked ||
			!get(session).configured ||
			get(session).busy
		) {
			return false;
		}
		batchActive = true;
		const own = ++uploadRevision;
		const signal = session.signal;
		const credentials = session.credentials();
		state.update((v) => ({
			...v,
			uploading: true,
			uploadStatus: "",
			uploadFailures: [],
			uploadCompleted: [],
		}));
		const failed = [];
		for (const [index, file] of files.entries()) {
			if (disposed || signal.aborted || own !== uploadRevision) {
				break;
			}
			state.update((v) => ({
				...v,
				uploadProgress: {
					name: file.name,
					index: index + 1,
					total: files.length,
					percent: 0,
				},
			}));
			let finished = false;
			try {
				const item = await send({
					file,
					credentials,
					signal,
					onProgress: (percent) => {
						if (
							!finished &&
							!disposed &&
							!signal.aborted &&
							own === uploadRevision
						) {
							state.update((v) => ({
								...v,
								uploadProgress: {
									name: file.name,
									index: index + 1,
									total: files.length,
									percent,
								},
							}));
						}
					},
				});
				if (!disposed && !signal.aborted && own === uploadRevision) {
					state.update((v) => ({
						...v,
						uploadCompleted: [
							...v.uploadCompleted,
							{ id: item.id, name: file.name },
						],
					}));
				}
			} catch (error) {
				if (!disposed && !signal.aborted && own === uploadRevision) {
					failed.push({ name: file.name, error: error.message });
				}
			} finally {
				finished = true;
			}
		}
		if (disposed || signal.aborted || own !== uploadRevision) {
			return false;
		}
		batchActive = false;
		state.update((v) => ({
			...v,
			uploading: false,
			uploadProgress: null,
			uploadFailures: failed,
			uploadStatus: failed.length
				? `${failed.length} file(s) failed. Select the failed files again through Upload.`
				: "Upload complete.",
		}));
		await search(get(state).query);
		return !failed.length;
	}
	async function reveal(id, opener) {
		const row = cards.get(id);
		const previous = get(state).selected;
		if (
			!row ||
			row.value.busy ||
			row.value.deleted ||
			previous?.loading ||
			!canPreview(row.value.metadata?.content_type)
		) {
			return false;
		}
		const type = row.value.metadata.content_type;
		const own = ++previewRevision;
		state.update((v) => ({
			...v,
			selected: {
				id,
				url: previous?.url || "",
				type: previous?.type || type,
				preview: previous ? previous.preview : row.value.preview,
				name: previous?.name || row.value.metadata.name,
				opener: previous?.opener || opener,
				loading: true,
				error: "",
			},
		}));
		const url = await row.media.reveal();
		if (!disposed && own === previewRevision && cards.get(id) === row) {
			state.update((v) => ({
				...v,
				selected: {
					...v.selected,
					...(url
						? {
								url,
								type,
								preview: row.value.preview,
								name: row.value.metadata.name,
							}
						: {}),
					loading: false,
					error: url ? "" : row.value.message || "Could not load this media.",
				},
			}));
		}
		return Boolean(url);
	}

	return {
		subscribe: state.subscribe,
		editDraft: (searchDraft) => state.update((v) => ({ ...v, searchDraft })),
		search,
		more: () => search(get(state).query, true),
		upload,
		dismissCompleted: () =>
			state.update((v) => ({
				...v,
				uploadCompleted: [],
				uploadStatus:
					v.uploadFailures.length || v.uploading ? v.uploadStatus : "",
			})),
		reveal,
		async morePreview() {
			const previous = get(state);
			if (
				!previous.selected ||
				previous.selected.loading ||
				previous.loading ||
				!previous.next
			) {
				return false;
			}
			const own = ++previewRevision;
			state.update((v) => ({
				...v,
				selected: { ...v.selected, loading: true, paging: true, error: "" },
			}));
			let nextMedia;
			while (get(state).next && !nextMedia) {
				const count = cards.size;
				const ok = await search(get(state).query, true);
				if (disposed || own !== previewRevision) {
					return false;
				}
				if (!ok) {
					state.update((v) => ({
						...v,
						selected: {
							...v.selected,
							loading: false,
							error: v.status || "Could not load more media.",
						},
					}));
					return false;
				}
				nextMedia = get(state)
					.cards.slice(count)
					.find(
						(media) =>
							!media.deleted && canPreview(media.metadata?.content_type),
					);
			}
			state.update((v) => ({
				...v,
				selected: { ...v.selected, loading: false, paging: false },
			}));
			return nextMedia ? reveal(nextMedia.id) : false;
		},
		closePreview() {
			previewRevision++;
			state.update((v) => ({ ...v, selected: null }));
		},
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
				previewRevision++;
				state.update((v) => ({ ...v, selected: null }));
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
