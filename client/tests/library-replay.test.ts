import assert from "node:assert/strict";
import test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { createChainStorage } from "../src/lib/chain-storage.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/library-chain.ts";
import { encodeOperation } from "../src/lib/protocol/library-state.ts";
import {
	createLibraryIdentity,
	type LibraryIdentity,
} from "../src/lib/services/library-identity.ts";
import {
	type ChainTransport,
	createChain,
	stateCheckpoint,
} from "../src/lib/stores/library-chain.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
class History implements ChainTransport {
	readonly records: VerifiedBlock[] = [];
	private readonly identity: LibraryIdentity;
	constructor(identity: LibraryIdentity) {
		this.identity = identity;
	}
	private head() {
		const last = this.records.at(-1);
		return last
			? { sequence: last.body.sequence, hash: bytesToHex(last.hash) }
			: { sequence: 0, hash: bytesToHex(this.identity.library) };
	}
	async read(after: string) {
		const index =
			after === bytesToHex(this.identity.library)
				? -1
				: this.records.findIndex((r) => bytesToHex(r.hash) === after);
		return {
			target: this.head(),
			records: this.records.slice(index + 1).map((r) => r.bytes),
			next: null,
		};
	}
	async append(bytes: Bytes) {
		const record = await verifyRecord(bytes, this.identity.signing.publicKey);
		const parent = this.head();
		if (
			bytesToHex(record.body.previous) !== parent.hash ||
			record.body.sequence !== parent.sequence + 1
		) {
			throw new Error("Conflict");
		}
		this.records.push(record);
		return { accepted: this.head(), head: this.head() };
	}
}
const signal = () => new AbortController().signal;
const filled = (n: number) => new Uint8Array(32).fill(n);
async function fixture(t: test.TestContext) {
	const created = await createLibraryIdentity("https://example.test", signal());
	t.after(created.identity.dispose);
	const storage = createChainStorage(
		created.identity.origin,
		bytesToHex(created.identity.library),
		new IDBFactory(),
	);
	const history = new History(created.identity);
	const chain = createChain(
		{
			genesis: created.identity.genesis,
			signing: created.identity.signing,
			encryption: created.identity.encryption,
			minimum: created.checkpoint,
		},
		storage,
		history,
		signal(),
	);
	t.after(chain.dispose);
	return { created, storage, history, chain };
}
function publication(id: Bytes) {
	return {
		effects: [["publish", id, filled(7)]] as const,
		plaintext: encodeOperation({
			kind: "AddFile",
			id,
			manifest: { hash: filled(3), key: filled(4) },
			metadata: { hash: filled(5), key: filled(6) },
		}),
	};
}

test("fixed-authority replay verifies cache publication and historical views", async (t) => {
	const f = await fixture(t);
	const initial = await f.chain.sync();
	assert.equal(initial.sequence, 0);
	const id = filled(9);
	const first = await f.chain.append({
		expected: stateCheckpoint(initial),
		...publication(id),
	});
	const second = await f.chain.append({
		expected: stateCheckpoint(first),
		effects: [],
		plaintext: encodeOperation({ kind: "DeleteFile", id }),
	});
	assert(second.files.get(bytesToHex(id))?.deleted);
	const historical = await f.chain.at(1, signal());
	assert.equal(historical.files.get(bytesToHex(id))?.deleted, false);
	assert.deepEqual(await f.storage.head(signal()), stateCheckpoint(second));
	assert.equal(f.history.records.length, 2);
	await assert.rejects(
		f.chain.append({
			expected: stateCheckpoint(first),
			effects: [],
			plaintext: encodeOperation({ kind: "DeleteFile", id }),
		}),
		/changed/,
	);
	assert.equal(f.history.records.length, 2);
});

test("a signed malformed operation never advances the trusted cached head", async (t) => {
	const f = await fixture(t);
	const initial = await f.chain.sync();
	const first = await f.chain.append({
		expected: stateCheckpoint(initial),
		...publication(filled(9)),
	});
	const malformed = await createRecord(
		{ library: first.library, sequence: 2, previous: first.head, effects: [] },
		f.created.identity.signing,
		f.created.identity.encryption,
		new Uint8Array([0x91, 0x01]),
	);
	f.history.records.push(malformed);
	await assert.rejects(f.chain.sync(), /Invalid chain operation/);
	assert.deepEqual(await f.storage.head(signal()), stateCheckpoint(first));
});

test("a server withholding a previously observed suffix is rejected", async (t) => {
	const f = await fixture(t);
	const initial = await f.chain.sync();
	await f.chain.append({
		expected: stateCheckpoint(initial),
		...publication(filled(9)),
	});
	f.history.records.length = 0;
	await assert.rejects(f.chain.sync());
	assert.equal((await f.storage.head(signal()))?.sequence, 1);
});
