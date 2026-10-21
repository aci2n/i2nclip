import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
import {
	type ChainStorage,
	type Checkpoint,
	createChainStorage,
} from "../src/lib/chain-storage.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import {
	encodeOperation,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { loadSigningKey } from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { createLibraryRecovery } from "../src/lib/protocol/recovery-key.ts";
import {
	type ChainPage,
	type ChainTransport,
	createChain,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
const bytes = (n: number): Bytes => new Uint8Array(32).fill(n);
async function device() {
	return loadSigningKey((await generatePrivateKey()).privateKey);
}

class Transport implements ChainTransport {
	readonly records: VerifiedBlock[] = [];
	readonly genesis: Checkpoint;
	reads = 0;
	writes = 0;
	loseResponse = false;
	pageOverride: ((page: ChainPage) => ChainPage) | null = null;
	constructor(genesis: Checkpoint) {
		this.genesis = genesis;
	}
	async read(
		after: string,
		until: string | null,
		signal: AbortSignal,
	): Promise<ChainPage> {
		signal.throwIfAborted();
		this.reads++;
		const targetIndex =
			until === null
				? this.records.length - 1
				: this.records.findIndex((r) => bytesToHex(r.hash) === until);
		const targetRecord = this.records[targetIndex];
		const target = !targetRecord
			? this.genesis
			: {
					sequence: targetIndex + 1,
					hash: bytesToHex(targetRecord.hash),
				};
		const start =
			after === this.genesis.hash
				? 0
				: this.records.findIndex((r) => bytesToHex(r.hash) === after) + 1;
		if (start === 0 && after !== this.genesis.hash) {
			throw new Error("Unknown anchor");
		}
		const records = this.records.slice(
			start,
			Math.min(start + 1, targetIndex + 1),
		);
		const last = records.at(-1);
		const page = {
			target,
			records: records.map((r) => r.bytes),
			next: last && start < targetIndex ? bytesToHex(last.hash) : null,
		};
		return this.pageOverride?.(page) ?? page;
	}
	async append(data: Bytes, signal: AbortSignal) {
		signal.throwIfAborted();
		this.writes++;
		const record = await verifyRecord(data);
		const current = this.records.at(-1);
		if (
			bytesToHex(record.body.previous) !==
			(current ? bytesToHex(current.hash) : this.genesis.hash)
		) {
			throw new Error("Conflict");
		}
		this.records.push(record);
		if (this.loseResponse) {
			this.loseResponse = false;
			throw new Error("Lost response");
		}
		const accepted = {
			sequence: record.body.sequence,
			hash: bytesToHex(record.hash),
		};
		return { accepted, head: accepted };
	}
}
async function fixture(t: TestContext, minimum?: Checkpoint) {
	const key = await device();
	const recovery = await createLibraryRecovery(
		"https://example.test",
		key.publicKey,
	);
	const initial = await initialChainState(recovery.recovery.genesis.bytes);
	const transport = new Transport(stateCheckpoint(initial));
	const factory = new IDBFactory();
	const storage = createChainStorage(
		"https://example.test",
		bytesToHex(initial.library),
		factory,
	);
	const credentials = {
		genesis: recovery.recovery.genesis.bytes,
		publicKey: key.publicKey,
		signingKey: key.privateCryptoKey,
		secrets: new Map([[1, bytes(9)]]),
		minimum: minimum ?? stateCheckpoint(initial),
	};
	const controller = new AbortController();
	const store = createChain(credentials, storage, transport, controller.signal);
	t.after(store.dispose);
	let state = initial;
	async function addFile(n: number) {
		const id = bytes(n);
		const plaintext = encodeOperation({
			kind: "AddFile",
			id,
			manifest: { hash: bytes(2), key: bytes(3) },
			metadata: { hash: bytes(4), key: bytes(5) },
		});
		const record = await createRecord(
			{
				library: state.library,
				sequence: state.sequence + 1,
				previous: state.head,
				epoch: 1,
				signer: key.publicKey,
				kind: "data",
				effects: [["publish", id, bytes(6)]],
			},
			key.privateCryptoKey,
			{ secret: bytes(9), plaintext },
		);
		state = reduceBlock(state, record, plaintext);
		transport.records.push(record);
		return state;
	}
	return {
		key,
		initial,
		transport,
		factory,
		storage,
		credentials,
		controller,
		store,
		addFile,
	};
}

test("bounded encrypted replay persists state and restarts from verified cache", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	const expected = await f.addFile(11);
	const a = f.store.sync();
	const b = f.store.sync();
	assert.equal(a, b);
	assert.deepEqual(await a, expected);
	assert.equal(f.transport.reads, 2);
	assert.equal(get(f.store).live?.files.size, 2);
	f.store.dispose();
	const storage = createChainStorage(
		"https://example.test",
		bytesToHex(f.initial.library),
		f.factory,
	);
	const restarted = createChain(
		f.credentials,
		storage,
		f.transport,
		new AbortController().signal,
	);
	t.after(restarted.dispose);
	assert.deepEqual(await restarted.sync(), expected);
	assert.equal(f.transport.reads, 3);
});

test("fresh client cannot publish a prefix below its trusted head or accept a fork", async (t) => {
	const f = await fixture(t);
	const expected = await f.addFile(10);
	await f.addFile(11);
	f.store.dispose();
	const storage = createChainStorage(
		"https://example.test",
		bytesToHex(f.initial.library),
		f.factory,
	);
	const pinned = createChain(
		{ ...f.credentials, minimum: stateCheckpoint(expected) },
		storage,
		f.transport,
		new AbortController().signal,
	);
	t.after(pinned.dispose);
	const seen: number[] = [];
	const unsubscribe = pinned.subscribe((s) => {
		if (s.live) {
			seen.push(s.live.sequence);
		}
	});
	t.after(unsubscribe);
	await pinned.sync();
	assert.ok(seen.every((n) => n >= 1));
	await storage.discardRecords(new AbortController().signal);
	f.transport.records.pop();
	await assert.rejects(pinned.sync(), /stale/);
	assert.equal((await storage.head(new AbortController().signal))?.sequence, 2);
});

test("invalid pages and signatures never advance the persisted head", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	f.transport.pageOverride = (page) => ({ ...page, next: "0".repeat(64) });
	await assert.rejects(f.store.sync(), /pagination/);
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		0,
	);
	f.transport.pageOverride = (page) => ({
		...page,
		records: page.records.map((b) => {
			const bad = b.slice();
			bad[bad.length - 1] ^= 1;
			return bad;
		}),
	});
	await assert.rejects(f.store.sync());
	assert.equal(
		(await f.storage.read(0, new AbortController().signal)).length,
		0,
	);
});

test("a persistence failure prevents accepted state from reaching the UI", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	const broken: ChainStorage = {
		...f.storage,
		append: async () => {
			throw new Error("Disk full");
		},
	};
	const store = createChain(
		f.credentials,
		broken,
		f.transport,
		new AbortController().signal,
	);
	t.after(store.dispose);
	await assert.rejects(store.sync(), /Disk full/);
	assert.equal(get(store).live?.sequence, 0);
	assert.match(get(store).storageError, /Disk full/);
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		0,
	);
});

test("mutations reject stale drafts and reconcile a lost append response by exact hash", async (t) => {
	const f = await fixture(t);
	const stale = stateCheckpoint(await f.store.sync());
	const current = await f.addFile(10);
	await assert.rejects(
		f.store.append({
			expected: stale,
			kind: "data",
			effects: [],
			plaintext: encodeOperation({ kind: "DeleteFile", id: bytes(10) }),
		}),
		/changed/,
	);
	assert.equal(f.transport.writes, 0);
	f.transport.loseResponse = true;
	const result = await f.store.append({
		expected: stateCheckpoint(current),
		kind: "data",
		effects: [],
		plaintext: encodeOperation({ kind: "DeleteFile", id: bytes(10) }),
	});
	assert.equal(result.files.get(bytesToHex(bytes(10)))?.deleted, true);
	assert.equal(f.transport.writes, 1);
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		2,
	);
});

test("disposal during a read suppresses late state publication", async (t) => {
	const f = await fixture(t);
	let release!: (page: ChainPage) => void;
	f.transport.read = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	const pending = f.store.sync();
	while (!release) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	f.store.dispose();
	release({ target: stateCheckpoint(f.initial), records: [], next: null });
	await assert.rejects(pending, /abort/i);
	assert.equal(get(f.store).live, null);
});

test("a trusted head with a different hash rejects an otherwise valid chain", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	const storage = createChainStorage(
		"https://other.test",
		bytesToHex(f.initial.library),
		f.factory,
	);
	const store = createChain(
		{ ...f.credentials, minimum: { sequence: 1, hash: "0".repeat(64) } },
		storage,
		f.transport,
		new AbortController().signal,
	);
	t.after(store.dispose);
	await assert.rejects(store.sync(), /trusted head/);
	assert.equal(get(store).live, null);
	assert.equal(
		(await storage.head(new AbortController().signal))?.hash,
		"0".repeat(64),
	);
});

test("a valid signature from an unenrolled device is rejected during synchronization", async (t) => {
	const f = await fixture(t);
	const outsider = await device();
	const target = await device();
	f.transport.records.push(
		await createRecord(
			{
				library: f.initial.library,
				sequence: 1,
				previous: f.initial.head,
				epoch: 1,
				signer: outsider.publicKey,
				kind: "enroll",
				effects: [target.publicKey],
			},
			outsider.privateCryptoKey,
		),
	);
	await assert.rejects(f.store.sync(), /unauthorized/);
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		0,
	);
});

test("ordinary device stores reject attempts to publish epoch resets", async (t) => {
	const f = await fixture(t);
	const replacement = await device();
	const initial = await f.store.sync();
	await assert.rejects(
		f.store.append({
			expected: stateCheckpoint(initial),
			kind: "rotate",
			effects: [2, replacement.publicKey, bytes(12)],
		}),
		/unauthorized/,
	);
	assert.equal(f.transport.writes, 0);
});

test("a live tab retains its observed head when another tab explicitly forgets shared history", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	await f.store.sync();
	await f.storage.clear(new AbortController().signal);
	f.transport.records.length = 0;
	await assert.rejects(f.store.sync(), /stale/);
	assert.equal(get(f.store).live?.sequence, 1);
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		1,
	);
});

test("historical replay reaches the live trusted head without changing live state or writing history", async (t) => {
	const f = await fixture(t);
	const first = await f.addFile(10);
	const second = await f.addFile(11);
	await f.store.sync();
	const reads = f.transport.reads;
	assert.deepEqual(await f.store.at(1, new AbortController().signal), first);
	assert.equal(
		(await f.store.at(0, new AbortController().signal)).files.size,
		0,
	);
	assert.deepEqual(get(f.store).live, second);
	assert.equal(f.transport.reads, reads);
	await assert.rejects(
		f.store.at(3, new AbortController().signal),
		/verified chain/,
	);
	await f.storage.discardRecords(new AbortController().signal);
	await assert.rejects(
		f.store.at(1, new AbortController().signal),
		/incomplete/,
	);
	assert.equal(get(f.store).live?.sequence, 2);
});
