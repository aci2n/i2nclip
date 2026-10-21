import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { createChainStorage } from "../src/lib/chain-storage.ts";
import { prepareRecoveryDevice } from "../src/lib/library-recovery.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import { createRecoveryFile } from "../src/lib/protocol/backup.ts";
import { b64urlToBytes, bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	decryptOperation,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	encodeOperation,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import {
	createLibraryDevice,
	encodeDevice,
} from "../src/lib/protocol/device.ts";
import { sealEpochKeys } from "../src/lib/protocol/epoch-envelope.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { epochKey } from "../src/lib/protocol/recovery-key.ts";
import { createSession } from "../src/lib/stores/identity.ts";
import { memoryStorage } from "./memory-database.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
const filled = (n: number): Bytes => new Uint8Array(32).fill(n);
class Server {
	readonly records: VerifiedBlock[] = [];
	loseResponse = false;
	posts = 0;
	readonly keys = new Map<number, Bytes>();
	state: ChainState;
	constructor(state: ChainState) {
		this.state = state;
	}
	readonly fetch = this.request.bind(this);
	private async request(input: string | URL | Request, options?: RequestInit) {
		const url = new URL(String(input));
		const auth = new Headers(options?.headers).get("Authorization") ?? "";
		const pub = b64urlToBytes(auth.replace("Bearer ", "").split(".")[0]);
		const active = this.state.devices.get(bytesToHex(pub))?.revokedAt === null;
		const root = bytesToHex(pub) === bytesToHex(this.state.recoveryPublicKey);
		if (url.pathname === "/api/ping") {
			return new Response(null, { status: active ? 204 : 401 });
		}
		if (options?.method === "POST") {
			assert.equal(url.pathname, "/api/blocks");
			this.posts++;
			const record = await verifyRecord(
				new Uint8Array(options.body as Uint8Array),
			);
			if (
				!active &&
				!root &&
				bytesToHex(record.body.effects[0] as Bytes) !== bytesToHex(pub)
			) {
				return new Response(null, { status: 401 });
			}
			if (
				this.records.some((r) => bytesToHex(r.hash) === bytesToHex(record.hash))
			) {
				return this.receipt(record);
			}
			if (bytesToHex(record.body.previous) !== bytesToHex(this.state.head)) {
				return new Response(null, { status: 409 });
			}
			this.state = reduceBlock(this.state, record);
			this.records.push(record);
			if (this.loseResponse) {
				this.loseResponse = false;
				throw new Error("Lost accepted response");
			}
			return this.receipt(record);
		}
		assert.equal(url.pathname, "/api/blocks");
		if (!root && !active) {
			return new Response(null, { status: 401 });
		}
		const after = url.searchParams.get("after");
		const index =
			after === bytesToHex(this.state.library)
				? -1
				: this.records.findIndex((r) => bytesToHex(r.hash) === after);
		const records = this.records.slice(index + 1, index + 2);
		const last = records.at(-1);
		return new Response(
			encode([
				this.state.head,
				this.state.sequence,
				records.map((r) => r.bytes),
				last && last.body.sequence < this.state.sequence ? last.hash : null,
			]),
		);
	}
	private receipt(record: VerifiedBlock) {
		return new Response(
			encode([
				record.hash,
				record.body.sequence,
				this.state.head,
				this.state.sequence,
			]),
		);
	}
}
async function fixture(t: test.TestContext) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
	Object.defineProperty(globalThis, "indexedDB", {
		value: new IDBFactory(),
		configurable: true,
	});
	t.after(() => {
		if (descriptor) {
			Object.defineProperty(globalThis, "indexedDB", descriptor);
		} else {
			Reflect.deleteProperty(globalThis, "indexedDB");
		}
	});
	const created = await createLibraryDevice("https://example.test");
	assert(created.device.identity.registration);
	const server = new Server(
		reduceBlock(
			await initialChainState(created.device.identity.genesis),
			await verifyRecord(created.device.identity.registration),
		),
	);
	server.records.push(await verifyRecord(created.device.identity.registration));
	server.keys.set(1, created.device.identity.epochs[0][1]);
	const id = filled(1);
	const plaintext = encodeOperation({
		kind: "AddFile",
		id,
		manifest: { hash: filled(2), key: filled(3) },
		metadata: { hash: filled(4), key: filled(5) },
	});
	const add = await createRecord(
		{
			library: server.state.library,
			sequence: server.state.sequence + 1,
			previous: server.state.head,
			epoch: 1,
			signer: created.device.key.publicKey,
			kind: "data",
			effects: [["publish", id, filled(6)]],
		},
		created.device.key.privateCryptoKey,
		{ secret: created.device.identity.epochs[0][1], plaintext },
	);
	server.state = reduceBlock(server.state, add, plaintext);
	server.records.push(add);
	const secret = await epochKey(
		created.recovery.identity.epochDerivationSecret,
		server.state.library,
		2,
		filled(12),
	);
	const envelopes = await sealEpochKeys(
		{
			library: server.state.library,
			sequence: server.state.sequence + 1,
			previous: server.state.head,
			epoch: 1,
			nextEpoch: 2,
			salt: filled(12),
		},
		[...server.state.devices.values()],
		secret,
	);
	const rotation = await createRecord(
		{
			library: server.state.library,
			sequence: server.state.sequence + 1,
			previous: server.state.head,
			epoch: 1,
			signer: created.recovery.key.publicKey,
			kind: "rotate",
			effects: [2, filled(12), envelopes],
		},
		created.recovery.key.privateCryptoKey,
	);
	server.state = reduceBlock(server.state, rotation);
	server.records.push(rotation);
	server.keys.set(2, secret);
	const device = created.device.key;
	const deletion = await createRecord(
		{
			library: server.state.library,
			sequence: server.state.sequence + 1,
			previous: server.state.head,
			epoch: 2,
			signer: device.publicKey,
			kind: "data",
			effects: [],
		},
		device.privateCryptoKey,
		{ secret, plaintext: encodeOperation({ kind: "DeleteFile", id }) },
	);
	server.state = reduceBlock(
		server.state,
		deletion,
		await decryptOperation(deletion, secret),
	);
	server.records.push(deletion);
	t.mock.method(globalThis, "fetch", server.fetch);
	return { ...created, server, id };
}

test("offline recovery decrypts every epoch and persists only a fresh local candidate", async (t) => {
	const f = await fixture(t);
	const pending = await prepareRecoveryDevice(
		f.recovery,
		new AbortController().signal,
	);
	assert.equal(pending.identity.phase, "recovering");
	assert.equal(pending.identity.epochs.length, 2);
	assert.deepEqual(pending.identity.epochs[1][1], f.server.keys.get(2));
	assert(pending.identity.recovery);
	const enrollment = await verifyRecord(pending.identity.recovery);
	assert.equal(enrollment.body.kind, "enroll");
	assert.deepEqual(enrollment.body.signer, f.recovery.key.publicKey);
	assert.deepEqual(enrollment.body.effects, [
		pending.key.publicKey,
		pending.identity.encryption.publicKey,
	]);
	assert.equal(enrollment.body.epoch, 2);
	assert.equal(pending.identity.rotation, null);
	const local = Buffer.from(encodeDevice(pending.identity));
	assert.equal(
		local.includes(Buffer.from(f.recovery.identity.signingKey.seed)),
		false,
	);
	assert.equal(
		local.includes(Buffer.from(f.recovery.identity.epochDerivationSecret)),
		false,
	);
	const cache = createChainStorage(
		"https://example.test",
		bytesToHex(f.server.state.library),
	);
	t.after(cache.dispose);
	assert.equal((await cache.head(new AbortController().signal))?.sequence, 4);
	assert.equal(f.server.posts, 0);
});

test("no-device recovery survives restart, lost responses, and loss of an accepted candidate", async (t) => {
	const f = await fixture(t);
	const backup = await createRecoveryFile(f.recovery.identity);
	const storage = memoryStorage();
	const session = createSession({
		persistence: createPersistence(storage.connect()),
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize("local password");
	assert.equal(
		await session.restore(new Blob([backup.bytes]), backup.password),
		true,
	);
	assert.equal(get(session).context, null);
	const firstCandidate = session.device().key.registrationKey;
	session.dispose();
	const resumedPersistence = createPersistence(storage.connect());
	const resumed = createSession({ persistence: resumedPersistence });
	t.after(resumed.dispose);
	await resumed.load();
	await resumed.unlock("local password");
	f.server.loseResponse = true;
	const failure = t.mock.method(resumedPersistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await resumed.submitRecovery(), false);
	assert.equal(resumed.device().identity.phase, "recovering");
	assert.equal(f.server.state.epoch, 2);
	failure.mock.restore();
	assert.equal(await resumed.reconcileRecovery(), true);
	assert.equal(f.server.posts, 1);
	assert.equal(resumed.identity().publicKey, firstCandidate);
	assert.equal(f.server.state.epoch, 2);
	assert.equal(get(resumed).context?.identity.phase, "active");
	assert.equal(f.server.state.files.get(bytesToHex(f.id))?.deleted, true);
	assert.equal(await resumed.forget(), true);
	// The sole recovery file works again; no exported device credential is needed.
	assert.equal(
		await resumed.restore(new Blob([backup.bytes]), backup.password),
		true,
	);
	assert.notEqual(resumed.device().key.registrationKey, firstCandidate);
	assert.equal(await resumed.submitRecovery(), true);
	assert.equal(f.server.state.epoch, 2);
	assert.equal(f.server.state.sequence, 6);
	assert.equal(resumed.identity().device.epochs.length, 2);
});

test("invalid encrypted history is rejected before accepting its head", async (t) => {
	const f = await fixture(t);
	const last = f.server.records.at(-1);
	assert.ok(last);
	const { loadSigningKey } = await import("../src/lib/protocol/crypto.ts");
	const initial = await loadSigningKey(f.device.identity.privateKey);
	// A valid signature alone is insufficient: an authenticated malformed operation
	// cannot advance the recovery cache's trusted head.
	const record = await createRecord(
		{
			...last.body,
			sequence: 2,
			previous: f.server.records[0].hash,
			epoch: 1,
			signer: initial.publicKey,
			effects: [],
		},
		initial.privateCryptoKey,
		{
			secret: f.device.identity.epochs[0][1],
			plaintext: encode(["UnknownOperation"]),
		},
	);
	f.server.records.splice(1, f.server.records.length - 1, record);
	f.server.state = { ...f.server.state, sequence: 2, head: record.hash };
	await assert.rejects(
		prepareRecoveryDevice(f.recovery, new AbortController().signal),
		/Invalid chain operation/,
	);
	const cache = createChainStorage(
		"https://example.test",
		bytesToHex(f.server.state.library),
	);
	t.after(cache.dispose);
	assert.equal((await cache.head(new AbortController().signal))?.sequence, 1);
});

test("explicit recovery revocation persists a candidate before publishing and prepares against the accepted head", async (t) => {
	const f = await fixture(t);
	const target = [...f.server.state.devices.values()].find(
		(device) => device.revokedAt === null,
	);
	assert(target);
	const before = f.server.state.sequence;
	let saved = false;
	f.server.loseResponse = true;
	const candidate = await prepareRecoveryDevice(
		f.recovery,
		new AbortController().signal,
		{
			publicKey: bytesToHex(target.publicKey),
			save: async (pending) => {
				assert.equal(f.server.posts, 0);
				assert.equal(pending.identity.phase, "recovering");
				assert.equal(pending.identity.head.sequence, before);
				saved = true;
			},
		},
	);
	assert(saved);
	assert.equal(
		f.server.state.devices.get(bytesToHex(target.publicKey))?.revokedAt,
		before + 1,
	);
	assert.equal(candidate.identity.head.sequence, before + 1);
	assert(candidate.identity.recovery);
	const enrollment = await verifyRecord(candidate.identity.recovery);
	assert.deepEqual(enrollment.body.previous, f.server.state.head);
	assert.equal(enrollment.body.epoch, 2);
});

test("failed recovery candidate persistence publishes no revocation", async (t) => {
	const f = await fixture(t);
	const target = [...f.server.state.devices.values()].find(
		(device) => device.revokedAt === null,
	);
	assert(target);
	await assert.rejects(
		prepareRecoveryDevice(f.recovery, new AbortController().signal, {
			publicKey: bytesToHex(target.publicKey),
			save: async () => {
				throw new Error("Disk full");
			},
		}),
		/Disk full/,
	);
	assert.equal(f.server.posts, 0);
	assert.equal(
		f.server.state.devices.get(bytesToHex(target.publicKey))?.revokedAt,
		null,
	);
});

test("recovery rejects an unrecognized revocation target before saving or publishing", async (t) => {
	const f = await fixture(t);
	await assert.rejects(
		prepareRecoveryDevice(f.recovery, new AbortController().signal, {
			publicKey: "00".repeat(32),
			save: async () => {
				assert.fail("Invalid target must not save a candidate");
			},
		}),
		/active device/,
	);
	assert.equal(f.server.posts, 0);
});
