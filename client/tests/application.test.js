import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createLibraryRuntime } from "../src/lib/service/runtime.js";
import { createApplication } from "../src/lib/stores/application.js";
import { engineClient, memoryRepository } from "./service-helpers.js";

function setup(t, page) {
	let location = new URL(
		`https://clip.example/${page}.html${["upload", "unlock"].includes(page) ? "?id=one" : ""}`,
	);
	const listeners = new Map();
	const browser = {
		get location() {
			return location;
		},
		history: {
			pushState(_state, _title, href) {
				location = new URL(href, location);
			},
		},
		addEventListener: (name, callback) => listeners.set(name, callback),
		removeEventListener: (name) => listeners.delete(name),
	};
	const engine = createLibraryRuntime({
		repository: memoryRepository(),
		defaultServerUrl: "https://clip.example",
	});
	t.after(engine.dispose);
	const app = createApplication(
		{ createService: () => engineClient(engine) },
		page,
		browser,
	);
	t.after(app.dispose);
	const navigate = (page) =>
		app.navigate({ button: 0, preventDefault() {} }, page);
	const back = (path) => {
		location = new URL(path, location);
		listeners.get("popstate")();
	};
	return { app, navigate, back, listeners };
}

test("navigation and history retain one library; modified clicks use native navigation", async (t) => {
	const { app, navigate, back, listeners } = setup(t, "library");
	await app.session.ready;
	const library = get(app).library;
	assert.equal(get(app).popupPage, null);
	assert.equal(get(app).pending, null);
	assert.equal(app.href("options"), "options.html");
	navigate("options");
	assert.equal(get(app).page, "options");
	back("library.html");
	assert.equal(get(app).library, library);
	app.navigate(
		{
			button: 0,
			ctrlKey: true,
			preventDefault() {
				assert.fail("modified link was intercepted");
			},
		},
		"options",
	);
	assert.equal(get(app).page, "library");
	app.dispose();
	assert.equal(listeners.size, 0);
});

test("popup navigation and history preserve its workflow, tag draft, and source ID", async (t) => {
	const { app, navigate, back } = setup(t, "upload");
	await app.session.ready;
	const first = get(app).pending;
	await first.ready;
	navigate("library");
	const library = get(app).library;
	assert.equal(get(app).pending, first);
	first.tags.set("draft");
	assert.equal(app.href("upload"), "upload.html?id=one");
	assert.equal(app.href("options"), "options.html?id=one");
	navigate("options");
	navigate("upload");
	assert.equal(get(first.tags), "draft");
	back("upload.html?id=one");
	assert.ok(get(app).pending);
	assert.equal(get(app).pending, first);
	assert.equal(get(app).auto, false);
	assert.equal(get(app).library, library);
	await get(app).pending.ready;
});

test("forget captures its selected library, prevents overlapping requests and suppresses stale errors", async () => {
	const { writable } = await import("svelte/store");
	const { createForgetLibrary } = await import(
		"../src/lib/stores/forget-library.js"
	);
	const { deferred } = await import("./helpers.js");
	const gate = deferred();
	let selected = "first";
	const calls = [];
	const root = {
		...writable({ instanceId: "owner", vault: { epoch: 1 } }),
		command: (name, payload) => {
			calls.push({ name, payload });
			return gate.promise;
		},
	};
	let accepted = false;
	const forget = createForgetLibrary(root, () => selected, {
		confirm: () => accepted,
	});
	assert.equal(await forget.run(), false);
	assert.equal(calls.length, 0);
	accepted = true;
	const pending = forget.run();
	assert.equal(await forget.run(), false);
	selected = "second";
	gate.reject(new Error("disk full"));
	assert.equal(await pending, false);
	assert.deepEqual(calls, [
		{ name: "libraries.forget", payload: { libraryId: "first" } },
	]);
	assert.deepEqual(get(forget), { busy: false, error: "" });
});
