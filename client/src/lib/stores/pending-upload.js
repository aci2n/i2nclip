import { get, writable } from "svelte/store";
import { prepareMedia, sendUpload } from "../media/upload.js";
import {
	createUploadTask,
	sendPendingUpload,
} from "../media/upload-workflow.js";

export function createPendingUpload(
	session,
	platform,
	id,
	media = { prepareMedia, sendUpload },
	{ auto = false } = {},
) {
	const state = writable({
		ready: false,
		busy: false,
		name: "",
		preview: "",
		status: "Loading…",
		available: false,
	});
	const update = (patch) => state.update((value) => ({ ...value, ...patch }));
	const preparation = new AbortController();
	let source;
	let prepared;
	let activeTask;
	let disposed = false;
	let preview = "";
	let sessionState;
	let autoStarted = false;
	let initialContext = true;
	let contextChanged = false;
	function maybeSend() {
		if (
			!auto ||
			contextChanged ||
			autoStarted ||
			disposed ||
			!prepared ||
			!get(state).available ||
			!sessionState.privateKey ||
			sessionState.busy
		)
			return;
		autoStarted = true;
		queueMicrotask(() => {
			if (!contextChanged) send("");
		});
	}
	// This observer controls automatic-send policy, not active transfer cancellation.
	const unsubscribe = session.subscribe((value) => {
		sessionState = value;

		maybeSend();
	});
	const unsubscribeContext = session.observeIdentity(
		() => {
			if (!initialContext) {
				contextChanged = true;
				update({ status: "Library changed. Try again." });
			}
			initialContext = false;
		},
		{ includeUnlocked: false },
	);

	async function prepare(signal) {
		if (!source) {
			source = await session.pending.get(id);
			if (!source) throw new Error("Nothing to upload.");
		}
		const result =
			prepared || (await media.prepareMedia(source, platform, signal));
		signal.throwIfAborted();
		prepared = result;
		if (!preview && prepared.blob.type.startsWith("image/"))
			preview = URL.createObjectURL(prepared.blob);
		update({ name: prepared.name, preview });
		return prepared;
	}
	const ready = (async () => {
		try {
			await prepare(preparation.signal);
			update({
				ready: true,
				available: true,
				status: contextChanged
					? "Library changed. Try again."
					: source.error || "",
			});
			maybeSend();
		} catch (error) {
			if (!disposed)
				update({
					ready: true,
					available: Boolean(source),
					status: error.message,
				});
		}
	})();

	async function send(tags) {
		if (disposed || !source || !get(state).available || get(state).busy) return;
		autoStarted = true;
		let task;
		try {
			task = createUploadTask({
				session,
				onInvalidated: () => {
					contextChanged = true;
					activeTask = null;
					update({ busy: false, status: "Library changed. Try again." });
				},
			});
		} catch (error) {
			update({ status: error.message });
			return;
		}
		activeTask = task;
		update({ busy: true, status: prepared ? "Uploading…" : "Preparing file…" });
		try {
			const outcome = await sendPendingUpload(
				{
					id,
					prepareSource: async () => {
						const result = prepared || (await prepare(task.signal));
						task.assertCurrent();
						update({ status: "Uploading…" });
						return result;
					},
					task,
					platform,
					tags,
					onUploaded: () => update({ available: false, status: "Uploaded." }),
					onProgress: (percent) => {
						if (!disposed && activeTask === task)
							update({ status: `Uploading… ${percent}%` });
					},
				},
				media.sendUpload,
			);
			task.assertCurrent();
			if (outcome === "uploaded") platform.close();
			else if (outcome === "busy")
				update({
					status: "Uploading in another page. Try again when it finishes.",
				});
			else
				update({
					available: false,
					status: "This upload was completed or removed.",
				});
		} catch (error) {
			if (!disposed && !task.signal.aborted) update({ status: error.message });
		} finally {
			task.dispose();
			if (!disposed && activeTask === task) {
				activeTask = null;
				update({ busy: false });
			}
		}
	}
	return {
		subscribe: state.subscribe,
		ready,
		tags: writable(""),
		send,
		dispose() {
			disposed = true;
			preparation.abort();
			activeTask?.dispose();
			unsubscribe();
			unsubscribeContext();
			if (preview) URL.revokeObjectURL(preview);
		},
	};
}
