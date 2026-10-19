import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createApplication } from "../src/lib/stores/application.ts";

test("application initializes before synchronous subscriptions and detaches navigation on disposal", (t) => {
	const storage = new Map<string, string>();
	const browser = Object.assign(new EventTarget(), {
		location: { origin: "https://clip.example", hash: "#/settings" },
		history: {
			replaceState(_state: unknown, _unused: string, hash: string) {
				browser.location.hash = hash;
			},
		},
		postMessage() {},
	});
	for (const [name, value] of [
		["window", browser],
		[
			"BroadcastChannel",
			class {
				constructor() {
					throw new Error("Session sharing unavailable.");
				}
			},
		],
		[
			"localStorage",
			{
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
				removeItem: (key: string) => storage.delete(key),
			},
		],
	] as const) {
		const original = Object.getOwnPropertyDescriptor(globalThis, name);
		Object.defineProperty(globalThis, name, { value, configurable: true });
		t.after(() => {
			if (original) {
				Object.defineProperty(globalThis, name, original);
			} else {
				Reflect.deleteProperty(globalThis, name);
			}
		});
	}
	const app = createApplication();
	t.after(app.dispose);
	assert.equal(get(app.routing).page, "settings");
	assert.equal(get(app.session).status, "new");
	assert.equal(get(app.session).checking, false);
	assert.deepEqual(get(app), { workspace: null, streams: null });
	assert.equal(app.canDropFiles(), false);
	app.routing.navigate({ page: "library" }, true);
	assert.equal(get(app.routing).page, "library");
	app.dispose();
	app.dispose();
	browser.location.hash = "#/settings";
	browser.dispatchEvent(new Event("hashchange"));
	assert.equal(get(app.routing).page, "library");
	assert.equal(get(app.session).status, "locked");
});
