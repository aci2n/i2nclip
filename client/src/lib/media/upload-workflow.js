import { sendUpload } from "./upload.js";

// One task spans preparation, transfers, and completion. Its owner disposes it.
export function createUploadTask({ session, signal, onInvalidated }) {
	const credentials = session.credentials();
	const controller = new AbortController();
	const current = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	let disposed = false;
	const unsubscribe = session.subscribe((value) => {
		if (
			!controller.signal.aborted &&
			(value.privateKey !== credentials.privateKey ||
				value.serverUrl !== credentials.serverUrl ||
				value.identityGeneration !== credentials.identityGeneration)
		) {
			controller.abort(
				new DOMException("Library changed. Try again.", "AbortError"),
			);
			onInvalidated?.();
		}
	});
	return {
		signal: current,
		assertCurrent: () => current.throwIfAborted(),
		async send(options, upload = sendUpload) {
			current.throwIfAborted();
			let transferring = true;
			try {
				const result = await upload({
					...options,
					credentials,
					signal: current,
					onProgress: (percent) => {
						if (transferring && !current.aborted) options.onProgress?.(percent);
					},
				});
				current.throwIfAborted();
				return result;
			} finally {
				transferring = false;
			}
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			controller.abort();
			unsubscribe();
		},
	};
}

// One pending ID has one sender across background and popup pages.
export async function sendPendingUpload(
	{
		task,
		id,
		source,
		prepareSource,
		platform,
		tags = "",
		onProgress,
		onUploaded,
	},
	upload = sendUpload,
) {
	task.assertCurrent();
	const locks = globalThis.navigator?.locks;
	if (!locks) throw new Error("Upload coordination is unavailable. Try again.");
	const outcome = await locks.request(
		`i2nclip-pending-upload:${id}`,
		{ mode: "exclusive", ifAvailable: true },
		async (lock) => {
			task.assertCurrent();
			if (!lock) return "busy";
			const key = `upload:${id}`;
			const stored = await platform.session.get(key);
			task.assertCurrent();
			if (!stored[key]) return "missing";
			const prepared = prepareSource ? await prepareSource() : source;
			task.assertCurrent();
			await task.send({ source: prepared, platform, tags, onProgress }, upload);
			await platform.session.remove(key);
			task.assertCurrent();
			onUploaded?.();
			return "uploaded";
		},
	);
	task.assertCurrent();
	if (outcome !== "uploaded") return outcome;
	// A failed notification cannot undo a successful upload.
	await Promise.resolve()
		.then(() => platform.notify("Uploaded."))
		.catch(() => {});
	task.assertCurrent();
	return outcome;
}
