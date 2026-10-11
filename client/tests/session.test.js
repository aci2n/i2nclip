import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { get } from "svelte/store";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { recoveryFile } from "../src/lib/protocol/recovery.js";
import { wrapPrivateKey } from "../src/lib/protocol/vault.js";
import { createLibrary } from "../src/lib/stores/library.js";
import { createSession } from "../src/lib/stores/session.js";
import { deferred, installSessionLocks, tick } from "./helpers.js";

beforeEach(installSessionLocks);

test("default server follows the web origin including its port, with an extension fallback", async (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "location", previous);
		else delete globalThis.location;
	});
	for (const [page, expected] of [
		["http://localhost:8080/settings", "http://localhost:8080"],
		["https://library.example:8443/settings", "https://library.example:8443"],
		["https://library.example/settings", "https://library.example"],
		["moz-extension://extension-id/popup.html", "https://clip.i2n.duckdns.org"],
	]) {
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: new URL(page),
		});
		const session = open(t, area(), area());
		assert.equal(get(session).serverUrl, expected);
		await session.ready;
		assert.equal(get(session).serverUrl, expected);
		const saved = open(t, area({ serverUrl: "https://saved.example" }), area());
		await saved.ready;
		assert.equal(get(saved).serverUrl, "https://saved.example");
	}
});

test("paired identities use a new local password and generation without registering again", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(),
		cached = area();
	const session = open(t, local, cached);
	await session.ready;
	const signal = new AbortController().signal;
	assert.ok(
		await session.importPairing({
			serverUrl: saved.serverUrl,
			privateKey,
			publicKey: saved.publicKey,
			password: "new-device-password",
			signal,
		}),
	);
	assert.notEqual(
		(await local.get()).identityGeneration,
		saved.identityGeneration,
	);
	assert.equal((await cached.get()).privateKey, privateKey);
	await cached.clear();
	await session.refresh();
	assert.equal(await session.unlock("password123"), false);
	assert.equal(await session.unlock("new-device-password"), true);
});

test("competing paired imports serialize and cannot replace an existing library", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area();
	const first = open(t, local, area()),
		second = open(t, local, area());
	await Promise.all([first.ready, second.ready]);
	const value = {
		serverUrl: saved.serverUrl,
		privateKey,
		publicKey: saved.publicKey,
		password: "new-device-password",
		signal: new AbortController().signal,
	};
	const outcomes = await Promise.all([
		first.importPairing(value),
		second.importPairing(value),
	]);
	assert.deepEqual(outcomes.map(Boolean).sort(), [false, true]);
	assert.equal((await local.get()).publicKey, saved.publicKey);
});

test("canceled or invalid paired imports never write an identity", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(),
		cached = area();
	const session = open(t, local, cached);
	await session.ready;
	const controller = new AbortController();
	controller.abort();
	const value = {
		serverUrl: saved.serverUrl,
		privateKey,
		publicKey: saved.publicKey,
		password: "new-device-password",
		signal: controller.signal,
	};
	assert.equal(await session.importPairing(value), false);
	assert.deepEqual(await local.get(), {});
	assert.equal(
		await session.importPairing({
			...value,
			signal: new AbortController().signal,
			publicKey: "different",
		}),
		false,
	);
	assert.deepEqual(await local.get(), {});
	await local.set({ pendingRegistration: {} });
	assert.equal(
		await session.importPairing({
			...value,
			signal: new AbortController().signal,
		}),
		false,
	);
	assert.equal((await local.get()).wrappedKey, undefined);
});

function area(initial = {}) {
	let values = { ...initial };
	return {
		get: async () => ({ ...values }),
		set: async (next) => {
			values = { ...values, ...next };
		},
		remove: async (keys) => {
			for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
		},
		clear: async () => {
			values = {};
		},
	};
}

async function identityFixture() {
	const { privateKey, publicKey } = await generatePrivateKey();
	const saved = {
		serverUrl: "https://clip.example",
		publicKey,
		wrappedKey: await wrapPrivateKey(privateKey, "password123", 1),
		identityGeneration: crypto.randomUUID(),
	};
	return { saved, privateKey, file: new Blob([recoveryFile(saved)]) };
}

function open(t, local, cached) {
	const store = createSession({
		local,
		session: cached,
		subscribe: () => () => {},
	});
	t.after(store.dispose);
	return store;
}

test("pairing transfer queued behind another page's reset rejects stale credentials", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const unlocked = { privateKey, sessionGeneration: saved.identityGeneration };
	const cleanup = area(unlocked);
	const first = open(t, local, cleanup);
	const second = open(t, local, area(unlocked));
	await Promise.all([first.ready, second.ready]);
	const expected = second.operation();
	const entered = deferred(),
		finish = deferred();
	cleanup.clear = async () => {
		entered.resolve();
		await finish.promise;
	};
	const resetting = first.reset();
	await entered.promise;
	assert.deepEqual(await local.get(), {});
	let transferred = false;
	const exporting = second.withIdentity(expected, async () => {
		transferred = true;
	});
	const rejected = assert.rejects(
		exporting,
		/Library or server changed|Library changed/,
	);
	await tick();
	assert.equal(transferred, false);
	finish.resolve();
	assert.equal(await resetting, true);
	await rejected;
	assert.equal(transferred, false);
});

test("pairing transfer rejects changed persisted server or generation without a refresh event", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const session = open(
		t,
		local,
		area({ privateKey, sessionGeneration: saved.identityGeneration }),
	);
	await session.ready;
	for (const change of [
		{ serverUrl: "https://other.example" },
		{ identityGeneration: "replacement" },
	]) {
		const expected = session.operation();
		await local.set({ ...saved, ...change });
		await assert.rejects(
			session.withIdentity(expected, async () =>
				assert.fail("stale identity exported"),
			),
			/Library or server changed|Library changed/,
		);
	}
});

test("pairing holds the session lock through submission before another page changes server", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const unlocked = { privateKey, sessionGeneration: saved.identityGeneration };
	const first = open(t, local, area(unlocked));
	const second = open(t, local, area(unlocked));
	await Promise.all([first.ready, second.ready]);
	const entered = deferred(),
		finish = deferred();
	const exporting = first.withIdentity(first.operation(), async (value) => {
		assert.equal(value.privateKey, privateKey);
		assert.equal(value.publicKey, saved.publicKey);
		entered.resolve();
		await finish.promise;
		assert.equal((await local.get()).serverUrl, saved.serverUrl);
	});
	await entered.promise;
	const changing = second.setServer("https://other.example");
	await tick();
	assert.equal((await local.get()).serverUrl, saved.serverUrl);
	finish.resolve();
	await exporting;
	assert.equal(await changing, true);
	assert.equal((await local.get()).serverUrl, "https://other.example");
});

test("reset clears a second tab's key and restoring the same identity cannot unlock it", async (t) => {
	const { saved, privateKey, file } = await identityFixture();
	const local = area(saved);
	const unlocked = { privateKey, sessionGeneration: saved.identityGeneration };
	const first = open(t, local, area(unlocked));
	const cached = area({ ...unlocked, "upload:pending": {} });
	const second = open(t, local, cached);
	await Promise.all([first.ready, second.ready]);
	assert.equal(get(second).privateKey, privateKey);
	assert.equal(await first.reset(), true);
	await second.refresh();
	assert.equal(get(second).privateKey, "");
	assert.deepEqual(await cached.get(), { "upload:pending": {} });
	assert.equal(await first.restore(file, "password123"), true);
	await second.refresh();
	assert.equal(get(second).privateKey, "");
	assert.notEqual(
		(await local.get()).identityGeneration,
		saved.identityGeneration,
	);
	assert.equal(await second.unlock("password123"), true);
	assert.equal(get(second).privateKey, privateKey);
	assert.equal(
		(await cached.get()).sessionGeneration,
		(await local.get()).identityGeneration,
	);
});

test("a tab that misses reset and restoration events rejects its old session generation", async (t) => {
	const { saved, privateKey, file } = await identityFixture();
	const local = area(saved);
	const unlocked = { privateKey, sessionGeneration: saved.identityGeneration };
	const cached = area(unlocked);
	const first = open(t, local, area(unlocked));
	const second = open(t, local, cached);
	await Promise.all([first.ready, second.ready]);
	assert.equal(await first.reset(), true);
	assert.equal(await first.restore(file, "password123"), true);
	assert.equal((await cached.get()).privateKey, privateKey);
	await second.refresh();
	await assert.rejects(
		second.withIdentity(second.operation(), () =>
			assert.fail("locked identity exported"),
		),
		/Library or server changed|Storage unavailable/,
	);
	assert.deepEqual(await cached.get(), {});
});

test("legacy unlocked sessions relock once and encrypted identities migrate on unlock", async (t) => {
	const { saved, privateKey } = await identityFixture();
	delete saved.identityGeneration;
	const local = area(saved);
	const cached = area({ privateKey });
	const session = open(t, local, cached);
	await session.ready;
	await assert.rejects(
		session.withIdentity(session.operation(), () =>
			assert.fail("locked identity exported"),
		),
		/Library or server changed|Storage unavailable/,
	);
	assert.deepEqual(await cached.get(), {});
	assert.equal(await session.unlock("wrong password"), false);
	assert.deepEqual(await local.get(), saved);
	assert.equal(await session.unlock("password123"), true);
	const generation = (await local.get()).identityGeneration;
	assert.ok(generation);
	assert.equal((await cached.get()).sessionGeneration, generation);
	assert.equal(get(session).privateKey, privateKey);
	assert.equal(await session.unlock("password123"), true);
	assert.equal((await local.get()).identityGeneration, generation);
	assert.deepEqual((await local.get()).wrappedKey, saved.wrappedKey);
});

test("queued refresh rereads a completed unlock and never removes its fresh key", async (t) => {
	const { saved } = await identityFixture();
	const local = area(saved);
	const cached = area();
	const session = open(t, local, cached);
	await session.ready;
	const writing = deferred(),
		finish = deferred();
	const write = cached.set;
	cached.set = async (values) => {
		writing.resolve();
		await finish.promise;
		await write(values);
	};
	const unlock = session.unlock("password123");
	await writing.promise;
	const refresh = session.refresh();
	finish.resolve();
	assert.equal(await unlock, true);
	await refresh;
	assert.ok((await cached.get()).privateKey);
	assert.equal(get(session).privateKey, (await cached.get()).privateKey);
});

test("stale-key cleanup finishes before a queued unlock writes its new key", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const cached = area();
	const session = open(t, local, cached);
	await session.ready;
	await cached.set({ privateKey, sessionGeneration: "old" });
	const removing = deferred(),
		finish = deferred();
	const remove = cached.remove;
	cached.remove = async (keys) => {
		removing.resolve();
		await finish.promise;
		await remove(keys);
	};
	const refresh = session.refresh();
	await removing.promise;
	const unlock = session.unlock("password123");
	finish.resolve();
	await refresh;
	assert.equal(await unlock, true);
	assert.equal((await cached.get()).privateKey, privateKey);
	assert.equal(
		(await cached.get()).sessionGeneration,
		saved.identityGeneration,
	);
});

test("reset invalidates shared identity before session cleanup and reports cleanup failures", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const cached = area({
		privateKey,
		sessionGeneration: saved.identityGeneration,
	});
	const session = open(t, local, cached);
	await session.ready;
	cached.clear = async () => {
		assert.deepEqual(await local.get(), {});
		throw new Error("session cleanup failed");
	};
	assert.equal(await session.reset(), false);
	assert.equal(get(session).privateKey, "");
	assert.equal(get(session).error, "session cleanup failed");
	assert.deepEqual(await cached.get(), {});
});

test("unavailable coordination locks the session without changing storage", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const cached = area({
		privateKey,
		sessionGeneration: saved.identityGeneration,
	});
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: undefined,
	});
	const session = open(t, local, cached);
	await session.ready;
	assert.equal(get(session).privateKey, "");
	assert.match(get(session).error, /coordination is unavailable/);
	assert.equal(await session.reset(), false);
	assert.deepEqual(await local.get(), saved);
	assert.equal((await cached.get()).privateKey, privateKey);
});

test("registration finishing after disposal cannot configure an identity", async (t) => {
	let receive;
	const started = new Promise((resolve) => {
		receive = resolve;
	});
	let finish;
	let signal;
	let writes = 0;
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		signal = options.signal;
		receive();
		return new Promise((resolve) => {
			finish = resolve;
		});
	});
	const storage = {
		get: async () => ({}),
		set: async () => {
			writes++;
		},
	};
	const session = createSession({
		local: storage,
		session: storage,
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	const create = session.create({
		serverUrl: "https://clip.example",
		password: "password123",
		otc: "code",
	});
	await started;
	session.dispose();
	assert.equal(signal.aborted, true);
	finish(new Response(null, { status: 204 }));
	assert.equal(await create, false);
	assert.equal(writes, 1); // Only the encrypted pending identity was saved before sending.
	assert.equal(await session.setServer("https://other.example"), false);
});

test("refresh locks an unlocked key belonging to a different saved library", async (t) => {
	const first = await generatePrivateKey(),
		second = await generatePrivateKey();
	let local = {
		wrappedKey: {},
		publicKey: first.publicKey,
		identityGeneration: "generation",
	};
	let cached = {
		privateKey: first.privateKey,
		sessionGeneration: "generation",
	};
	const session = createSession({
		local: { get: async () => local },
		session: {
			get: async () => cached,
			remove: async () => {
				cached = {};
			},
		},
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	assert.equal(get(session).privateKey, first.privateKey);
	local = { ...local, publicKey: second.publicKey };
	await session.refresh();
	assert.equal(get(session).privateKey, "");
	await assert.rejects(
		session.withIdentity(session.operation(), () =>
			assert.fail("locked identity exported"),
		),
		/Library or server changed|Storage unavailable/,
	);
	assert.deepEqual(cached, {});
});

test("session mutations serialize across pages using the same Web Lock", async (t) => {
	const gate = deferred();
	const writes = [];
	const locks = [];
	let tail = Promise.resolve();
	const previous = Object.getOwnPropertyDescriptor(navigator, "locks");
	Object.defineProperty(navigator, "locks", {
		configurable: true,
		value: {
			request(name, options, task) {
				locks.push({ name, signal: options.signal });
				const next = tail.then(task);
				tail = next.catch(() => {});
				return next;
			},
		},
	});
	t.after(() => {
		if (previous) Object.defineProperty(navigator, "locks", previous);
		else delete navigator.locks;
	});
	let local = {};
	const platform = {
		local: {
			get: async () => local,
			set: async (value) => {
				writes.push(value.serverUrl);
				if (writes.length === 1) await gate.promise;
				local = { ...local, ...value };
			},
		},
		session: { get: async () => ({}) },
		subscribe: () => () => {},
	};
	const one = createSession(platform),
		two = createSession(platform);
	t.after(() => {
		one.dispose();
		two.dispose();
	});
	await Promise.all([one.ready, two.ready]);
	const first = one.setServer("https://first.example"),
		second = two.setServer("https://second.example");
	await tick();
	assert.deepEqual(writes, ["https://first.example"]);
	assert.equal(get(two).busy, true);
	gate.resolve();
	assert.deepEqual(await Promise.all([first, second]), [true, true]);
	assert.deepEqual(writes, ["https://first.example", "https://second.example"]);
	assert.ok(
		locks.every((lock) => lock.name === "i2nclip-session" && lock.signal),
	);
});

test("invalid server schemes and embedded credentials cannot alter storage", async (t) => {
	let writes = 0;
	const storage = {
		get: async () => ({}),
		set: async () => {
			writes++;
		},
	};
	const session = createSession({
		local: storage,
		session: storage,
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	for (const url of [
		"not-a-url",
		"javascript:alert(1)",
		"https://user:secret@clip.example",
	]) {
		assert.equal(await session.setServer(url), false);
	}
	assert.equal(writes, 0);
});

test("failed storage verification locks the session until a successful refresh", async (t) => {
	const identity = await generatePrivateKey();
	let failed = false;
	const session = createSession({
		local: {
			get: async () => {
				if (failed) throw new Error("Storage unavailable");
				return {
					publicKey: identity.publicKey,
					wrappedKey: {},
					identityGeneration: "generation",
				};
			},
		},
		session: {
			get: async () => ({
				privateKey: identity.privateKey,
				sessionGeneration: "generation",
			}),
		},
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	assert.equal(get(session).privateKey, identity.privateKey);
	failed = true;
	await session.refresh();
	assert.equal(get(session).privateKey, "");
	assert.equal(get(session).error, "Storage unavailable");
	await assert.rejects(
		session.withIdentity(session.operation(), () =>
			assert.fail("locked identity exported"),
		),
		/Library or server changed|Storage unavailable/,
	);
	failed = false;
	await session.refresh();
	assert.equal(get(session).privateKey, identity.privateKey);
	assert.equal(get(session).error, "");
});

test("identity operations cannot be forged, borrowed from another service, or reused after disposal", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const cached = { privateKey, sessionGeneration: saved.identityGeneration };
	const first = open(t, local, area(cached));
	const second = open(t, local, area(cached));
	await Promise.all([first.ready, second.ready]);
	const operation = first.operation();
	assert.equal("expected" in operation, false);
	assert.equal(Object.isFrozen(operation), true);
	for (const invalid of [
		{ signal: new AbortController().signal },
		second.operation(),
	])
		await assert.rejects(
			first.withIdentity(invalid, () =>
				assert.fail("foreign identity operation"),
			),
			/Invalid session operation/,
		);
	operation.dispose();
	await assert.rejects(
		first.withIdentity(operation, () =>
			assert.fail("disposed identity operation"),
		),
		/Invalid session operation/,
	);
});

test("reset immediately invalidates all identity operations, including a callback holding the mutex", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	const session = open(
		t,
		local,
		area({ privateKey, sessionGeneration: saved.identityGeneration }),
	);
	await session.ready;
	const operation = session.operation();
	const entered = deferred(),
		finish = deferred();
	const held = session.withIdentity(operation, async () => {
		entered.resolve();
		await finish.promise;
	});
	const rejected = assert.rejects(held, { name: "AbortError" });
	await entered.promise;
	const resetting = session.reset();
	assert.equal(operation.signal.aborted, true);
	assert.equal(get(session).privateKey, "");
	assert.equal((await local.get()).wrappedKey != null, true);
	finish.resolve();
	await rejected;
	assert.equal(await resetting, true);
	assert.deepEqual(await local.get(), {});
});

test("pending upload error updates queued behind reset cannot recreate discarded work", async (t) => {
	const local = area({});
	const cached = area({ "upload:one": { name: "one" } });
	const session = open(t, local, cached);
	await session.ready;
	const entered = deferred(),
		finish = deferred();
	const clear = cached.clear;
	cached.clear = async () => {
		entered.resolve();
		await finish.promise;
		await clear();
	};
	const resetting = session.reset();
	await entered.promise;
	const failed = session.pending.fail("one", "offline");
	finish.resolve();
	assert.equal(await resetting, true);
	assert.equal(await failed, false);
	assert.equal(await session.pending.get("one"), undefined);
});

test("a missed storage notification refreshes the identity and lets library search recover", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const local = area(saved);
	// open deliberately delivers no storage notifications.
	const session = open(
		t,
		local,
		area({ privateKey, sessionGeneration: saved.identityGeneration }),
	);
	await session.ready;
	const servers = [];
	const initialListed = deferred();
	const library = createLibrary(
		session,
		{},
		{
			list: async ({ serverUrl }) => {
				servers.push(serverUrl);
				initialListed.resolve();
				return { items: [], next: null };
			},
		},
	);
	t.after(library.dispose);
	await initialListed.promise;
	await tick();
	assert.deepEqual(servers, [saved.serverUrl]);

	const serverUrl = "https://changed.example";
	await local.set({ serverUrl });
	await library.search("new");
	await tick();
	await library.search("retry");
	await tick();

	assert.equal(get(session).serverUrl, serverUrl);
	assert.equal(servers.at(-1), serverUrl);
	assert.equal(get(library).loading, false);
	assert.equal(get(library).status, "");
});

test("an explicit platform default takes precedence over the page origin", async (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "location");
	Object.defineProperty(globalThis, "location", {
		configurable: true,
		value: new URL("http://localhost:8080"),
	});
	t.after(() => {
		if (previous) Object.defineProperty(globalThis, "location", previous);
		else delete globalThis.location;
	});
	const session = createSession({
		defaultServerUrl: "https://extension.example",
		local: area(),
		session: area(),
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	assert.equal(get(session).serverUrl, "https://extension.example");
});

test("invalidation callbacks cannot start a second mutation inside the first one", async (t) => {
	const { saved, privateKey } = await identityFixture();
	const session = open(
		t,
		area(saved),
		area({ privateKey, sessionGeneration: saved.identityGeneration }),
	);
	await session.ready;
	let reentrant;
	const operation = session.operation({
		onInvalidated: () => {
			reentrant = session.setServer("https://other.example");
		},
	});
	t.after(operation.dispose);
	assert.equal(await session.reset(), true);
	assert.equal(await reentrant, false);
});
