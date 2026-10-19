import {
	BRIDGE_TIMEOUT_MS,
	HEARTBEAT_MS,
	type PageMessage,
	STREAM_PREFIX,
	STREAM_READ_BYTES,
	type StreamDescription,
	type WorkerMessage,
} from "../streaming/messages.ts";

export interface ContentSource extends StreamDescription {
	id?: string;
	read(
		start: number,
		end: number,
		signal: AbortSignal,
	): Promise<Uint8Array<ArrayBuffer>>;
}

interface Entry {
	source: ContentSource;
	controller: AbortController;
	finished?: (error?: Error) => void;
	started?: () => void;
	dispose(): void;
}

// Owned by the unlocked application session, independently of workspace/views.
// The worker transports plaintext only; keys and authenticated workflows stay here.
interface ContentStreamsDependencies {
	sessionSignal: AbortSignal;
}
interface ContentStreamsRuntime {
	controller: AbortController;
	signal: AbortSignal;
	entries: Map<string, Entry>;
	requests: Set<() => void>;
	waiting: Set<() => void>;
	reading: number;
	initialization?: Promise<string>;
	onMessage: (event: MessageEvent<WorkerMessage>) => void;
	dispose: () => void;
}

export function createContentStreams(sessionSignal: AbortSignal) {
	const deps: ContentStreamsDependencies = { sessionSignal };
	const controller = new AbortController();
	const runtime: ContentStreamsRuntime = {
		controller,
		signal: AbortSignal.any([controller.signal, sessionSignal]),
		entries: new Map(),
		requests: new Set(),
		waiting: new Set(),
		reading: 0,
		onMessage: (event) => openRequest(runtime, event),
		dispose: () => disposeStreams(deps, runtime),
	};
	sessionSignal.addEventListener("abort", runtime.dispose, { once: true });

	return {
		open: openContent.bind(null, runtime),
		download: downloadContent.bind(null, runtime),
		invalidate: invalidateContent.bind(null, runtime),
		dispose: runtime.dispose,
	};
}

async function acquireRead(
	runtime: ContentStreamsRuntime,
	request: AbortSignal,
) {
	while (runtime.reading >= 2) {
		await new Promise<void>((resolve, reject) =>
			waitForRead(runtime.waiting, request, resolve, reject),
		);
	}
	request.throwIfAborted();
	runtime.reading++;
}

function openRequest(
	runtime: ContentStreamsRuntime,
	event: MessageEvent<WorkerMessage>,
) {
	if (
		event.source !== navigator.serviceWorker.controller ||
		event.data?.kind !== "open"
	) {
		return;
	}
	const port = event.ports[0];
	if (!port) {
		return;
	}
	const entry = runtime.entries.get(event.data.token);
	if (!entry || runtime.signal.aborted) {
		port.postMessage({
			kind: "error",
			message: "The file session has ended.",
		} satisfies PageMessage);
		port.close();
		return;
	}
	const downloadRequest = event.data.download === true;
	if (downloadRequest) {
		entry.started?.();
	}
	const operation = new AbortController();
	const request = AbortSignal.any([
		runtime.signal,
		entry.controller.signal,
		operation.signal,
	]);
	const current: StreamRequest = {
		port,
		entry,
		downloadRequest,
		operation,
		request,
		closed: false,
		busy: false,
		abort: () =>
			closeRequest(runtime, current, new Error("The file session has ended.")),
	};
	request.addEventListener("abort", current.abort, { once: true });
	runtime.requests.add(current.abort);
	port.onmessage = (message) => readRequest(runtime, current, message);
	if (downloadRequest) {
		current.heartbeat = setInterval(
			() => pingRequest(runtime, current),
			HEARTBEAT_MS,
		);
	}
	const { size, type, name } = entry.source;
	sendRequest(current, { kind: "description", value: { size, type, name } });
}

interface StreamRequest {
	port: MessagePort;
	entry: Entry;
	downloadRequest: boolean;
	operation: AbortController;
	request: AbortSignal;
	closed: boolean;
	busy: boolean;
	heartbeat?: ReturnType<typeof setInterval>;
	deadline?: ReturnType<typeof setTimeout>;
	abort: () => void;
}

function sendRequest(
	current: Pick<StreamRequest, "port">,
	message: PageMessage,
	transfer: Transferable[] = [],
) {
	current.port.postMessage(message, transfer);
}

function closeRequest(
	runtime: ContentStreamsRuntime,
	current: StreamRequest,
	error?: Error,
) {
	if (current.closed) {
		return;
	}
	current.closed = true;
	clearInterval(current.heartbeat);
	clearTimeout(current.deadline);
	if (error) {
		sendRequest(current, { kind: "error", message: error.message });
	}
	current.operation.abort();
	runtime.requests.delete(current.abort);
	current.request.removeEventListener("abort", current.abort);
	current.port.close();
	if (current.downloadRequest) {
		const finished = current.entry.finished;
		current.entry.finished = undefined;
		finished?.(error);
	}
}

async function readRequest(
	runtime: ContentStreamsRuntime,
	current: StreamRequest,
	message: MessageEvent<WorkerMessage>,
) {
	if (current.closed) {
		return;
	}
	if (message.data.kind === "pong") {
		clearTimeout(current.deadline);
		current.deadline = undefined;
		return;
	}
	if (message.data.kind === "complete") {
		closeRequest(runtime, current);
		return;
	}
	if (message.data.kind === "cancel") {
		closeRequest(runtime, current, new Error("Download cancelled."));
		return;
	}
	if (message.data.kind !== "read" || current.closed) {
		return;
	}
	const { start, end } = message.data;
	if (
		current.busy ||
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end <= start ||
		end > current.entry.source.size ||
		end - start > STREAM_READ_BYTES
	) {
		closeRequest(runtime, current, new Error("Invalid content read request."));
		return;
	}
	current.busy = true;
	let acquired = false;
	try {
		await acquireRead(runtime, current.request);
		acquired = true;
		const bytes = await current.entry.source.read(start, end, current.request);
		current.request.throwIfAborted();
		if (bytes.byteLength !== end - start) {
			throw new Error("Invalid plaintext range length.");
		}
		const value =
			bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
				? bytes.buffer
				: bytes.slice().buffer;
		sendRequest(current, { kind: "bytes", value }, [value]);
	} catch (error) {
		closeRequest(
			runtime,
			current,
			error instanceof Error ? error : new Error("Content read failed."),
		);
	} finally {
		current.busy = false;
		if (acquired) {
			runtime.reading--;
			runtime.waiting.values().next().value?.();
		}
	}
}

function pingRequest(runtime: ContentStreamsRuntime, current: StreamRequest) {
	if (current.deadline !== undefined) {
		return;
	}
	current.deadline = setTimeout(
		() =>
			closeRequest(
				runtime,
				current,
				new Error("Download connection lost. Retry the download."),
			),
		BRIDGE_TIMEOUT_MS,
	);
	sendRequest(current, { kind: "ping" });
}

async function initializeStreams(runtime: ContentStreamsRuntime) {
	runtime.signal.throwIfAborted();
	if (!window.isSecureContext || !("serviceWorker" in navigator)) {
		throw new Error(
			"Streaming requires service workers on HTTPS or localhost.",
		);
	}
	navigator.serviceWorker.addEventListener("message", runtime.onMessage);
	const registration = await navigator.serviceWorker.register(
		"/streaming-worker.js",
		{
			scope: "/",
		},
	);
	registration.active?.postMessage({ kind: "claim" });
	runtime.signal.throwIfAborted();
	await new Promise<void>((resolve, reject) =>
		waitForController(runtime.signal, resolve, reject),
	);
	const client = await new Promise<string>((resolve, reject) =>
		requestClient(runtime.signal, resolve, reject),
	);
	runtime.signal.throwIfAborted();
	return client;
}

function disposeStreams(
	deps: ContentStreamsDependencies,
	runtime: ContentStreamsRuntime,
) {
	runtime.controller.abort();
	deps.sessionSignal.removeEventListener("abort", runtime.dispose);
	if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
		navigator.serviceWorker.removeEventListener("message", runtime.onMessage);
	}
	for (const close of runtime.requests) {
		close();
	}
	for (const entry of runtime.entries.values()) {
		entry.dispose();
	}
	runtime.entries.clear();
}

async function openStream(
	runtime: ContentStreamsRuntime,
	source: ContentSource,
	lifetime?: AbortSignal,
	finished?: (error?: Error) => void,
) {
	runtime.signal.throwIfAborted();
	lifetime?.throwIfAborted();
	if (!Number.isSafeInteger(source.size) || source.size < 0) {
		throw new Error("Invalid plaintext size.");
	}
	runtime.initialization ??= initializeStreams(runtime).catch((error) => {
		runtime.initialization = undefined;
		throw error;
	});
	const client = await runtime.initialization;
	runtime.signal.throwIfAborted();
	lifetime?.throwIfAborted();
	const token = crypto.randomUUID();
	const entry: Entry = {
		source,
		controller: new AbortController(),
		finished,
		dispose: () => disposeEntry(runtime.entries, entry, token, lifetime),
	};
	runtime.entries.set(token, entry);
	lifetime?.addEventListener("abort", entry.dispose, { once: true });
	const base = `${STREAM_PREFIX}${client}/${token}`;
	return {
		url: `${base}/inline`,
		downloadUrl: `${base}/download`,
		dispose: entry.dispose,
		entry,
	};
}

async function openContent(
	runtime: ContentStreamsRuntime,
	source: ContentSource,
	lifetime?: AbortSignal,
) {
	const { entry: _entry, ...lease } = await openStream(
		runtime,
		source,
		lifetime,
	);
	return lease;
}

async function downloadContent(
	runtime: ContentStreamsRuntime,
	source: ContentSource,
	start: (url: string) => unknown,
) {
	let finish: (error?: Error) => void = () => {};
	const done = new Promise<void>((resolve, reject) => {
		const completion: DownloadCompletion = { finished: false, resolve, reject };
		finish = (error) => finishDownload(completion, error);
	});
	// Observe rejection before waiting for initialization or a browser request.
	void done.catch(() => {});
	const lease = await openStream(runtime, source, undefined, finish);
	const timer = setTimeout(
		() => finish(new Error("The browser did not start the download.")),
		BRIDGE_TIMEOUT_MS,
	);
	lease.entry.started = () => clearTimeout(timer);
	try {
		runtime.signal.throwIfAborted();
		await start(lease.downloadUrl);
		await done;
	} finally {
		clearTimeout(timer);
		lease.dispose();
	}
}

function invalidateContent(runtime: ContentStreamsRuntime, id: string) {
	for (const entry of runtime.entries.values()) {
		if (entry.source.id === id) {
			entry.dispose();
		}
	}
}

export type ContentStreams = ReturnType<typeof createContentStreams>;

function disposeEntry(
	entries: Map<string, Entry>,
	entry: Entry,
	token: string,
	lifetime?: AbortSignal,
) {
	if (entry.controller.signal.aborted) {
		return;
	}
	lifetime?.removeEventListener("abort", entry.dispose);
	entry.controller.abort();
	const finished = entry.finished;
	entry.finished = undefined;
	finished?.(new Error("The file session has ended."));
	entries.delete(token);
}

interface ReadWait {
	waiting: Set<() => void>;
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
	ready: () => void;
	abort: () => void;
}

function waitForRead(
	waiting: Set<() => void>,
	signal: AbortSignal,
	resolve: () => void,
	reject: (error: unknown) => void,
) {
	const wait: ReadWait = {
		waiting,
		signal,
		resolve,
		reject,
		ready: () => finishReadWait(wait),
		abort: () => finishReadWait(wait, true),
	};
	waiting.add(wait.ready);
	signal.addEventListener("abort", wait.abort, { once: true });
	if (signal.aborted) {
		wait.abort();
	}
}

function finishReadWait(wait: ReadWait, aborted = false) {
	wait.waiting.delete(wait.ready);
	wait.signal.removeEventListener("abort", wait.abort);
	if (aborted) {
		wait.reject(wait.signal.reason);
	} else {
		wait.resolve();
	}
}

interface ControllerWait {
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
	changed: () => void;
	abort: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

function waitForController(
	signal: AbortSignal,
	resolve: () => void,
	reject: (error: unknown) => void,
) {
	const wait: ControllerWait = {
		signal,
		resolve,
		reject,
		changed: () => controllerChanged(wait),
		abort: () => finishControllerWait(wait, signal.reason),
	};
	wait.timer = setTimeout(
		() =>
			finishControllerWait(
				wait,
				new Error("Streaming worker did not activate."),
			),
		BRIDGE_TIMEOUT_MS,
	);
	navigator.serviceWorker.addEventListener("controllerchange", wait.changed);
	signal.addEventListener("abort", wait.abort, { once: true });
	wait.changed();
	if (signal.aborted) {
		wait.abort();
	}
}

function controllerChanged(wait: ControllerWait) {
	if (navigator.serviceWorker.controller) {
		finishControllerWait(wait);
	}
}

function finishControllerWait(wait: ControllerWait, error?: unknown) {
	clearTimeout(wait.timer);
	navigator.serviceWorker.removeEventListener("controllerchange", wait.changed);
	wait.signal.removeEventListener("abort", wait.abort);
	if (error !== undefined) {
		wait.reject(error);
	} else {
		wait.resolve();
	}
}

interface ClientWait {
	signal: AbortSignal;
	channel: MessageChannel;
	resolve: (client: string) => void;
	reject: (error: unknown) => void;
	abort: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

function requestClient(
	signal: AbortSignal,
	resolve: (client: string) => void,
	reject: (error: unknown) => void,
) {
	const wait: ClientWait = {
		signal,
		resolve,
		reject,
		channel: new MessageChannel(),
		abort: () => failClientWait(wait, signal.reason),
	};
	wait.timer = setTimeout(
		() => failClientWait(wait, new Error("Streaming worker did not respond.")),
		BRIDGE_TIMEOUT_MS,
	);
	wait.channel.port1.onmessage = (event: MessageEvent<{ client: string }>) =>
		receiveClient(wait, event.data.client);
	signal.addEventListener("abort", wait.abort, { once: true });
	navigator.serviceWorker.controller?.postMessage({ kind: "client" }, [
		wait.channel.port2,
	]);
	if (signal.aborted) {
		wait.abort();
	}
}

function closeClientWait(wait: ClientWait) {
	clearTimeout(wait.timer);
	wait.channel.port1.close();
	wait.signal.removeEventListener("abort", wait.abort);
}

function receiveClient(wait: ClientWait, client: string) {
	closeClientWait(wait);
	wait.resolve(client);
}

function failClientWait(wait: ClientWait, error: unknown) {
	closeClientWait(wait);
	wait.reject(error);
}

interface DownloadCompletion {
	finished: boolean;
	resolve: () => void;
	reject: (error: Error) => void;
}

function finishDownload(completion: DownloadCompletion, error?: Error) {
	if (completion.finished) {
		return;
	}
	completion.finished = true;
	if (error) {
		completion.reject(error);
	} else {
		completion.resolve();
	}
}
