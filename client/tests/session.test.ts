import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import * as api from "../src/lib/api.ts";
import {
	createPersistence,
	IDENTITY_STORAGE_KEY,
} from "../src/lib/persistence.ts";
import { bytesToB64 } from "../src/lib/protocol/bytes.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { exportRecovery } from "../src/lib/protocol/recovery.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { assertPresent } from "./assert.ts";
import { deferred } from "./helpers.ts";

export function storage() {
	const values = new Map<string, string>();
	return {
		values,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}
const password = "master-password";
const serverUrl = "https://clip.example";
function storageEvent(
	local: ReturnType<typeof storage>,
	key: string | null = IDENTITY_STORAGE_KEY,
) {
	return Object.assign(new Event("storage"), { storageArea: local, key });
}
async function fixture(
	t: test.TestContext,
	http: Partial<api.IdentityApi> = {},
) {
	const local = storage();
	const events = new EventTarget();
	const persistence = createPersistence(local);
	const session = createSession({
		persistence,
		events,
		http: { ...api, registerKey: async () => {}, ...http },
	});
	t.after(session.dispose);
	assert.equal(await session.initialize(password), true);
	return { local, events, persistence, session };
}
test("encrypted identity survives fresh sessions, password change and forgetting without plaintext persistence", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), true);
	const privateKey = f.session.identity().privateKey;
	const saved = assertPresent(f.local.getItem(IDENTITY_STORAGE_KEY));
	for (const secret of [
		bytesToB64(encode(privateKey)),
		bytesToB64(privateKey.seed),
		serverUrl,
		password,
	]) {
		assert(!saved.includes(secret));
	}
	f.session.dispose();
	const restored = createSession({ persistence: createPersistence(f.local) });
	t.after(restored.dispose);
	assert.equal(get(restored).status, "locked");
	assert.equal(await restored.unlock("wrong-password"), false);
	assert.equal(await restored.unlock(password), true);
	assert.deepEqual(restored.identity().privateKey, privateKey);
	const old = assertPresent(get(restored).context);
	assert.equal(await restored.changePassword(password, "new-password"), true);
	assert.equal(old.signal.aborted, true);
	assert.notEqual(get(restored).context, old);
	restored.dispose();
	const last = createSession({ persistence: createPersistence(f.local) });
	t.after(last.dispose);
	assert.equal(await last.unlock(password), false);
	assert.equal(await last.unlock("new-password"), true);
	assert.equal(await last.forget(), true);
	assert.equal(get(last).unlocked, true);
	assert.equal(get(last).context, null);
	assert.throws(() => last.identity(), /Unlock/);
});
test("failed writes preserve the current context and encrypted record", async (t) => {
	const f = await fixture(t);
	await f.session.create({ serverUrl, otc: "invite" });
	const context = get(f.session).context;
	const before = f.persistence.text();
	f.local.setItem = () => {
		throw new Error("Storage quota exceeded.");
	};
	assert.equal(await f.session.forget(), false);
	assert.equal(get(f.session).context, context);
	assert.equal(assertPresent(context).signal.aborted, false);
	assert.equal(f.persistence.text(), before);
	assert.match(get(f.session).error, /quota/);
	assert.equal(get(f.session).busy, false);
});
test("external record replacement cancels registration and overlapping commands are rejected", async (t) => {
	const entered = deferred<AbortSignal | undefined>();
	const done = deferred();
	t.after(() => done.resolve());
	const f = await fixture(t, {
		registerKey: async ({ signal }) => {
			entered.resolve(signal);
			await done.promise;
		},
	});
	const registering = f.session.create({ serverUrl, otc: "invite" });
	const signal = assertPresent(await entered.promise);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	f.local.removeItem(IDENTITY_STORAGE_KEY);
	f.events.dispatchEvent(storageEvent(f.local));
	assert.equal(signal.aborted, true);
	done.resolve();
	assert.equal(await registering, false);
	assert.equal(get(f.session).status, "new");
	assert.equal(f.persistence.text(), null);
});
test("recovery checks registration and cannot replace a configured library", async (t) => {
	const identity = {
		server_url: serverUrl,
		private_key: (await generatePrivateKey()).privateKey,
	};
	const file = new Blob([await exportRecovery(identity, "recovery-password")]);
	let registered = false;
	const f = await fixture(t, { isKeyRegistered: async () => registered });
	assert.equal(await f.session.restore(file, "recovery-password"), false);
	registered = true;
	assert.equal(await f.session.restore(file, "recovery-password"), true);
	assert.deepEqual(f.session.identity().privateKey, identity.private_key);
	assert.equal(await f.session.restore(file, "recovery-password"), false);
});
test("external password changes abort old access; irrelevant and delayed events do not", async (t) => {
	const f = await fixture(t);
	await f.session.create({ serverUrl, otc: "invite" });
	const second = createSession({
		persistence: createPersistence(f.local),
		events: f.events,
	});
	t.after(second.dispose);
	await second.unlock(password);
	const signal = get(second).signal;
	await f.session.changePassword(password, "changed-password");
	f.events.dispatchEvent(storageEvent(f.local, "unrelated"));
	f.events.dispatchEvent(storageEvent(storage()));
	assert.equal(signal.aborted, false);
	f.events.dispatchEvent(storageEvent(f.local));
	assert.equal(signal.aborted, true);
	assert.equal(get(second).status, "locked");
	assert.equal(await second.unlock(password), false);
	assert.equal(await second.unlock("changed-password"), true);
	const context = get(second).context;
	f.events.dispatchEvent(storageEvent(f.local));
	assert.equal(get(second).context, context);
	f.local.values.clear();
	f.events.dispatchEvent(storageEvent(f.local, null));
	assert.equal(get(second).status, "new");
	second.dispose();
	const state = get(second);
	f.local.setItem(IDENTITY_STORAGE_KEY, "damaged");
	f.events.dispatchEvent(storageEvent(f.local));
	assert.equal(get(second), state);
});
test("conditional persistence refuses a stale write even before storage notification", async (t) => {
	const f = await fixture(t);
	const entered = deferred();
	const encrypted = deferred<ArrayBuffer>();
	t.after(() => encrypted.resolve(new ArrayBuffer(32)));
	t.mock.method(crypto.subtle, "encrypt", () => {
		entered.resolve();
		return encrypted.promise;
	});
	const forgetting = f.session.forget();
	await entered.promise;
	f.local.setItem(IDENTITY_STORAGE_KEY, "another record");
	encrypted.resolve(new ArrayBuffer(32));
	assert.equal(await forgetting, false);
	assert.equal(f.persistence.text(), "another record");
	assert.match(get(f.session).error, /changed in another tab/);
});
test("disposal during non-abortable encryption cannot write or restore access", async (t) => {
	const f = await fixture(t);
	const before = f.persistence.text();
	const entered = deferred();
	const encrypted = deferred<ArrayBuffer>();
	t.after(() => encrypted.resolve(new ArrayBuffer(32)));
	t.mock.method(crypto.subtle, "encrypt", () => {
		entered.resolve();
		return encrypted.promise;
	});
	const forgetting = f.session.forget();
	await entered.promise;
	f.session.dispose();
	encrypted.resolve(new ArrayBuffer(32));
	assert.equal(await forgetting, false);
	assert.equal(f.persistence.text(), before);
	assert.equal(get(f.session).unlocked, false);
});
test("unavailable storage is reported without crashing initialization", (t) => {
	const persistence = createPersistence({
		getItem() {
			throw new Error("Storage access denied.");
		},
		setItem() {},
		removeItem() {},
	});
	const session = createSession({ persistence });
	t.after(session.dispose);
	assert.equal(get(session).status, "locked");
	assert.match(get(session).error, /access denied/);
});
test("paired imports validate keys and respect caller cancellation", async (t) => {
	const f = await fixture(t);
	const { privateKey } = await generatePrivateKey();
	const caller = new AbortController();
	const value = {
		server_url: serverUrl,
		private_key: privateKey,
		public_key: privateKey.public_key,
		signal: caller.signal,
	};
	assert.equal(
		await f.session.importPairing({ ...value, public_key: new Uint8Array(32) }),
		false,
	);
	caller.abort();
	assert.equal(await f.session.importPairing(value), false);
	assert.equal(get(f.session).configured, false);
	assert.equal(
		await f.session.importPairing({
			...value,
			signal: new AbortController().signal,
		}),
		true,
	);
	assert.deepEqual(f.session.identity().privateKey, privateKey);
});
