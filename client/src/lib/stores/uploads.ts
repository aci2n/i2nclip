import type { Readable } from "svelte/store";
import { get, writable } from "svelte/store";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES } from "../api.ts";
import { errorMessage } from "../error.ts";
import { createLog, failureFields } from "../log.ts";
import { checkSourceSize } from "../media/convert.ts";
import {
	copyUploadOptions,
	defaultUploadOptions,
	type UploadOptions,
	validUploadOptions,
} from "../media/options.ts";
import type { SendOptions } from "../media/upload.ts";
import { sendUpload } from "../media/upload.ts";
import type { Metadata } from "../protocol/meta-plain.ts";
import type { LibraryContext } from "./session.ts";
export interface PendingUpload {
	key: number;
	file: File;
	options: UploadOptions;
}

export interface UploadState {
	pending: PendingUpload[];
	notices: { name: string; message: string }[];
	uploading: boolean;
	progress: {
		name: string;
		index: number;
		total: number;
		percent: number;
		phase: "preparing" | "converting" | "uploading";
	} | null;
	failures: { name: string; error: string }[];
	completed: { id: string; name: string }[];
	status: string;
}
export type Uploads = ReturnType<typeof createUploads>;

const empty = (): UploadState => ({
	uploading: false,
	pending: [],
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
		preferences?: Readable<{ options: UploadOptions }>;
	},
) {
	const log = createLog("uploads");
	const state = writable(empty());
	const controller = new AbortController();

	let nextKey = 0;
	let activeEntries: { file: File; options: UploadOptions }[] = [];
	const defaults = () =>
		copyUploadOptions(
			preferences ? get(preferences).options : defaultUploadOptions(),
		);
	const available = () =>
		!controller.signal.aborted &&
		!context.signal.aborted &&
		!get(state).uploading;
	function stage(files: File[]) {
		if (!available()) {
			return;
		}
		state.update((v) => ({
			...v,
			pending: [
				...v.pending,
				...files.map((file) => ({ key: nextKey++, file, options: defaults() })),
			],
		}));
	}
	function editOptions(key: number, options: UploadOptions) {
		if (!available() || !validUploadOptions(options)) {
			return;
		}
		state.update((v) => ({
			...v,
			pending: v.pending.map((entry) =>
				entry.key === key
					? { ...entry, options: copyUploadOptions(options) }
					: entry,
			),
		}));
	}
	function upload(files: File[], extra: Metadata = {}) {
		if (!available() || get(state).pending.length || !files.length) {
			return Promise.resolve(false);
		}
		return run(
			files.map((file) => ({ file, options: defaults() })),
			extra,
		);
	}
	function start() {
		if (!available() || !get(state).pending.length) {
			return Promise.resolve(false);
		}
		const entries = get(state).pending.map(({ file, options }) => ({
			file,
			options: copyUploadOptions(options),
		}));
		return run(entries);
	}
	async function run(
		entries: { file: File; options: UploadOptions }[],
		extra: Metadata = {},
	) {
		activeEntries = entries;
		const total = entries.length;
		const operation = log.operation();
		const started = performance.now();
		log.info("started", { operation, count: total });
		const signal = AbortSignal.any([controller.signal, context.signal]);
		const credentials = context;
		state.update((v) => ({
			...v,
			uploading: true,
			pending: [],
			notices: [],
			status: "",
			failures: [],
			completed: [],
		}));
		const failed: UploadState["failures"] = [];
		for (let index = 0; entries.length; index++) {
			const entry = entries.shift();
			if (!entry) {
				break;
			}
			const { file, options } = entry;
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
			function report(phase: "converting" | "uploading", percent: number) {
				if (
					finished ||
					signal.aborted ||
					!Number.isFinite(percent) ||
					(phase === "converting" && get(state).progress?.phase === "uploading")
				) {
					return;
				}
				state.update((v) => ({
					...v,
					progress: {
						name: preparedName,
						index: index + 1,
						total,
						percent: Math.max(0, Math.min(100, Math.round(percent))),
						phase,
					},
				}));
			}
			try {
				const item = await send({
					file,
					maxFilePlaintextBytes: getMaxFilePlaintextBytes(),
					options,
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
					onConversionProgress: (percent) => report("converting", percent),
					onProgress: (percent) => report("uploading", percent),
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
			entries.length = 0;
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
		stage,
		start,
		editOptions,
		useDefaults: (key: number) => editOptions(key, defaults()),
		remove: (key: number) => {
			if (available()) {
				state.update((v) => ({
					...v,
					pending: v.pending.filter((entry) => entry.key !== key),
				}));
			}
		},
		cancel: () => {
			if (available()) {
				state.update((v) => ({ ...v, pending: [] }));
			}
		},
		getMaxFilePlaintextBytes,
		checkFile: (file: File) =>
			checkSourceSize(file, defaults(), getMaxFilePlaintextBytes()),
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
			activeEntries.length = 0;
			state.set(empty());
		},
	};
}
