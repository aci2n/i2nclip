import { sendUpload } from "./upload.js";

// One task spans preparation, transfers, and completion. Its owner disposes it.
export function createUploadTask({ session, signal, onInvalidated }) {
	const operation = session.operation({ signal, onInvalidated });
	if (!operation.unlocked) {
		operation.dispose();
		throw new Error("Unlock before uploading.");
	}
	const current = operation.signal;
	return {
		signal: current,
		pending: session.pending,
		assertCurrent: () => current.throwIfAborted(),
		async send(options, upload = sendUpload) {
			current.throwIfAborted();
			const credentials = await session.withIdentity(
				operation,
				(identity) => identity,
			);
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
		dispose: operation.dispose,
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
			const stored = await task.pending.get(id);
			task.assertCurrent();
			if (!stored) return "missing";
			const prepared = prepareSource ? await prepareSource() : source;
			task.assertCurrent();
			await task.send({ source: prepared, platform, tags, onProgress }, upload);
			await task.pending.remove(id);
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
