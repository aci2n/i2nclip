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

export function createMediaItem(
	initial: api.Media,
	context: LibraryContext,
	options: MediaOptions = {},
): Pick<MediaItemStoreImpl, keyof MediaItemStoreImpl> {
	return new MediaItemStoreImpl(initial, context, options);
}

class MediaItemStoreImpl {
	private readonly initial: api.Media;
	private readonly context: LibraryContext;
	private readonly http: MediaApi;
	private readonly urls: ObjectUrls;
	private readonly saveFile: (url: string, filename: string) => unknown;
	private readonly streams?: ContentStreams;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<MediaState>;
	private readonly controller: AbortController;
	private readonly signal: AbortSignal;
	private readonly ownedUrls: Set<string>;
	private previewLease: Awaited<ReturnType<ContentStreams["open"]>> | null;
	private activeLoad: AbortSignal | null;
	private onAbort: () => void;

	readonly subscribe: Writable<MediaState>["subscribe"];
	readonly reveal = this.revealMedia.bind(this);
	readonly download = this.downloadMedia.bind(this);
	readonly updateMetadata = this.updateMediaMetadata.bind(this);
	readonly remove = this.removeMedia.bind(this);
	readonly dispose = this.releaseMedia.bind(this);

	constructor(
		initial: api.Media,
		context: LibraryContext,
		{
			http = api,
			urls = URL,
			download = saveDownload,
			streams,
		}: MediaOptions = {},
	) {
		this.initial = initial;
		this.context = context;
		this.http = http;
		this.urls = urls;
		this.saveFile = download;
		this.streams = streams;
		this.log = createLog("media");
		const controller = new AbortController();
		this.state = writable<MediaState>({
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
		this.subscribe = this.state.subscribe;
		this.controller = controller;
		this.signal = AbortSignal.any([controller.signal, context.signal]);
		this.ownedUrls = new Set();
		this.previewLease = null;
		this.activeLoad = null;
		this.onAbort = this.disposeMedia.bind(this);
		if (this.signal.aborted) {
			this.disposeMedia();
		} else {
			this.signal.addEventListener("abort", this.onAbort, { once: true });
			try {
				this.initializeThumbnail();
			} catch (error) {
				this.releaseMedia();
				throw error;
			}
		}
	}

	private makeMediaUrl(blob: Blob) {
		const url = this.urls.createObjectURL(blob);
		this.ownedUrls.add(url);
		return url;
	}

	private disposeMedia() {
		if (this.controller.signal.aborted) {
			return;
		}
		this.log.debug("disposed", { urlCount: this.ownedUrls.size });
		this.controller.abort();
		for (const url of this.ownedUrls) {
			this.urls.revokeObjectURL(url);
		}
		this.ownedUrls.clear();
		this.previewLease?.dispose();
		this.previewLease = null;
		this.state.update((v) => ({
			...v,
			ready: false,
			url: "",
			preview: "",
			text: null,
			textTruncated: false,
			busy: false,
		}));
	}

	private async mutateMedia(action: string, work: () => Promise<boolean>) {
		if (
			this.signal.aborted ||
			get(this.state).busy ||
			get(this.state).deleted
		) {
			this.log.debug("mutation-rejected", { action, reason: "unavailable" });
			return false;
		}
		const operation = this.log.operation();
		this.log.info("mutation-started", { action, operation });
		this.state.update((v) => ({
			...v,
			busy: true,
			message: "",
			error: false,
		}));
		try {
			const ok = await work();
			if (ok) {
				this.log.info("mutation-completed", { action, operation });
			} else {
				this.log.debug("mutation-cancelled", { action, operation });
			}
			return ok;
		} catch (error) {
			if (this.signal.aborted) {
				this.log.debug("mutation-cancelled", { action, operation });
			} else {
				this.log.error("mutation-failed", {
					action,
					operation,
					...failureFields(error),
				});
			}
			if (!this.signal.aborted) {
				this.state.update((v) => ({
					...v,
					message: errorMessage(error),
					error: true,
				}));
			}
			return false;
		} finally {
			if (!this.signal.aborted) {
				this.state.update((v) => ({ ...v, busy: false }));
			}
		}
	}

	private mediaSource(): ContentSource {
		const value = get(this.state);
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
				this.http.readContentRange({
					...this.context,
					content,
					start,
					end,
					signal: AbortSignal.any([this.context.signal, request]),
				}),
		};
	}

	private async revealMedia(callerSignal?: AbortSignal) {
		if (
			this.signal.aborted ||
			callerSignal?.aborted ||
			get(this.state).busy ||
			get(this.state).deleted
		) {
			return false;
		}
		if (get(this.state).ready) {
			this.state.update((v) => ({ ...v, message: "", error: false }));
			return true;
		}
		const request = AbortSignal.any(
			callerSignal ? [this.signal, callerSignal] : [this.signal],
		);
		this.activeLoad = request;
		const release = () => this.releaseLoad(request);
		request.addEventListener("abort", release, { once: true });
		this.state.update((v) => ({
			...v,
			busy: true,
			message: "",
			error: false,
		}));
		try {
			const content = this.mediaSource();
			const value = get(this.state);
			if (isText(content.type, value.metadata?.name)) {
				const bytes = await content.read(
					0,
					Math.min(content.size, TEXT_PREVIEW_BYTES),
					request,
				);
				request.throwIfAborted();
				const textTruncated = content.size > TEXT_PREVIEW_BYTES;
				this.state.update((v) => ({
					...v,
					text: decodeTextPreview(bytes, textTruncated),
					textTruncated,
					ready: true,
				}));
			} else if (/^(image|audio|video)\//.test(content.type)) {
				if (!this.streams) {
					throw new Error("Streaming is unavailable.");
				}
				const lease = await this.streams.open(
					{
						...content,
						read: (start, end, readSignal) =>
							this.readPreview(content, request, start, end, readSignal),
					},
					request,
				);
				request.throwIfAborted();
				this.previewLease?.dispose();
				this.previewLease = lease;
				this.state.update((v) => ({ ...v, url: lease.url, ready: true }));
				request.addEventListener("abort", () => this.clearPreview(lease), {
					once: true,
				});
			} else {
				this.state.update((v) => ({ ...v, ready: true }));
			}
			return true;
		} catch (error) {
			if (!request.aborted) {
				this.state.update((v) => ({
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

	private downloadMedia() {
		return this.mutateMedia("download", () => this.performDownload());
	}

	private updateMediaMetadata(patch: Metadata) {
		return this.mutateMedia("metadata", () =>
			this.performMetadataUpdate(patch),
		);
	}

	private removeMedia() {
		return this.mutateMedia("remove", () => this.performRemoval());
	}

	private releaseMedia() {
		this.signal.removeEventListener("abort", this.onAbort);
		this.disposeMedia();
	}

	private initializeThumbnail() {
		const thumb = this.initial.thumb;
		if (thumb?.length && !this.signal.aborted) {
			const preview = this.makeMediaUrl(
				new Blob([thumb], { type: "image/webp" }),
			);
			this.state.update((value) => ({ ...value, preview }));
		}
	}

	private async performDownload() {
		if (!this.streams) {
			throw new Error("Streaming is unavailable.");
		}
		const content = this.mediaSource();
		// Session ownership lets native downloads continue across navigation.
		await this.streams.download(content, (url) =>
			this.saveFile(url, content.name),
		);
		return true;
	}

	private async performMetadataUpdate(patch: Metadata) {
		const value = get(this.state);
		if (!value.metadata) {
			throw new Error("File metadata is unavailable.");
		}
		const metadata = { ...value.metadata, ...patch };
		if (Object.hasOwn(patch, "tags")) {
			metadata.tags = uniqueTags(patch.tags);
		}
		const result = await this.http.updateMetadata({
			...this.context,
			id: value.id,
			metadata,
			thumb: value.thumb,
			prevMetaHash: value.metaHash,
			signal: this.signal,
		});
		if (this.signal.aborted) {
			return false;
		}
		if (result.conflict) {
			this.log.warn("metadata-conflict");
			this.state.update((v) => ({ ...v, ...result.item }));
			throw new Error(
				"Metadata changed on another device. Review the current metadata and retry.",
			);
		}
		this.state.update((v) => ({ ...v, ...result, metadata }));
		return true;
	}

	private async performRemoval() {
		await this.http.remove({
			...this.context,
			id: this.initial.id,
			signal: this.signal,
		});
		if (this.signal.aborted) {
			return false;
		}
		this.streams?.invalidate(this.initial.id);
		this.disposeMedia();
		this.state.update((v) => ({ ...v, deleted: true }));
		return true;
	}

	private releaseLoad(request: AbortSignal) {
		if (this.activeLoad === request) {
			this.activeLoad = null;
			this.state.update((v) => ({ ...v, busy: false }));
		}
	}

	private clearPreview(
		lease: NonNullable<Awaited<ReturnType<ContentStreams["open"]>> | null>,
	) {
		if (this.previewLease === lease) {
			this.previewLease = null;
			this.state.update((v) => ({ ...v, url: "", ready: false }));
		}
	}
	private async readPreview(
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
				this.state.update((v) => ({
					...v,
					ready: false,
					error: true,
					message: errorMessage(error),
				}));
			}
			throw error;
		}
	}
}

export function saveDownload(url: string, _filename: string) {
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.click();
}
