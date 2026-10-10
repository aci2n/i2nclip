import assert from "node:assert/strict";
import test from "node:test";
import { createSession } from "../src/lib/stores/session.js";

test("registration finishing after disposal cannot save an identity", async (t) => {
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
	assert.equal(writes, 0);
	assert.equal(await session.setServer("https://other.example"), false);
});

test("refresh locks an unlocked key belonging to a different saved library", async (t) => {
	const { generatePrivateKey } = await import(
		"../src/lib/protocol/identity.js"
	);
	const { get } = await import("svelte/store");
	const first = await generatePrivateKey(),
		second = await generatePrivateKey();
	let local = { wrappedKey: {}, publicKey: first.publicKey };
	const session = createSession({
		local: { get: async () => local },
		session: { get: async () => ({ privateKey: first.privateKey }) },
		subscribe: () => () => {},
	});
	t.after(session.dispose);
	await session.ready;
	assert.equal(get(session).privateKey, first.privateKey);
	local = { wrappedKey: {}, publicKey: second.publicKey };
	await session.refresh();
	assert.equal(get(session).privateKey, "");
	assert.throws(session.credentials, /Unlock/);
});

test("session mutations serialize across pages using the same Web Lock", async (t) => {
	const { get } = await import("svelte/store");
	const { deferred, tick } = await import("./helpers.js");
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
	const { generatePrivateKey } = await import(
		"../src/lib/protocol/identity.js"
	);
	const { get } = await import("svelte/store");
	const identity = await generatePrivateKey();
	let failed = false;
	const session = createSession({
		local: {
			get: async () => {
				if (failed) throw new Error("Storage unavailable");
				return { publicKey: identity.publicKey, wrappedKey: {} };
			},
		},
		session: { get: async () => ({ privateKey: identity.privateKey }) },
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
