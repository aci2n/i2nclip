import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { checkSourceSize } from "../media/prepare.ts";
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

	let activeFiles: File[] = [];
	const compression = () =>
		preferences ? get(preferences).compressImages : true;
	function upload(files: File[], extra: Metadata = {}) {
		if (
			controller.signal.aborted ||
			context.signal.aborted ||
			get(state).uploading ||
			!files.length
		) {
			return Promise.resolve(false);
		}
		return run([...files], extra);
	}
	async function run(files: File[], extra: Metadata = {}) {
		activeFiles = files;
		const compressImages = compression();
		const total = files.length;
		const operation = log.operation();
		const started = performance.now();
		log.info("started", { operation, count: total });
		const signal = AbortSignal.any([controller.signal, context.signal]);
		const credentials = context;
		state.update((v) => ({
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
			state.update((v) => ({
				...v,
				progress: {
					name: file.name,
					index: index + 1,
					total,
					percent: 0,
					phase: "preparing",
				},
			}));
			log.debug("file-started", { operation, index: index + 1 });
			let finished = false;
			let preparedName = file.name;
			function report(percent: number) {
				if (finished || signal.aborted || !Number.isFinite(percent)) {
					return;
				}
				state.update((v) => ({
					...v,
					progress: {
						name: preparedName,
						index: index + 1,
						total,
						percent: Math.max(0, Math.min(100, Math.round(percent))),
						phase: "uploading",
					},
				}));
			}
			try {
				const item = await send({
					file,
					maxFilePlaintextBytes: getMaxFilePlaintextBytes(),
					compressImages,
					onPrepared: (name) => {
						if (!finished && !signal.aborted) {
							preparedName = name;
							state.update((v) => ({
								...v,
								progress: v.progress ? { ...v.progress, name } : null,
							}));
						}
					},
					onNotice: (message) => {
						if (!finished && !signal.aborted) {
							state.update((v) => ({
								...v,
								notices: [...v.notices, { name: file.name, message }],
							}));
						}
					},
					extra,
					credentials,
					signal,
					onProgress: report,
				});
				if (!signal.aborted) {
					log.debug("file-completed", { operation, index: index + 1 });
					state.update((v) => ({
						...v,
						completed: [...v.completed, { id: item.id, name: preparedName }],
					}));
				}
			} catch (error) {
				if (!signal.aborted) {
					log.warn("file-failed", {
						operation,
						index: index + 1,
						...failureFields(error),
					});
					failed.push({ name: preparedName, error: errorMessage(error) });
				}
			} finally {
				finished = true;
			}
		}
		if (signal.aborted) {
			files.length = 0;
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
			count: total,
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
		checkFile: (file: File) =>
			checkSourceSize(file, compression(), getMaxFilePlaintextBytes()),
		dismissCompleted: () =>
			state.update((v) => ({
				...v,
				completed: [],
				notices: [],
				status: v.failures.length || v.uploading ? v.status : "",
			})),
		dispose() {
			log.debug("disposed");
			controller.abort();
			activeFiles.length = 0;
			state.set(empty());
		},
	};
}
