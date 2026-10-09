import { get, writable } from "svelte/store";
import { prepareMedia, sendUpload } from "../media.js";

export function createPendingUpload(
	session,
	platform,
	id,
	media = { prepareMedia, sendUpload },
) {
	const state = writable({
		ready: false,
		busy: false,
		name: "",
		preview: "",
		status: "Loading…",
		available: false,
	});
	const preparation = new AbortController();
	let source;
	let request;
	let credentials;
	let disposed = false;
	let preview = "";
	const unsubscribe = session.subscribe((value) => {
		if (
			credentials &&
			(credentials.privateKey !== value.privateKey ||
				credentials.serverUrl !== value.serverUrl)
		) {
			request?.abort();
			credentials = null;
			state.update((value) => ({
				...value,
				busy: false,
				status: "Library changed. Try again.",
			}));
		}
	});
	const ready = (async () => {
		try {
			const stored = await platform.session.get(`upload:${id}`);
			if (!stored[`upload:${id}`]) throw new Error("Nothing to upload.");
			source = await media.prepareMedia(
				stored[`upload:${id}`],
				platform,
				preparation.signal,
			);
			preparation.signal.throwIfAborted();
			if (source.blob.type.startsWith("image/"))
				preview = URL.createObjectURL(source.blob);
			state.set({
				ready: true,
				busy: false,
				name: source.name,
				preview,
				status: "",
				available: true,
			});
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					ready: true,
					status: error.message,
				}));
		}
	})();

	return {
		subscribe: state.subscribe,
		ready,
		async send(tags) {
			if (disposed || !source || !get(state).available || get(state).busy)
				return;
			let captured;
			try {
				captured = session.credentials();
			} catch (error) {
				state.update((value) => ({ ...value, status: error.message }));
				return;
			}
			credentials = captured;
			const controller = new AbortController();
			request = controller;
			state.update((value) => ({ ...value, busy: true, status: "Uploading…" }));
			try {
				await media.sendUpload(
					source,
					captured,
					platform,
					tags,
					(percent) => {
						if (!controller.signal.aborted)
							state.update((value) => ({
								...value,
								status: `Uploading… ${percent}%`,
							}));
					},
					controller.signal,
				);
				controller.signal.throwIfAborted();
				await platform.session.remove(`upload:${id}`);
				controller.signal.throwIfAborted();
				state.update((value) => ({
					...value,
					available: false,
					status: "Uploaded.",
				}));
				await platform.notify("Uploaded.");
				controller.signal.throwIfAborted();
				platform.close();
			} catch (error) {
				if (!disposed && !controller.signal.aborted)
					state.update((value) => ({ ...value, status: error.message }));
			} finally {
				if (!disposed && request === controller)
					state.update((value) => ({ ...value, busy: false }));
			}
		},
		dispose() {
			disposed = true;
			preparation.abort();
			request?.abort();
			unsubscribe();
			if (preview) URL.revokeObjectURL(preview);
		},
	};
}
