import {
	BRIDGE_TIMEOUT_MS,
	type PageMessage,
	STREAM_PREFIX,
	STREAM_READ_BYTES,
	type WorkerMessage,
} from "./messages.ts";
import { byteRange } from "./range.ts";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

// Resolve the owning page again for every request. No worker-global token/key
// registry is needed, so a stopped worker can serve a subsequent seek normally.
self.addEventListener("message", (event) => {
	if (event.data?.kind === "claim") {
		event.waitUntil(self.clients.claim());
		return;
	}
	if (event.data?.kind === "client" && event.source && "id" in event.source) {
		event.ports[0]?.postMessage({ client: event.source.id });
	}
});

self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (
		url.origin === self.location.origin &&
		url.pathname.startsWith(STREAM_PREFIX)
	) {
		event.respondWith(serve(event.request, url));
	}
});

function failure(status: number) {
	return new Response(null, {
		status,
		headers: { "cache-control": "no-store" },
	});
}

async function serve(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return failure(405);
	}
	const parts = url.pathname.slice(STREAM_PREFIX.length).split("/");
	if (parts.length !== 3 || !["inline", "download"].includes(parts[2])) {
		return failure(404);
	}
	const [clientId, token, mode] = parts;
	const client = await self.clients.get(clientId);
	if (!client || new URL(client.url).origin !== self.location.origin) {
		return failure(404);
	}
	const channel = new MessageChannel();
	const port = channel.port1;
	let pending: {
		resolve: (message: PageMessage) => void;
		reject: (error: Error) => void;
	} | null = null;
	let closed = false;
	let failureReason: Error | null = null;
	let buffered = new Uint8Array();
	let consumed = 0;
	let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
	const send = (message: WorkerMessage) => port.postMessage(message);
	const close = (complete = false) => {
		if (closed) {
			return;
		}
		closed = true;
		buffered = new Uint8Array();
		consumed = 0;
		send({ kind: complete ? "complete" : "cancel" });
		pending?.reject(new Error("Stream closed."));
		pending = null;
		port.close();
	};
	port.onmessage = (event: MessageEvent<PageMessage>) => {
		const waiter = pending;
		pending = null;
		if (event.data.kind === "error") {
			failureReason = new Error(event.data.message);
			waiter?.reject(failureReason);
			bodyController?.error(failureReason);
			close();
		} else {
			waiter?.resolve(event.data);
		}
	};
	const receive = () =>
		new Promise<PageMessage>((resolve, reject) => {
			if (closed || failureReason) {
				reject(failureReason ?? new Error("Stream closed."));
				return;
			}
			const timer = setTimeout(() => {
				pending = null;
				reject(new Error("The owning tab did not respond."));
			}, BRIDGE_TIMEOUT_MS);
			pending = {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
		});
	try {
		const describing = receive();
		client.postMessage(
			{
				kind: "open",
				token,
				download: mode === "download" && request.method === "GET",
			} satisfies WorkerMessage,
			[channel.port2],
		);
		const message = await describing;
		if (message.kind !== "description") {
			throw new Error("Invalid stream description.");
		}
		const { size, type, name } = message.value;
		if (!Number.isSafeInteger(size) || size < 0) {
			throw new Error("Invalid stream size.");
		}
		const range = byteRange(request.headers.get("range"), size);
		const headers = new Headers({
			"content-type": type,
			"accept-ranges": "bytes",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "sandbox allow-downloads; default-src 'none'",
			"cross-origin-resource-policy": "same-origin",
		});
		if (!range) {
			close();
			headers.set("content-range", `bytes */${size}`);
			return new Response(null, { status: 416, headers });
		}
		// Firefox may eagerly drain a synthesized response even when its fetch
		// consumer stops reading. Bound inline range responses independently of
		// native backpressure; players request further ranges as needed.
		if (mode === "inline" && range.partial) {
			range.end = Math.min(range.end, range.start + STREAM_READ_BYTES);
		}
		const partial = range.partial;
		headers.set("content-length", String(range.end - range.start));
		if (partial) {
			headers.set(
				"content-range",
				`bytes ${range.start}-${range.end - 1}/${size}`,
			);
		}
		const encoded = encodeURIComponent(name).replace(
			/[!'()*]/g,
			(value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
		);
		headers.set(
			"content-disposition",
			`${mode === "download" ? "attachment" : "inline"}; filename*=UTF-8''${encoded}`,
		);
		if (request.method === "HEAD" || range.start === range.end) {
			close(true);
			return new Response(request.method === "HEAD" ? null : new Uint8Array(), {
				status: partial ? 206 : 200,
				headers,
			});
		}
		let offset = range.start;
		const body = new ReadableStream<Uint8Array>(
			{
				start(controller) {
					bodyController = controller;
				},
				async pull(controller) {
					try {
						if (consumed === buffered.length) {
							const end = Math.min(range.end, offset + STREAM_READ_BYTES);
							const reading = receive();
							send({ kind: "read", start: offset, end });
							const data = await reading;
							if (
								data.kind !== "bytes" ||
								data.value.byteLength !== end - offset
							) {
								throw new Error("Invalid plaintext range response.");
							}
							buffered = new Uint8Array(data.value);
							consumed = 0;
						}
						const length = Math.min(64 * 1024, buffered.length - consumed);
						controller.enqueue(buffered.slice(consumed, consumed + length));
						consumed += length;
						offset += length;
						if (offset === range.end) {
							controller.close();
							close(true);
						}
					} catch (error) {
						controller.error(error);
						close();
					}
				},
				cancel: () => close(),
			},
			{ highWaterMark: 0 },
		);
		return new Response(body, { status: partial ? 206 : 200, headers });
	} catch {
		close();
		return failure(503);
	}
}
