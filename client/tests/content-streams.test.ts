import assert from "node:assert/strict";
import test from "node:test";
import {
	type ContentSource,
	createContentStreams,
} from "../src/lib/stores/content-streams.ts";
import type {
	PageMessage,
	WorkerMessage,
} from "../src/lib/streaming/messages.ts";
import { deferred } from "./helpers.ts";

function fixture(t: test.TestContext) {
	const lifetime = new AbortController();
	const serviceWorker = Object.assign(new EventTarget(), {
		controller: {
			postMessage(_message: unknown, ports: MessagePort[]) {
				ports[0]?.postMessage({ client: "owner" });
				ports[0]?.close();
			},
		},
		async register() {
			return { active: { postMessage() {} } };
		},
	});
	const originalNavigator = Object.getOwnPropertyDescriptor(
		globalThis,
		"navigator",
	);
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "navigator", {
		value: { serviceWorker },
		configurable: true,
	});
	Object.defineProperty(globalThis, "window", {
		value: { isSecureContext: true },
		configurable: true,
	});
	const streams = createContentStreams(lifetime.signal);
	const ports: MessagePort[] = [];
	t.after(() => {
		lifetime.abort();
		streams.dispose();
		for (const port of ports) {
			port.close();
		}
		for (const [name, descriptor] of [
			["navigator", originalNavigator],
			["window", originalWindow],
		] as const) {
			if (descriptor) {
				Object.defineProperty(globalThis, name, descriptor);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		}
	});
	function connect(url: string, download = true) {
		const channel = new MessageChannel();
		ports.push(channel.port1, channel.port2);
		const messages: PageMessage[] = [];
		const description = deferred();
		channel.port2.onmessage = (event: MessageEvent<PageMessage>) => {
			messages.push(event.data);
			if (event.data.kind === "description") {
				description.resolve();
			}
		};
		serviceWorker.dispatchEvent(
			Object.assign(new Event("message"), {
				source: serviceWorker.controller,
				data: { kind: "open", token: url.split("/").at(-2), download },
				ports: [channel.port1],
			}),
		);
		return {
			messages,
			description: description.promise,
			port: channel.port2,
			send(message: WorkerMessage) {
				channel.port2.postMessage(message);
			},
		};
	}
	const source: ContentSource = {
		size: 4,
		name: "file.bin",
		type: "application/octet-stream",
		async read(start, end) {
			return new Uint8Array(end - start);
		},
	};
	return { streams, lifetime, source, connect };
}

test("successful downloads close once without sending an error", async (t) => {
	const f = fixture(t);
	let peer: ReturnType<typeof f.connect> | undefined;
	const opened = deferred();
	const downloading = f.streams.download(f.source, (url) => {
		peer = f.connect(url);
		opened.resolve();
	});
	await opened.promise;
	assert(peer);
	await peer.description;
	peer.send({ kind: "complete" });
	peer.send({ kind: "cancel" });
	await downloading;
	f.streams.dispose();
	f.streams.dispose();
	assert.deepEqual(
		peer.messages.map((message) => message.kind),
		["description"],
	);
});

test("cancellation aborts an owned read and permits a fresh download", async (t) => {
	const f = fixture(t);
	const reading = deferred<AbortSignal>();
	f.source.read = (_start, _end, signal) => {
		reading.resolve(signal);
		return new Promise((_resolve, reject) => {
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		});
	};
	let peer: ReturnType<typeof f.connect> | undefined;
	const opened = deferred();
	const downloading = f.streams.download(f.source, (url) => {
		peer = f.connect(url);
		opened.resolve();
	});
	const rejected = assert.rejects(downloading, /cancelled/);
	await opened.promise;
	assert(peer);
	await peer.description;
	peer.send({ kind: "read", start: 0, end: 4 });
	const signal = await reading.promise;
	peer.send({ kind: "cancel" });
	await rejected;
	assert(signal.aborted);
	await f.streams.download(f.source, (url) => {
		const next = f.connect(url);
		next.send({ kind: "complete" });
	});
});
