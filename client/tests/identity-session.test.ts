import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import type { verifyDevice } from "../src/lib/device-verification.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import type { EncryptedBackup } from "../src/lib/protocol/backup.ts";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import {
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { openRecoveryFile } from "../src/lib/protocol/recovery-key.ts";
import { stateCheckpoint } from "../src/lib/stores/chain.ts";
import { createSession, type IdentityApi } from "../src/lib/stores/identity.ts";
import { createDevice, registerSession } from "./library-fixture.ts";
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
	let recoveryFile: EncryptedBackup | null = null;
	const session = createSession({
		persistence,
		http,
		verify,
		download: (file) => {
			recoveryFile = { bytes: file.bytes.slice(), password: file.password };
		},
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize(password, remember);
	function reopen(nextHttp = http) {
		const next = createSession({
			persistence: createPersistence(storage.connect()),
			http: nextHttp,
			verify,
			download: () => {},
		});
		t.after(next.dispose);
		return next;
	}
	return {
		storage,
		persistence,
		session,
		reopen,
		recoveryFile: () => {
			assert.ok(recoveryFile);
			return recoveryFile;
		},
	};
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
	assert.equal(
		await registerSession(f.session, { serverUrl, otc: "invite" }),
		false,
	);
	assert.equal(get(f.session).prepared, true);
	assert.equal(get(f.session).context, null);
	assert.match(get(f.session).error, /credentials are saved/);
	f.session.dispose();
	const resumed = f.reopen();
	await resumed.load();
	await resumed.unlock(password);
	assert.equal(get(resumed).prepared, true);
	assert.equal(get(resumed).serverUrl, serverUrl);
	assert.equal(
		await registerSession(resumed, { serverUrl, otc: "used code" }),
		true,
	);
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
	assert.equal(
		await registerSession(f.session, { serverUrl, otc: "invite" }),
		false,
	);
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
	assert.equal(
		await registerSession(f.session, { serverUrl, otc: "invite" }),
		false,
	);
	assert.equal(accepted, true);
	const resumed = f.reopen();
	await resumed.load();
	assert.equal(get(resumed).unlocked, true);
	assert.equal(get(resumed).prepared, true);
	assert.equal(
		await registerSession(resumed, { serverUrl, otc: "used" }),
		true,
	);
	assert.equal(resumed.identity().device.epochs.length, 1);
});

test("independent tabs retain loaded local sessions", async (t) => {
	const f = await fixture(t, {
		async registered() {
			return false;
		},
		async register() {},
	});
	assert.equal(
		await registerSession(f.session, { serverUrl, otc: "invite" }),
		true,
	);
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
			const initial = await initialChainState(device.identity.genesis);
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
	await registerSession(f.session, { serverUrl, otc: "invite" });
	const original = f.session.device();
	const context = get(f.session).context;
	assert.ok(context);
	const replacement = await createDevice(serverUrl);
	const initial = await initialChainState(original.identity.genesis);
	const backup = f.recoveryFile();
	const recovery = await openRecoveryFile(backup.bytes, backup.password);
	const record = await createRecord(
		{
			library: initial.library,
			sequence: 1,
			previous: initial.head,
			epoch: 1,
			signer: recovery.key.publicKey,
			kind: "rotate",
			effects: [2, replacement.key.publicKey, new Uint8Array(32).fill(12)],
		},
		recovery.key.privateCryptoKey,
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

test("creation requires a recovery download and resumed creation requires its matching file", async (t) => {
	let registrations = 0;
	const f = await fixture(t, {
		registered: async () => false,
		register: async () => {
			registrations++;
		},
	});
	assert.equal(await f.session.create({ serverUrl, otc: "invite" }), false);
	assert.equal(registrations, 0);
	assert.match(get(f.session).error, /Download the recovery file/);
	const artifact = get(f.session).recoveryFile;
	assert.ok(artifact);
	const savedFile = {
		bytes: artifact.bytes.slice(),
		password: artifact.password,
	};
	assert.match(savedFile.password, /^[A-Za-z0-9_-]{43}$/);
	await f.session.downloadRecovery();
	f.session.dispose();
	const resumed = f.reopen();
	await resumed.load();
	await resumed.unlock(password);
	assert.equal(await resumed.create({ serverUrl, otc: "invite" }), false);
	assert.equal(registrations, 0);
	const unrelated = await createDevice(serverUrl);
	const { createRecoveryFile } = await import("../src/lib/protocol/backup.ts");
	const wrong = await createRecoveryFile(unrelated.recovery.identity);
	assert.equal(
		await resumed.resumeCreation(new Blob([wrong.bytes]), wrong.password),
		false,
	);
	assert.match(get(resumed).error, /another library/);
	assert.equal(
		await resumed.resumeCreation(
			new Blob([savedFile.bytes]),
			savedFile.password,
		),
		true,
	);
	assert.equal(await resumed.create({ serverUrl, otc: "invite" }), true);
	assert.equal(registrations, 1);
	assert.equal(get(resumed).recoveryFile, null);
	const recovery = await openRecoveryFile(savedFile.bytes, savedFile.password);
	const { encodeDevice } = await import("../src/lib/protocol/device.ts");
	const local = Buffer.from(encodeDevice(resumed.identity().device));
	assert.equal(
		local.includes(Buffer.from(recovery.identity.signingKey.seed)),
		false,
	);
	assert.equal(
		local.includes(Buffer.from(recovery.identity.epochDerivationSecret)),
		false,
	);
	recovery.identity.signingKey.seed.fill(0);
	recovery.identity.epochDerivationSecret.fill(0);
});

test("failed recovery downloads retain the same artifact and cannot enable registration", async (t) => {
	let attempts = 0;
	const session = createSession({
		persistence: createPersistence(memoryStorage().connect()),
		http: {
			registered: async () => false,
			register: async () => {
				throw new Error("must not register");
			},
		},
		download: () => {
			attempts++;
			throw new Error("Download blocked");
		},
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize(password);
	assert.equal(await session.prepareCreation(serverUrl), true);
	const artifact = get(session).recoveryFile;
	assert.equal(await session.downloadRecovery(), false);
	assert.equal(await session.downloadRecovery(), false);
	assert.equal(attempts, 2);
	assert.equal(get(session).recoveryFile, artifact);
	assert.equal(get(session).recoveryDownloaded, false);
	assert.equal(await session.create({ serverUrl, otc: "invite" }), false);
});
