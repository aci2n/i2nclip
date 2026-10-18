import {
	BRIDGE_TIMEOUT_MS,
	type PageMessage,
	STREAM_PREFIX,
	STREAM_READ_BYTES,
	type StreamDescription,
	type WorkerMessage,
} from "../streaming/messages.ts";

export interface ContentSource extends StreamDescription {
	read(
		start: number,
		end: number,
		signal: AbortSignal,
	): Promise<Uint8Array<ArrayBuffer>>;
}

interface Entry {
	source: ContentSource;
	controller: AbortController;
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
		const operation = new AbortController();
		const request = AbortSignal.any([
			signal,
			entry.controller.signal,
			operation.signal,
		]);
		let closed = false;
		let busy = false;
		const send = (message: PageMessage, transfer: Transferable[] = []) =>
			port.postMessage(message, transfer);
		const close = () => {
			if (closed) {
				return;
			}
			closed = true;
			send({ kind: "error", message: "The file session has ended." });
			operation.abort();
			requests.delete(close);
			request.removeEventListener("abort", close);
			port.close();
		};
		request.addEventListener("abort", close, { once: true });
		requests.add(close);
		port.onmessage = async (message: MessageEvent<WorkerMessage>) => {
			if (message.data.kind === "cancel") {
				close();
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
				close();
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
			} catch {
				close();
			} finally {
				busy = false;
				if (acquired) {
					reading--;
					waiting.values().next().value?.();
				}
			}
		};
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
		if ("serviceWorker" in navigator) {
			navigator.serviceWorker.removeEventListener("message", onMessage);
		}
		for (const close of requests) {
			close();
		}
		for (const entry of entries.values()) {
			entry.controller.abort();
		}
		entries.clear();
	}
	sessionSignal.addEventListener("abort", dispose, { once: true });
	return {
		async open(source: ContentSource) {
			signal.throwIfAborted();
			if (!Number.isSafeInteger(source.size) || source.size < 0) {
				throw new Error("Invalid plaintext size.");
			}
			initialization ??= initialize().catch((error) => {
				initialization = undefined;
				throw error;
			});
			const client = await initialization;
			signal.throwIfAborted();
			const token = crypto.randomUUID();
			const entry = { source, controller: new AbortController() };
			entries.set(token, entry);
			const base = `${STREAM_PREFIX}${client}/${token}`;
			return {
				url: `${base}/inline`,
				downloadUrl: `${base}/download`,
				dispose() {
					entry.controller.abort();
					entries.delete(token);
				},
			};
		},
		dispose,
	};
}

export type ContentStreams = ReturnType<typeof createContentStreams>;
