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

interface UploadsDependencies {
	context: LibraryContext;
	send: (options: SendOptions) => Promise<{ id: string }>;
	onComplete: () => unknown;
	preferences?: Readable<{ compressImages: boolean }>;
	log: ReturnType<typeof createLog>;
}
interface UploadsRuntime {
	state: Writable<UploadState>;
	controller: AbortController;
	activeFiles: File[];
}
interface UploadFile {
	signal: AbortSignal;
	name: string;
	preparedName: string;
	index: number;
	total: number;
	finished: boolean;
}

// Application owns this store so batches survive navigation between views.
export function createUploads(
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
	const deps: UploadsDependencies = {
		context,
		send,
		onComplete,
		preferences,
		log: createLog("uploads"),
	};
	const runtime: UploadsRuntime = {
		state: writable(empty()),
		controller: new AbortController(),
		activeFiles: [],
	};

	return {
		subscribe: runtime.state.subscribe,
		upload: uploadFiles.bind(null, deps, runtime),
		dismissCompleted: () =>
			runtime.state.update((v) => ({
				...v,
				completed: [],
				notices: [],
				status: v.failures.length || v.uploading ? v.status : "",
			})),
		dispose: disposeUploads.bind(null, deps, runtime),
	};
}

function uploadFiles(
	deps: UploadsDependencies,
	runtime: UploadsRuntime,
	files: File[],
	extra: Metadata = {},
) {
	if (
		runtime.controller.signal.aborted ||
		deps.context.signal.aborted ||
		get(runtime.state).uploading ||
		!files.length
	) {
		return Promise.resolve(false);
	}
	return runBatch(deps, runtime, [...files], extra);
}

async function runBatch(
	deps: UploadsDependencies,
	runtime: UploadsRuntime,
	files: File[],
	extra: Metadata = {},
) {
	runtime.activeFiles = files;
	const compressImages = deps.preferences
		? get(deps.preferences).compressImages
		: true;
	const total = files.length;
	const operation = deps.log.operation();
	const started = performance.now();
	deps.log.info("started", { operation, count: total });
	const signal = AbortSignal.any([
		runtime.controller.signal,
		deps.context.signal,
	]);
	const credentials = deps.context;
	runtime.state.update((v) => ({
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
		runtime.state.update((v) => ({
			...v,
			progress: {
				name: file.name,
				index: index + 1,
				total,
				percent: 0,
				phase: "preparing",
			},
		}));
		deps.log.debug("file-started", { operation, index: index + 1 });
		const current: UploadFile = {
			signal,
			name: file.name,
			preparedName: file.name,
			index: index + 1,
			total,
			finished: false,
		};
		try {
			const item = await deps.send({
				file,
				compressImages,
				onPrepared: (name) => uploadPrepared(runtime.state, current, name),
				onNotice: (message) => uploadNotice(runtime.state, current, message),
				extra,
				credentials,
				signal,
				onProgress: (percent) =>
					uploadProgress(runtime.state, current, percent),
			});
			if (!signal.aborted) {
				deps.log.debug("file-completed", { operation, index: index + 1 });
				runtime.state.update((v) => ({
					...v,
					completed: [
						...v.completed,
						{ id: item.id, name: current.preparedName },
					],
				}));
			}
		} catch (error) {
			if (!signal.aborted) {
				deps.log.warn("file-failed", {
					operation,
					index: index + 1,
					...failureFields(error),
				});
				failed.push({ name: current.preparedName, error: errorMessage(error) });
			}
		} finally {
			current.finished = true;
		}
	}
	if (signal.aborted) {
		files.length = 0;
		deps.log.debug("cancelled", { operation });
		return false;
	}
	runtime.state.update((v) => ({
		...v,
		uploading: false,
		progress: null,
		failures: failed,
		status: failed.length
			? `${failed.length} file(s) failed. Select the failed files again through Upload.`
			: "Upload complete.",
	}));
	deps.log.info("completed", {
		operation,
		count: total,
		failures: failed.length,
		elapsedMs: Math.round(performance.now() - started),
	});
	await deps.onComplete();
	return !signal.aborted && !failed.length;
}

function disposeUploads(deps: UploadsDependencies, runtime: UploadsRuntime) {
	deps.log.debug("disposed");
	runtime.controller.abort();
	runtime.activeFiles.length = 0;
	runtime.state.set(empty());
}

function uploadProgress(
	state: UploadsRuntime["state"],
	current: UploadFile,
	percent: number,
) {
	if (current.finished || current.signal.aborted || !Number.isFinite(percent)) {
		return;
	}
	state.update((v) => ({
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
function uploadPrepared(
	state: UploadsRuntime["state"],
	current: UploadFile,
	name: string,
) {
	if (current.finished || current.signal.aborted) {
		return;
	}
	current.preparedName = name;
	state.update((v) => ({
		...v,
		progress: v.progress ? { ...v.progress, name } : null,
	}));
}
function uploadNotice(
	state: UploadsRuntime["state"],
	current: UploadFile,
	message: string,
) {
	if (current.finished || current.signal.aborted) {
		return;
	}
	state.update((v) => ({
		...v,
		notices: [...v.notices, { name: current.name, message }],
	}));
}
