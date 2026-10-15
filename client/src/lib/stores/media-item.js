import { get, writable } from "svelte/store";
import * as api from "../api.js";
import { audioArt } from "../media/audio-art.js";
import { downloadName } from "../media/format.js";
import { sniffContentType } from "../media/metadata.js";
import {
	decodeTextPreview,
	isText,
	TEXT_PREVIEW_BYTES,
} from "../media/text.js";
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
		url: "",
		preview: "",
		text: null,
		textTruncated: false,
		message: "",
		error: false,
		progress: null,
	});
	const controller = new AbortController();
	const epoch = session.epoch;
	const signal = AbortSignal.any([controller.signal, session.signal]);
	const ownedUrls = new Set();
	let disposed = false;
	let content;
	let activeLoad;
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
		if (disposed) {
			return;
		}
		disposed = true;
		controller.abort();
		for (const url of ownedUrls) {
			urls.revokeObjectURL(url);
		}
		ownedUrls.clear();
		content = null;
		state.update((v) => ({
			...v,
			url: "",
			preview: "",
			text: null,
			textTruncated: false,
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
	// Mutations only need the item's lifetime and its ordinary busy guard.
	async function mutate(work) {
		if (!current() || get(state).busy || get(state).deleted) {
			return false;
		}
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			return await work();
		} catch (error) {
			if (current()) {
				state.update((v) => ({ ...v, message: error.message, error: true }));
			}
			return false;
		} finally {
			if (current()) {
				state.update((v) => ({ ...v, busy: false }));
			}
		}
	}
	// Content loading alone supports caller cancellation. Keep its guards here.
	async function withContent(callerSignal, useContent) {
		if (
			!current() ||
			get(state).busy ||
			get(state).deleted ||
			callerSignal?.aborted
		) {
			return false;
		}
		const request = AbortSignal.any(
			callerSignal ? [signal, callerSignal] : [signal],
		);
		activeLoad = request;
		const release = () => {
			if (activeLoad === request) {
				activeLoad = null;
				state.update((v) => ({ ...v, busy: false, progress: null }));
			}
		};
		request.addEventListener("abort", release, { once: true });
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			if (!get(state).url) {
				const bytes = await http.getContent({
					...session.credentials(),
					id: initial.id,
					signal: request,
					onProgress: (progress) => {
						if (activeLoad === request && !request.aborted) {
							state.update((v) => ({ ...v, progress }));
						}
					},
				});
				request.throwIfAborted();
				const value = get(state);
				content = new Blob([bytes], {
					type: value.metadata?.contentType || "application/octet-stream",
				});
				const url = makeUrl(content);
				let preview = value.preview;
				if (value.metadata?.contentType?.startsWith("audio/")) {
					const art = audioArt(bytes);
					if (art) {
						preview = makeUrl(
							new Blob([art], { type: sniffContentType(art, "") }),
						);
					}
				}
				state.update((v) => ({ ...v, url, preview }));
			}
			request.throwIfAborted();
			const result = await useContent(request);
			request.throwIfAborted();
			return result;
		} catch (error) {
			if (!request.aborted && current()) {
				state.update((v) => ({ ...v, message: error.message, error: true }));
			}
			return false;
		} finally {
			request.removeEventListener("abort", release);
			release();
		}
	}
	return {
		subscribe: state.subscribe,
		reveal: (callerSignal) =>
			withContent(callerSignal, async (request) => {
				const value = get(state);
				if (
					value.text === null &&
					isText(value.metadata?.contentType, value.metadata?.name)
				) {
					const blob = content;
					const bytes = new Uint8Array(
						await blob.slice(0, TEXT_PREVIEW_BYTES).arrayBuffer(),
					);
					request.throwIfAborted();
					const textTruncated = blob.size > TEXT_PREVIEW_BYTES;
					state.update((v) => ({
						...v,
						text: decodeTextPreview(bytes, textTruncated),
						textTruncated,
					}));
				}
				return get(state).url;
			}),
		download: () =>
			withContent(undefined, async (request) => {
				const value = get(state);
				await download(
					value.url,
					downloadName(
						value.metadata?.name || value.id,
						value.metadata?.contentType,
					),
				);
				request.throwIfAborted();
				return true;
			}),
		updateMetadata: (patch) =>
			mutate(async () => {
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
			mutate(async () => {
				await http.remove({
					...session.credentials(),
					id: initial.id,
					signal,
				});
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
