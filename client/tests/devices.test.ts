import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import { createChainStorage } from "../src/lib/chain-storage.ts";
import { createPersistence } from "../src/lib/persistence.ts";
import type { EncryptedBackup } from "../src/lib/protocol/backup.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import { reduceBlock } from "../src/lib/protocol/chain-state.ts";
import { generateDeviceEncryptionKey } from "../src/lib/protocol/device-encryption.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import {
	type ChainTransport,
	createChain,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";
import { createDevices } from "../src/lib/stores/devices.ts";
import { createSession } from "../src/lib/stores/identity.ts";
import {
	initialSessionState,
	registerSession,
	sessionEnrollment,
} from "./library-fixture.ts";
import { memoryStorage } from "./memory-database.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
async function fixture(t: test.TestContext) {
	const persistence = createPersistence(memoryStorage().connect());
	let recoveryFile: EncryptedBackup | null = null;
	const session = createSession({
		persistence,
		download: (file) => {
			recoveryFile = { bytes: file.bytes.slice(), password: file.password };
		},
		http: { registered: async () => false, register: async () => {} },
	});
	t.after(session.dispose);
	await session.load();
	await session.initialize("master password");
	await registerSession(session, {
		serverUrl: "https://example.test",
		otc: "invite",
	});
	const original = session.device();
	const context = get(session).context;
	assert(context);
	let server = await initialSessionState(session);
	const records: VerifiedBlock[] = [await sessionEnrollment(session)];
	const posts: Bytes[] = [];
	let outcome: "accepted" | "lost" | "rejected" = "accepted";
	const transport: ChainTransport = {
		async read(after, until, signal) {
			signal.throwIfAborted();
			const end =
				until === null
					? records.length - 1
					: records.findIndex((record) => bytesToHex(record.hash) === until);
			assert(end >= 0);
			const start =
				after === bytesToHex(server.library)
					? 0
					: records.findIndex((record) => bytesToHex(record.hash) === after) +
						1;
			const target = records[end];
			return {
				target: {
					sequence: target.body.sequence,
					hash: bytesToHex(target.hash),
				},
				records: records.slice(start, end + 1).map((record) => record.bytes),
				next: null,
			};
		},
		async append(bytes) {
			posts.push(bytes.slice());
			if (outcome === "rejected") {
				throw new Error("Disconnected before acceptance");
			}
			const record = await verifyRecord(bytes);
			server = reduceBlock(server, record);
			records.push(record);
			if (outcome === "lost") {
				throw new Error("Lost response");
			}
			return {
				accepted: stateCheckpoint(server),
				head: stateCheckpoint(server),
			};
		},
	};
	const storage = createChainStorage(
		original.identity.serverUrl,
		bytesToHex(server.library),
		new IDBFactory(),
	);
	t.after(storage.dispose);
	const chain = createChain(
		{
			genesis: original.identity.genesis,
			publicKey: original.key.publicKey,
			signingKey: original.key.privateCryptoKey,
			secrets: new Map(original.identity.epochs),
			minimum: original.identity.head,
			encryption: {
				publicKey: original.identity.encryption.publicKey,
				keyPair: original.encryptionKey,
			},
		},
		storage,
		transport,
		context.signal,
	);
	t.after(chain.dispose);
	const devices = createDevices(session, chain, transport, context.signal);
	t.after(devices.dispose);
	async function advance() {
		const { privateKey } = await generatePrivateKey();
		const encryption = await generateDeviceEncryptionKey();
		try {
			const record = await createRecord(
				{
					library: server.library,
					sequence: server.sequence + 1,
					previous: server.head,
					epoch: server.epoch,
					signer: original.key.publicKey,
					kind: "enroll",
					effects: [privateKey.public_key, encryption.publicKey],
				},
				original.key.privateCryptoKey,
			);
			server = reduceBlock(server, record);
			records.push(record);
		} finally {
			privateKey.seed.fill(0);
			encryption.secret.fill(0);
		}
	}
	return {
		session,
		devices,
		persistence,
		chain,
		original,
		context,
		posts,
		advance,
		current: () => server,
		outcome: (value: typeof outcome) => {
			outcome = value;
		},
		prepareRotation: () => {
			assert(recoveryFile);
			return devices.prepareRotation(
				new Blob([recoveryFile.bytes]),
				recoveryFile.password,
			);
		},
	};
}

test("rotation preserves device identity and context and reconciles exact acceptance after a lost response", async (t) => {
	const f = await fixture(t);
	assert.equal(await f.prepareRotation(), true);
	const plan = f.session.device().identity.rotation;
	assert(plan);
	f.outcome("lost");
	assert.equal(await f.devices.submitRotation(), true);
	assert.equal(f.posts.length, 1);
	assert.deepEqual(f.posts[0], plan.record);
	assert.equal(f.session.identity().device.rotation, null);
	assert.deepEqual(
		f.session.identity().device.privateKey,
		f.original.identity.privateKey,
	);
	assert.deepEqual(
		f.session.identity().device.encryption,
		f.original.identity.encryption,
	);
	assert.equal(f.session.identity().device.epochs.length, 2);
	assert.equal(get(f.session).context, f.context);
	assert.equal(f.context.signal.aborted, false);
	assert.equal(
		f.current().devices.get(bytesToHex(f.original.key.publicKey))?.revokedAt,
		null,
	);
	assert.equal(
		Buffer.from(f.posts[0]).includes(Buffer.from(plan.secret)),
		false,
	);
});

test("a rejected append preserves the exact pending plan for retry", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	f.outcome("rejected");
	assert.equal(await f.devices.submitRotation(), false);
	assert(f.session.device().identity.rotation);
	assert.match(get(f.devices).error, /not been accepted/);
	f.outcome("accepted");
	assert.equal(await f.devices.submitRotation(), true);
	assert.deepEqual(f.posts[0], f.posts[1]);
	assert.equal(f.session.identity().device.rotation, null);
});

test("a moved parent requires explicit reconstruction and a new local plan", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	await f.advance();
	assert.equal(await f.devices.submitRotation(), false);
	assert.equal(f.posts.length, 0);
	assert.match(get(f.devices).error, /new rotation/);
	assert.equal(await f.prepareRotation(), true);
	assert.equal(await f.devices.submitRotation(), true);
	assert.equal(f.posts.length, 1);
});

test("an accepted rotation remains recoverable when final credential persistence fails", async (t) => {
	const f = await fixture(t);
	await f.prepareRotation();
	const fail = t.mock.method(f.persistence, "save", async () => {
		throw new Error("Disk full");
	});
	assert.equal(await f.devices.submitRotation(), false);
	assert.match(get(f.devices).error, /Disk full/);
	assert(f.session.device().identity.rotation);
	fail.mock.restore();
	assert.equal(await f.devices.reconcile(), true);
	assert.equal(f.session.identity().device.rotation, null);
	assert.equal(f.posts.length, 1);
});
