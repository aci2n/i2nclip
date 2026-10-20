import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.ts";
import { createApplication } from "../src/lib/stores/application.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { memoryStorage } from "./memory-database.ts";

function browserFixture(t: test.TestContext) {
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
	return browser;
}

test("application initializes before synchronous subscriptions and detaches navigation on disposal", async (t) => {
	const browser = browserFixture(t);
	const storage = memoryStorage();
	const session = createSession({
		persistence: createPersistence(storage.connect()),
	});
	const preferences = createPreferences(storage.connect());
	const app = createApplication({ session, preferences });
	t.after(app.dispose);
	app.start();
	assert.equal(get(app.session).checking, true);
	await Promise.all([session.load(), preferences.load()]);
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

test("application starts initial reads and receiver exactly once, and cannot restart after disposal", async (t) => {
	const browser = browserFixture(t);
	const sessionDb = memoryStorage().connect();
	const preferencesDb = memoryStorage().connect();
	const sessionRead = t.mock.method(sessionDb, "read", async () => undefined);
	const preferencesRead = t.mock.method(
		preferencesDb,
		"read",
		async () => undefined,
	);
	const listeners = t.mock.method(browser, "addEventListener");
	const app = createApplication({
		session: createSession({ persistence: createPersistence(sessionDb) }),
		preferences: createPreferences(preferencesDb),
	});
	t.after(app.dispose);
	assert.equal(sessionRead.mock.callCount(), 0);
	assert.equal(preferencesRead.mock.callCount(), 0);
	const receiverCount = () =>
		listeners.mock.calls.filter((call) => call.arguments[0] === "message")
			.length;
	assert.equal(receiverCount(), 0);
	const { start } = app;
	start();
	start();
	await Promise.all([app.session.load(), app.preferences.load()]);
	assert.equal(sessionRead.mock.callCount(), 1);
	assert.equal(preferencesRead.mock.callCount(), 1);
	assert.equal(receiverCount(), 1);
	app.dispose();
	start();
	assert.equal(receiverCount(), 1);
	assert.deepEqual(get(app), { workspace: null, streams: null });
});

test("application disposal before start leaves storage and receiver untouched", (t) => {
	const browser = browserFixture(t);
	const db = memoryStorage().connect();
	const read = t.mock.method(db, "read", async () => undefined);
	const listeners = t.mock.method(browser, "addEventListener");
	const app = createApplication({
		session: createSession({ persistence: createPersistence(db) }),
		preferences: createPreferences(memoryStorage().connect()),
	});
	t.after(app.dispose);
	app.dispose();
	app.start();
	assert.equal(read.mock.callCount(), 0);
	assert.equal(
		listeners.mock.calls.some((call) => call.arguments[0] === "message"),
		false,
	);
});

test("failed receiver setup releases its subscription and application resources", (t) => {
	const browser = browserFixture(t);
	const add = browser.addEventListener.bind(browser);
	const remove = t.mock.method(browser, "removeEventListener");
	t.mock.method(
		browser,
		"addEventListener",
		(...[type, listener, options]: Parameters<typeof add>) => {
			if (type === "message") {
				throw new Error("Receiver setup failed");
			}
			add(type, listener, options);
		},
	);
	const db = memoryStorage().connect();
	const read = t.mock.method(db, "read", async () => undefined);
	const session = createSession({ persistence: createPersistence(db) });
	let activeSubscriptions = 0;
	const subscribe = session.subscribe;
	t.mock.method(
		session,
		"subscribe",
		(...args: Parameters<typeof subscribe>) => {
			activeSubscriptions++;
			const unsubscribe = subscribe(...args);
			return () => {
				activeSubscriptions--;
				unsubscribe();
			};
		},
	);
	const app = createApplication({
		session,
		preferences: createPreferences(memoryStorage().connect()),
	});
	t.after(app.dispose);
	assert.throws(app.start, /Receiver setup failed/);
	assert.equal(activeSubscriptions, 0);
	assert.equal(read.mock.callCount(), 0);
	assert.equal(get(session).status, "locked");
	assert(remove.mock.calls.some((call) => call.arguments[0] === "hashchange"));
	app.start();
	assert.equal(activeSubscriptions, 0);
});

test("disposal from a synchronous startup notification detaches the new subscription", (t) => {
	browserFixture(t);
	const db = memoryStorage().connect();
	const read = t.mock.method(db, "read", async () => undefined);
	const session = createSession({ persistence: createPersistence(db) });
	let active = 0;
	const subscribe = session.subscribe;
	t.mock.method(
		session,
		"subscribe",
		(...args: Parameters<typeof subscribe>) => {
			active++;
			const unsubscribe = subscribe(...args);
			return () => {
				active--;
				unsubscribe();
			};
		},
	);
	const app = createApplication({
		session,
		preferences: createPreferences(memoryStorage().connect()),
	});
	t.after(app.dispose);
	let notifications = 0;
	const stop = app.subscribe(() => {
		if (++notifications === 2) {
			app.dispose();
		}
	});
	t.after(stop);
	app.start();
	assert.equal(active, 0);
	assert.equal(read.mock.callCount(), 0);
});
