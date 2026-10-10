import { get, writable } from "svelte/store";
import { prepareMedia, sendUpload } from "../media/upload.js";

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
	const preparation = new AbortController();
	let source;
	let request;
	let credentials;
	let disposed = false;
	let preview = "";
	let sessionState;
	let autoStarted = false;
	let context;
	let contextChanged = false;
	function maybeSend() {
		if (
			!auto ||
			contextChanged ||
			autoStarted ||
			disposed ||
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
	const unsubscribe = session.subscribe((value) => {
		sessionState = value;
		const nextContext = value.ready
			? { serverUrl: value.serverUrl, publicKey: value.publicKey }
			: null;
		const changed =
			context &&
			nextContext &&
			(context.serverUrl !== nextContext.serverUrl ||
				context.publicKey !== nextContext.publicKey);
		if (nextContext) context = nextContext;
		if (
			changed ||
			(credentials &&
				(credentials.privateKey !== value.privateKey ||
					credentials.serverUrl !== value.serverUrl))
		) {
			contextChanged = true;
			request?.abort();
			request = null;
			credentials = null;
			state.update((value) => ({
				...value,
				busy: false,
				status: "Library changed. Try again.",
			}));
		}
		maybeSend();
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
				status: contextChanged ? "Library changed. Try again." : "",
				available: true,
			});
			maybeSend();
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					ready: true,
					status: error.message,
				}));
		}
	})();

	async function send(tags) {
		if (disposed || !source || !get(state).available || get(state).busy) return;
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
		let transferring = true;
		state.update((value) => ({ ...value, busy: true, status: "Uploading…" }));
		try {
			await media.sendUpload(
				source,
				captured,
				platform,
				tags,
				(percent) => {
					if (
						!disposed &&
						request === controller &&
						!controller.signal.aborted &&
						transferring
					)
						state.update((value) => ({
							...value,
							status: `Uploading… ${percent}%`,
						}));
				},
				controller.signal,
			);
			transferring = false;
			controller.signal.throwIfAborted();
			await platform.session.remove(`upload:${id}`);
			controller.signal.throwIfAborted();
			state.update((value) => ({
				...value,
				available: false,
				status: "Uploaded.",
			}));
			// Notification failure does not undo a saved upload.
			await Promise.resolve()
				.then(() => platform.notify("Uploaded."))
				.catch(() => {});
			controller.signal.throwIfAborted();
			platform.close();
		} catch (error) {
			if (!disposed && !controller.signal.aborted)
				state.update((value) => ({ ...value, status: error.message }));
		} finally {
			transferring = false;
			if (!disposed && request === controller) {
				request = null;
				state.update((value) => ({ ...value, busy: false }));
			}
		}
	}
	return {
		subscribe: state.subscribe,
		ready,
		send,
		dispose() {
			disposed = true;
			preparation.abort();
			request?.abort();
			unsubscribe();
			if (preview) URL.revokeObjectURL(preview);
		},
	};
}
