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
export function createContentStreams(sessionSignal: AbortSignal) {
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, sessionSignal]);
	const entries = new Map<string, Entry>();
	const requests = new Set<() => void>();
	const waiting = new Set<() => void>();
	let reading = 0;
	let initialization: Promise<string> | undefined;

	async function capacity(request: AbortSignal) {
		while (reading >= 2) {
			await new Promise<void>((resolve, reject) => {
				const ready = () => {
					waiting.delete(ready);
					request.removeEventListener("abort", abort);
					resolve();
				};
				const abort = () => {
					waiting.delete(ready);
					reject(request.reason);
				};
				waiting.add(ready);
				request.addEventListener("abort", abort, { once: true });
				if (request.aborted) {
					abort();
				}
			});
		}
		request.throwIfAborted();
		reading++;
	}

	function onMessage(event: MessageEvent<WorkerMessage>) {
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
		const entry = entries.get(event.data.token);
		if (!entry || signal.aborted) {
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
			signal,
			entry.controller.signal,
			operation.signal,
		]);
		let closed = false;
		let busy = false;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const send = (message: PageMessage, transfer: Transferable[] = []) =>
			port.postMessage(message, transfer);
		const close = (error?: Error) => {
			if (closed) {
				return;
			}
			closed = true;
			clearInterval(heartbeat);
			clearTimeout(deadline);
			if (error) {
				send({ kind: "error", message: error.message });
			}
			operation.abort();
			requests.delete(abort);
			request.removeEventListener("abort", abort);
			port.close();
			if (downloadRequest) {
				const finished = entry.finished;
				entry.finished = undefined;
				finished?.(error);
			}
		};
		const abort = () => close(new Error("The file session has ended."));
		request.addEventListener("abort", abort, { once: true });
		requests.add(abort);
		port.onmessage = async (message: MessageEvent<WorkerMessage>) => {
			if (closed) {
				return;
			}
			if (message.data.kind === "pong") {
				clearTimeout(deadline);
				deadline = undefined;
				return;
			}
			if (message.data.kind === "complete") {
				close();
				return;
			}
			if (message.data.kind === "cancel") {
				close(new Error("Download cancelled."));
				return;
			}
			if (message.data.kind !== "read" || closed) {
				return;
			}
			const { start, end } = message.data;
			if (
				busy ||
				!Number.isSafeInteger(start) ||
				!Number.isSafeInteger(end) ||
				start < 0 ||
				end <= start ||
				end > entry.source.size ||
				end - start > STREAM_READ_BYTES
			) {
				close(new Error("Invalid content read request."));
				return;
			}
			busy = true;
			let acquired = false;
			try {
				await capacity(request);
				acquired = true;
				const bytes = await entry.source.read(start, end, request);
				request.throwIfAborted();
				if (bytes.byteLength !== end - start) {
					throw new Error("Invalid plaintext range length.");
				}
				const value =
					bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
						? bytes.buffer
						: bytes.slice().buffer;
				send({ kind: "bytes", value }, [value]);
			} catch (error) {
				close(
					error instanceof Error ? error : new Error("Content read failed."),
				);
			} finally {
				busy = false;
				if (acquired) {
					reading--;
					waiting.values().next().value?.();
				}
			}
		};
		if (downloadRequest) {
			heartbeat = setInterval(() => {
				if (deadline !== undefined) {
					return;
				}
				deadline = setTimeout(
					() =>
						close(new Error("Download connection lost. Retry the download.")),
					BRIDGE_TIMEOUT_MS,
				);
				send({ kind: "ping" });
			}, HEARTBEAT_MS);
		}
		const { size, type, name } = entry.source;
		send({ kind: "description", value: { size, type, name } });
	}

	async function initialize() {
		signal.throwIfAborted();
		if (!window.isSecureContext || !("serviceWorker" in navigator)) {
			throw new Error(
				"Streaming requires service workers on HTTPS or localhost.",
			);
		}
		navigator.serviceWorker.addEventListener("message", onMessage);
		const registration = await navigator.serviceWorker.register(
			"/streaming-worker.js",
			{
				scope: "/",
			},
		);
		registration.active?.postMessage({ kind: "claim" });
		signal.throwIfAborted();
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timer);
				navigator.serviceWorker.removeEventListener(
					"controllerchange",
					changed,
				);
				signal.removeEventListener("abort", aborted);
			};
			const changed = () => {
				if (navigator.serviceWorker.controller) {
					cleanup();
					resolve();
				}
			};
			const aborted = () => {
				cleanup();
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Streaming worker did not activate."));
			}, BRIDGE_TIMEOUT_MS);
			navigator.serviceWorker.addEventListener("controllerchange", changed);
			signal.addEventListener("abort", aborted, { once: true });
			changed();
			if (signal.aborted) {
				aborted();
			}
		});
		const client = await new Promise<string>((resolve, reject) => {
			const channel = new MessageChannel();
			const cleanup = () => {
				clearTimeout(timer);
				channel.port1.close();
				signal.removeEventListener("abort", aborted);
			};
			const aborted = () => {
				cleanup();
				reject(signal.reason);
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("Streaming worker did not respond."));
			}, BRIDGE_TIMEOUT_MS);
			channel.port1.onmessage = (event: MessageEvent<{ client: string }>) => {
				cleanup();
				resolve(event.data.client);
			};
			signal.addEventListener("abort", aborted, { once: true });
			navigator.serviceWorker.controller?.postMessage({ kind: "client" }, [
				channel.port2,
			]);
			if (signal.aborted) {
				aborted();
			}
		});
		signal.throwIfAborted();
		return client;
	}

	function dispose() {
		controller.abort();
		sessionSignal.removeEventListener("abort", dispose);
		if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
			navigator.serviceWorker.removeEventListener("message", onMessage);
		}
		for (const close of requests) {
			close();
		}
		for (const entry of entries.values()) {
			entry.dispose();
		}
		entries.clear();
	}
	sessionSignal.addEventListener("abort", dispose, { once: true });
	async function open(
		source: ContentSource,
		lifetime?: AbortSignal,
		finished?: (error?: Error) => void,
	) {
		signal.throwIfAborted();
		lifetime?.throwIfAborted();
		if (!Number.isSafeInteger(source.size) || source.size < 0) {
			throw new Error("Invalid plaintext size.");
		}
		initialization ??= initialize().catch((error) => {
			initialization = undefined;
			throw error;
		});
		const client = await initialization;
		signal.throwIfAborted();
		lifetime?.throwIfAborted();
		const token = crypto.randomUUID();
		const entry: Entry = {
			source,
			controller: new AbortController(),
			finished,
			dispose() {
				if (entry.controller.signal.aborted) {
					return;
				}
				lifetime?.removeEventListener("abort", entry.dispose);
				entry.controller.abort();
				const finished = entry.finished;
				entry.finished = undefined;
				finished?.(new Error("The file session has ended."));
				entries.delete(token);
			},
		};
		entries.set(token, entry);
		lifetime?.addEventListener("abort", entry.dispose, { once: true });
		const base = `${STREAM_PREFIX}${client}/${token}`;
		return {
			url: `${base}/inline`,
			downloadUrl: `${base}/download`,
			dispose: entry.dispose,
			entry,
		};
	}

	return {
		async open(source: ContentSource, lifetime?: AbortSignal) {
			const { entry: _entry, ...lease } = await open(source, lifetime);
			return lease;
		},
		async download(source: ContentSource, start: (url: string) => unknown) {
			let finish: (error?: Error) => void = () => {};
			const done = new Promise<void>((resolve, reject) => {
				let finished = false;
				finish = (error) => {
					if (finished) {
						return;
					}
					finished = true;
					if (error) {
						reject(error);
					} else {
						resolve();
					}
				};
			});
			// Observe rejection before waiting for initialization or a browser request.
			void done.catch(() => {});
			const lease = await open(source, undefined, finish);
			const timer = setTimeout(
				() => finish(new Error("The browser did not start the download.")),
				BRIDGE_TIMEOUT_MS,
			);
			lease.entry.started = () => clearTimeout(timer);
			try {
				signal.throwIfAborted();
				await start(lease.downloadUrl);
				await done;
			} finally {
				clearTimeout(timer);
				lease.dispose();
			}
		},
		invalidate(id: string) {
			for (const entry of entries.values()) {
				if (entry.source.id === id) {
					entry.dispose();
				}
			}
		},
		dispose,
	};
}

export type ContentStreams = ReturnType<typeof createContentStreams>;
