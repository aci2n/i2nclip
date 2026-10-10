import { get, writable } from "svelte/store";
import { getContent, remove, updateMetadata } from "../api.js";
import { audioArt } from "../media/audio-art.js";
import { downloadName } from "../media/format.js";
import { sniffContentType } from "../media/metadata.js";
import { tagTokens } from "../protocol/crypto.js";
import { uniqueTags } from "../protocol/tags.js";

export function createMediaItem(
	initialItem,
	credentials,
	platform,
	api = { getContent, remove, updateMetadata },
) {
	let item = initialItem;
	const urls = new Set();
	const controller = new AbortController();
	const signal = controller.signal;
	let disposed = false;
	let bytes;
	const makeUrl = (data, type) => {
		const url = URL.createObjectURL(new Blob([data], { type }));
		urls.add(url);
		return url;
	};
	const state = writable({
		...item,
		busy: false,
		deleted: false,
		shown: false,
		progress: null,
		message: "",
		error: false,
		url: "",
		preview: item.thumb?.length ? makeUrl(item.thumb, "image/webp") : "",
	});
	const options = { ...credentials, id: item.id, signal };

	// This advisory check never replaces an action's result.
	const checkedMetadata = item.metadata;
	const checkedTokens = item.tokens || [];
	if (checkedMetadata)
		tagTokens(credentials.privateKey, checkedMetadata.tags || [])
			.then((expected) => {
				if (
					!disposed &&
					get(state).metadata === checkedMetadata &&
					!get(state).message &&
					(expected.length !== checkedTokens.length ||
						expected.some((token) => !checkedTokens.includes(token)))
				) {
					state.update((value) => ({
						...value,
						message: "Tags on the server do not match this file.",
					}));
				}
			})
			.catch(() => {});

	async function run(action) {
		if (disposed || get(state).busy || get(state).deleted) return null;
		state.update((value) => ({
			...value,
			busy: true,
			message: "",
			error: false,
		}));
		try {
			return await action();
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					message: error.message,
					error: true,
				}));
			return null;
		} finally {
			if (!disposed)
				state.update((value) => ({ ...value, busy: false, progress: null }));
		}
	}

	async function content() {
		if (get(state).url) return get(state).url;
		let receiving = true;
		try {
			const result = await api.getContent({
				...options,
				onProgress: (progress) => {
					if (receiving && !disposed)
						state.update((value) => ({ ...value, progress }));
				},
			});
			signal.throwIfAborted();
			bytes = result;
			const type =
				get(state).metadata?.content_type || "application/octet-stream";
			const url = makeUrl(bytes, type);
			state.update((value) => ({ ...value, url }));
			return url;
		} finally {
			receiving = false;
		}
	}

	return {
		subscribe: state.subscribe,
		updateItem(nextItem) {
			if (disposed) return;
			item = nextItem;
			state.update((value) => ({
				...value,
				...nextItem,
				url: value.url,
				preview:
					value.preview ||
					(nextItem.thumb?.length ? makeUrl(nextItem.thumb, "image/webp") : ""),
			}));
		},
		reveal: () =>
			run(async () => {
				const url = await content();
				signal.throwIfAborted();
				const type = get(state).metadata?.content_type || "";
				const art = type.startsWith("audio/") ? audioArt(bytes) : null;
				state.update((value) => ({
					...value,
					shown: true,
					preview: art
						? makeUrl(art, sniffContentType(art, ""))
						: value.preview,
				}));
				return url;
			}),
		download: () =>
			run(async () => {
				const url = await content();
				signal.throwIfAborted();
				const metadata = get(state).metadata;
				await platform.download(
					url,
					downloadName(metadata?.name || item.id, metadata?.content_type),
				);
			}),
		retag: (tags) =>
			run(async () => {
				const value = get(state);
				if (!value.metadata) throw new Error("No metadata to update.");
				const metadata = { ...value.metadata, tags: uniqueTags(tags) };
				const result = await api.updateMetadata({
					...options,
					metadata,
					thumb: item.thumb,
				});
				signal.throwIfAborted();
				state.update((current) => ({
					...current,
					metadata,
					tokens: result.tokens,
					message: "",
				}));
				return { metadata, tokens: result.tokens };
			}),
		remove: () =>
			run(async () => {
				await api.remove(options);
				signal.throwIfAborted();
				bytes = null;
				urls.forEach((url) => {
					URL.revokeObjectURL(url);
				});
				urls.clear();
				state.update((value) => ({
					...value,
					deleted: true,
					url: "",
					preview: "",
				}));
				return true;
			}),
		dispose() {
			disposed = true;
			controller.abort();
			bytes = null;
			urls.forEach((url) => {
				URL.revokeObjectURL(url);
			});
			urls.clear();
		},
	};
}
