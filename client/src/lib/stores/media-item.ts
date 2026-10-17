import { get, writable } from "svelte/store";
import type { MediaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { audioArt } from "../media/audio-art.ts";
import { downloadName } from "../media/format.ts";
import { sniffContentType } from "../media/metadata.ts";
import {
	decodeTextPreview,
	isText,
	TEXT_PREVIEW_BYTES,
} from "../media/text.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { uniqueTags } from "../protocol/tags.ts";
import type { SessionReader } from "./session.ts";
export interface MediaState extends api.Media {
	busy: boolean;
	deleted: boolean;
	url: string;
	preview: string;
	text: string | null;
	textTruncated: boolean;
	message: string;
	error: boolean;
	progress: number | null;
}
export interface ObjectUrls {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
}
export interface MediaOptions {
	http?: MediaApi;
	urls?: ObjectUrls;
	download?: (url: string, filename: string) => unknown;
}
export type MediaItem = ReturnType<typeof createMediaItem>;

export function createMediaItem(
	initial: api.Media,
	session: SessionReader,
	{ http = api, urls = URL, download = saveDownload }: MediaOptions = {},
) {
	const state = writable<MediaState>({
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
	const signal = AbortSignal.any([controller.signal, session.signal]);
	const ownedUrls = new Set<string>();
	let content: Blob | null = null;
	let activeLoad: AbortSignal | null = null;
	function makeUrl(blob: Blob) {
		const url = urls.createObjectURL(blob);
		ownedUrls.add(url);
		return url;
	}
	function dispose() {
		if (controller.signal.aborted) {
			return;
		}
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
	const thumb = initial.thumb;
	if (thumb?.length && !signal.aborted) {
		const preview = makeUrl(new Blob([thumb], { type: "image/webp" }));
		state.update((value) => ({ ...value, preview }));
	}
	// Mutations only need the item's lifetime and its ordinary busy guard.
	async function mutate(work: () => Promise<boolean>) {
		if (signal.aborted || get(state).busy || get(state).deleted) {
			return false;
		}
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			return await work();
		} catch (error) {
			if (!signal.aborted) {
				state.update((v) => ({
					...v,
					message: errorMessage(error),
					error: true,
				}));
			}
			return false;
		} finally {
			if (!signal.aborted) {
				state.update((v) => ({ ...v, busy: false }));
			}
		}
	}
	// Content loading alone supports caller cancellation. Keep its guards here.
	async function withContent<T>(
		callerSignal: AbortSignal | undefined,
		useContent: (blob: Blob, signal: AbortSignal) => Promise<T>,
	) {
		if (
			signal.aborted ||
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
			let blob = content;
			if (!blob) {
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
				blob = new Blob([bytes], {
					type: value.metadata?.content_type || "application/octet-stream",
				});
				content = blob;
				const url = makeUrl(blob);
				let preview = value.preview;
				if (value.metadata?.content_type?.startsWith("audio/")) {
					const art = audioArt(bytes);
					if (art) {
						preview = makeUrl(
							new Blob([art], { type: sniffContentType(art, "") }),
						);
					}
				}
				state.update((v) => ({ ...v, url, preview }));
			}
			const result = await useContent(blob, request);
			request.throwIfAborted();
			return result;
		} catch (error) {
			if (!request.aborted) {
				state.update((v) => ({
					...v,
					message: errorMessage(error),
					error: true,
				}));
			}
			return false;
		} finally {
			request.removeEventListener("abort", release);
			release();
		}
	}
	return {
		subscribe: state.subscribe,
		reveal: (callerSignal?: AbortSignal) =>
			withContent(callerSignal, async (blob, request) => {
				const value = get(state);
				if (
					value.text === null &&
					isText(value.metadata?.content_type || "", value.metadata?.name)
				) {
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
			withContent(undefined, async () => {
				const value = get(state);
				await download(
					value.url,
					downloadName(
						value.metadata?.name || value.id,
						value.metadata?.content_type || "",
					),
				);
				return true;
			}),
		updateMetadata: (patch: Metadata) =>
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
				if (signal.aborted) {
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
				if (signal.aborted) {
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
export function saveDownload(url: string, filename: string) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = filename;
	anchor.click();
}
