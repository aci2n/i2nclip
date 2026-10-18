import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import type { SendOptions } from "../media/upload.ts";
import { sendUpload } from "../media/upload.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import type { LibraryContext } from "./session.ts";
export interface UploadState {
	uploading: boolean;
	progress: {
		name: string;
		index: number;
		total: number;
		percent: number;
	} | null;
	failures: { name: string; error: string }[];
	completed: { id: string; name: string }[];
	status: string;
}
export type Uploads = ReturnType<typeof createUploads>;

const empty = (): UploadState => ({
	uploading: false,
	progress: null,
	failures: [],
	completed: [],
	status: "",
});

// Application owns this store so batches survive navigation between views.
export function createUploads(
	context: LibraryContext,
	{
		send = sendUpload,
		onComplete,
		preferences,
		getMaxFilePlaintextBytes = () => DEFAULT_MAX_FILE_PLAINTEXT_BYTES,
	}: {
		getMaxFilePlaintextBytes?: () => number;
		send?: (options: SendOptions) => Promise<{ id: string }>;
		onComplete: () => unknown;
		preferences?: Readable<{ compressImages: boolean }>;
	},
) {
	const log = createLog("uploads");
	const state = writable(empty());
	const controller = new AbortController();

	async function upload(files: File[], extra: Metadata = {}) {
		if (
			controller.signal.aborted ||
			get(state).uploading ||
			!files.length ||
			context.signal.aborted
		) {
			log.debug("rejected", {
				reason:
					controller.signal.aborted || context.signal.aborted
						? "disposed"
						: files.length
							? "busy"
							: "empty",
			});
			return false;
		}
		const operation = log.operation();
		const started = performance.now();
		log.info("started", { operation, count: files.length });
		const signal = AbortSignal.any([controller.signal, context.signal]);
		const credentials = context;
		const compressImages = preferences ? get(preferences).compressImages : true;
		state.update((v) => ({
			...v,
			uploading: true,
			status: "",
			failures: [],
			completed: [],
		}));
		const failed: UploadState["failures"] = [];
		for (const [index, file] of files.entries()) {
			if (signal.aborted) {
				break;
			}
			state.update((v) => ({
				...v,
				progress: {
					name: file.name,
					index: index + 1,
					total: files.length,
					percent: 0,
				},
			}));
			log.debug("file-started", { operation, index: index + 1 });
			let finished = false;
			try {
				const item = await send({
					file,
					maxFilePlaintextBytes: getMaxFilePlaintextBytes(),
					compressImages,
					extra,
					credentials,
					signal,
					onProgress: (percent) => {
						if (!finished && !signal.aborted) {
							state.update((v) => ({
								...v,
								progress: {
									name: file.name,
									index: index + 1,
									total: files.length,
									percent,
								},
							}));
						}
					},
				});
				if (!signal.aborted) {
					log.debug("file-completed", { operation, index: index + 1 });
					state.update((v) => ({
						...v,
						completed: [...v.completed, { id: item.id, name: file.name }],
					}));
				}
			} catch (error) {
				if (!signal.aborted) {
					log.warn("file-failed", {
						operation,
						index: index + 1,
						...failureFields(error),
					});
					failed.push({ name: file.name, error: errorMessage(error) });
				}
			} finally {
				finished = true;
			}
		}
		if (signal.aborted) {
			log.debug("cancelled", { operation });
			return false;
		}
		state.update((v) => ({
			...v,
			uploading: false,
			progress: null,
			failures: failed,
			status: failed.length
				? `${failed.length} file(s) failed. Select the failed files again through Upload.`
				: "Upload complete.",
		}));
		log.info("completed", {
			operation,
			count: files.length,
			failures: failed.length,
			elapsedMs: Math.round(performance.now() - started),
		});
		await onComplete();
		return !signal.aborted && !failed.length;
	}

	return {
		subscribe: state.subscribe,
		upload,
		getMaxFilePlaintextBytes,
		dismissCompleted: () =>
			state.update((v) => ({
				...v,
				completed: [],
				status: v.failures.length || v.uploading ? v.status : "",
			})),
		dispose() {
			log.debug("disposed");
			controller.abort();
			state.set(empty());
		},
	};
}
