import { get, writable } from "svelte/store";
import { createUploadTask } from "../media/upload-workflow.js";

// The library owns this store; one task runs each sequential batch.
export function createUploadBatch(
	session,
	platform,
	sendUpload,
	onBatchUploaded,
) {
	const empty = () => ({
		uploadStatus: "",
		uploading: false,
		uploadProgress: null,
		uploadFailures: [],
	});
	const state = writable(empty());
	const update = (patch) => state.update((value) => ({ ...value, ...patch }));
	let activeTask;
	let disposed = false;

	function reset() {
		activeTask?.dispose();
		activeTask = null;
		state.set(empty());
	}

	function recordResult(file, error) {
		const failures = get(state).uploadFailures.filter(
			(failure) => failure.file !== file,
		);
		if (error) failures.push({ file, error: error.message });
		update({ uploadFailures: failures });
	}

	async function upload(files) {
		const identity = get(session);
		if (
			disposed ||
			!identity.ready ||
			!identity.wrappedKey ||
			!identity.privateKey ||
			get(state).uploading ||
			!files.length
		)
			return;
		const task = createUploadTask({ session });
		activeTask = task;
		const current = () =>
			!disposed && activeTask === task && !task.signal.aborted;
		let uploaded = false;
		update({ uploading: true, uploadStatus: "" });
		try {
			for (let index = 0; index < files.length; index++) {
				task.assertCurrent();
				const file = files[index];
				const progress = (percent) => {
					if (current())
						update({
							uploadProgress: {
								name: file.name,
								index: index + 1,
								total: files.length,
								percent,
							},
						});
				};
				progress(0);
				try {
					await task.send(
						{
							source: { blob: file, name: file.name },
							platform,
							onProgress: progress,
						},
						sendUpload,
					);
					uploaded = true;
					if (current()) recordResult(file);
				} catch (error) {
					task.assertCurrent();
					if (current()) recordResult(file, error);
				}
			}
			if (current()) {
				update({ uploadStatus: "", uploadProgress: null });
				if (uploaded) await onBatchUploaded();
			}
		} catch (error) {
			if (current()) update({ uploadStatus: error.message });
		} finally {
			if (current()) {
				update({ uploading: false, uploadProgress: null });
				activeTask = null;
			}
			task.dispose();
		}
	}

	return {
		subscribe: state.subscribe,
		upload,
		retryUploads: () =>
			upload(get(state).uploadFailures.map(({ file }) => file)),
		reset,
		dispose() {
			disposed = true;
			reset();
		},
	};
}
