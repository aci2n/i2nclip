import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { get } from "svelte/store";
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
import { HttpError } from "../src/lib/services/library-api.ts";
import {
	type ChainStorage,
	type Checkpoint,
	createChainStorage,
} from "../src/lib/storage/chain.ts";
import {
	type ChainPage,
	type ChainTransport,
	createChain,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";
import { createIdentity } from "./library-fixture.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
const bytes = (n: number): Bytes => new Uint8Array(32).fill(n);

class Transport implements ChainTransport {
	readonly records: VerifiedBlock[] = [];
	readonly genesis: Checkpoint;
	reads = 0;
	writes = 0;
	loseResponse = false;
	pageOverride: ((page: ChainPage) => ChainPage) | null = null;
	readonly publicKey: Bytes;
	constructor(genesis: Checkpoint, publicKey: Bytes) {
		this.publicKey = publicKey;
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
		const record = await verifyRecord(data, this.publicKey);
		const current = this.records.at(-1);
		if (
			bytesToHex(record.body.previous) !==
			(current ? bytesToHex(current.hash) : this.genesis.hash)
		) {
			throw new HttpError(409);
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
	const identity = await createIdentity("https://example.test");
	t.after(identity.dispose);
	const key = identity.signing;
	const initial = await initialChainState(identity.genesis);
	const transport = new Transport(stateCheckpoint(initial), key.publicKey);
	const factory = new IDBFactory();
	const storage = createChainStorage(
		"https://example.test",
		bytesToHex(initial.library),
		factory,
	);
	const credentials = {
		genesis: identity.genesis,
		signing: key,
		encryption: identity.encryption,
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

				effects: [["publish", id, bytes(6)]],
			},
			key,
			identity.encryption,
			plaintext,
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

function addOperation(id: Bytes) {
	return {
		effects: [["publish", id, bytes(6)]] as const,
		plaintext: encodeOperation({
			kind: "AddFile",
			id,
			manifest: { hash: bytes(2), key: bytes(3) },
			metadata: { hash: bytes(4), key: bytes(5) },
		}),
	};
}

test("mutations rebase onto concurrent writers and retry a lost parent race", async (t) => {
	const f = await fixture(t);
	await f.store.sync();
	await f.addFile(10);
	const append = f.transport.append.bind(f.transport);
	let raced = false;
	f.transport.append = async (data, signal) => {
		if (!raced) {
			raced = true;
			await f.addFile(11);
		}
		return append(data, signal);
	};
	const result = await f.store.append(addOperation(bytes(12)));
	assert.equal(result.sequence, 3);
	assert.deepEqual(
		[...result.files.keys()],
		[10, 11, 12].map((n) => bytesToHex(bytes(n))),
	);
	assert.equal(f.transport.writes, 2);
	assert.equal(get(f.store).error, "");
	assert.equal(
		(await f.storage.head(new AbortController().signal))?.sequence,
		3,
	);
});

test("mutation preconditions run against the current state and lost responses reconcile", async (t) => {
	const f = await fixture(t);
	await f.addFile(10);
	await assert.rejects(
		f.store.append({
			check: (state) => {
				assert.equal(state.sequence, 1);
				throw new Error("This file changed.");
			},
			effects: [],
			plaintext: encodeOperation({ kind: "DeleteFile", id: bytes(10) }),
		}),
		/file changed/,
	);
	assert.equal(f.transport.writes, 0);
	f.transport.loseResponse = true;
	const result = await f.store.append({
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

test("concurrent mutations queue in order and a refresh waits for them", async (t) => {
	const f = await fixture(t);
	const first = f.store.append(addOperation(bytes(10)));
	const second = f.store.append({
		effects: [],
		plaintext: encodeOperation({ kind: "DeleteFile", id: bytes(10) }),
	});
	const refreshed = f.store.sync();
	assert.equal((await first).sequence, 1);
	assert.equal((await second).sequence, 2);
	const state = await refreshed;
	assert.equal(state.sequence, 2);
	assert.equal(state.files.get(bytesToHex(bytes(10)))?.deleted, true);
	assert.equal(get(f.store).storageError, "");
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(
		f.store.append({ ...addOperation(bytes(11)), signal: aborted.signal }),
		/abort/i,
	);
	assert.equal((await f.store.append(addOperation(bytes(12)))).sequence, 3);
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
	assert.deepEqual(
		await f.store.at(first.sequence, new AbortController().signal),
		first,
	);
	assert.equal(
		(await f.store.at(0, new AbortController().signal)).files.size,
		0,
	);
	assert.deepEqual(get(f.store).live, second);
	assert.equal(f.transport.reads, reads);
	await assert.rejects(
		f.store.at(second.sequence + 1, new AbortController().signal),
		/verified chain/,
	);
	await f.storage.discardRecords(new AbortController().signal);
	await assert.rejects(
		f.store.at(1, new AbortController().signal),
		/incomplete/,
	);
	assert.equal(get(f.store).live?.sequence, 2);
});
