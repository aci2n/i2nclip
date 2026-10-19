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
import { deferred, tick } from "./helpers.ts";

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

test("lost workers time out and release downloads for a fresh attempt", async (t) => {
	const f = fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const opened = deferred();
	let peer: ReturnType<typeof f.connect> | undefined;
	const downloading = f.streams.download(f.source, (url) => {
		peer = f.connect(url);
		opened.resolve();
	});
	const rejected = assert.rejects(downloading, /connection lost.*Retry/);
	await opened.promise;
	assert(peer);
	await peer.description;
	peer.port.close();
	t.mock.timers.tick(10_000);
	t.mock.timers.tick(30_000);
	await rejected;
	await f.streams.download(f.source, (url) => {
		f.connect(url).send({ kind: "complete" });
	});
	t.mock.timers.tick(120_000);
});

test("answering heartbeats preserves idle downloads and content messages", async (t) => {
	const f = fixture(t);
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	const opened = deferred();
	let peer: ReturnType<typeof f.connect> | undefined;
	const downloading = f.streams.download(f.source, (url) => {
		peer = f.connect(url);
		opened.resolve();
	});
	await opened.promise;
	assert(peer);
	await peer.description;
	for (let index = 0; index < 5; index++) {
		const bytes = deferred();
		peer.port.onmessage = (event: MessageEvent<PageMessage>) => {
			if (event.data.kind === "ping") {
				peer?.send({ kind: "pong" });
				peer?.send({ kind: "read", start: 0, end: 4 });
			} else if (event.data.kind === "bytes") {
				assert.equal(event.data.value.byteLength, 4);
				bytes.resolve();
			}
		};
		t.mock.timers.tick(10_000);
		await bytes.promise;
	}
	peer.send({ kind: "complete" });
	await downloading;
	t.mock.timers.tick(120_000);
});

test("concurrent requests keep cancellation separate and release read capacity", async (t) => {
	const f = fixture(t);
	const started = [
		deferred<AbortSignal>(),
		deferred<AbortSignal>(),
		deferred<AbortSignal>(),
	];
	const results = [
		deferred<Uint8Array<ArrayBuffer>>(),
		deferred<Uint8Array<ArrayBuffer>>(),
		deferred<Uint8Array<ArrayBuffer>>(),
	];
	let active = 0;
	let maximum = 0;
	let count = 0;
	f.source.read = async (_start, _end, signal) => {
		const index = count++;
		active++;
		maximum = Math.max(maximum, active);
		const abort = () => results[index].reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		started[index].resolve(signal);
		try {
			return await results[index].promise;
		} finally {
			active--;
			signal.removeEventListener("abort", abort);
		}
	};
	const leases = await Promise.all(
		[0, 1, 2].map(() => f.streams.open(f.source)),
	);
	const peers = leases.map((lease) => f.connect(lease.url, false));
	await Promise.all(peers.map((peer) => peer.description));
	peers[0].send({ kind: "read", start: 0, end: 4 });
	const first = await started[0].promise;
	peers[1].send({ kind: "read", start: 0, end: 4 });
	const second = await started[1].promise;
	peers[2].send({ kind: "read", start: 0, end: 4 });
	await tick();
	assert.equal(count, 2);
	peers[0].send({ kind: "cancel" });
	const third = await started[2].promise;
	assert.equal(first.aborted, true);
	assert.equal(second.aborted, false);
	assert.equal(third.aborted, false);
	assert.equal(maximum, 2);
	const bytes = peers.slice(1).map(
		(peer) =>
			new Promise<ArrayBuffer>((resolve) => {
				peer.port.onmessage = (event: MessageEvent<PageMessage>) => {
					if (event.data.kind === "bytes") {
						resolve(event.data.value);
					}
				};
			}),
	);
	results[1].resolve(new Uint8Array([1, 2, 3, 4]));
	results[2].resolve(new Uint8Array([5, 6, 7, 8]));
	assert.deepEqual(
		(await Promise.all(bytes)).map((value) => [...new Uint8Array(value)]),
		[
			[1, 2, 3, 4],
			[5, 6, 7, 8],
		],
	);
	peers[1].send({ kind: "complete" });
	peers[2].send({ kind: "complete" });
});
