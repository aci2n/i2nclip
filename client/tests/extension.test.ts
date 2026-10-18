import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { writable } from "svelte/store";
import { ModuleKind, ScriptTarget, transpileModule } from "typescript";
import { installBridge } from "../extension/bridge.ts";
import type { ContextBrowser } from "../extension/capture.ts";
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
} from "../extension/capture.ts";
import type {
	BridgeReply,
	BridgeRequest,
	CaptureTab,
} from "../extension/types.d.ts";
import { DEFAULT_MAX_FILE_PLAINTEXT_BYTES as WEB_MAX_FILE_BYTES } from "../src/lib/api.ts";
import { checkSourceSize } from "../src/lib/media/convert.ts";
import { defaultUploadOptions } from "../src/lib/media/options.ts";
import type { Metadata } from "../src/lib/protocol/meta-plain.ts";
import type {
	CaptureEvent,
	CaptureSessionState,
} from "../src/lib/stores/extension.ts";
import { createExtensionReceiver } from "../src/lib/stores/extension.ts";
import { assertPresent } from "./assert.ts";
import { deferred, tick } from "./helpers.ts";
import { captureLogs } from "./log-capture.ts";

test("background startup restores the menu without an install event", async () => {
	const source = await readFile(
		new URL("../extension/background.ts", import.meta.url),
		"utf8",
	);
	const menus = new Map<
		string | number,
		{
			id?: string | number;
			title?: string;
			contexts?: string[];
		}
	>([["old", { title: "Old menu" }]]);
	let click: ((...args: unknown[]) => unknown) | undefined;
	const browser = {
		runtime: { onMessage: { addListener() {} } },
		menus: {
			removeAll: async () => menus.clear(),
			create: (menu: { id: string; title: string; contexts: string[] }) =>
				menus.set(menu.id, menu),
			onClicked: {
				addListener: (listener: (...args: unknown[]) => unknown) => {
					click = listener;
				},
			},
		},
	};
	// Run the real entry point in a fresh realm. No onInstalled event is sent.
	runInNewContext(
		transpileModule(source, {
			compilerOptions: {
				module: ModuleKind.ESNext,
				target: ScriptTarget.ES2022,
			},
		}).outputText.replace(/^import[\s\S]*?;\n/, ""),
		{
			browser,
			checkAppUrl,
			handleUploadResult,
			readCaptureContext,
			sendToApp,
		},
	);
	await Promise.resolve();
	assert.equal(menus.size, 1);
	assert.equal(assertPresent(menus.get("upload")).title, "Upload to i2nclip");
	assert.deepEqual(
		Array.from(assertPresent(assertPresent(menus.get("upload")).contexts)),
		["image", "audio", "video"],
	);
	assert.equal(typeof click, "function");
});
function app(
	t: test.TestContext,
	patch: Partial<CaptureSessionState> = {},
	result = Promise.resolve(true),
	getMaxFilePlaintextBytes = () => WEB_MAX_FILE_BYTES,
) {
	let lifetime = new AbortController();
	const sessionState = writable<CaptureSessionState>({
		status: "unlocked",
		unlocked: true,
		configured: true,
		busy: false,
		signal: lifetime.signal,
		...patch,
	});
	const session = {
		subscribe: sessionState.subscribe,
	};
	const uploads: File[][] = [];
	const extra: (Metadata | undefined)[] = [];
	const batches = Object.assign(
		writable<{ uploading: boolean; pending: readonly unknown[] }>({
			uploading: false,
			pending: [],
		}),
		{
			getMaxFilePlaintextBytes,
			checkFile: (file: File) =>
				checkSourceSize(
					file,
					defaultUploadOptions(),
					getMaxFilePlaintextBytes(),
				),
			upload: (files: File[], context?: Metadata) => {
				uploads.push(files);
				extra.push(context);
				batches.set({ uploading: true, pending: [] });
				return result;
			},
		},
	);
	const listeners = new Map<string, (event: CaptureEvent) => void>();
	const replies: {
		type: string;
		result: BridgeReply;
	}[] = [];
	const browser = {
		location: { origin: "https://clip.example" },
		addEventListener: (type: string, callback: (event: CaptureEvent) => void) =>
			listeners.set(type, callback),
		removeEventListener: (type: string) => listeners.delete(type),
		postMessage: (message: unknown) =>
			replies.push(
				message as {
					type: string;
					result: BridgeReply;
				},
			),
	};
	let navigations = 0;
	const receiver = createExtensionReceiver(
		session,
		() => batches,
		() => navigations++,
		browser,
	);
	t.after(() => {
		receiver.dispose();
		lifetime.abort();
	});
	const receive = (
		data: Record<string, unknown>,
		origin = browser.location.origin,
		source: unknown = browser,
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
		invalidate() {
			lifetime.abort();
			lifetime = new AbortController();
			sessionState.update((value) => ({ ...value, signal: lifetime.signal }));
		},
		batches,
		receiver,
		receive,
		uploads,
		extra,
		replies,
		listeners,
		get navigations() {
			return navigations;
		},
	};
}
const file = {
	type: "file",
	extra: {
		sourceUrl: "https://example.com/photo",
		sourceTitle: "A photo",
	},
	file: new File([new Uint8Array([0, 1, 2, 3, 255])], "Photo.png", {
		type: "image/png",
	}),
};
test("bridge uploads through the root upload store and rejects overlapping work", async (t) => {
	const fixture = app(t);
	assert.deepEqual(fixture.receive({ type: "probe" }), {
		ok: true,
		needsUnlock: false,
	});
	assert.deepEqual(fixture.receive(file), { ok: true, needsUnlock: false });
	assert.equal(fixture.navigations, 1);
	assert.deepEqual(fixture.extra[0], {
		source_url: file.extra.sourceUrl,
		source_title: file.extra.sourceTitle,
	});
	const uploaded = fixture.uploads[0][0];
	assert.equal(uploaded.name, file.file.name);
	assert.equal(uploaded.type, file.file.type);
	assert.deepEqual(
		new Uint8Array(await uploaded.arrayBuffer()),
		new Uint8Array([0, 1, 2, 3, 255]),
	);
	assert.match(
		assertPresent(assertPresent(fixture.receive(file)).error),
		/busy/,
	);
	assert.equal(fixture.uploads.length, 1);
});
test("locked receipt uploads exactly once when unlock finishes its busy transition", (t) => {
	const logs = captureLogs(t);
	const fixture = app(t, {
		status: "locked",
		unlocked: false,
		configured: false,
	});
	assert.deepEqual(fixture.receive(file), { ok: true, needsUnlock: true });
	assert.equal(fixture.uploads.length, 0);
	assert.match(
		assertPresent(assertPresent(fixture.receive(file)).error),
		/pending/,
	);
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
	assert.deepEqual(fixture.extra[0], {
		source_url: file.extra.sourceUrl,
		source_title: file.extra.sourceTitle,
	});
	fixture.batches.set({ uploading: false, pending: [] });
	fixture.sessionState.update((value) => ({ ...value }));
	assert.equal(fixture.uploads.length, 1);
	const pending = logs.find(
		(entry) => entry.event === "[i2nclip] extension-receiver.pending-unlock",
	);
	const resumed = logs.find(
		(entry) => entry.event === "[i2nclip] extension-receiver.pending-resumed",
	);
	assert(pending);
	assert.equal(pending.fields.operation, resumed?.fields.operation);
	assert.equal(pending.fields.instance, resumed?.fields.instance);
	const output = JSON.stringify(logs);
	assert(!output.includes(file.extra.sourceUrl));
	assert(!output.includes(file.extra.sourceTitle));
	assert(!output.includes(file.file.name));
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
	assert.match(
		assertPresent(assertPresent(fixture.receive(file)).error),
		/pending/,
	);
	fixture.invalidate();
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
		const result = deferred<boolean>();
		const fixture = app(t, {}, result.promise);
		assert.equal(assertPresent(fixture.receive(file)).ok, true);
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
	for (const value of [undefined, "not a file", {}, new Blob(["bytes"])]) {
		assert.equal(
			assertPresent(fixture.receive({ ...file, file: value })).ok,
			false,
		);
	}
	fixture.sessionState.update((value) => ({ ...value, busy: true }));
	assert.match(
		assertPresent(assertPresent(fixture.receive(file)).error),
		/busy/,
	);
	fixture.sessionState.update((value) => ({
		...value,
		busy: false,
		configured: false,
	}));
	assert.match(
		assertPresent(assertPresent(fixture.receive(file)).error),
		/Set up/,
	);
	assert.equal(fixture.uploads.length, 0);
});
test("receiver checks file size without reading its bytes", (t) => {
	const fixture = app(t);
	assert.equal(MAX_FILE_BYTES, WEB_MAX_FILE_BYTES);
	const tooLarge = new File([new Uint8Array(MAX_FILE_BYTES + 1)], "large.bin");
	assert.match(
		assertPresent(
			assertPresent(fixture.receive({ ...file, file: tooLarge })).error,
		),
		/32 MB/,
	);
	assert.equal(fixture.uploads.length, 0);
});
test("receiver uses the active file quota and preserves a zero limit", (t) => {
	let limit = 0;
	const fixture = app(t, {}, Promise.resolve(true), () => limit);
	assert.match(
		assertPresent(fixture.receive(file)?.error),
		/Uploads are disabled/,
	);
	assert.equal(fixture.uploads.length, 0);
	limit = 64 * 1024 * 1024;
	const large = new File([], "large.bin");
	Object.defineProperty(large, "size", { value: WEB_MAX_FILE_BYTES + 1 });
	large.arrayBuffer = async () => assert.fail("handoff must not read bytes");
	assert.equal(fixture.receive({ ...file, file: large })?.ok, true);
	assert.deepEqual(fixture.uploads, [[large]]);
});
test("configuration and tab matching require the configured origin and path", () => {
	assert.equal(
		checkAppUrl("https://clip.example/?example=1#/settings"),
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
		matchesApp("https://clip.example/#/settings", "https://clip.example/"),
	);
	assert(!matchesApp("https://clip.example/other", "https://clip.example/"));
	assert(!matchesApp("https://clip.example.evil/", "https://clip.example/"));
	assert(!matchesApp(undefined, "https://clip.example/"));
});
test("capture preserves bytes in a File and sanitizes its final filename", async () => {
	const bytes = Uint8Array.from({ length: 50001 }, (_, index) => index % 256);
	const result = await fetchFile(
		"https://media.example/a%2Fb.png",
		async (_, options) => {
			assert.equal(assertPresent(options).credentials, "omit");
			assert(assertPresent(options).signal instanceof AbortSignal);
			return new Response(bytes, {
				headers: {
					"content-type": "image/png; charset=binary",
					"content-length": "1",
				},
			});
		},
	);
	assert.equal(result.name, "a b.png");
	assert.equal(result.type, "image/png");
	assert.deepEqual(Buffer.from(await result.arrayBuffer()), Buffer.from(bytes));
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
			assertPresent(response.body).getReader = () => reader;
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
			return new Response();
		}),
		/HTTP/,
	);
	assert.equal(fetched, false);
});
function extensionBrowser(tabs: CaptureTab[]) {
	const calls: unknown[][] = [];
	const values = new Map(tabs.map((tab) => [assertPresent(tab.id), tab]));
	return {
		calls,
		runtime: { id: "i2nclip@i2n" },
		tabs: {
			sendMessage: async (
				tabId: number,
				message: {
					request: BridgeRequest;
					channel?: string;
					appUrl?: string;
					timeout?: number;
				},
			) => {
				calls.push([message.request.type, tabId]);
				return { ok: true };
			},
			query: async (query: { url: string }) => {
				calls.push(["query", query.url]);
				return tabs;
			},
			get: async (id: number) => assertPresent(values.get(id)),
			update: async (id: number) => calls.push(["focus", id]),
			create: async (options: { url: string }) => {
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
			update: async (id: number) => calls.push(["window", id]),
		},
		scripting: {
			executeScript: async () => [],
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
							url: "https://clip.example/#/settings",
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
				assertPresent(browser.calls.find(([action]) => action === "create"))[1],
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
	browser.tabs.sendMessage = async () => ({ ok: false, error: "Busy" });
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
	browser.tabs.sendMessage = async (_, { request }) => {
		if (request.type === "probe") {
			return { ok: true };
		}
		sent++;
		return {
			ok: false,
			unavailable: true,
			error: "Check the app before retrying.",
		};
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
		browser.tabs.sendMessage = async (_, { request }) => ({
			ok: true,
			needsUnlock: request.type === "probe" ? !needsUnlock : needsUnlock,
		});
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
	const notifications: string[] = [];
	const browser = { runtime: { id: "i2nclip@i2n" } };
	const notify = async (message: string) => notifications.push(message);
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
	assert.equal(notifications.length, 0);
	await handleUploadResult(browser, { ...message, ok: false }, sender, notify);
	assert.match(assertPresent(notifications.at(-1)), /Upload failed.*Photo.png/);
	await handleUploadResult(browser, message, sender, notify);
	assert.match(assertPresent(notifications.at(-1)), /Uploaded Photo.png/);
	assert.equal(notifications.length, 2);
});
function injectedBridge(request = file) {
	const listeners = new Map<string, (event: CaptureEvent) => void>();
	const window = {
		addEventListener: (type: string, callback: (event: CaptureEvent) => void) =>
			listeners.set(type, callback),
		removeEventListener: (type: string) => listeners.delete(type),
		postMessage() {},
	};
	const reported: {
		ok: boolean;
	}[] = [];
	let receive:
		| ((
				message: unknown,
				sender: {
					id: string;
				},
		  ) => Promise<BridgeReply>)
		| undefined;
	const install = runInNewContext(`(${installBridge.toString()})`, {
		window,
		location: { origin: "https://clip.example", pathname: "/" },
		URL,
		crypto: { randomUUID: () => "unique-request" },
		setTimeout,
		clearTimeout,
		browser: {
			runtime: {
				id: "i2nclip@i2n",
				onMessage: {
					addListener: (listener: (...args: unknown[]) => unknown) => {
						receive = listener as typeof receive;
					},
				},
				sendMessage: async (message: unknown) =>
					reported.push(
						message as {
							ok: boolean;
						},
					),
			},
		},
	});
	install();
	const reply = assertPresent(receive)(
		{
			channel: "i2nclip-extension-v1",
			appUrl: "https://clip.example/",
			request,
		},
		{ id: "i2nclip@i2n" },
	);
	const emit = (
		type: string,
		result: BridgeReply & {
			cancelled?: boolean;
		},
		token = "unique-request",
	) =>
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
	assertPresent(bridge.listeners.get("pagehide"))({
		data: null,
		source: null,
		origin: "",
	});
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
				getTargetElement: (id: number) => {
					const attributes = elements.get(id);
					return attributes
						? {
								getAttribute: (name: string) =>
									(attributes as Record<string, string | undefined>)[name] ||
									null,
							}
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
	let target: { tabId: number; frameIds: number[] } | undefined;
	const browser = {
		scripting: {
			executeScript: async (
				request: Parameters<ContextBrowser["scripting"]["executeScript"]>[0],
			) => {
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
	let delivered: File | undefined;
	let extra: import("../extension/types.d.ts").CaptureExtra | undefined;
	browser.tabs.sendMessage = async (_, { request }) => {
		if (request.type === "file") {
			delivered = request.file;
			extra = request.extra;
		}
		return { ok: true, needsUnlock: false };
	};
	await sendToApp(
		browser,
		"https://clip.example/",
		"https://media.example/image.php",
		async () =>
			new Response("photo", { headers: { "content-type": "image/png" } }),
		{
			label: "A mountain portrait",
			title: "Page title",
			url: "https://user:secret@example.com/gallery?photo=42#view",
		},
	);
	assert.equal(assertPresent(delivered).name, "A mountain portrait.png");
	assert.deepEqual(extra, {
		sourceUrl: "https://example.com/gallery?photo=42#view",
		sourceTitle: "Page title",
	});
	assert.equal(assertPresent(delivered).type, "image/png");
	assert.equal(
		Buffer.from(await assertPresent(delivered).arrayBuffer()).toString(),
		"photo",
	);
});
test("cancelled captures release bridge listeners without notifications", async () => {
	const bridge = injectedBridge();
	bridge.emit("reply", { ok: true, needsUnlock: true });
	await bridge.reply;
	bridge.emit("complete", { ok: false, cancelled: true });
	assert.equal(bridge.listeners.size, 0);
	assert.equal(bridge.reported.length, 0);
});

test("extension captures wait for the user to finish a pending web review", (t) => {
	const fixture = app(t);
	fixture.batches.set({ uploading: false, pending: [{ file: file.file }] });
	assert.equal(fixture.receive(file)?.ok, false);
	assert.match(fixture.receive(file)?.error ?? "", /busy/);
	assert.equal(fixture.uploads.length, 0);
	fixture.batches.set({ uploading: false, pending: [] });
	assert.equal(fixture.receive(file)?.ok, true);
	assert.equal(fixture.uploads.length, 1);
});

test("eligible oversized image handoff reaches shared upload preparation without reading", (t) => {
	const fixture = app(t, {}, Promise.resolve(true), () => 1);
	const large = new File([new Uint8Array(10)], "large.png", {
		type: "image/png",
	});
	large.arrayBuffer = async () => assert.fail("handoff must not read bytes");
	assert.equal(fixture.receive({ ...file, file: large })?.ok, true);
	assert.deepEqual(fixture.uploads, [[large]]);
});
