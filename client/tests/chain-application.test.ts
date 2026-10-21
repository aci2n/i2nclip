import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.ts";
import { hexToBytes } from "../src/lib/protocol/bytes.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createChainApplication as createApplication } from "../src/lib/stores/chain-application.ts";
import { createSession } from "../src/lib/stores/identity.ts";
import { createPreferences } from "../src/lib/stores/preferences.ts";
import { registerSession } from "./library-fixture.ts";
import { memoryStorage } from "./memory-database.ts";

function browserFixture(t: test.TestContext) {
	const browser = Object.assign(new EventTarget(), {
		location: { origin: "https://clip.example", hash: "#/settings" },
		history: {
			replaceState(_state: unknown, _unused: string, hash: string) {
				browser.location.hash = hash;
			},
		},
		postMessage(_message?: unknown, _origin?: string) {},
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
	assert.deepEqual(get(app), { workspace: null });
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
	assert.deepEqual(get(app), { workspace: null });
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

test("one root workspace survives navigation, including deep links, and historical views reject captures", async (t) => {
	const browser = browserFixture(t);
	browser.location.hash = `#/media/${"11".repeat(32)}`;
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	const range = Object.getOwnPropertyDescriptor(globalThis, "IDBKeyRange");
	Object.defineProperty(globalThis, "indexedDB", {
		value: new IDBFactory(),
		configurable: true,
	});
	Object.defineProperty(globalThis, "IDBKeyRange", {
		value: IDBKeyRange,
		configurable: true,
	});
	t.after(() => {
		if (descriptor) {
			Object.defineProperty(globalThis, "indexedDB", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
		if (range) {
			Object.defineProperty(globalThis, "IDBKeyRange", range);
		} else {
			Reflect.deleteProperty(globalThis, "IDBKeyRange");
		}
	});
	const session = createSession({
		persistence: createPersistence(memoryStorage().connect()),
		download: () => {},
		http: { registered: async () => false, register: async () => {} },
	});
	const app = createApplication({
		session,
		preferences: createPreferences(memoryStorage().connect()),
	});
	t.after(app.dispose);
	t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
		const url = new URL(String(input));
		if (url.pathname === "/api/quota") {
			return new Response(encode([1024 * 1024, 100, 0, 0, 0]));
		}
		const after = url.searchParams.get("after");
		assert.ok(after);
		return new Response(encode([hexToBytes(after), 0, [], null]));
	});
	app.start();
	await Promise.all([session.load(), app.preferences.load()]);
	await session.initialize("local password");
	await registerSession(session, {
		serverUrl: "https://clip.example",
		otc: "invite",
	});
	const workspace = get(app).workspace;
	assert.ok(workspace);
	await workspace.chain.sync();
	assert.equal(get(app.routing).page, "media");
	assert.equal(app.canDropFiles(), true);
	app.routing.navigate({ page: "settings" }, true);
	assert.equal(get(app).workspace, workspace);
	app.routing.navigate({ page: "library" }, true);
	assert.equal(get(app).workspace, workspace);
	await workspace.view.select(0);
	assert.equal(app.canDropFiles(), false);
	const post = t.mock.method(browser, "postMessage");
	browser.dispatchEvent(
		Object.assign(new Event("message"), {
			source: browser,
			origin: browser.location.origin,
			data: {
				channel: "i2nclip-extension-v1",
				type: "probe",
				token: "historical",
			},
		}),
	);
	const reply = post.mock.calls.at(-1)?.arguments[0] as {
		result: { ok: boolean; error: string };
	};
	assert.equal(reply.result.ok, false);
	assert.match(reply.result.error, /live library/);
	await workspace.view.select(null);
	assert.equal(app.canDropFiles(), true);
	await session.lock();
	assert.equal(get(app).workspace, null);
	assert.equal(workspace.context.signal.aborted, true);
});
