import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createApplication } from "../src/lib/stores/application.js";

function setup(t, page) {
	let location = new URL(`https://clip.example/${page}.html?id=one`);
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
	const storage = { get: async () => ({}) };
	const app = createApplication(
		{ local: storage, session: storage, subscribe: () => () => {} },
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

test("returning to a popup via history recreates its workflow without discarding the library", async (t) => {
	const { app, navigate, back } = setup(t, "upload");
	await app.session.ready;
	const first = get(app).pending;
	await first.ready;
	navigate("library");
	const library = get(app).library;
	assert.equal(get(app).pending, null);
	back("upload.html?id=one");
	assert.ok(get(app).pending);
	assert.notEqual(get(app).pending, first);
	assert.equal(get(app).auto, false);
	assert.equal(get(app).library, library);
	await get(app).pending.ready;
});
