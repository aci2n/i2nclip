import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { get, writable } from "svelte/store";
import { handoff } from "../extension/bridge.js";
import {
	captureDetails,
	captureName,
	checkAppUrl,
	fetchFile,
	handleUploadResult,
	MAX_FILE_BYTES,
	matchesApp,
	readCaptureContext,
	sendToApp,
} from "../extension/capture.js";
import { MAX_FILE_BYTES as WEB_MAX_FILE_BYTES } from "../src/lib/api.js";
import { createExtensionReceiver } from "../src/lib/stores/extension.js";
import { deferred, tick } from "./helpers.js";

test("background startup restores the menu without an install event", async () => {
	const source = await readFile(
		new URL("../extension/background.js", import.meta.url),
		"utf8",
	);
	const menus = new Map([["old", { title: "Old menu" }]]);
	let click;
	const browser = {
		runtime: { onMessage: { addListener() {} } },
		menus: {
			removeAll: async () => menus.clear(),
			create: (menu) => menus.set(menu.id, menu),
			onClicked: {
				addListener: (listener) => {
					click = listener;
				},
			},
		},
	};
	// Run the real entry point in a fresh realm. No onInstalled event is sent.
	runInNewContext(source.replace(/^import[\s\S]*?;\n/, ""), {
		browser,
		checkAppUrl,
		handleUploadResult,
		readCaptureContext,
		sendToApp,
	});
	await Promise.resolve();
	assert.equal(menus.size, 1);
	assert.equal(menus.get("upload").title, "Upload to i2nclip");
	assert.deepEqual(Array.from(menus.get("upload").contexts), [
		"image",
		"audio",
		"video",
	]);
	assert.equal(typeof click, "function");
});

function app(t, patch = {}, result = Promise.resolve(true)) {
	const sessionState = writable({
		status: "unlocked",
		unlocked: true,
		configured: true,
		busy: false,
		epoch: 0,
		...patch,
	});
	const session = {
		subscribe: sessionState.subscribe,
		get epoch() {
			return get(sessionState).epoch;
		},
	};
	const uploads = [];
	const library = writable({ uploading: false });
	library.upload = (files) => {
		uploads.push(files);
		library.set({ uploading: true });
		return result;
	};
	const listeners = new Map();
	const replies = [];
	const browser = {
		location: { origin: "https://clip.example" },
		addEventListener: (type, callback) => listeners.set(type, callback),
		removeEventListener: (type) => listeners.delete(type),
		postMessage: (message) => replies.push(message),
	};
	let navigations = 0;
	const receiver = createExtensionReceiver(
		session,
		library,
		() => navigations++,
		browser,
	);
	t.after(() => receiver.dispose());
	const receive = (
		data,
		origin = browser.location.origin,
		source = browser,
	) => {
		listeners.get("message")?.({
			data: { channel: "i2nclip-extension-v1", token: "request", ...data },
			origin,
			source,
		});
		return replies.at(-1)?.result;
	};
	return {
		sessionState,
		library,
		receiver,
		receive,
		uploads,
		replies,
		listeners,
		get navigations() {
			return navigations;
		},
	};
}

const file = {
	type: "file",
	name: "Photo.png",
	mime: "image/png",
	base64: "AAECA/8=",
};

test("bridge uploads through the existing library and rejects overlapping work", async (t) => {
	const fixture = app(t);
	assert.deepEqual(fixture.receive({ type: "probe" }), {
		ok: true,
		needsUnlock: false,
	});
	assert.deepEqual(fixture.receive(file), { ok: true, needsUnlock: false });
	assert.equal(fixture.navigations, 1);
	const uploaded = fixture.uploads[0][0];
	assert.equal(uploaded.name, file.name);
	assert.equal(uploaded.type, file.mime);
	assert.deepEqual(
		new Uint8Array(await uploaded.arrayBuffer()),
		new Uint8Array([0, 1, 2, 3, 255]),
	);
	assert.match(fixture.receive(file).error, /busy/);
	assert.equal(fixture.uploads.length, 1);
});

test("locked receipt uploads exactly once when unlock finishes its busy transition", (t) => {
	const fixture = app(t, {
		status: "locked",
		unlocked: false,
		configured: false,
	});
	assert.deepEqual(fixture.receive(file), { ok: true, needsUnlock: true });
	assert.equal(fixture.uploads.length, 0);
	assert.match(fixture.receive(file).error, /pending/);
	fixture.sessionState.update((value) => ({ ...value, busy: true }));
	fixture.sessionState.update((value) => ({
		...value,
		status: "unlocked",
		unlocked: true,
		configured: true,
	}));
	assert.equal(fixture.uploads.length, 0);
	fixture.sessionState.update((value) => ({ ...value, busy: false }));
	assert.equal(fixture.uploads.length, 1);
	fixture.library.set({ uploading: false });
	fixture.sessionState.update((value) => ({ ...value }));
	assert.equal(fixture.uploads.length, 1);
});

test("failed unlock keeps the capture and invalidation or disposal discards it", (t) => {
	const fixture = app(t, {
		status: "locked",
		unlocked: false,
		configured: false,
	});
	fixture.receive(file);
	fixture.sessionState.update((value) => ({ ...value, busy: true }));
	fixture.sessionState.update((value) => ({ ...value, busy: false }));
	assert.match(fixture.receive(file).error, /pending/);
	fixture.sessionState.update((value) => ({ ...value, epoch: 1 }));
	fixture.sessionState.update((value) => ({
		...value,
		status: "unlocked",
		unlocked: true,
		configured: true,
	}));
	assert.equal(fixture.uploads.length, 0);
	fixture.sessionState.update((value) => ({
		...value,
		status: "locked",
		unlocked: false,
		configured: false,
	}));
	fixture.receive(file);
	fixture.receiver.dispose();
	assert.equal(fixture.listeners.size, 0);
	fixture.sessionState.update((value) => ({
		...value,
		status: "unlocked",
		unlocked: true,
		configured: true,
	}));
	assert.equal(fixture.uploads.length, 0);
});

test("captures emit completion only after the regular upload settles", async (t) => {
	for (const ok of [true, false]) {
		const result = deferred();
		const fixture = app(t, {}, result.promise);
		assert.equal(fixture.receive(file).ok, true);
		assert(!fixture.replies.some((message) => message.type === "complete"));
		result.resolve(ok);
		await tick();
		assert.deepEqual(
			fixture.replies.filter((message) => message.type === "complete"),
			[
				{
					channel: "i2nclip-extension-v1",
					type: "complete",
					token: "request",
					result: { ok },
				},
			],
		);
	}
});

test("receiver rejects setup, mutation, foreign messages, and malformed files", (t) => {
	const fixture = app(t);
	fixture.receive(file, "https://other.example");
	fixture.receive(file, "https://clip.example", {});
	fixture.receive({ ...file, channel: "other" });
	fixture.receive({ ...file, token: {} });
	assert.equal(fixture.replies.length, 0);
	for (const patch of [
		{ name: "../file" },
		{ mime: "text/html\n" },
		{ base64: "!bad" },
		{ name: "" },
		{ base64: "====" },
	]) {
		assert.equal(fixture.receive({ ...file, ...patch }).ok, false);
	}
	fixture.sessionState.update((value) => ({ ...value, busy: true }));
	assert.match(fixture.receive(file).error, /busy/);
	fixture.sessionState.update((value) => ({
		...value,
		busy: false,
		configured: false,
	}));
	assert.match(fixture.receive(file).error, /Set up/);
	assert.equal(fixture.uploads.length, 0);
});

test("receiver checks the decoded size before allocating a file", (t) => {
	const fixture = app(t);
	assert.equal(MAX_FILE_BYTES, WEB_MAX_FILE_BYTES);
	// This encoding fits the maximum encoded length but decodes to limit + 1.
	const tooLarge = "A".repeat(4 * Math.ceil(MAX_FILE_BYTES / 3));
	assert.match(fixture.receive({ ...file, base64: tooLarge }).error, /32 MB/);
	assert.equal(fixture.uploads.length, 0);
});

test("configuration and tab matching require the configured origin and path", () => {
	assert.equal(
		checkAppUrl("https://clip.example/?page=settings#x"),
		"https://clip.example/",
	);
	assert.equal(checkAppUrl("http://127.0.0.1:8080/"), "http://127.0.0.1:8080/");
	for (const value of [
		"http://clip.example/",
		"https://user:pass@clip.example/",
		"file:///tmp/app",
		"bad",
	]) {
		assert.throws(() => checkAppUrl(value));
	}
	assert(
		matchesApp("https://clip.example/?page=settings", "https://clip.example/"),
	);
	assert(!matchesApp("https://clip.example/other", "https://clip.example/"));
	assert(!matchesApp("https://clip.example.evil/", "https://clip.example/"));
	assert(!matchesApp(undefined, "https://clip.example/"));
});

test("capture preserves bytes across base64 chunks and sanitizes filenames", async () => {
	const bytes = Uint8Array.from({ length: 50_001 }, (_, index) => index % 256);
	const result = await fetchFile(
		"https://media.example/a%2Fb.png",
		async (_, options) => {
			assert.equal(options.credentials, "omit");
			assert(options.signal instanceof AbortSignal);
			return new Response(bytes, {
				headers: {
					"content-type": "image/png; charset=binary",
					"content-length": "1",
				},
			});
		},
	);
	assert.equal(result.name, "a_b.png");
	assert.equal(result.mime, "image/png");
	assert.deepEqual(Buffer.from(result.base64, "base64"), Buffer.from(bytes));
});

test("capture rejects overflow, HTTP errors, and read failures and cancels streams", async () => {
	for (const scenario of ["overflow", "declared", "http", "read"]) {
		let cancelled = 0;
		const body = new ReadableStream({
			start(controller) {
				if (scenario === "overflow") {
					controller.enqueue(new Uint8Array(MAX_FILE_BYTES + 1));
				}
			},
			cancel() {
				cancelled++;
			},
		});
		const response = new Response(body, {
			status: scenario === "http" ? 403 : 200,
			headers:
				scenario === "declared"
					? { "content-length": String(MAX_FILE_BYTES + 1) }
					: {},
		});
		if (scenario === "read") {
			const reader = body.getReader();
			reader.read = async () => {
				throw new Error("Read failed");
			};
			response.body.getReader = () => reader;
		}
		await assert.rejects(
			fetchFile("https://media.example/file", async () => response),
			scenario === "http"
				? /403/
				: scenario === "read"
					? /Read failed/
					: /32 MB/,
		);
		assert.equal(cancelled, 1, scenario);
	}
	let fetched = false;
	await assert.rejects(
		fetchFile("blob:https://media.example/file", async () => {
			fetched = true;
		}),
		/HTTP/,
	);
	assert.equal(fetched, false);
});

function extensionBrowser(tabs) {
	const calls = [];
	const values = new Map(tabs.map((tab) => [tab.id, tab]));
	return {
		calls,
		runtime: { id: "i2nclip@i2n" },
		tabs: {
			query: async (query) => {
				calls.push(["query", query.url]);
				return tabs;
			},
			get: async (id) => values.get(id),
			update: async (id) => calls.push(["focus", id]),
			create: async (options) => {
				calls.push(["create", options]);
				const tab = {
					id: 9,
					windowId: 4,
					status: "complete",
					url: options.url,
				};
				values.set(tab.id, tab);
				return tab;
			},
		},
		windows: {
			update: async (id) => calls.push(["window", id]),
		},
		scripting: {
			executeScript: async ({ target, args }) => {
				calls.push([args[0].request.type, target.tabId]);
				return [{ result: { ok: true } }];
			},
		},
	};
}

test("extension reuses the web app tab or creates one and sends exactly once", async () => {
	for (const existing of [false, true]) {
		const browser = extensionBrowser(
			existing
				? [
						{
							id: 3,
							windowId: 2,
							url: "https://clip.example/?page=settings",
							status: "complete",
						},
					]
				: [{ id: 1, url: "https://other.example/", status: "complete" }],
		);
		await sendToApp(
			browser,
			"https://clip.example/",
			"https://media.example/photo.png",
			async () =>
				new Response("photo", { headers: { "content-type": "image/png" } }),
		);
		assert.equal(
			browser.calls.filter(([action]) => action === "create").length,
			existing ? 0 : 1,
		);
		assert.deepEqual(
			browser.calls.filter(([action]) => action === "file"),
			[["file", existing ? 3 : 9]],
		);
		assert(!browser.calls.some(([action]) => action === "focus"));
		assert(!browser.calls.some(([action]) => action === "window"));
		assert.deepEqual(browser.calls[0], ["query", "https://clip.example/*"]);
		if (!existing) {
			assert.deepEqual(
				browser.calls.find(([action]) => action === "create")[1],
				{
					url: "https://clip.example/",
					active: false,
				},
			);
		}
	}
});

test("extension does not fetch on rejection or retry an uncertain handoff", async () => {
	const browser = extensionBrowser([
		{ id: 3, windowId: 2, url: "https://clip.example/", status: "complete" },
	]);
	let fetched = 0;
	let sent = 0;
	browser.scripting.executeScript = async () => [
		{ result: { ok: false, error: "Busy" } },
	];
	const fetcher = async () => {
		fetched++;
		return new Response("photo");
	};
	await assert.rejects(
		sendToApp(
			browser,
			"https://clip.example/",
			"https://media.example/photo",
			fetcher,
		),
		/Busy/,
	);
	assert.equal(fetched, 0);
	browser.scripting.executeScript = async ({ args }) => {
		if (args[0].request.type === "probe") {
			return [{ result: { ok: true } }];
		}
		sent++;
		return [
			{
				result: {
					ok: false,
					unavailable: true,
					error: "Check the app before retrying.",
				},
			},
		];
	};
	await assert.rejects(
		sendToApp(
			browser,
			"https://clip.example/",
			"https://media.example/photo",
			fetcher,
		),
		/Check the app/,
	);
	assert.equal(fetched, 1);
	assert.equal(sent, 1);
});

test("focus follows the final locked receipt, including lock changes during fetching", async () => {
	for (const needsUnlock of [true, false]) {
		const browser = extensionBrowser([
			{ id: 3, windowId: 2, url: "https://clip.example/", status: "complete" },
		]);
		browser.scripting.executeScript = async ({ args }) => [
			{
				result: {
					ok: true,
					needsUnlock:
						args[0].request.type === "probe" ? !needsUnlock : needsUnlock,
				},
			},
		];
		await sendToApp(
			browser,
			"https://clip.example/",
			"https://media.example/photo",
			async () => new Response("photo"),
		);
		assert.equal(
			browser.calls.some(([action]) => action === "focus"),
			needsUnlock,
		);
		assert.equal(
			browser.calls.some(([action]) => action === "window"),
			needsUnlock,
		);
	}
});

test("upload results notify success or failure without managing windows", async () => {
	const notifications = [];
	const browser = { runtime: { id: "i2nclip@i2n" } };
	const notify = async (message) => notifications.push(message);
	const message = {
		type: "upload-complete",
		appUrl: "https://clip.example/",
		name: "Photo.png",
		ok: true,
	};
	const sender = {
		id: browser.runtime.id,
		frameId: 0,
		url: message.appUrl,
		tab: { id: 9, windowId: 4 },
	};
	for (const patch of [
		{ id: "other" },
		{ frameId: 1 },
		{ url: "https://other.example/" },
	]) {
		await handleUploadResult(browser, message, { ...sender, ...patch }, notify);
	}
	assert.deepEqual(notifications, []);
	await handleUploadResult(browser, { ...message, ok: false }, sender, notify);
	assert.match(notifications.at(-1), /Upload failed.*Photo.png/);
	await handleUploadResult(browser, message, sender, notify);
	assert.match(notifications.at(-1), /Uploaded Photo.png/);
	assert.equal(notifications.length, 2);
});

function injectedBridge(request = { type: "file", name: "Photo.png" }) {
	const listeners = new Map();
	const window = {
		addEventListener: (type, callback) => listeners.set(type, callback),
		removeEventListener: (type) => listeners.delete(type),
		postMessage() {},
	};
	const reported = [];
	const inject = runInNewContext(`(${handoff.toString()})`, {
		window,
		location: { origin: "https://clip.example", pathname: "/" },
		URL,
		crypto: { randomUUID: () => "unique-request" },
		setTimeout,
		clearTimeout,
		browser: {
			runtime: { sendMessage: async (message) => reported.push(message) },
		},
	});
	const reply = inject({
		appUrl: "https://clip.example/",
		request,
	});
	const emit = (type, result, token = "unique-request") =>
		listeners.get("message")?.({
			source: window,
			origin: "https://clip.example",
			data: { channel: "i2nclip-extension-v1", type, token, result },
		});
	return { listeners, reported, reply, emit };
}

test("bridge reports correlated upload outcomes and releases completion listeners", async () => {
	for (const ok of [true, false]) {
		const bridge = injectedBridge();
		bridge.emit("reply", { ok: true, needsUnlock: true });
		assert.equal((await bridge.reply).ok, true);
		assert.equal(bridge.reported.length, 0);
		bridge.emit("complete", { ok: true }, "other-request");
		assert.equal(bridge.reported.length, 0);
		bridge.emit("complete", { ok });
		assert.equal(bridge.listeners.size, 0);
		assert.equal(bridge.reported.length, 1);
		assert.equal(bridge.reported[0].ok, ok);
	}
});

test("navigation settles an unfinished handoff and releases its listeners", async () => {
	const bridge = injectedBridge();
	bridge.listeners.get("pagehide")();
	assert.equal((await bridge.reply).ok, false);
	assert.equal(bridge.listeners.size, 0);
	assert.equal(bridge.reported.length, 0);
});

test("capture names prefer media descriptions, then page titles and page URLs", () => {
	assert.equal(
		captureName(
			{ label: "  Córdoba   at sunset  ", title: "Page title" },
			"image.php",
			"image/jpeg",
		),
		"Córdoba at sunset.jpg",
	);
	assert.equal(
		captureName({ label: "", title: "A portrait.png" }, "image", "image/png"),
		"A portrait.png",
	);
	assert.equal(
		captureName(
			{
				title: "  ",
				url: "https://user:secret@example.com/trips/C%C3%B3rdoba?photo=42#view",
			},
			"image.png",
			"image/png",
		),
		"example.com trips Córdoba photo=42#view.png",
	);
	assert.equal(
		captureName(
			{ url: "https://example.com/gallery?photo=43" },
			"image.png",
			"image/png",
		),
		"example.com gallery photo=43.png",
	);
	assert.equal(captureName({}, "Original.mp3", "audio/mpeg"), "Original.mp3");
	assert.equal(
		captureName(
			{ label: 'Folder/Name\\:*?"<>|\nTitle' },
			"image.png",
			"image/png",
		),
		"Folder Name Title.png",
	);
	const long = captureName(
		{ label: "A".repeat(600) },
		"image.png",
		"image/png",
	);
	assert.equal(long.length, 255);
	assert(long.endsWith(".png"));
});

test("source inspection uses the exact clicked target and falls through blank attributes", async () => {
	const elements = new Map([
		[1, { alt: "First image" }],
		[2, { alt: "  ", title: "Second image" }],
		[3, { "aria-label": "Voice recording" }],
	]);
	const inspect = runInNewContext(`(${captureDetails.toString()})`, {
		browser: {
			menus: {
				getTargetElement: (id) => {
					const attributes = elements.get(id);
					return attributes
						? { getAttribute: (name) => attributes[name] || null }
						: null;
				},
			},
		},
		document: { title: "Frame title" },
		location: { href: "https://media.example/frame" },
	});
	assert.equal(inspect(1).label, "First image");
	assert.equal(inspect(2).label, "Second image");
	assert.equal(inspect(3).label, "Voice recording");
	assert.equal(inspect(99).label, "");
	let target;
	const browser = {
		scripting: {
			executeScript: async (request) => {
				target = request.target;
				return [{ result: inspect(request.args[0]) }];
			},
		},
	};
	const details = await readCaptureContext(
		browser,
		{ frameId: 7, targetElementId: 2 },
		{ id: 3, title: "Tab title" },
	);
	assert.deepEqual(target, { tabId: 3, frameIds: [7] });
	assert.equal(details.label, "Second image");
	assert.equal(details.title, "Frame title");
	browser.scripting.executeScript = async () => {
		throw new Error("Restricted frame");
	};
	assert.deepEqual(
		await readCaptureContext(
			browser,
			{ frameUrl: "https://media.example/frame" },
			{ id: 3, title: "Tab title" },
		),
		{ title: "Tab title", url: "https://media.example/frame" },
	);
});

test("capture passes the descriptive filename to the ordinary handoff", async () => {
	const browser = extensionBrowser([
		{ id: 3, windowId: 2, url: "https://clip.example/", status: "complete" },
	]);
	let delivered;
	browser.scripting.executeScript = async ({ args }) => {
		if (args[0].request.type === "file") {
			delivered = args[0].request;
		}
		return [{ result: { ok: true, needsUnlock: false } }];
	};
	await sendToApp(
		browser,
		"https://clip.example/",
		"https://media.example/image.php",
		async () =>
			new Response("photo", { headers: { "content-type": "image/png" } }),
		{ label: "A mountain portrait", title: "Page title" },
	);
	assert.equal(delivered.name, "A mountain portrait.png");
	assert.equal(delivered.mime, "image/png");
	assert.equal(Buffer.from(delivered.base64, "base64").toString(), "photo");
});

test("cancelled captures release bridge listeners without notifications", async () => {
	const bridge = injectedBridge();
	bridge.emit("reply", { ok: true, needsUnlock: true });
	await bridge.reply;
	bridge.emit("complete", { ok: false, cancelled: true });
	assert.equal(bridge.listeners.size, 0);
	assert.equal(bridge.reported.length, 0);
});
