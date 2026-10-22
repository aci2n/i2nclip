import type test from "node:test";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	type VerifiedBlock,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import {
	createLibraryIdentity,
	type LibraryIdentity,
} from "../src/lib/services/library-identity.ts";
import { createChainStorage } from "../src/lib/storage/chain.ts";
import { type ChainTransport, createChain } from "../src/lib/stores/chain.ts";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange });
/** An in-memory server chain that accepts only the next block. */
export class MemoryTransport implements ChainTransport {
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
export const signal = () => new AbortController().signal;
export const filled = (n: number) => new Uint8Array(32).fill(n);
/** A real chain store over a fresh identity, cache database and memory server. */
export async function memoryChain(t: test.TestContext) {
	const created = await createLibraryIdentity("https://example.test", signal());
	t.after(created.identity.dispose);
	const storage = createChainStorage(
		created.identity.origin,
		bytesToHex(created.identity.library),
		new IDBFactory(),
	);
	const transport = new MemoryTransport(created.identity);
	const chain = createChain(
		{
			genesis: created.identity.genesis,
			signing: created.identity.signing,
			encryption: created.identity.encryption,
			minimum: created.checkpoint,
		},
		storage,
		transport,
		signal(),
	);
	t.after(chain.dispose);
	return { created, storage, transport, chain };
}
export function publication(id: Bytes, metadata = filled(5)) {
	return {
		effects: [["publish", id, filled(7)]] as const,
		operation: {
			kind: "AddFile" as const,
			id,
			manifest: { hash: filled(3), key: filled(4) },
			metadata: { hash: metadata, key: filled(6) },
		},
	};
}
