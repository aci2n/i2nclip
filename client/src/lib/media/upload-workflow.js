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
				value.serverUrl !== credentials.serverUrl)
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

// Pending-ID cleanup is shared by background and popup submissions.
export async function sendPendingUpload(
	{ task, id, source, platform, tags = "", onProgress, onUploaded },
	upload = sendUpload,
) {
	await task.send({ source, platform, tags, onProgress }, upload);
	await platform.session.remove(`upload:${id}`);
	task.assertCurrent();
	onUploaded?.();
	// A failed notification cannot undo a successful upload.
	await Promise.resolve()
		.then(() => platform.notify("Uploaded."))
		.catch(() => {});
	task.assertCurrent();
}
