import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createSession } from "../src/lib/stores/session.js";

const creation = {
	serverUrl: "https://clip.example",
	password: "password123",
	otc: "invitation",
};
function platform() {
	let local = {},
		session = {};
	return {
		local: {
			get: async () => ({ ...local }),
			set: async (value) => {
				local = { ...local, ...value };
			},
			remove: async (key) => {
				delete local[key];
			},
		},
		session: {
			get: async () => ({ ...session }),
			set: async (value) => {
				session = { ...session, ...value };
			},
		},
		subscribe: () => () => {},
	};
}
function open(t, storage) {
	const session = createSession(storage);
	t.after(session.dispose);
	return session;
}

test("lost registration response survives reopening and retries the same identity without another invitation", async (t) => {
	const storage = platform();
	let registrations = 0,
		registeredKey;
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "POST") {
			registrations++;
			registeredKey = JSON.parse(options.body).public_key;
			const { pendingRegistration } = await storage.local.get();
			assert.equal(pendingRegistration.publicKey, registeredKey);
			assert.equal(pendingRegistration.privateKey, undefined);
			assert.equal(pendingRegistration.password, undefined);
			assert.equal(pendingRegistration.otc, undefined);
			throw new Error("response lost");
		}
		assert.ok(options.headers.authorization);
		return new Response('{"media":[]}', { status: 200 });
	});
	const first = open(t, storage);
	assert.equal(await first.create(creation), false);
	assert.equal(get(first).wrappedKey, null);
	const pending = (await storage.local.get()).pendingRegistration;
	first.dispose();
	const second = open(t, storage);
	await second.ready;
	assert.equal(get(second).serverUrl, creation.serverUrl);
	assert.equal(await second.create(creation), true);
	const saved = await storage.local.get();
	assert.equal(saved.publicKey, registeredKey);
	assert.deepEqual(saved.wrappedKey, pending.wrappedKey);
	assert.equal(saved.pendingRegistration, null);
	assert.ok(get(second).privateKey);
	assert.equal(registrations, 1);
});

test("pending identity must be saved before any registration is sent", async (t) => {
	const storage = platform();
	storage.local.set = async () => {
		throw new Error("disk full");
	};
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
	});
	assert.equal(await open(t, storage).create(creation), false);
	assert.equal(calls, 0);
});

test("final identity persistence failure retains the encrypted identity for retry", async (t) => {
	const storage = platform();
	const save = storage.local.set;
	let fail = true,
		posts = 0;
	storage.local.set = async (value) => {
		if (value.wrappedKey && fail) throw new Error("disk full");
		return save(value);
	};
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "POST") {
			posts++;
			return new Response(null, { status: 204 });
		}
		return new Response('{"media":[]}', { status: 200 });
	});
	const session = open(t, storage);
	assert.equal(await session.create(creation), false);
	const pending = (await storage.local.get()).pendingRegistration;
	assert.ok(pending);
	fail = false;
	assert.equal(await session.create(creation), true);
	assert.equal((await storage.local.get()).publicKey, pending.publicKey);
	assert.equal(posts, 1);
});

test("session persistence failure leaves a recoverable locked identity", async (t) => {
	const storage = platform();
	const save = storage.session.set;
	storage.session.set = async () => {
		throw new Error("session full");
	};
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status: 204 }),
	);
	const session = open(t, storage);
	assert.equal(await session.create(creation), false);
	assert.ok(get(session).wrappedKey);
	assert.equal(get(session).privateKey, "");
	assert.equal(get(session).pendingRegistration, null);
	storage.session.set = save;
	assert.equal(await session.unlock(creation.password), true);
	assert.ok(get(session).privateKey);
});

test("retry rejects wrong password and server, preserves pending identity, and can explicitly discard it", async (t) => {
	const storage = platform();
	let calls = 0;
	t.mock.method(globalThis, "fetch", async () => {
		calls++;
		throw new Error("offline");
	});
	const session = open(t, storage);
	assert.equal(await session.create(creation), false);
	const before = await storage.local.get();
	assert.equal(
		await session.create({ ...creation, password: "wrongpass" }),
		false,
	);
	assert.equal(
		await session.create({ ...creation, serverUrl: "https://other.example" }),
		false,
	);
	assert.equal(await session.setServer("https://other.example"), false);
	assert.equal(calls, 1);
	assert.deepEqual(await storage.local.get(), before);
	assert.equal(await session.discardCreation(), true);
	assert.equal(get(session).pendingRegistration, null);
});

test("an unregistered pending identity retries registration with the same public key", async (t) => {
	const storage = platform();
	const keys = [];
	t.mock.method(globalThis, "fetch", async (_url, options) => {
		if (options.method === "GET") return new Response(null, { status: 401 });
		keys.push(JSON.parse(options.body).public_key);
		if (keys.length === 1) throw new Error("offline");
		return new Response(null, { status: 204 });
	});
	const session = open(t, storage);
	assert.equal(await session.create(creation), false);
	assert.equal(await session.create(creation), true);
	assert.equal(keys.length, 2);
	assert.equal(keys[0], keys[1]);
});
