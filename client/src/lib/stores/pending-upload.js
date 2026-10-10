import { get, writable } from "svelte/store";
import { prepareMedia, sendUpload } from "../media/upload.js";

// Shared by immediate context-menu uploads and popup submissions. The caller
// owns UI state; this function owns one credential-bound transfer and cleanup.
export async function sendPendingUpload(
	{ id, source, session, platform, tags = "", onProgress, onUploaded, signal },
	upload = sendUpload,
) {
	const credentials = session.credentials();
	const controller = new AbortController();
	const current = signal
		? AbortSignal.any([signal, controller.signal])
		: controller.signal;
	const unsubscribe = session.subscribe((value) => {
		if (
			value.privateKey !== credentials.privateKey ||
			value.serverUrl !== credentials.serverUrl
		)
			controller.abort(
				new DOMException("Library changed. Try again.", "AbortError"),
			);
	});
	let transferring = true;
	try {
		current.throwIfAborted();
		await upload({
			source,
			credentials,
			platform,
			tags,
			signal: current,
			onProgress: (percent) => {
				if (transferring && !current.aborted) onProgress?.(percent);
			},
		});
		transferring = false;
		current.throwIfAborted();
		await platform.session.remove(`upload:${id}`);
		current.throwIfAborted();
		onUploaded?.();
		// A failed notification cannot undo a successful upload.
		await Promise.resolve()
			.then(() => platform.notify("Uploaded."))
			.catch(() => {});
		current.throwIfAborted();
	} finally {
		transferring = false;
		unsubscribe();
	}
}

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
	let prepared;
	let request;
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
	const unsubscribe = session.subscribe((value) => {
		const previous = sessionState;
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
			(request &&
				previous &&
				(previous.privateKey !== value.privateKey ||
					previous.serverUrl !== value.serverUrl))
		) {
			contextChanged = true;
			request?.abort();
			request = null;
			state.update((value) => ({
				...value,
				busy: false,
				status: "Library changed. Try again.",
			}));
		}
		maybeSend();
	});
	async function prepare(signal) {
		if (!source) {
			const stored = await platform.session.get(`upload:${id}`);
			source = stored[`upload:${id}`];
			if (!source) throw new Error("Nothing to upload.");
		}
		const result =
			prepared || (await media.prepareMedia(source, platform, signal));
		signal.throwIfAborted();
		prepared = result;
		if (!preview && prepared.blob.type.startsWith("image/"))
			preview = URL.createObjectURL(prepared.blob);
		state.update((value) => ({ ...value, name: prepared.name, preview }));
		return prepared;
	}
	const ready = (async () => {
		try {
			await prepare(preparation.signal);
			state.update((value) => ({
				...value,
				ready: true,
				available: true,
				status: contextChanged
					? "Library changed. Try again."
					: source.error || "",
			}));
			maybeSend();
		} catch (error) {
			if (!disposed)
				state.update((value) => ({
					...value,
					ready: true,
					available: Boolean(source),
					status: error.message,
				}));
		}
	})();

	async function send(tags) {
		if (disposed || !source || !get(state).available || get(state).busy) return;
		autoStarted = true;
		const controller = new AbortController();
		request = controller;
		state.update((value) => ({
			...value,
			busy: true,
			status: prepared ? "Uploading…" : "Preparing file…",
		}));
		try {
			const source = prepared || (await prepare(controller.signal));
			controller.signal.throwIfAborted();
			state.update((value) => ({ ...value, status: "Uploading…" }));
			await sendPendingUpload(
				{
					id,
					source,
					session,
					platform,
					tags,
					signal: controller.signal,
					onUploaded: () =>
						state.update((value) => ({
							...value,
							available: false,
							status: "Uploaded.",
						})),
					onProgress: (percent) => {
						if (!disposed && request === controller)
							state.update((value) => ({
								...value,
								status: `Uploading… ${percent}%`,
							}));
					},
				},
				media.sendUpload,
			);
			controller.signal.throwIfAborted();
			platform.close();
		} catch (error) {
			if (!disposed && !controller.signal.aborted)
				state.update((value) => ({ ...value, status: error.message }));
		} finally {
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
