import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import {
	type Checkpoint,
	createChainStorage,
} from "../src/lib/chain-storage.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	type VerifiedBlock,
} from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	encodeOperation,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { loadSigningKey } from "../src/lib/protocol/crypto.ts";
import {
	generateDeviceEncryptionKey,
	loadDeviceEncryptionKey,
} from "../src/lib/protocol/device-encryption.ts";
import {
	type EpochEnvelope,
	sealEpochKeys,
} from "../src/lib/protocol/epoch-envelope.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import {
	createLibraryRecovery,
	epochKey,
} from "../src/lib/protocol/recovery-key.ts";
import {
	type ChainTransport,
	createChain,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
class History implements ChainTransport {
	readonly records: VerifiedBlock[] = [];
	reads = 0;
	current: ChainState;
	constructor(current: ChainState) {
		this.current = current;
	}
	add(record: VerifiedBlock, plaintext?: Bytes) {
		this.current = reduceBlock(this.current, record, plaintext);
		this.records.push(record);
	}
	async read(after: string, until: string | null, signal: AbortSignal) {
		signal.throwIfAborted();
		this.reads++;
		const targetIndex =
			until === null
				? this.records.length - 1
				: this.records.findIndex((record) => bytesToHex(record.hash) === until);
		const afterIndex =
			after === bytesToHex(this.current.library)
				? -1
				: this.records.findIndex((record) => bytesToHex(record.hash) === after);
		assert(targetIndex >= 0);
		assert(afterIndex >= 0 || after === bytesToHex(this.current.library));
		const record = this.records[afterIndex + 1];
		const target = this.records[targetIndex];
		const batch = record && afterIndex < targetIndex ? [record] : [];
		return {
			target: stateCheckpoint({
				...this.current,
				sequence: target.body.sequence,
				head: target.hash,
			}),
			records: batch.map((record) => record.bytes),
			next:
				batch.length && afterIndex + 1 < targetIndex
					? bytesToHex(record.hash)
					: null,
		};
	}
	async append(): Promise<never> {
		throw new Error("The server fixture appends explicitly.");
	}
}
async function fixture(t: test.TestContext) {
	async function device() {
		const { privateKey } = await generatePrivateKey();
		const key = await loadSigningKey(privateKey);
		const encryption = await generateDeviceEncryptionKey();
		const encryptionKey = await loadDeviceEncryptionKey(encryption);
		t.after(() => {
			privateKey.seed.fill(0);
			encryption.secret.fill(0);
		});
		return { key, encryption, encryptionKey };
	}
	const owner = await device();
	const retained = await device();
	const revoked = await device();
	const root = await createLibraryRecovery(
		"https://example.test",
		owner.key.publicKey,
		owner.encryption.publicKey,
	);
	const history = new History(
		await initialChainState(root.recovery.genesis.bytes),
	);
	history.add(root.enrollment);
	const ownerPin = stateCheckpoint(history.current);
	async function enroll(target: Awaited<ReturnType<typeof device>>) {
		const state = history.current;
		history.add(
			await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					epoch: state.epoch,
					signer: owner.key.publicKey,
					kind: "enroll",
					effects: [target.key.publicKey, target.encryption.publicKey],
				},
				owner.key.privateCryptoKey,
			),
		);
		return stateCheckpoint(history.current);
	}
	const retainedPin = await enroll(retained);
	const revokedPin = await enroll(revoked);
	const state = history.current;
	history.add(
		await createRecord(
			{
				library: state.library,
				sequence: state.sequence + 1,
				previous: state.head,
				epoch: state.epoch,
				signer: owner.key.publicKey,
				kind: "revoke",
				effects: [revoked.key.publicKey],
			},
			owner.key.privateCryptoKey,
		),
	);
	const beforeRotation = history.current;
	const secrets = new Map([[1, root.epochKey]]);
	for (const epoch of [2, 3]) {
		const parent = history.current;
		const salt = crypto.getRandomValues(new Uint8Array(32));
		const secret = await epochKey(
			root.recovery.identity.epochDerivationSecret,
			parent.library,
			epoch,
			salt,
		);
		secrets.set(epoch, secret);
		const envelopes = await sealEpochKeys(
			{
				library: parent.library,
				sequence: parent.sequence + 1,
				previous: parent.head,
				epoch: parent.epoch,
				nextEpoch: epoch,
				salt,
			},
			[...parent.devices.values()],
			secret,
		);
		history.add(
			await createRecord(
				{
					library: parent.library,
					sequence: parent.sequence + 1,
					previous: parent.head,
					epoch: parent.epoch,
					signer: root.recovery.key.publicKey,
					kind: "rotate",
					effects: [epoch, salt, envelopes],
				},
				root.recovery.key.privateCryptoKey,
			),
		);
	}
	const parent = history.current;
	const id = new Uint8Array(32).fill(19);
	const plaintext = encodeOperation({
		kind: "AddFile",
		id,
		manifest: {
			hash: new Uint8Array(32).fill(1),
			key: new Uint8Array(32).fill(2),
		},
		metadata: {
			hash: new Uint8Array(32).fill(3),
			key: new Uint8Array(32).fill(4),
		},
	});
	const third = secrets.get(3);
	assert(third);
	history.add(
		await createRecord(
			{
				library: parent.library,
				sequence: parent.sequence + 1,
				previous: parent.head,
				epoch: 3,
				signer: owner.key.publicKey,
				kind: "data",
				effects: [["publish", id, new Uint8Array(32).fill(5)]],
			},
			owner.key.privateCryptoKey,
			{ secret: third, plaintext },
		),
		plaintext,
	);
	t.after(() => {
		root.recovery.identity.signingKey.seed.fill(0);
		root.recovery.identity.epochDerivationSecret.fill(0);
		for (const secret of secrets.values()) {
			secret.fill(0);
		}
	});
	function open(
		target: typeof owner,
		minimum: Checkpoint,
		factory = new IDBFactory(),
	) {
		const cache = createChainStorage(
			"https://example.test",
			bytesToHex(parent.library),
			factory,
		);
		const store = createChain(
			{
				genesis: root.recovery.genesis.bytes,
				publicKey: target.key.publicKey,
				signingKey: target.key.privateCryptoKey,
				secrets: new Map([[1, root.epochKey]]),
				minimum,
				encryption: {
					publicKey: target.encryption.publicKey,
					keyPair: target.encryptionKey,
				},
			},
			cache,
			history,
			new AbortController().signal,
		);
		t.after(store.dispose);
		return { store, cache, factory };
	}
	return {
		owner,
		retained,
		revoked,
		ownerPin,
		retainedPin,
		revokedPin,
		history,
		secrets,
		root,
		beforeRotation,
		open,
	};
}

test("an offline retained device replays multiple rotations, decrypts new operations, and restarts from durable envelopes", async (t) => {
	const f = await fixture(t);
	const first = f.open(f.retained, f.retainedPin);
	const state = await first.store.sync();
	assert.equal(state.epoch, 3);
	assert.equal(state.files.size, 1);
	const keys = first.store.keyring();
	assert.deepEqual(
		keys.map(([epoch, key]) => [epoch, key]),
		[...f.secrets.entries()],
	);
	for (const [, key] of keys) {
		key.fill(0);
	}
	assert.deepEqual(first.store.keyring()[1][1], f.secrets.get(2));
	first.store.dispose();
	const reads = f.history.reads;
	const restarted = f.open(f.retained, f.retainedPin, first.factory);
	assert.deepEqual(await restarted.store.sync(), state);
	assert.equal(f.history.reads, reads + 1);
	const exported = restarted.store.keyring();
	for (const [, key] of exported) {
		key.fill(0);
	}
});

test("a revoked device cannot recover the next epoch even when the server exposes every block", async (t) => {
	const f = await fixture(t);
	const { store, cache } = f.open(f.revoked, f.revokedPin);
	await assert.rejects(store.sync(), /Missing encryption secret/);
	assert.equal(get(store).live?.sequence, f.beforeRotation.sequence);
	assert.equal(
		(await cache.head(new AbortController().signal))?.sequence,
		f.beforeRotation.sequence,
	);
	assert.equal(get(store).live?.epoch, 1);
});

test("missing recipient entries in a recovery-signed rotation cannot advance the trusted head", async (t) => {
	const f = await fixture(t);
	const good = f.history.records[4];
	const [epoch, salt, envelopes] = good.body.effects as readonly [
		number,
		Bytes,
		readonly EpochEnvelope[],
	];
	const bad = await createRecord(
		{ ...good.body, effects: [epoch, salt, envelopes.slice(1)] },
		f.root.recovery.key.privateCryptoKey,
	);
	f.history.records.splice(4, f.history.records.length - 4, bad);
	const { store, cache } = f.open(f.retained, f.retainedPin);
	await assert.rejects(store.sync(), /every authorized device/);
	assert.equal(
		(await cache.head(new AbortController().signal))?.sequence,
		f.beforeRotation.sequence,
	);
});

test("a malformed recipient ciphertext fails locally even when the root signature is valid", async (t) => {
	const f = await fixture(t);
	const good = f.history.records[4];
	const [epoch, salt, envelopes] = good.body.effects as readonly [
		number,
		Bytes,
		readonly EpochEnvelope[],
	];
	const altered = envelopes.map((entry) => {
		const ciphertext = entry[2].slice();
		if (bytesToHex(entry[0]) === bytesToHex(f.retained.key.publicKey)) {
			ciphertext[0] ^= 1;
		}
		return [entry[0], entry[1], ciphertext] as const;
	});
	const bad = await createRecord(
		{ ...good.body, effects: [epoch, salt, altered] },
		f.root.recovery.key.privateCryptoKey,
	);
	f.history.records.splice(4, f.history.records.length - 4, bad);
	const broken = f.open(f.retained, f.retainedPin);
	await assert.rejects(broken.store.sync());
	assert.equal(
		(await broken.cache.head(new AbortController().signal))?.sequence,
		f.beforeRotation.sequence,
	);
	const unaffected = f.open(f.owner, f.ownerPin);
	assert.equal((await unaffected.store.sync()).epoch, 2);
});
