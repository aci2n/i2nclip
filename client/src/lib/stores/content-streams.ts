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

export type ContentStreams = ReturnType<typeof createContentStreams>;

interface ReadWait {
	waiting: Set<() => void>;
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
	ready: () => void;
	abort: () => void;
}

interface ControllerWait {
	signal: AbortSignal;
	resolve: () => void;
	reject: (error: unknown) => void;
	changed: () => void;
	abort: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface ClientWait {
	signal: AbortSignal;
	channel: MessageChannel;
	resolve: (client: string) => void;
	reject: (error: unknown) => void;
	abort: () => void;
	timer?: ReturnType<typeof setTimeout>;
}

interface DownloadCompletion {
	finished: boolean;
	resolve: () => void;
	reject: (error: Error) => void;
}
export function createContentStreams(
	sessionSignal: AbortSignal,
): Pick<ContentStreamsStoreImpl, keyof ContentStreamsStoreImpl> {
	return new ContentStreamsStoreImpl(sessionSignal);
}

class ContentStreamsStoreImpl {
	private readonly sessionSignal: AbortSignal;
	private readonly controller: AbortController;
	private readonly signal: AbortSignal;
	private readonly entries: Map<string, Entry>;
	private readonly requests: Set<() => void>;
	private readonly waiting: Set<() => void>;
	private reading: number;
	private initialization?: Promise<string>;
	private onMessage: (event: MessageEvent<WorkerMessage>) => void;

	readonly open = this.openContent.bind(this);
	readonly download = this.downloadContent.bind(this);
	readonly invalidate = this.invalidateContent.bind(this);
	readonly dispose = this.disposeStreams.bind(this);

	constructor(sessionSignal: AbortSignal) {
		this.sessionSignal = sessionSignal;
		const controller = new AbortController();
		this.controller = controller;
		this.signal = AbortSignal.any([controller.signal, sessionSignal]);
		this.entries = new Map();
		this.requests = new Set();
		this.waiting = new Set();
		this.reading = 0;
		this.onMessage = this.openRequest.bind(this);
		if (sessionSignal.aborted) {
			this.disposeStreams();
		} else {
			sessionSignal.addEventListener("abort", this.dispose, { once: true });
		}
	}

	private async acquireRead(request: AbortSignal) {
		while (this.reading >= 2) {
			await new Promise<void>((resolve, reject) =>
				waitForRead(this.waiting, request, resolve, reject),
			);
		}
		request.throwIfAborted();
		this.reading++;
	}

	private openRequest(event: MessageEvent<WorkerMessage>) {
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
		const entry = this.entries.get(event.data.token);
		if (!entry || this.signal.aborted) {
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
			this.signal,
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
				this.closeRequest(current, new Error("The file session has ended.")),
		};
		request.addEventListener("abort", current.abort, { once: true });
		this.requests.add(current.abort);
		port.onmessage = (message) => this.readRequest(current, message);
		if (downloadRequest) {
			current.heartbeat = setInterval(
				() => this.pingRequest(current),
				HEARTBEAT_MS,
			);
		}
		const { size, type, name } = entry.source;
		sendRequest(current, { kind: "description", value: { size, type, name } });
	}

	private closeRequest(current: StreamRequest, error?: Error) {
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
		this.requests.delete(current.abort);
		current.request.removeEventListener("abort", current.abort);
		current.port.close();
		if (current.downloadRequest) {
			const finished = current.entry.finished;
			current.entry.finished = undefined;
			finished?.(error);
		}
	}

	private async readRequest(
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
			this.closeRequest(current);
			return;
		}
		if (message.data.kind === "cancel") {
			this.closeRequest(current, new Error("Download cancelled."));
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
			this.closeRequest(current, new Error("Invalid content read request."));
			return;
		}
		current.busy = true;
		let acquired = false;
		try {
			await this.acquireRead(current.request);
			acquired = true;
			const bytes = await current.entry.source.read(
				start,
				end,
				current.request,
			);
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
			this.closeRequest(
				current,
				error instanceof Error ? error : new Error("Content read failed."),
			);
		} finally {
			current.busy = false;
			if (acquired) {
				this.reading--;
				this.waiting.values().next().value?.();
			}
		}
	}

	private pingRequest(current: StreamRequest) {
		if (current.deadline !== undefined) {
			return;
		}
		current.deadline = setTimeout(
			() =>
				this.closeRequest(
					current,
					new Error("Download connection lost. Retry the download."),
				),
			BRIDGE_TIMEOUT_MS,
		);
		sendRequest(current, { kind: "ping" });
	}

	private async initializeStreams() {
		this.signal.throwIfAborted();
		if (!window.isSecureContext || !("serviceWorker" in navigator)) {
			throw new Error(
				"Streaming requires service workers on HTTPS or localhost.",
			);
		}
		navigator.serviceWorker.addEventListener("message", this.onMessage);
		const registration = await navigator.serviceWorker.register(
			"/streaming-worker.js",
			{
				scope: "/",
			},
		);
		registration.active?.postMessage({ kind: "claim" });
		this.signal.throwIfAborted();
		await new Promise<void>((resolve, reject) =>
			waitForController(this.signal, resolve, reject),
		);
		const client = await new Promise<string>((resolve, reject) =>
			requestClient(this.signal, resolve, reject),
		);
		this.signal.throwIfAborted();
		return client;
	}

	private disposeStreams() {
		this.controller.abort();
		this.sessionSignal.removeEventListener("abort", this.dispose);
		if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
			navigator.serviceWorker.removeEventListener("message", this.onMessage);
		}
		for (const close of this.requests) {
			close();
		}
		for (const entry of this.entries.values()) {
			entry.dispose();
		}
		this.entries.clear();
	}

	private async openStream(
		source: ContentSource,
		lifetime?: AbortSignal,
		finished?: (error?: Error) => void,
	) {
		this.signal.throwIfAborted();
		lifetime?.throwIfAborted();
		if (!Number.isSafeInteger(source.size) || source.size < 0) {
			throw new Error("Invalid plaintext size.");
		}
		this.initialization ??= this.initializeStreams().catch((error) =>
			this.initializationFailed(error),
		);
		const client = await this.initialization;
		this.signal.throwIfAborted();
		lifetime?.throwIfAborted();
		const token = crypto.randomUUID();
		const entry: Entry = {
			source,
			controller: new AbortController(),
			finished,
			dispose: () => disposeEntry(this.entries, entry, token, lifetime),
		};
		this.entries.set(token, entry);
		lifetime?.addEventListener("abort", entry.dispose, { once: true });
		const base = `${STREAM_PREFIX}${client}/${token}`;
		return {
			url: `${base}/inline`,
			downloadUrl: `${base}/download`,
			dispose: entry.dispose,
			entry,
		};
	}

	private async openContent(source: ContentSource, lifetime?: AbortSignal) {
		const { entry: _entry, ...lease } = await this.openStream(source, lifetime);
		return lease;
	}

	private async downloadContent(
		source: ContentSource,
		start: (url: string) => unknown,
	) {
		let finish: (error?: Error) => void = () => {};
		const done = new Promise<void>((resolve, reject) => {
			const completion: DownloadCompletion = {
				finished: false,
				resolve,
				reject,
			};
			finish = (error) => finishDownload(completion, error);
		});
		// Observe rejection before waiting for initialization or a browser request.
		void done.catch(() => {});
		const lease = await this.openStream(source, undefined, finish);
		const timer = setTimeout(
			() => finish(new Error("The browser did not start the download.")),
			BRIDGE_TIMEOUT_MS,
		);
		lease.entry.started = () => clearTimeout(timer);
		try {
			this.signal.throwIfAborted();
			await start(lease.downloadUrl);
			await done;
		} finally {
			clearTimeout(timer);
			lease.dispose();
		}
	}

	private invalidateContent(id: string) {
		for (const entry of this.entries.values()) {
			if (entry.source.id === id) {
				entry.dispose();
			}
		}
	}

	private initializationFailed(error: unknown): never {
		this.initialization = undefined;
		throw error;
	}
}

function sendRequest(
	current: Pick<StreamRequest, "port">,
	message: PageMessage,
	transfer: Transferable[] = [],
) {
	current.port.postMessage(message, transfer);
}

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
