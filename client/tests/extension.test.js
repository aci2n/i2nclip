import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { get, writable } from "svelte/store";
import {
	checkAppUrl,
	fetchFile,
	MAX_FILE_BYTES,
	matchesApp,
	sendToApp,
} from "../extension/capture.js";
import { MAX_FILE_BYTES as WEB_MAX_FILE_BYTES } from "../src/lib/api.js";
import { createExtensionReceiver } from "../src/lib/stores/extension.js";

test("background startup restores the menu without an install event", async () => {
	const source = await readFile(
		new URL("../extension/background.js", import.meta.url),
		"utf8",
	);
	const menus = new Map([["old", { title: "Old menu" }]]);
	let click;
	const browser = {
		contextMenus: {
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
	runInNewContext(source.replace(/^import[^\n]+\n/, ""), {
		browser,
		checkAppUrl,
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

function app(t, patch = {}) {
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
		return Promise.resolve(true);
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
	assert.deepEqual(fixture.receive({ type: "probe" }), { ok: true });
	assert.deepEqual(fixture.receive(file), { ok: true });
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

test("locked receipt remains in memory until explicitly uploaded after unlock", async (t) => {
	const fixture = app(t, {
		status: "locked",
		unlocked: false,
		configured: false,
	});
	assert.equal(fixture.receive(file).ok, true);
	assert.equal(get(fixture.receiver).name, file.name);
	assert.equal(fixture.receiver.upload(), false);
	assert.match(fixture.receive(file).error, /pending/);
	fixture.sessionState.update((value) => ({
		...value,
		status: "unlocked",
		unlocked: true,
		configured: true,
	}));
	assert.equal(get(fixture.receiver).canUpload, true);
	assert.equal(fixture.uploads.length, 0);
	assert.equal(fixture.receiver.upload(), true);
	assert.equal(get(fixture.receiver).name, "");
	assert.equal(fixture.uploads.length, 1);
});

test("cancel, session invalidation, and disposal release pending files", (t) => {
	const fixture = app(t, {
		status: "locked",
		unlocked: false,
		configured: false,
	});
	fixture.receive(file);
	fixture.receiver.cancel();
	assert.equal(get(fixture.receiver).name, "");
	fixture.receive(file);
	fixture.sessionState.update((value) => ({ ...value, epoch: 1 }));
	assert.equal(get(fixture.receiver).name, "");
	fixture.receive(file);
	fixture.receiver.dispose();
	assert.equal(get(fixture.receiver).name, "");
	assert.equal(fixture.listeners.size, 0);
	assert.equal(fixture.receiver.upload(), false);
	assert.equal(fixture.uploads.length, 0);
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
		tabs: {
			query: async () => tabs,
			get: async (id) => values.get(id),
			create: async ({ url }) => {
				calls.push(["create", url]);
				const tab = { id: 9, windowId: 4, status: "complete", url };
				values.set(tab.id, tab);
				return tab;
			},
			update: async (id) => calls.push(["focus", id]),
		},
		windows: { update: async (id) => calls.push(["window", id]) },
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
		assert(browser.calls.some(([action]) => action === "focus"));
		assert(browser.calls.some(([action]) => action === "window"));
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
