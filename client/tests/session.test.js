import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { get } from "svelte/store";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { recoveryFile } from "../src/lib/protocol/recovery.js";
import { wrapPrivateKey } from "../src/lib/protocol/vault.js";
import { createSession } from "../src/lib/stores/session.js";
import { deferred, installSessionLocks, tick } from "./helpers.js";

beforeEach(installSessionLocks);

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
	assert.throws(second.credentials, /Unlock/);
	assert.deepEqual(await cached.get(), {});
});

test("legacy unlocked sessions relock once and encrypted identities migrate on unlock", async (t) => {
	const { saved, privateKey } = await identityFixture();
	delete saved.identityGeneration;
	const local = area(saved);
	const cached = area({ privateKey });
	const session = open(t, local, cached);
	await session.ready;
	assert.throws(session.credentials, /Unlock/);
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
	assert.throws(session.credentials, /Unlock/);
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
	assert.throws(session.credentials, /Unlock/);
	failed = false;
	await session.refresh();
	assert.equal(get(session).privateKey, identity.privateKey);
	assert.equal(get(session).error, "");
});
