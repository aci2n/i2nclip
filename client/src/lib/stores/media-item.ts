import { get, type Writable, writable } from "svelte/store";
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

interface MediaItemDependencies {
	initial: api.Media;
	context: LibraryContext;
	http: MediaApi;
	urls: ObjectUrls;
	download: (url: string, filename: string) => unknown;
	streams?: ContentStreams;
	log: ReturnType<typeof createLog>;
}
interface MediaItemRuntime {
	state: Writable<MediaState>;
	controller: AbortController;
	signal: AbortSignal;
	ownedUrls: Set<string>;
	previewLease: Awaited<ReturnType<ContentStreams["open"]>> | null;
	activeLoad: AbortSignal | null;
	onAbort: () => void;
}

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
	const deps: MediaItemDependencies = {
		initial,
		context,
		http,
		urls,
		download,
		streams,
		log: createLog("media"),
	};
	const controller = new AbortController();
	const runtime: MediaItemRuntime = {
		state: writable<MediaState>({
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
		}),
		controller,
		signal: AbortSignal.any([controller.signal, context.signal]),
		ownedUrls: new Set(),
		previewLease: null,
		activeLoad: null,
		onAbort: () => disposeMedia(deps, runtime),
	};
	runtime.signal.addEventListener("abort", runtime.onAbort, { once: true });
	initializeThumbnail(deps, runtime);

	return {
		subscribe: runtime.state.subscribe,
		reveal: revealMedia.bind(null, deps, runtime),
		download: downloadMedia.bind(null, deps, runtime),
		updateMetadata: updateMediaMetadata.bind(null, deps, runtime),
		remove: removeMedia.bind(null, deps, runtime),
		dispose: releaseMedia.bind(null, deps, runtime),
	};
}

function makeMediaUrl(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
	blob: Blob,
) {
	const url = deps.urls.createObjectURL(blob);
	runtime.ownedUrls.add(url);
	return url;
}

function disposeMedia(deps: MediaItemDependencies, runtime: MediaItemRuntime) {
	if (runtime.controller.signal.aborted) {
		return;
	}
	deps.log.debug("disposed", { urlCount: runtime.ownedUrls.size });
	runtime.controller.abort();
	for (const url of runtime.ownedUrls) {
		deps.urls.revokeObjectURL(url);
	}
	runtime.ownedUrls.clear();
	runtime.previewLease?.dispose();
	runtime.previewLease = null;
	runtime.state.update((v) => ({
		...v,
		ready: false,
		url: "",
		preview: "",
		text: null,
		textTruncated: false,
		busy: false,
	}));
}

// Mutations only need the item's lifetime and its ordinary busy guard.
async function mutateMedia(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
	action: string,
	work: () => Promise<boolean>,
) {
	if (
		runtime.signal.aborted ||
		get(runtime.state).busy ||
		get(runtime.state).deleted
	) {
		deps.log.debug("mutation-rejected", { action, reason: "unavailable" });
		return false;
	}
	const operation = deps.log.operation();
	deps.log.info("mutation-started", { action, operation });
	runtime.state.update((v) => ({
		...v,
		busy: true,
		message: "",
		error: false,
	}));
	try {
		const ok = await work();
		if (ok) {
			deps.log.info("mutation-completed", { action, operation });
		} else {
			deps.log.debug("mutation-cancelled", { action, operation });
		}
		return ok;
	} catch (error) {
		if (runtime.signal.aborted) {
			deps.log.debug("mutation-cancelled", { action, operation });
		} else {
			deps.log.error("mutation-failed", {
				action,
				operation,
				...failureFields(error),
			});
		}
		if (!runtime.signal.aborted) {
			runtime.state.update((v) => ({
				...v,
				message: errorMessage(error),
				error: true,
			}));
		}
		return false;
	} finally {
		if (!runtime.signal.aborted) {
			runtime.state.update((v) => ({ ...v, busy: false }));
		}
	}
}

function mediaSource(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
): ContentSource {
	const value = get(runtime.state);
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
			deps.http.readContentRange({
				...deps.context,
				content,
				start,
				end,
				signal: AbortSignal.any([deps.context.signal, request]),
			}),
	};
}

async function revealMedia(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
	callerSignal?: AbortSignal,
) {
	if (
		runtime.signal.aborted ||
		callerSignal?.aborted ||
		get(runtime.state).busy ||
		get(runtime.state).deleted
	) {
		return false;
	}
	if (get(runtime.state).ready) {
		runtime.state.update((v) => ({ ...v, message: "", error: false }));
		return true;
	}
	const request = AbortSignal.any(
		callerSignal ? [runtime.signal, callerSignal] : [runtime.signal],
	);
	runtime.activeLoad = request;
	const release = () => releaseLoad(runtime, request);
	request.addEventListener("abort", release, { once: true });
	runtime.state.update((v) => ({
		...v,
		busy: true,
		message: "",
		error: false,
	}));
	try {
		const content = mediaSource(deps, runtime);
		const value = get(runtime.state);
		if (isText(content.type, value.metadata?.name)) {
			const bytes = await content.read(
				0,
				Math.min(content.size, TEXT_PREVIEW_BYTES),
				request,
			);
			request.throwIfAborted();
			const textTruncated = content.size > TEXT_PREVIEW_BYTES;
			runtime.state.update((v) => ({
				...v,
				text: decodeTextPreview(bytes, textTruncated),
				textTruncated,
				ready: true,
			}));
		} else if (/^(image|audio|video)\//.test(content.type)) {
			if (!deps.streams) {
				throw new Error("Streaming is unavailable.");
			}
			const lease = await deps.streams.open(
				{
					...content,
					read: (start, end, readSignal) =>
						readPreview(
							runtime.state,
							content,
							request,
							start,
							end,
							readSignal,
						),
				},
				request,
			);
			request.throwIfAborted();
			runtime.previewLease?.dispose();
			runtime.previewLease = lease;
			runtime.state.update((v) => ({ ...v, url: lease.url, ready: true }));
			request.addEventListener("abort", () => clearPreview(runtime, lease), {
				once: true,
			});
		} else {
			runtime.state.update((v) => ({ ...v, ready: true }));
		}
		return true;
	} catch (error) {
		if (!request.aborted) {
			runtime.state.update((v) => ({
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

function downloadMedia(deps: MediaItemDependencies, runtime: MediaItemRuntime) {
	return mutateMedia(deps, runtime, "download", () =>
		performDownload(deps, runtime),
	);
}

function updateMediaMetadata(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
	patch: Metadata,
) {
	return mutateMedia(deps, runtime, "metadata", () =>
		performMetadataUpdate(deps, runtime, patch),
	);
}

function removeMedia(deps: MediaItemDependencies, runtime: MediaItemRuntime) {
	return mutateMedia(deps, runtime, "remove", () =>
		performRemoval(deps, runtime),
	);
}

function releaseMedia(deps: MediaItemDependencies, runtime: MediaItemRuntime) {
	runtime.signal.removeEventListener("abort", runtime.onAbort);
	disposeMedia(deps, runtime);
}
export function saveDownload(url: string, _filename: string) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.click();
}

function initializeThumbnail(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
) {
	const thumb = deps.initial.thumb;
	if (thumb?.length && !runtime.signal.aborted) {
		const preview = makeMediaUrl(
			deps,
			runtime,
			new Blob([thumb], { type: "image/webp" }),
		);
		runtime.state.update((value) => ({ ...value, preview }));
	}
}

async function performDownload(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
) {
	if (!deps.streams) {
		throw new Error("Streaming is unavailable.");
	}
	const content = mediaSource(deps, runtime);
	// Session ownership lets native downloads continue across navigation.
	await deps.streams.download(content, (url) =>
		deps.download(url, content.name),
	);
	return true;
}

async function performMetadataUpdate(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
	patch: Metadata,
) {
	const value = get(runtime.state);
	if (!value.metadata) {
		throw new Error("File metadata is unavailable.");
	}
	const metadata = { ...value.metadata, ...patch };
	if (Object.hasOwn(patch, "tags")) {
		metadata.tags = uniqueTags(patch.tags);
	}
	const result = await deps.http.updateMetadata({
		...deps.context,
		id: value.id,
		metadata,
		thumb: value.thumb,
		prevMetaHash: value.metaHash,
		signal: runtime.signal,
	});
	if (runtime.signal.aborted) {
		return false;
	}
	if (result.conflict) {
		deps.log.warn("metadata-conflict");
		runtime.state.update((v) => ({ ...v, ...result.item }));
		throw new Error(
			"Metadata changed on another device. Review the current metadata and retry.",
		);
	}
	runtime.state.update((v) => ({ ...v, ...result, metadata }));
	return true;
}

async function performRemoval(
	deps: MediaItemDependencies,
	runtime: MediaItemRuntime,
) {
	await deps.http.remove({
		...deps.context,
		id: deps.initial.id,
		signal: runtime.signal,
	});
	if (runtime.signal.aborted) {
		return false;
	}
	deps.streams?.invalidate(deps.initial.id);
	disposeMedia(deps, runtime);
	runtime.state.update((v) => ({ ...v, deleted: true }));
	return true;
}

function releaseLoad(runtime: MediaItemRuntime, request: AbortSignal) {
	if (runtime.activeLoad === request) {
		runtime.activeLoad = null;
		runtime.state.update((v) => ({ ...v, busy: false }));
	}
}
function clearPreview(
	runtime: MediaItemRuntime,
	lease: NonNullable<MediaItemRuntime["previewLease"]>,
) {
	if (runtime.previewLease === lease) {
		runtime.previewLease = null;
		runtime.state.update((v) => ({ ...v, url: "", ready: false }));
	}
}
async function readPreview(
	state: MediaItemRuntime["state"],
	content: ContentSource,
	request: AbortSignal,
	start: number,
	end: number,
	readSignal: AbortSignal,
) {
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
}
