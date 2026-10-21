import { get, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import { downloadName } from "../media/format.ts";
import {
	decodeTextPreview,
	isText,
	TEXT_PREVIEW_BYTES,
} from "../media/text.ts";
import { bytesToHex } from "../protocol/bytes.ts";
import type { MaterializedFile } from "../protocol/chain-state.ts";
import type { FileManifest, FileMetadata } from "../protocol/file-objects.ts";
import type { Files } from "../services/files.ts";
import type { ContentSource, ContentStreams } from "./content-streams.ts";

type MediaFiles = Pick<Files, "manifest" | "readRange" | "thumbnail">;
export class FileContentSource implements ContentSource {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly size: number;
	private readonly files: MediaFiles;
	private readonly manifest: FileManifest;
	private readonly signal: AbortSignal;
	private readonly report?: (error: unknown) => void;
	readonly read = this.readRange.bind(this);
	constructor(
		files: MediaFiles,
		file: MaterializedFile,
		metadata: FileMetadata,
		manifest: FileManifest,
		signal: AbortSignal,
		report?: (error: unknown) => void,
	) {
		this.files = files;
		this.manifest = manifest;
		this.signal = signal;
		this.report = report;
		this.id = bytesToHex(file.id);
		this.type = metadata.attributes.content_type || "application/octet-stream";
		this.name = downloadName(metadata.attributes.name || this.id, this.type);
		this.size = manifest.content.size;
	}
	private async readRange(start: number, end: number, request: AbortSignal) {
		const signal = AbortSignal.any([this.signal, request]);
		try {
			return await this.files.readRange(this.manifest, start, end, signal);
		} catch (error) {
			if (!signal.aborted) {
				this.report?.(error);
			}
			throw error;
		}
	}
}
export interface FileMediaState {
	readonly ready: boolean;
	readonly busy: boolean;
	readonly url: string;
	readonly preview: string;
	readonly text: string | null;
	readonly textTruncated: boolean;
	readonly message: string;
	readonly error: boolean;
}
const empty = (): FileMediaState => ({
	ready: false,
	busy: false,
	url: "",
	preview: "",
	text: null,
	textTruncated: false,
	message: "",
	error: false,
});
export type FileMedia = ReturnType<typeof createFileMedia>;
export function createFileMedia(
	file: MaterializedFile,
	metadata: FileMetadata,
	files: MediaFiles,
	streams: Pick<ContentStreams, "open">,
	signal: AbortSignal,
	urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): Pick<FileMediaImpl, keyof FileMediaImpl> {
	return new FileMediaImpl(file, metadata, files, streams, signal, urls);
}
class FileMediaImpl {
	private readonly file: MaterializedFile;
	private readonly metadata: FileMetadata;
	private readonly files: MediaFiles;
	private readonly streams: Pick<ContentStreams, "open">;
	private readonly urls: Pick<
		typeof URL,
		"createObjectURL" | "revokeObjectURL"
	>;
	private readonly controller = new AbortController();
	private readonly signal: AbortSignal;
	private previewController = new AbortController();
	private lease: Awaited<ReturnType<ContentStreams["open"]>> | null = null;
	private thumbnailTask: Promise<void> | null = null;
	private thumbnailLoaded = false;
	private thumbnailUrl = "";
	private readonly state = writable<FileMediaState>(empty());
	readonly subscribe = this.state.subscribe;
	readonly thumbnail = this.loadThumbnail.bind(this);
	readonly reveal = this.revealFile.bind(this);
	readonly close = this.closePreview.bind(this);
	readonly dispose = this.disposeMedia.bind(this);
	constructor(
		file: MaterializedFile,
		metadata: FileMetadata,
		files: MediaFiles,
		streams: Pick<ContentStreams, "open">,
		signal: AbortSignal,
		urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">,
	) {
		this.file = file;
		this.metadata = metadata;
		this.files = files;
		this.streams = streams;
		this.urls = urls;
		this.signal = AbortSignal.any([signal, this.controller.signal]);
		this.signal.addEventListener("abort", this.dispose, { once: true });
	}
	private loadThumbnail() {
		if (this.thumbnailLoaded || this.signal.aborted) {
			return Promise.resolve();
		}
		this.thumbnailTask ??= this.readThumbnail();
		return this.thumbnailTask;
	}
	private async readThumbnail() {
		let bytes: Uint8Array<ArrayBuffer> | null = null;
		try {
			bytes = await this.files.thumbnail(this.file, this.metadata, this.signal);
			this.signal.throwIfAborted();
			if (bytes) {
				this.thumbnailUrl = this.urls.createObjectURL(
					new Blob([bytes], { type: "image/webp" }),
				);
				this.state.update((state) => ({
					...state,
					preview: this.thumbnailUrl,
				}));
			}
			this.thumbnailLoaded = true;
		} catch (error) {
			if (!this.signal.aborted) {
				this.state.update((state) => ({
					...state,
					message: `Thumbnail unavailable: ${errorMessage(error)}`,
					error: true,
				}));
			}
		} finally {
			bytes?.fill(0);
			this.thumbnailTask = null;
		}
	}
	private reportError(error: unknown) {
		if (!this.signal.aborted && !this.previewController.signal.aborted) {
			this.state.update((state) => ({
				...state,
				message: errorMessage(error),
				error: true,
			}));
		}
	}
	private async revealFile(caller?: AbortSignal) {
		if (this.signal.aborted || caller?.aborted || get(this.state).busy) {
			return false;
		}
		if (get(this.state).ready) {
			return true;
		}
		this.previewController.abort();
		this.previewController = new AbortController();
		const signal = AbortSignal.any([
			this.signal,
			this.previewController.signal,
			...(caller ? [caller] : []),
		]);
		signal.addEventListener("abort", this.close, { once: true });
		this.state.update((state) => ({
			...state,
			busy: true,
			message: "",
			error: false,
		}));
		let lease: Awaited<ReturnType<ContentStreams["open"]>> | null = null;
		try {
			const manifest = await this.files.manifest(this.file, signal);
			signal.throwIfAborted();
			const source = new FileContentSource(
				this.files,
				this.file,
				this.metadata,
				manifest,
				signal,
				this.reportError.bind(this),
			);
			if (isText(source.type, source.name)) {
				const bytes = await source.read(
					0,
					Math.min(source.size, TEXT_PREVIEW_BYTES),
					signal,
				);
				try {
					signal.throwIfAborted();
					this.state.update((state) => ({
						...state,
						text: decodeTextPreview(bytes, source.size > TEXT_PREVIEW_BYTES),
						textTruncated: source.size > TEXT_PREVIEW_BYTES,
						ready: true,
					}));
				} finally {
					bytes.fill(0);
				}
			} else if (/^(image|audio|video)\//.test(source.type)) {
				lease = await this.streams.open(source, signal);
				signal.throwIfAborted();
				this.lease = lease;
				this.state.update((state) => ({
					...state,
					url: lease?.url ?? "",
					ready: true,
				}));
			} else {
				this.state.update((state) => ({ ...state, ready: true }));
			}
			return true;
		} catch (error) {
			lease?.dispose();
			if (!signal.aborted) {
				this.reportError(error);
			}
			return false;
		} finally {
			if (!signal.aborted) {
				this.state.update((state) => ({ ...state, busy: false }));
			}
		}
	}
	private closePreview() {
		this.previewController.abort();
		this.lease?.dispose();
		this.lease = null;
		if (!this.signal.aborted) {
			this.state.update((state) => ({ ...empty(), preview: state.preview }));
		}
	}
	private disposeMedia() {
		if (this.controller.signal.aborted) {
			return;
		}
		this.signal.removeEventListener("abort", this.dispose);
		this.controller.abort();
		this.closePreview();
		if (this.thumbnailUrl) {
			this.urls.revokeObjectURL(this.thumbnailUrl);
			this.thumbnailUrl = "";
		}
		this.state.set(empty());
	}
}
