import { get, writable } from "svelte/store";
import { list } from "../api.js";
import { sendUpload } from "../media/upload.js";
import { splitTags } from "../protocol/crypto.js";
import { createMediaItem } from "./media-item.js";
import { createUploadBatch } from "./upload-batch.js";

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
	});
	let credentials = null;
	let identityOperation;
	let revision = 0;
	let request;
	let disposed = false;
	let previewRevision = 0;
	const mediaItems = new Map();

	const batch = createUploadBatch(session, platform, api.sendUpload, () =>
		load(),
	);
	const unsubscribeBatch = batch.subscribe((uploads) =>
		state.update((value) => ({ ...value, ...uploads })),
	);

	function clearMediaItems() {
		previewRevision++;
		for (const media of mediaItems.values()) media.dispose();
		mediaItems.clear();
	}

	function invalidate() {
		revision++;
		identityOperation?.dispose();
		identityOperation = null;
		credentials = null;
		request?.abort();
		batch.reset();
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
		const operation = identityOperation;
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
			const captured = await session.withIdentity(
				operation,
				(identity) => identity,
			);
			controller.signal.throwIfAborted();
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

	const unsubscribe = session.observeIdentity((value) => {
		const next =
			value.ready && value.wrappedKey && value.privateKey
				? {
						serverUrl: value.serverUrl,
						privateKey: value.privateKey,
						identityGeneration: value.identityGeneration,
					}
				: null;

		invalidate();
		credentials = next;
		if (credentials) {
			identityOperation = session.operation({ onInvalidated: invalidate });
			load();
		}
	});

	function media(item) {
		if (disposed || !credentials) return null;
		let media = mediaItems.get(item.id);
		if (!media) {
			media = createMediaItem(item, credentials, platform, undefined, {
				validate: () =>
					session.withIdentity(identityOperation, (identity) => identity),
			});
			mediaItems.set(item.id, media);
		} else media.updateItem(item);
		return media;
	}
	function updateItem(id, changes) {
		if (!disposed)
			state.update((value) => ({
				...value,
				items: value.items.map((item) => {
					if (item.id !== id) return item;
					const updated = { ...item, ...changes };
					mediaItems.get(id)?.updateItem(updated);
					return updated;
				}),
			}));
	}
	function updateTags(id, metadata, tokens) {
		updateItem(id, { metadata, tokens });
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
		updateItem,
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
			if (result.conflict) {
				if (result.item) updateItem(id, result.item);
				return false;
			}
			updateItem(id, result);
			return true;
		},
		upload: batch.upload,
		retryUploads: batch.retryUploads,
		dispose() {
			disposed = true;
			invalidate();
			unsubscribe();
			batch.dispose();
			unsubscribeBatch();
		},
	};
}
