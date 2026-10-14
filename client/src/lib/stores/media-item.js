import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { audioArt } from "../media/audio-art.js";
import { downloadName } from "../media/format.js";
import { sniffContentType } from "../media/metadata.js";
import { uniqueTags } from "../protocol/tags.js";

export function createMediaItem(
	initial,
	session,
	{ http = api, urls = URL, download = saveDownload } = {},
) {
	const state = writable({
		...initial,
		busy: false,
		deleted: false,
		shown: false,
		url: "",
		preview: "",
		message: "",
		error: false,
		progress: null,
	});
	const controller = new AbortController();
	const epoch = session.epoch;
	const signal = AbortSignal.any([controller.signal, session.signal]);
	const ownedUrls = new Set();
	let bytes;
	let disposed = false;
	function current() {
		return !disposed && !signal.aborted && session.epoch === epoch;
	}
	function makeUrl(blob) {
		if (!current()) {
			return "";
		}
		const url = urls.createObjectURL(blob);
		ownedUrls.add(url);
		return url;
	}
	function dispose() {
		disposed = true;
		controller.abort();
		bytes = null;
		for (const url of ownedUrls) {
			urls.revokeObjectURL(url);
		}
		ownedUrls.clear();
		state.update((v) => ({
			...v,
			url: "",
			preview: "",
			shown: false,
			busy: false,
			progress: null,
		}));
	}
	const onAbort = () => dispose();
	signal.addEventListener("abort", onAbort, { once: true });
	if (initial.thumb?.length) {
		state.update((v) => ({
			...v,
			preview: makeUrl(new Blob([initial.thumb], { type: "image/webp" })),
		}));
	}
	async function run(work) {
		if (!current() || get(state).busy || get(state).deleted) {
			return false;
		}
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			const result = await work();
			if (!current() && !get(state).deleted) {
				return false;
			}
			return result ?? true;
		} catch (error) {
			if (current()) {
				state.update((v) => ({ ...v, message: error.message, error: true }));
			}
			return false;
		} finally {
			if (current()) {
				state.update((v) => ({ ...v, busy: false, progress: null }));
			}
		}
	}
	async function receive() {
		if (bytes) {
			return;
		}
		const result = await http.getContent({
			...session.credentials(),
			id: initial.id,
			signal,
			onProgress: (progress) => {
				if (current()) {
					state.update((v) => ({ ...v, progress }));
				}
			},
		});
		if (!current()) {
			return;
		}
		bytes = result;
		const value = get(state);
		const url = makeUrl(
			new Blob([bytes], {
				type: value.metadata?.content_type || "application/octet-stream",
			}),
		);
		let preview = value.preview;
		if (value.metadata?.content_type?.startsWith("audio/")) {
			const art = audioArt(bytes);
			if (art) {
				preview = makeUrl(new Blob([art], { type: sniffContentType(art, "") }));
			}
		}
		state.update((v) => ({ ...v, url, preview }));
	}
	return {
		subscribe: state.subscribe,
		reveal: () =>
			run(async () => {
				await receive();
				if (!current()) {
					return false;
				}
				state.update((v) => ({ ...v, shown: true }));
				return get(state).url;
			}),
		download: () =>
			run(async () => {
				await receive();
				if (current()) {
					const v = get(state);
					await download(
						v.url,
						downloadName(v.metadata?.name || v.id, v.metadata?.content_type),
					);
				}
			}),
		updateMetadata: (patch) =>
			run(async () => {
				const value = get(state);
				if (!value.metadata) {
					throw new Error("File metadata is unavailable.");
				}
				const metadata = { ...value.metadata, ...patch };
				if (Object.hasOwn(patch, "tags")) {
					metadata.tags = uniqueTags(patch.tags);
				}
				const result = await http.updateMetadata({
					...session.credentials(),
					id: value.id,
					metadata,
					thumb: value.thumb,
					prevMetaHash: value.metaHash,
					signal,
				});
				if (!current()) {
					return false;
				}
				if (result.conflict) {
					state.update((v) => ({ ...v, ...result.item }));
					throw new Error(
						"Metadata changed on another device. Review the current metadata and retry.",
					);
				}
				state.update((v) => ({ ...v, ...result, metadata }));
				return true;
			}),
		remove: () =>
			run(async () => {
				await http.remove({ ...session.credentials(), id: initial.id, signal });
				if (!current()) {
					return false;
				}
				dispose();
				state.update((v) => ({ ...v, deleted: true }));
				return true;
			}),
		dispose() {
			signal.removeEventListener("abort", onAbort);
			dispose();
		},
	};
}

export function saveDownload(url, filename) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
}
