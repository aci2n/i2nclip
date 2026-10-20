import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.ts";
import { createApplication } from "../src/lib/stores/application.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { memoryStorage } from "./memory-database.ts";

test("application initializes before synchronous subscriptions and detaches navigation on disposal", async (t) => {
	const browser = Object.assign(new EventTarget(), {
		location: { origin: "https://clip.example", hash: "#/settings" },
		history: {
			replaceState(_state: unknown, _unused: string, hash: string) {
				browser.location.hash = hash;
			},
		},
		postMessage() {},
	});
	const original = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		value: browser,
		configurable: true,
	});
	t.after(() => {
		if (original) {
			Object.defineProperty(globalThis, "window", original);
		} else {
			Reflect.deleteProperty(globalThis, "window");
		}
	});
	const storage = memoryStorage();
	const session = createSession({
		persistence: createPersistence(storage.connect()),
	});
	const preferences = createPreferences(storage.connect());
	const app = createApplication({ session, preferences });
	t.after(app.dispose);
	assert.equal(get(app.session).checking, true);
	await Promise.all([session.loaded, preferences.loaded]);
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
