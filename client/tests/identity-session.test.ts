import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { verifyDevice } from "../src/lib/device-verification.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import {
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import {
	createDevice,
	exportDeviceBackup,
} from "../src/lib/protocol/device.ts";
import { stateCheckpoint } from "../src/lib/stores/chain.ts";
import { createSession, type IdentityApi } from "../src/lib/stores/identity.ts";
import { memoryStorage } from "./memory-database.ts";

const password = "master password";
const serverUrl = "https://example.test";

async function fixture(
	t: test.TestContext,
	http: IdentityApi,
	remember = false,
	verify?: typeof verifyDevice,
) {
	const storage = memoryStorage();
	const persistence = createPersistence(storage.connect());
	const session = createSession({ persistence, http, verify });
	t.after(session.dispose);
	await session.load();
	await session.initialize(password, remember);
	function reopen(nextHttp = http) {
		const next = createSession({
			persistence: createPersistence(storage.connect()),
			http: nextHttp,
			verify,
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
	const f = await fixture(
		t,
		{
			async registered(value) {
				assert.equal(value.key.registrationKey, device.key.registrationKey);
				return true;
			},
			async register() {
				throw new Error("must not enroll a new key");
			},
		},
		false,
		async (loaded, minimum) => {
			assert.deepEqual(minimum, identity.head);
			const initial = await initialChainState(loaded.initialPublicKey);
			return {
				...initial,
				sequence: minimum.sequence,
				head: hexToBytes(minimum.hash),
				epoch: 2,
			};
		},
	);
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

test("pairing credentials are durable before readiness and activation requires the handed-off head", async (t) => {
	const owner = await createDevice(serverUrl);
	const receiver = await createDevice(serverUrl);
	const prepared = {
		...owner.identity,
		privateKey: receiver.identity.privateKey,
		phase: "pairing" as const,
	};
	let allowed = false;
	const enrollment = { sequence: 1, hash: "ac".repeat(32) };
	const f = await fixture(
		t,
		{ registered: async () => true, register: async () => {} },
		false,
		async (device, minimum) => {
			assert.equal(device.key.registrationKey, receiver.key.registrationKey);
			assert.deepEqual(minimum, enrollment);
			if (!allowed) {
				throw new Error("Enrollment is not yet visible");
			}
			const initial = await initialChainState(device.initialPublicKey);
			return {
				...initial,
				sequence: 1,
				head: hexToBytes(enrollment.hash),
				devices: new Map([
					...initial.devices,
					[
						bytesToHex(device.key.publicKey),
						{
							publicKey: device.key.publicKey,
							authorizedAt: 1,
							revokedAt: null,
						},
					],
				]),
			};
		},
	);
	assert.equal(
		await f.session.preparePairing(prepared, new AbortController().signal),
		true,
	);
	assert.equal(get(f.session).context, null);
	assert.equal(get(f.session).prepared, true);
	const restarted = f.reopen();
	await restarted.load();
	await restarted.unlock(password);
	assert.deepEqual(
		restarted.device().identity.privateKey,
		receiver.identity.privateKey,
	);
	assert.equal(await restarted.activatePairing(enrollment), false);
	assert.equal(get(restarted).context, null);
	assert.equal(restarted.device().identity.phase, "pairing");
	allowed = true;
	assert.equal(await restarted.activatePairing(enrollment), true);
	assert.equal(restarted.identity().publicKey, receiver.key.registrationKey);
	assert.deepEqual(restarted.identity().device.head, enrollment);
});

test("pending rotation saves both outcomes without replacing the live context and survives activation write failure", async (t) => {
	const f = await fixture(t, {
		registered: async () => false,
		register: async () => {},
	});
	await f.session.create({ serverUrl, otc: "invite" });
	const original = f.session.device();
	const context = get(f.session).context;
	assert.ok(context);
	const replacement = await createDevice(serverUrl);
	const initial = await initialChainState(original.initialPublicKey);
	const record = await createRecord(
		{
			library: initial.library,
			sequence: 1,
			previous: initial.head,
			epoch: 1,
			signer: original.key.publicKey,
			kind: "rotate",
			effects: [2, replacement.key.publicKey],
		},
		original.key.privateCryptoKey,
	);
	const rotation = {
		replacement: replacement.identity.privateKey,
		secret: crypto.getRandomValues(new Uint8Array(32)),
		record: record.bytes,
	};
	assert.equal(
		await f.session.prepareRotation(rotation, stateCheckpoint(initial)),
		true,
	);
	assert.equal(get(f.session).context, context);
	assert.equal(context.signal.aborted, false);
	assert.equal(get(f.session).pendingRotation, true);
	const verified = reduceBlock(initial, record);
	const save = f.persistence.save;
	const failure = t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.session.finishRotation(verified), false);
	assert.equal(get(f.session).context, context);
	assert.deepEqual(f.session.device().identity.rotation, rotation);
	failure.mock.restore();
	assert.equal(f.persistence.save, save);
	const restarted = f.reopen();
	await restarted.load();
	await restarted.unlock(password);
	assert.deepEqual(restarted.device().identity.rotation, rotation);
	assert.equal(await restarted.finishRotation(verified), true);
	assert.equal(restarted.identity().publicKey, replacement.key.registrationKey);
	assert.equal(restarted.identity().device.epochs.length, 2);
	assert.deepEqual(restarted.identity().device.epochs[1]?.[1], rotation.secret);
	assert.equal(restarted.identity().device.rotation, null);
});
