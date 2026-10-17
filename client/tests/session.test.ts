import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import * as api from "../src/lib/api.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import { bytesToB64 } from "../src/lib/protocol/bytes.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { exportRecovery } from "../src/lib/protocol/recovery.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { assertPresent } from "./assert.ts";
import { deferred } from "./helpers.ts";

function storage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => values.set(key, value),
		removeItem: (key: string) => values.delete(key),
	};
}
const password = "master-password";
const serverUrl = "https://clip.example";
async function fixture(
	t: test.TestContext,
	http: Partial<api.IdentityApi> = {},
) {
	const local = storage();
	const persistence = createPersistence(local);
	const session = createSession({ persistence, http: { ...api, ...http } });
	t.after(session.dispose);
	assert.equal(await session.initialize(password), true);
	assert.equal(session.ready, false);
	return { local, persistence, session };
}
test("one encrypted identity survives reload, password changes, and forgetting without plaintext secrets", async (t) => {
	const f = await fixture(t, { registerKey: async () => {} });
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), true);
	assert.equal(f.session.ready, true);
	const privateKey = get(f.session).privateKey;
	assert.notEqual(privateKey, "");
	if (privateKey === "") {
		throw new Error("Missing identity");
	}
	const saved = [...f.local.values.values()][0];
	assert.equal(f.local.values.size, 1);
	for (const secret of [
		bytesToB64(encode(privateKey)),
		bytesToB64(privateKey.seed),
		serverUrl,
		password,
	]) {
		assert(!saved.includes(secret));
	}
	f.session.dispose();
	assert.equal(f.session.ready, false);
	assert.equal(get(f.session).privateKey, "");
	assert.equal(get(f.session).unlocked, false);
	const restored = createSession({ persistence: createPersistence(f.local) });
	t.after(restored.dispose);
	assert.equal(get(restored).status, "locked");
	assert.equal(await restored.unlock("wrong-password"), false);
	assert.equal(await restored.unlock(password), true);
	assert.deepEqual(get(restored).privateKey, privateKey);
	const changing = restored.changePassword(password, "new-password");
	assert.equal(restored.ready, false);
	assert.equal(await changing, true);
	assert.equal(restored.ready, true);
	restored.lock();
	assert.equal(restored.ready, false);
	assert.equal(get(restored).privateKey, "");
	assert.equal(await restored.unlock(password), false);
	assert.equal(await restored.unlock("new-password"), true);
	assert.equal(await restored.forget(), true);
	assert.equal(restored.ready, false);
	assert.equal(get(restored).configured, false);
	restored.lock();
	assert.equal(await restored.unlock("new-password"), true);
	assert.equal(get(restored).configured, false);
});
test("storage failure retains the previous record and identity", async (t) => {
	const f = await fixture(t, { registerKey: async () => {} });
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), true);
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
	const entered = deferred<AbortSignal | undefined>();
	const result = deferred();
	const f = await fixture(t, {
		registerKey: async ({ signal }) => {
			entered.resolve(signal);
			await result.promise;
		},
	});
	const registering = f.session.create({
		serverUrl,
		otc: "invite",
	});
	const signal = await entered.promise;
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	f.session.lock();
	result.resolve();
	assert.equal(await registering, false);
	assert.equal(assertPresent(signal).aborted, true);
	assert.equal(await f.session.unlock(password), true);
	assert.equal(get(f.session).configured, false);
});
test("recovery verifies server registration and cannot replace a configured singleton", async (t) => {
	const identity = {
		server_url: serverUrl,
		private_key: (await generatePrivateKey()).privateKey,
	};
	const text = await exportRecovery(identity, "recovery-password");
	let registered = false;
	const f = await fixture(t, { isKeyRegistered: async () => registered });
	const file = new Blob([text]);
	assert.equal(await f.session.restore(file, "recovery-password"), false);
	assert.equal(get(f.session).configured, false);
	registered = true;
	assert.equal(await f.session.restore(file, "recovery-password"), true);
	assert.deepEqual(get(f.session).privateKey, identity.private_key);
	assert.equal(await f.session.restore(file, "recovery-password"), false);
	assert.deepEqual(get(f.session).privateKey, identity.private_key);
});
test("locking during encryption cannot commit or restore an unwrapped key", async () => {
	const local = storage();
	const persistence = createPersistence(local);
	const initializing = persistence.initialize(password);
	persistence.lock();
	await assert.rejects(initializing, { name: "AbortError" });
	assert.equal(local.values.size, 0);
	await persistence.initialize(password);
	const saving = persistence.save({
		server_url: "https://late.example",
		private_key: (await generatePrivateKey()).privateKey,
	});
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
			Reflect.deleteProperty(globalThis, "localStorage");
		}
	});
	const session = createSession();
	t.after(session.dispose);
	assert.equal(get(session).status, "locked");
	assert.match(get(session).error, /access denied/);
});
test("an unlocked session reuses its crypto context and replaces it after locking", async (t) => {
	const f = await fixture(t, { registerKey: async () => {} });
	await f.session.create({ serverUrl, otc: "invite" });
	const first = f.session.credentials();
	assert.equal(first.key, f.session.credentials().key);
	assert.equal(Object.hasOwn(first, "privateKey"), false);
	assert.equal(first.key.registrationKey, get(f.session).publicKey);
	f.session.lock();
	assert.throws(() => f.session.credentials(), /Unlock/);
	assert.equal(await f.session.unlock(password), true);
	const next = f.session.credentials();
	assert.notEqual(next.key, first.key);
	assert.equal(next.key.registrationKey, first.key.registrationKey);
	assert.equal(await f.session.forget(), true);
	assert.throws(() => f.session.credentials(), /Unlock/);
});

function storageEvent(
	local: ReturnType<typeof storage>,
	key: string | null = "i2nclip.identity",
) {
	return Object.assign(new Event("storage"), { storageArea: local, key });
}

test("external password changes cancel sessions, clear keys and require independent unlock", async (t) => {
	const local = storage();
	const events = new EventTarget();
	const first = createSession({
		persistence: createPersistence(local),
		http: { ...api, registerKey: async () => {} },
	});
	const second = createSession({
		persistence: createPersistence(local, events),
	});
	t.after(first.dispose);
	t.after(second.dispose);
	assert.equal(await first.initialize(password), true);
	assert.equal(await first.create({ serverUrl, otc: "invite" }), true);
	assert.equal(await second.unlock(password), true);
	const operation = second.operation();
	t.after(operation.dispose);
	const signal = second.signal;
	first.lock();
	assert.equal(get(second).unlocked, true);
	assert.equal(await first.unlock(password), true);
	assert.equal(await first.changePassword(password, "changed-password"), true);
	events.dispatchEvent(storageEvent(local, "unrelated"));
	events.dispatchEvent(storageEvent(storage()));
	assert.equal(get(second).unlocked, true);
	events.dispatchEvent(storageEvent(local));
	assert.equal(get(second).status, "locked");
	assert.equal(get(second).privateKey, "");
	assert.equal(operation.signal.aborted, true);
	assert.equal(signal.aborted, true);
	assert.throws(() => second.credentials(), /Unlock/);
	assert.equal(await second.unlock(password), false);
	assert.equal(await second.unlock("changed-password"), true);
	assert.equal(await first.forget(), true);
	events.dispatchEvent(storageEvent(local));
	assert.equal(get(second).status, "locked");
	assert.equal(await second.unlock("changed-password"), true);
	assert.equal(get(second).configured, false);
	assert.equal(first.reset(), true);
	events.dispatchEvent(storageEvent(local, null));
	assert.equal(get(second).status, "new");
	assert.equal(get(second).unlocked, false);
	second.dispose();
	const afterDisposal = get(second);
	local.setItem("i2nclip.identity", "damaged");
	events.dispatchEvent(storageEvent(local));
	assert.equal(get(second), afterDisposal);
});

test("a concurrent record change prevents stale encrypted writes even before notification", async (t) => {
	const local = storage();
	const persistence = createPersistence(local);
	await persistence.initialize(password);
	t.after(persistence.lock);
	const entered = deferred();
	const encrypted = deferred<ArrayBuffer>();
	t.after(() => encrypted.resolve(new ArrayBuffer(32)));
	t.mock.method(crypto.subtle, "encrypt", () => {
		entered.resolve();
		return encrypted.promise;
	});
	const saving = persistence.save(null);
	await entered.promise;
	local.setItem("i2nclip.identity", "another tab's record");
	const rejected = assert.rejects(saving, /changed in another tab/);
	encrypted.resolve(new ArrayBuffer(32));
	await rejected;
	assert.equal(local.getItem("i2nclip.identity"), "another tab's record");
});
