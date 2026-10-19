import { get, writable } from "svelte/store";
import type { MediaApi } from "../api.ts";
import * as api from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { downloadName } from "../media/format.ts";
import {
	decodeTextPreview,
	isText,
	TEXT_PREVIEW_BYTES,
} from "../media/text.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import { uniqueTags } from "../protocol/tags.ts";
import type { ContentSource, ContentStreams } from "./content-streams.ts";
import type { LibraryContext } from "./session.ts";
export interface MediaState extends api.Media {
	ready: boolean;
	busy: boolean;
	deleted: boolean;
	url: string;
	preview: string;
	text: string | null;
	textTruncated: boolean;
	message: string;
	error: boolean;
}
export interface ObjectUrls {
	createObjectURL(blob: Blob): string;
	revokeObjectURL(url: string): void;
}
export interface MediaOptions {
	streams?: ContentStreams;
	http?: MediaApi;
	urls?: ObjectUrls;
	download?: (url: string, filename: string) => unknown;
}
export type MediaItem = ReturnType<typeof createMediaItem>;

export function createMediaItem(
	initial: api.Media,
	context: LibraryContext,
	{
		http = api,
		urls = URL,
		download = saveDownload,
		streams,
	}: MediaOptions = {},
) {
	const log = createLog("media");
	const state = writable<MediaState>({
		...initial,
		ready: false,
		busy: false,
		deleted: false,
		url: "",
		preview: "",
		text: null,
		textTruncated: false,
		message: "",
		error: false,
	});
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, context.signal]);
	const ownedUrls = new Set<string>();
	let previewLease: Awaited<ReturnType<ContentStreams["open"]>> | null = null;
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
		log.debug("disposed", { urlCount: ownedUrls.size });
		controller.abort();
		for (const url of ownedUrls) {
			urls.revokeObjectURL(url);
		}
		ownedUrls.clear();
		previewLease?.dispose();
		previewLease = null;
		state.update((v) => ({
			...v,
			ready: false,
			url: "",
			preview: "",
			text: null,
			textTruncated: false,
			busy: false,
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
	async function mutate(action: string, work: () => Promise<boolean>) {
		if (signal.aborted || get(state).busy || get(state).deleted) {
			log.debug("mutation-rejected", { action, reason: "unavailable" });
			return false;
		}
		const operation = log.operation();
		log.info("mutation-started", { action, operation });
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			const ok = await work();
			if (ok) {
				log.info("mutation-completed", { action, operation });
			} else {
				log.debug("mutation-cancelled", { action, operation });
			}
			return ok;
		} catch (error) {
			if (signal.aborted) {
				log.debug("mutation-cancelled", { action, operation });
			} else {
				log.error("mutation-failed", {
					action,
					operation,
					...failureFields(error),
				});
			}
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
	function source(): ContentSource {
		const value = get(state);
		const content = value.content;
		if (!content) {
			throw new Error("File content descriptor is unavailable.");
		}
		return {
			id: content.id,
			size: content.size,
			name: downloadName(
				value.metadata?.name || value.id,
				value.metadata?.content_type || "",
			),
			type: value.metadata?.content_type || "application/octet-stream",
			read: (start, end, request) =>
				http.readContentRange({
					...context,
					content,
					start,
					end,
					signal: AbortSignal.any([context.signal, request]),
				}),
		};
	}
	async function reveal(callerSignal?: AbortSignal) {
		if (
			signal.aborted ||
			callerSignal?.aborted ||
			get(state).busy ||
			get(state).deleted
		) {
			return false;
		}
		if (get(state).ready) {
			state.update((v) => ({ ...v, message: "", error: false }));
			return true;
		}
		const request = AbortSignal.any(
			callerSignal ? [signal, callerSignal] : [signal],
		);
		activeLoad = request;
		const release = () => {
			if (activeLoad === request) {
				activeLoad = null;
				state.update((v) => ({ ...v, busy: false }));
			}
		};
		request.addEventListener("abort", release, { once: true });
		state.update((v) => ({ ...v, busy: true, message: "", error: false }));
		try {
			const content = source();
			const value = get(state);
			if (isText(content.type, value.metadata?.name)) {
				const bytes = await content.read(
					0,
					Math.min(content.size, TEXT_PREVIEW_BYTES),
					request,
				);
				request.throwIfAborted();
				const textTruncated = content.size > TEXT_PREVIEW_BYTES;
				state.update((v) => ({
					...v,
					text: decodeTextPreview(bytes, textTruncated),
					textTruncated,
					ready: true,
				}));
			} else if (/^(image|audio|video)\//.test(content.type)) {
				if (!streams) {
					throw new Error("Streaming is unavailable.");
				}
				const lease = await streams.open(
					{
						...content,
						async read(start, end, readSignal) {
							try {
								return await content.read(start, end, readSignal);
							} catch (error) {
								if (!request.aborted && !readSignal.aborted) {
									state.update((v) => ({
										...v,
										ready: false,
										error: true,
										message: errorMessage(error),
									}));
								}
								throw error;
							}
						},
					},
					request,
				);
				request.throwIfAborted();
				previewLease?.dispose();
				previewLease = lease;
				state.update((v) => ({ ...v, url: lease.url, ready: true }));
				request.addEventListener(
					"abort",
					() => {
						if (previewLease === lease) {
							previewLease = null;
							state.update((v) => ({ ...v, url: "", ready: false }));
						}
					},
					{ once: true },
				);
			} else {
				state.update((v) => ({ ...v, ready: true }));
			}
			return true;
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
		reveal,
		download: () =>
			mutate("download", async () => {
				if (!streams) {
					throw new Error("Streaming is unavailable.");
				}
				const content = source();
				// Session ownership lets native downloads continue across navigation.
				await streams.download(content, (url) => download(url, content.name));
				return true;
			}),
		updateMetadata: (patch: Metadata) =>
			mutate("metadata", async () => {
				const value = get(state);
				if (!value.metadata) {
					throw new Error("File metadata is unavailable.");
				}
				const metadata = { ...value.metadata, ...patch };
				if (Object.hasOwn(patch, "tags")) {
					metadata.tags = uniqueTags(patch.tags);
				}
				const result = await http.updateMetadata({
					...context,
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
					log.warn("metadata-conflict");
					state.update((v) => ({ ...v, ...result.item }));
					throw new Error(
						"Metadata changed on another device. Review the current metadata and retry.",
					);
				}
				state.update((v) => ({ ...v, ...result, metadata }));
				return true;
			}),
		remove: () =>
			mutate("remove", async () => {
				await http.remove({
					...context,
					id: initial.id,
					signal,
				});
				if (signal.aborted) {
					return false;
				}
				streams?.invalidate(initial.id);
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
export function saveDownload(url: string, _filename: string) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.click();
}
