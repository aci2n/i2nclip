import type { Readable } from "svelte/store";
import { get, type Writable, writable } from "svelte/store";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { SendOptions } from "../media/upload.ts";
import { sendUpload } from "../media/upload.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import type { LibraryContext } from "./session.ts";

export interface UploadState {
	notices: { name: string; message: string }[];
	uploading: boolean;
	progress: {
		name: string;
		index: number;
		total: number;
		percent: number;
		phase: "preparing" | "uploading";
	} | null;
	failures: { name: string; error: string }[];
	completed: { id: string; name: string }[];
	status: string;
}

export type Uploads = ReturnType<typeof createUploads>;

const empty = (): UploadState => ({
	uploading: false,
	notices: [],
	progress: null,
	failures: [],
	completed: [],
	status: "",
});

interface UploadFile {
	signal: AbortSignal;
	name: string;
	preparedName: string;
	index: number;
	total: number;
	finished: boolean;
}

export function createUploads(
	context: LibraryContext,
	options: {
		send?: (options: SendOptions) => Promise<{ id: string }>;
		onComplete: () => unknown;
		preferences?: Readable<{ compressImages: boolean }>;
	},
): Pick<UploadsStoreImpl, keyof UploadsStoreImpl> {
	return new UploadsStoreImpl(context, options);
}

class UploadsStoreImpl {
	private readonly context: LibraryContext;
	private readonly send: (options: SendOptions) => Promise<{ id: string }>;
	private readonly onComplete: () => unknown;
	private readonly preferences?: Readable<{ compressImages: boolean }>;
	private readonly log: ReturnType<typeof createLog>;
	private readonly state: Writable<UploadState>;
	private readonly controller: AbortController;
	private activeFiles: File[];

	readonly subscribe: Writable<UploadState>["subscribe"];
	readonly upload = this.uploadFiles.bind(this);
	readonly dismissCompleted = this.dismissCompletedCommand.bind(this);
	readonly dispose = this.disposeUploads.bind(this);

	constructor(
		context: LibraryContext,
		{
			send = sendUpload,
			onComplete,
			preferences,
		}: {
			send?: (options: SendOptions) => Promise<{ id: string }>;
			onComplete: () => unknown;
			preferences?: Readable<{ compressImages: boolean }>;
		},
	) {
		this.context = context;
		this.send = send;
		this.onComplete = onComplete;
		this.preferences = preferences;
		this.log = createLog("uploads");
		this.state = writable(empty());
		this.subscribe = this.state.subscribe;
		this.controller = new AbortController();
		this.activeFiles = [];
	}

	private dismissCompletedCommand() {
		return this.state.update((v) => ({
			...v,
			completed: [],
			notices: [],
			status: v.failures.length || v.uploading ? v.status : "",
		}));
	}

	private uploadFiles(files: File[], extra: Metadata = {}) {
		if (
			this.controller.signal.aborted ||
			this.context.signal.aborted ||
			get(this.state).uploading ||
			!files.length
		) {
			return Promise.resolve(false);
		}
		return this.runBatch([...files], extra);
	}

	private async runBatch(files: File[], extra: Metadata = {}) {
		this.activeFiles = files;
		const compressImages = this.preferences
			? get(this.preferences).compressImages
			: true;
		const total = files.length;
		const operation = this.log.operation();
		const started = performance.now();
		this.log.info("started", { operation, count: total });
		const signal = AbortSignal.any([
			this.controller.signal,
			this.context.signal,
		]);
		const credentials = this.context;
		this.state.update((v) => ({
			...v,
			uploading: true,
			notices: [],
			status: "",
			failures: [],
			completed: [],
		}));
		const failed: UploadState["failures"] = [];
		for (let index = 0; files.length; index++) {
			const file = files.shift();
			if (!file) {
				break;
			}
			if (signal.aborted) {
				break;
			}
			this.state.update((v) => ({
				...v,
				progress: {
					name: file.name,
					index: index + 1,
					total,
					percent: 0,
					phase: "preparing",
				},
			}));
			this.log.debug("file-started", { operation, index: index + 1 });
			const current: UploadFile = {
				signal,
				name: file.name,
				preparedName: file.name,
				index: index + 1,
				total,
				finished: false,
			};
			try {
				const item = await this.send({
					file,
					compressImages,
					onPrepared: (name) => this.uploadPrepared(current, name),
					onNotice: (message) => this.uploadNotice(current, message),
					extra,
					credentials,
					signal,
					onProgress: (percent) => this.uploadProgress(current, percent),
				});
				if (!signal.aborted) {
					this.log.debug("file-completed", { operation, index: index + 1 });
					this.state.update((v) => ({
						...v,
						completed: [
							...v.completed,
							{ id: item.id, name: current.preparedName },
						],
					}));
				}
			} catch (error) {
				if (!signal.aborted) {
					this.log.warn("file-failed", {
						operation,
						index: index + 1,
						...failureFields(error),
					});
					failed.push({
						name: current.preparedName,
						error: errorMessage(error),
					});
				}
			} finally {
				current.finished = true;
			}
		}
		if (signal.aborted) {
			files.length = 0;
			this.log.debug("cancelled", { operation });
			return false;
		}
		this.state.update((v) => ({
			...v,
			uploading: false,
			progress: null,
			failures: failed,
			status: failed.length
				? `${failed.length} file(s) failed. Select the failed files again through Upload.`
				: "Upload complete.",
		}));
		this.log.info("completed", {
			operation,
			count: total,
			failures: failed.length,
			elapsedMs: Math.round(performance.now() - started),
		});
		await this.onComplete();
		return !signal.aborted && !failed.length;
	}

	private disposeUploads() {
		this.log.debug("disposed");
		this.controller.abort();
		this.activeFiles.length = 0;
		this.state.set(empty());
	}

	private uploadProgress(current: UploadFile, percent: number) {
		if (
			current.finished ||
			current.signal.aborted ||
			!Number.isFinite(percent)
		) {
			return;
		}
		this.state.update((v) => ({
			...v,
			progress: {
				name: current.preparedName,
				index: current.index,
				total: current.total,
				percent: Math.max(0, Math.min(100, Math.round(percent))),
				phase: "uploading",
			},
		}));
	}

	private uploadPrepared(current: UploadFile, name: string) {
		if (current.finished || current.signal.aborted) {
			return;
		}
		current.preparedName = name;
		this.state.update((v) => ({
			...v,
			progress: v.progress ? { ...v.progress, name } : null,
		}));
	}

	private uploadNotice(current: UploadFile, message: string) {
		if (current.finished || current.signal.aborted) {
			return;
		}
		this.state.update((v) => ({
			...v,
			notices: [...v.notices, { name: current.name, message }],
		}));
	}
}
