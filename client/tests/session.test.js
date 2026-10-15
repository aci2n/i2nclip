import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import { exportRecovery } from "../src/lib/protocol/recovery.js";
import { createSession } from "../src/lib/stores/session.js";
import { deferred } from "./helpers.js";

function storage() {
	const values = new Map();
	return {
		values,
		getItem: (key) => values.get(key) ?? null,
		setItem: (key, value) => values.set(key, value),
		removeItem: (key) => values.delete(key),
	};
}
const password = "master-password";
const serverUrl = "https://clip.example";
async function fixture(t, http = {}) {
	const local = storage();
	const persistence = createPersistence(local);
	const session = createSession({
		persistence,
		http,
		defaultServerUrl: serverUrl,
	});
	t.after(session.dispose);
	assert.equal(await session.initialize(password), true);
	return { local, persistence, session };
}

test("one encrypted identity survives reload, password changes, and forgetting without plaintext secrets", async (t) => {
	const f = await fixture(t, { registerKey: async () => {} });
	assert.equal(await f.session.create({ otc: "invite" }), true);
	const privateKey = get(f.session).privateKey;
	const saved = [...f.local.values.values()][0];
	assert.equal(f.local.values.size, 1);
	for (const secret of [
		privateKey,
		JSON.parse(privateKey).seed,
		serverUrl,
		password,
	]) {
		assert(!saved.includes(secret));
	}
	f.session.dispose();
	assert.equal(get(f.session).privateKey, "");
	assert.equal(get(f.session).unlocked, false);
	const restored = createSession({ persistence: createPersistence(f.local) });
	t.after(restored.dispose);
	assert.equal(get(restored).status, "locked");
	assert.equal(await restored.unlock("wrong-password"), false);
	assert.equal(await restored.unlock(password), true);
	assert.equal(get(restored).privateKey, privateKey);
	assert.equal(await restored.changePassword(password, "new-password"), true);
	restored.lock();
	assert.equal(get(restored).privateKey, "");
	assert.equal(await restored.unlock(password), false);
	assert.equal(await restored.unlock("new-password"), true);
	assert.equal(await restored.forget(), true);
	assert.equal(get(restored).configured, false);
	restored.lock();
	assert.equal(await restored.unlock("new-password"), true);
	assert.equal(get(restored).configured, false);
});

test("storage failure retains the previous record and identity", async (t) => {
	const f = await fixture(t, { registerKey: async () => {} });
	assert.equal(await f.session.create({ otc: "invite" }), true);
	const before = [...f.local.values.values()][0];
	f.local.setItem = () => {
		throw new Error("Storage quota exceeded.");
	};
	assert.equal(await f.session.forget(), false);
	assert.equal(get(f.session).configured, true);
	assert.equal([...f.local.values.values()][0], before);
	assert.match(get(f.session).error, /quota/);
	assert.equal(get(f.session).busy, false);
});

test("locking cancels registration and rejects overlapping session mutations", async (t) => {
	const entered = deferred();
	const result = deferred();
	const f = await fixture(t, {
		registerKey: async ({ signal }) => {
			entered.resolve(signal);
			await result.promise;
		},
	});
	const registering = f.session.create({
		otc: "invite",
	});
	const signal = await entered.promise;
	assert.equal(await f.session.create({ otc: "invite" }), false);
	f.session.lock();
	result.resolve();
	assert.equal(await registering, false);
	assert.equal(signal.aborted, true);
	assert.equal(await f.session.unlock(password), true);
	assert.equal(get(f.session).configured, false);
});

test("recovery verifies server registration and cannot replace a configured singleton", async (t) => {
	const identity = {
		serverUrl,
		privateKey: (await generatePrivateKey()).privateKey,
	};
	const text = await exportRecovery(identity, "recovery-password");
	let registered = false;
	const f = await fixture(t, { isKeyRegistered: async () => registered });
	const file = new Blob([text]);
	assert.equal(await f.session.restore(file, "recovery-password"), false);
	assert.equal(get(f.session).configured, false);
	registered = true;
	assert.equal(await f.session.restore(file, "recovery-password"), true);
	assert.equal(get(f.session).privateKey, identity.privateKey);
	assert.equal(await f.session.restore(file, "recovery-password"), false);
	assert.equal(get(f.session).privateKey, identity.privateKey);
});

test("locking during encryption cannot commit or restore an unwrapped key", async () => {
	const local = storage();
	const persistence = createPersistence(local);
	const initializing = persistence.initialize(password);
	persistence.lock();
	await assert.rejects(initializing, { name: "AbortError" });
	assert.equal(local.values.size, 0);
	await persistence.initialize(password);
	const saving = persistence.save({ serverUrl: "https://late.example" });
	persistence.lock();
	await assert.rejects(saving, { name: "AbortError" });
	assert.equal(await persistence.unlock(password), null);
});

test("unavailable browser storage is reported without crashing initialization", (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		get() {
			throw new Error("Storage access denied.");
		},
	});
	t.after(() => {
		if (previous) {
			Object.defineProperty(globalThis, "localStorage", previous);
		} else {
			delete globalThis.localStorage;
		}
	});
	const session = createSession();
	t.after(session.dispose);
	assert.equal(get(session).status, "locked");
	assert.match(get(session).error, /access denied/);
});
