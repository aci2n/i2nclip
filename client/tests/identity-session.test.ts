import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import { createPersistence } from "../src/lib/persistence.ts";
import {
	createDevice,
	exportDeviceBackup,
} from "../src/lib/protocol/device.ts";
import { createSession, type IdentityApi } from "../src/lib/stores/identity.ts";
import { memoryStorage } from "./memory-database.ts";

const password = "master password";
const serverUrl = "https://example.test";

async function fixture(
	t: test.TestContext,
	http: IdentityApi,
	remember = false,
) {
	const storage = memoryStorage();
	const persistence = createPersistence(storage.connect());
	const session = createSession({ persistence, http });
	t.after(session.dispose);
	await session.load();
	await session.initialize(password, remember);
	function reopen(nextHttp = http) {
		const next = createSession({
			persistence: createPersistence(storage.connect()),
			http: nextHttp,
		});
		t.after(next.dispose);
		return next;
	}
	return { storage, persistence, session, reopen };
}

test("registration persists independent credentials before networking and reuses them after restart", async (t) => {
	let registeredKey = "";
	let registrations = 0;
	const http: IdentityApi = {
		async registered(device) {
			return registeredKey === device.key.registrationKey;
		},
		async register(device) {
			registeredKey = device.key.registrationKey;
			registrations++;
			throw new Error("Lost response");
		},
	};
	const f = await fixture(t, http);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	assert.equal(get(f.session).prepared, true);
	assert.equal(get(f.session).context, null);
	assert.match(get(f.session).error, /credentials are saved/);
	f.session.dispose();
	const resumed = f.reopen();
	await resumed.load();
	await resumed.unlock(password);
	assert.equal(get(resumed).prepared, true);
	assert.equal(get(resumed).serverUrl, serverUrl);
	assert.equal(await resumed.create({ serverUrl, otc: "used code" }), true);
	assert.equal(registrations, 1);
	assert.equal(resumed.identity().publicKey, registeredKey);
	assert.equal("fileKeyMaterial" in resumed.identity().key, false);
	assert.equal(get(resumed).prepared, false);
});

test("failed candidate persistence sends no registration request", async (t) => {
	let requests = 0;
	const f = await fixture(t, {
		async registered() {
			requests++;
			return false;
		},
		async register() {
			requests++;
		},
	});
	t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	assert.equal(requests, 0);
	assert.equal(get(f.session).context, null);
	assert.match(get(f.session).error, /Disk full/);
});

test("accepted registration with a failed activation write preserves the prepared identity", async (t) => {
	let accepted = false;
	const http: IdentityApi = {
		async registered() {
			return accepted;
		},
		async register() {
			accepted = true;
		},
	};
	const f = await fixture(t, http, true);
	const save = f.persistence.save;
	let writes = 0;
	t.mock.method(
		f.persistence,
		"save",
		async (...args: Parameters<typeof save>) => {
			writes++;
			if (writes === 2) {
				throw new Error("Disk full");
			}
			return save(...args);
		},
	);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	assert.equal(accepted, true);
	const resumed = f.reopen();
	await resumed.load();
	assert.equal(get(resumed).unlocked, true);
	assert.equal(get(resumed).prepared, true);
	assert.equal(await resumed.create({ serverUrl, otc: "used" }), true);
	assert.equal(resumed.identity().device.epochs.length, 1);
});

test("backup import preserves a logical device, historical epochs, and a pinned head", async (t) => {
	const device = await createDevice(serverUrl);
	const identity = {
		...device.identity,
		phase: "active" as const,
		head: { sequence: 3, hash: "ab".repeat(32) },
		epochs: [
			...device.identity.epochs,
			[2, crypto.getRandomValues(new Uint8Array(32))] as const,
		],
	};
	const backup = await exportDeviceBackup(identity, password);
	const f = await fixture(t, {
		async registered(value) {
			assert.equal(value.key.registrationKey, device.key.registrationKey);
			return true;
		},
		async register() {
			throw new Error("must not enroll a new key");
		},
	});
	assert.equal(await f.session.restore(new Blob([backup]), password), true);
	assert.deepEqual(f.session.identity().device, identity);
	const restarted = f.reopen();
	await restarted.load();
	await restarted.unlock(password);
	assert.deepEqual(restarted.identity().device.head, identity.head);
	assert.deepEqual(restarted.identity().device.epochs, identity.epochs);
});

test("revoked backups do not install and independent tabs keep their loaded sessions", async (t) => {
	const device = await createDevice(serverUrl);
	const backup = await exportDeviceBackup(
		{ ...device.identity, phase: "active" },
		password,
	);
	const f = await fixture(t, {
		async registered() {
			return false;
		},
		async register() {},
	});
	assert.equal(await f.session.restore(new Blob([backup]), password), false);
	assert.match(get(f.session).error, /not authorized/);
	assert.equal(get(f.session).context, null);
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), true);
	const other = f.reopen();
	await other.load();
	await other.unlock(password);
	const lifetime = get(other).signal;
	assert.equal(
		await f.session.changePassword(password, "different password"),
		true,
	);
	assert.equal(lifetime.aborted, false);
	assert.equal(await other.forget(), false);
	assert.match(get(other).error, /Refresh/);
});
