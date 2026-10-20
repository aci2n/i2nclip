import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import * as api from "../src/lib/api.ts";
import {
	createPersistence,
	type SavedIdentity,
} from "../src/lib/persistence.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { exportRecovery } from "../src/lib/protocol/recovery.ts";
import { createSession } from "../src/lib/stores/session.ts";
import { assertPresent } from "./assert.ts";
import { deferred } from "./helpers.ts";
import { memoryStorage } from "./memory-database.ts";

const password = "master-password";
const serverUrl = "https://clip.example";
async function fixture(
	t: test.TestContext,
	http: Partial<api.IdentityApi> = {},
	remember = false,
) {
	const storage = memoryStorage();
	const database = storage.connect();
	const persistence = createPersistence(database);
	const session = createSession({
		persistence,
		http: { ...api, registerKey: async () => {}, ...http },
	});
	t.after(session.dispose);
	await session.loaded;
	assert.equal(await session.initialize(password, remember), true);
	async function reopen() {
		const next = createSession({
			persistence: createPersistence(storage.connect()),
		});
		t.after(next.dispose);
		await next.loaded;
		return next;
	}
	return { storage, database, persistence, session, reopen };
}

test("unremembered identity survives sessions encrypted; each tab unlocks independently", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), true);
	const identity = f.session.identity();
	const saved = assertPresent(
		await f.persistence.read(new AbortController().signal),
	);
	assert.equal(saved.key, undefined);
	assert(!JSON.stringify(saved).includes(password));
	assert(!JSON.stringify(saved).includes(serverUrl));
	assert(
		!JSON.stringify(saved).includes(JSON.stringify(identity.privateKey.seed)),
	);
	const second = await f.reopen();
	assert.equal(get(second).status, "locked");
	assert.equal(await second.unlock("wrong-password"), false);
	assert.equal(await second.unlock(password), true);
	assert.deepEqual(second.identity().privateKey, identity.privateKey);
	const signal = get(second).signal;
	assert.equal(
		await f.session.changePassword(password, "changed-password"),
		true,
	);
	assert.equal(signal.aborted, false, "another tab retains its loaded session");
	assert.equal(get(second).unlocked, true);
	assert.equal(await second.forget(), false);
	assert.match(get(second).error, /Refresh/);
	assert.equal(get(second).signal, signal);
	const third = await f.reopen();
	assert.equal(await third.unlock(password), false);
	assert.equal(await third.unlock("changed-password"), true);
});

test("remembered non-extractable key restores configured identity and rotates with password", async (t) => {
	const f = await fixture(t, {}, true);
	await f.session.create({ serverUrl, otc: "invite" });
	const identity = f.session.identity();
	const saved = assertPresent(
		await f.persistence.read(new AbortController().signal),
	);
	assert.equal(assertPresent(saved.key).extractable, false);
	await assert.rejects(
		crypto.subtle.exportKey("raw", assertPresent(saved.key)),
	);
	const second = await f.reopen();
	assert.equal(get(second).unlocked, true);
	assert.deepEqual(second.identity().privateKey, identity.privateKey);
	const old = get(second).signal;
	assert.equal(await second.changePassword(password, "changed-password"), true);
	assert.equal(old.aborted, true);
	second.dispose();
	f.session.dispose();
	const third = await f.reopen();
	assert.equal(get(third).unlocked, true);
	assert.deepEqual(third.identity().privateKey, identity.privateKey);
});

test("password unlock can enable remembering, and unchecked unlock removes it", async (t) => {
	const f = await fixture(t);
	const second = await f.reopen();
	assert.equal(await second.unlock(password, true), true);
	assert.equal(get(await f.reopen()).unlocked, true);
	// Explicit password unlock is also valid while a remembered session is loaded.
	assert.equal(await second.unlock(password), true);
	assert.equal(get(await f.reopen()).status, "locked");
});

test("Lock clears remembered access and local work but leaves other loaded tabs independent", async (t) => {
	const f = await fixture(t, {}, true);
	await f.session.create({ serverUrl, otc: "invite" });
	const second = await f.reopen();
	const otherSignal = get(second).signal;
	const ownSignal = get(f.session).signal;
	assert.equal(await f.session.lock(), true);
	assert.equal(ownSignal.aborted, true);
	assert.equal(get(f.session).status, "locked");
	assert.equal(otherSignal.aborted, false);
	assert.equal(get(second).unlocked, true);
	assert.equal(get(await f.reopen()).status, "locked");
	assert.equal(
		await second.changePassword(password, "changed-password"),
		false,
	);
	assert.match(get(second).error, /Refresh/);
	assert.equal(await f.session.unlock(password), true);
});

test("Forget removes remembered identity; Reset removes session without deleting preferences", async (t) => {
	const f = await fixture(t, {}, true);
	f.storage.values.set("compressImages", false);
	await f.session.create({ serverUrl, otc: "invite" });
	assert.equal(await f.session.forget(), true);
	assert.equal(get(f.session).unlocked, true);
	assert.equal(get(f.session).context, null);
	assert.equal(get(await f.reopen()).status, "locked");
	assert.equal(await f.session.reset(), true);
	assert.equal(get(await f.reopen()).status, "new");
	assert.equal(f.storage.values.get("compressImages"), false);
});

test("failed identity writes preserve durable state and current context", async (t) => {
	const f = await fixture(t, {}, true);
	await f.session.create({ serverUrl, otc: "invite" });
	const before = f.storage.values.get("session");
	const context = assertPresent(get(f.session).context);
	t.mock.method(f.database, "update", async () => {
		throw new Error("Storage quota exceeded.");
	});
	assert.equal(await f.session.forget(), false);
	assert.equal(f.storage.values.get("session"), before);
	assert.equal(get(f.session).context, context);
	assert.equal(context.signal.aborted, false);
	assert.match(get(f.session).error, /quota/);
});

test("remember failure still unlocks locally and reports that access was not remembered", async (t) => {
	const f = await fixture(t);
	const session = await f.reopen();
	const persistence = createPersistence(f.storage.connect());
	const failing = createSession({ persistence });
	t.after(failing.dispose);
	await failing.loaded;
	t.mock.method(persistence, "remember", async () => {
		throw new Error("Storage unavailable.");
	});
	assert.equal(await failing.unlock(password, true), true);
	assert.equal(get(failing).unlocked, true);
	assert.match(get(failing).notice, /could not be remembered/);
	assert.equal(get(session).unlocked, false);
	assert.equal(get(await f.reopen()).status, "locked");
});

test("Lock failure ends local access, reports durable failure, and can be retried", async (t) => {
	const f = await fixture(t, {}, true);
	const fail = t.mock.method(f.database, "update", async () => {
		throw new Error("Storage unavailable.");
	});
	assert.equal(await f.session.lock(), false);
	assert.equal(get(f.session).unlocked, false);
	assert.match(get(f.session).error, /Retry Lock/);
	assert.equal(get(await f.reopen()).unlocked, true);
	fail.mock.restore();
	assert.equal(await f.session.lock(), true);
	assert.equal(get(await f.reopen()).status, "locked");
});

test("invalid remembered key falls back to password unlock", async (t) => {
	const f = await fixture(t, {}, true);
	const saved = f.storage.values.get("session") as SavedIdentity;
	f.storage.values.set("session", { ...saved, key: "broken" });
	const second = await f.reopen();
	assert.equal(get(second).status, "locked");
	assert.match(get(second).error, /Remembered access/);
	assert.equal(await second.unlock(password), true);
	assert.equal(get(await f.reopen()).status, "locked");
});

test("startup storage failure offers retry and cannot be mistaken for empty setup", async (t) => {
	const db = memoryStorage().connect();
	const fail = t.mock.method(db, "read", async () => {
		throw new Error("Storage access denied.");
	});
	const session = createSession({ persistence: createPersistence(db) });
	t.after(session.dispose);
	await session.loaded;
	assert.equal(get(session).storageError, true);
	assert.match(get(session).error, /access denied/);
	assert.equal(await session.initialize(password), false);
	fail.mock.restore();
	assert.equal(await session.retry(), true);
	assert.equal(get(session).status, "new");
	assert.equal(await session.initialize(password), true);
});

test("damaged session reports an error and explicit Reset permits new setup", async (t) => {
	const storage = memoryStorage();
	storage.values.set("session", "damaged");
	const session = createSession({
		persistence: createPersistence(storage.connect()),
	});
	t.after(session.dispose);
	await session.loaded;
	assert.equal(get(session).storageError, true);
	assert.equal(await session.reset(), true);
	assert.equal(await session.initialize(password), true);
});

for (const action of ["lock", "dispose"] as const) {
	test(`${action} during password derivation cannot restore access`, async (t) => {
		const f = await fixture(t);
		const persistence = createPersistence(f.storage.connect());
		const second = createSession({ persistence });
		t.after(second.dispose);
		await second.loaded;
		const entered = deferred();
		const release = deferred();
		t.after(() => release.resolve());
		const derive = persistence.passwordKey;
		t.mock.method(
			persistence,
			"passwordKey",
			async (...args: Parameters<typeof derive>) => {
				entered.resolve();
				await release.promise;
				return derive(...args);
			},
		);
		const unlocking = second.unlock(password, true);
		await entered.promise;
		await second[action]();
		release.resolve();
		assert.equal(await unlocking, false);
		assert.equal(get(second).unlocked, false);
		assert.equal(get(await f.reopen()).status, "locked");
	});
	test(`${action} during identity encryption prevents durable writes and late publication`, async (t) => {
		const f = await fixture(t);
		const before = f.storage.values.get("session");
		const entered = deferred();
		const encrypted = deferred<ArrayBuffer>();
		t.after(() => encrypted.resolve(new ArrayBuffer(32)));
		t.mock.method(crypto.subtle, "encrypt", () => {
			entered.resolve();
			return encrypted.promise;
		});
		const forgetting = f.session.forget();
		await entered.promise;
		await f.session[action]();
		const after = f.storage.values.get("session");
		encrypted.resolve(new ArrayBuffer(32));
		assert.equal(await forgetting, false);
		assert.equal(f.storage.values.get("session"), after);
		if (action === "dispose") {
			assert.equal(after, before);
		}
		assert.equal(get(f.session).unlocked, false);
	});
}

test("late startup read cannot restore remembered access after Lock", async (t) => {
	const f = await fixture(t, {}, true);
	const db = f.storage.connect();
	const read = db.read;
	const entered = deferred();
	const release = deferred();
	t.after(() => release.resolve());
	t.mock.method(db, "read", async (...args: Parameters<typeof read>) => {
		const saved = await read(...args);
		entered.resolve();
		await release.promise;
		return saved;
	});
	const second = createSession({ persistence: createPersistence(db) });
	t.after(second.dispose);
	await entered.promise;
	await second.lock();
	release.resolve();
	await second.loaded;
	assert.equal(get(second).status, "locked");
	assert.equal(get(await f.reopen()).status, "locked");
});

test("external replacement does not cancel registration but its stale save is rejected", async (t) => {
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
	const second = await f.reopen();
	await second.unlock(password);
	await second.changePassword(password, "changed-password");
	assert.equal(signal.aborted, false);
	done.resolve();
	assert.equal(await registering, false);
	assert.match(get(f.session).error, /Refresh/);
	assert.equal(get(f.session).configured, false);
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
test("Create recovers a lost reply or storage failure without spending another invitation", async (t) => {
	for (const failure of ["reply", "storage"]) {
		await t.test(failure, async (t) => {
			let enrolled = "";
			let registrations = 0;
			const f = await fixture(t, {
				registerKey: async ({ key }) => {
					enrolled = key.registrationKey;
					registrations++;
					if (failure === "reply") {
						throw new Error("Lost reply");
					}
				},
				isKeyRegistered: async ({ key }) => key.registrationKey === enrolled,
			});
			const write = f.database.update;
			if (failure === "storage") {
				f.database.update = () => {
					throw new Error("Storage unavailable");
				};
			}
			assert.equal(await f.session.create({ serverUrl, otc: "spent" }), false);
			assert.equal(get(f.session).configured, false);
			assert.match(get(f.session).error, /Retry Create in this tab/);
			f.database.update = write;
			assert.equal(
				await f.session.create({ serverUrl: `${serverUrl}/`, otc: "spent" }),
				true,
			);
			assert.equal(f.session.identity().publicKey, enrolled);
			assert.equal(registrations, 1);
		});
	}
});

test("Create preserves its candidate across failed checks, rejected invitations and failed Restore", async (t) => {
	const keys: string[] = [];
	let checkFails = true;
	let checks = 0;
	const f = await fixture(t, {
		registerKey: async ({ key, otc }) => {
			keys.push(key.registrationKey);
			if (otc !== "valid") {
				throw new Error("Invalid invitation");
			}
		},
		isKeyRegistered: async () => {
			checks++;
			if (checkFails) {
				throw new Error("Offline");
			}
			return false;
		},
	});
	assert.equal(await f.session.create({ serverUrl, otc: "invalid" }), false);
	assert.equal(await f.session.restore(new Blob(["bad"]), password), false);
	assert.equal(await f.session.create({ serverUrl, otc: "valid" }), false);
	assert.equal(keys.length, 1, "a failed check must not submit registration");
	checkFails = false;
	assert.equal(await f.session.create({ serverUrl, otc: "valid" }), true);
	assert.equal(checks, 2);
	assert.equal(keys[0], keys[1]);
	assert.equal(f.session.identity().publicKey, keys[0]);
});
