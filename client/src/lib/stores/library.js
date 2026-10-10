import { get, writable } from "svelte/store";
import { list } from "../api.js";
import { sendUpload } from "../media/upload.js";
import { splitTags } from "../protocol/crypto.js";
import { createMediaItem } from "./media-item.js";

export function createLibrary(session, platform, api = { list, sendUpload }) {
	const state = writable({
		items: [],
		cards: [],
		selected: null,
		next: null,
		query: "",
		loading: false,
		empty: null,
		status: "",
		uploadStatus: "",
		uploading: false,
		uploadProgress: null,
		uploadFailures: [],
	});
	let credentials = null;
	let revision = 0;
	let request;
	let uploadRequest;
	let disposed = false;
	let previewRevision = 0;
	const mediaItems = new Map();
	let uploadSources = new WeakMap();

	function clearMediaItems() {
		previewRevision++;
		for (const media of mediaItems.values()) media.dispose();
		mediaItems.clear();
	}

	function invalidate() {
		uploadSources = new WeakMap();
		revision++;
		request?.abort();
		uploadRequest?.abort();
		clearMediaItems();
		state.update((value) => ({
			...value,
			items: [],
			cards: [],
			selected: null,
			next: null,
			loading: false,
			empty: null,
			status: "",
			uploadStatus: "",
			uploading: false,
			uploadProgress: null,
			uploadFailures: [],
		}));
	}

	async function load(more = false) {
		if (
			!credentials ||
			disposed ||
			(more && (get(state).loading || !get(state).next))
		)
			return;
		if (!more) {
			revision++;
			request?.abort();
			clearMediaItems();
		}
		const version = revision;
		const captured = credentials;
		const controller = new AbortController();
		request = controller;
		const after = more ? get(state).next : null;
		const query = get(state).query;
		state.update((value) => ({
			...value,
			items: more ? value.items : [],
			cards: more ? value.cards : [],
			selected: more ? value.selected : null,
			next: more ? value.next : null,
			loading: true,
			empty: null,
			status: "Loading…",
		}));
		try {
			const page = await api.list({
				...captured,
				tags: query,
				after,
				signal: controller.signal,
			});
			if (disposed || version !== revision || controller.signal.aborted) return;
			// Keep existing entries when cursor pages overlap: a late list response
			// must not overwrite a tag edit that completed while More was loading.
			const entries = new Map(
				(more ? get(state).items : []).map((item) => [item.id, item]),
			);
			for (const item of page.items)
				if (!entries.has(item.id)) entries.set(item.id, item);
			const items = [...entries.values()];
			const cards = items.map((item) => ({ item, media: media(item) }));
			state.update((value) => ({
				...value,
				items,
				cards,
				next: page.next,
				empty:
					!more && !page.items.length
						? splitTags(query).length
							? "search"
							: "library"
						: null,
				status: "",
			}));
		} catch (error) {
			if (!disposed && version === revision && !controller.signal.aborted)
				state.update((value) => ({ ...value, status: error.message }));
		} finally {
			if (!disposed && version === revision)
				state.update((value) => ({ ...value, loading: false }));
		}
	}

	const unsubscribe = session.subscribe((value) => {
		const next =
			value.ready && value.wrappedKey && value.privateKey
				? { serverUrl: value.serverUrl, privateKey: value.privateKey }
				: null;
		if (
			next?.serverUrl === credentials?.serverUrl &&
			next?.privateKey === credentials?.privateKey
		)
			return;
		invalidate();
		credentials = next;
		if (credentials) load();
	});

	async function upload(files) {
		if (disposed || !credentials || get(state).uploading || !files.length)
			return;
		const captured = credentials;
		const controller = new AbortController();
		uploadRequest = controller;
		const current = () =>
			!disposed &&
			credentials === captured &&
			uploadRequest === controller &&
			!controller.signal.aborted;
		let uploaded = false;
		state.update((value) => ({ ...value, uploading: true, uploadStatus: "" }));
		try {
			for (let index = 0; index < files.length; index++) {
				controller.signal.throwIfAborted();
				const file = files[index];
				let source = uploadSources.get(file);
				if (!source) {
					source = { blob: file, name: file.name };
					uploadSources.set(file, source);
				}
				let fileActive = true;
				const progress = (percent) => {
					if (fileActive && current())
						state.update((value) => ({
							...value,
							uploadProgress: {
								name: file.name,
								index: index + 1,
								total: files.length,
								percent,
							},
						}));
				};
				progress(0);
				try {
					await api.sendUpload(
						source,
						captured,
						platform,
						"",
						progress,
						controller.signal,
					);
					controller.signal.throwIfAborted();
					uploaded = true;
					uploadSources.delete(file);
					if (current())
						state.update((value) => ({
							...value,
							uploadFailures: value.uploadFailures.filter(
								(failure) => failure.file !== file,
							),
						}));
				} catch (error) {
					controller.signal.throwIfAborted();
					if (current())
						state.update((value) => ({
							...value,
							uploadFailures: [
								...value.uploadFailures.filter(
									(failure) => failure.file !== file,
								),
								{ file, error: error.message },
							],
						}));
				} finally {
					fileActive = false;
				}
			}
			if (current()) {
				state.update((value) => ({
					...value,
					uploadStatus: "",
					uploadProgress: null,
				}));
				if (uploaded) await load();
			}
		} catch (error) {
			if (current())
				state.update((value) => ({ ...value, uploadStatus: error.message }));
		} finally {
			if (current()) {
				state.update((value) => ({
					...value,
					uploading: false,
					uploadProgress: null,
				}));
				uploadRequest = null;
			}
		}
	}

	function media(item) {
		if (disposed || !credentials) return null;
		let media = mediaItems.get(item.id);
		if (!media) {
			media = createMediaItem(item, credentials, platform);
			mediaItems.set(item.id, media);
		} else media.updateItem(item);
		return media;
	}
	function updateTags(id, metadata, tokens) {
		if (!disposed)
			state.update((value) => ({
				...value,
				items: value.items.map((item) => {
					if (item.id !== id) return item;
					const updated = { ...item, metadata, tokens };
					mediaItems.get(id)?.updateItem(updated);
					return updated;
				}),
			}));
	}
	return {
		subscribe: state.subscribe,
		search(value = get(state).query) {
			if (disposed) return;
			state.update((current) => ({ ...current, query: value }));
			return load();
		},
		more: () => load(true),
		query: () => get(state).query,
		updateTags,
		media,
		async reveal(id, opener) {
			const target = mediaItems.get(id);
			const previewVersion = ++previewRevision;
			const url = await target?.reveal();
			if (
				!url ||
				disposed ||
				previewVersion !== previewRevision ||
				mediaItems.get(id) !== target
			)
				return;
			const metadata = get(target).metadata;
			if (metadata?.content_type?.startsWith("image/"))
				state.update((value) => ({
					...value,
					selected: { id, url, name: metadata.name || id, opener },
				}));
		},
		closePreview() {
			previewRevision++;
			state.update((value) => ({ ...value, selected: null }));
		},
		async remove(id) {
			const target = mediaItems.get(id);
			if (!target || get(target).busy || get(target).deleted) return;
			if (
				!platform.confirm(
					`Delete ${get(target).metadata?.name || id}? This cannot be undone.`,
				)
			)
				return;
			if (await target.remove())
				state.update((value) => ({
					...value,
					selected: value.selected?.id === id ? null : value.selected,
				}));
		},
		async retag(id, tags) {
			const target = mediaItems.get(id);
			const result = await target?.retag(tags);
			if (!result || disposed || mediaItems.get(id) !== target) return false;
			updateTags(id, result.metadata, result.tokens);
			return true;
		},
		upload,
		retryUploads: () =>
			upload(get(state).uploadFailures.map(({ file }) => file)),
		dispose() {
			disposed = true;
			invalidate();
			unsubscribe();
		},
	};
}
