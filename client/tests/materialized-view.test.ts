import assert from "node:assert/strict";
import test from "node:test";
import { get, writable } from "svelte/store";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import type {
	ChainState,
	MaterializedFile,
} from "../src/lib/protocol/chain-state.ts";
import type { FileMetadata } from "../src/lib/protocol/file-objects.ts";
import type { ChainStore, ChainView } from "../src/lib/stores/chain.ts";
import { createMaterializedView } from "../src/lib/stores/materialized-view.ts";
import { deferred } from "./helpers.ts";

const bytes = (n: number) => new Uint8Array(32).fill(n);
function file(n: number): MaterializedFile {
	return {
		id: bytes(n),
		createdSequence: n,
		manifest: { hash: bytes(n + 1), key: bytes(n + 2) },
		metadata: { hash: bytes(n + 3), key: bytes(n + 4) },
		deleted: false,
		purged: false,
	};
}
function source(files: readonly MaterializedFile[], sequence = 1): ChainState {
	return {
		library: bytes(0),
		head: bytes(sequence),
		sequence,
		epoch: 1,
		recoveryPublicKey: bytes(101),
		epochSalt: bytes(102),
		devices: new Map(),
		files: new Map(files.map((file) => [bytesToHex(file.id), file])),
	};
}
function chain(initial: ChainState) {
	const state = writable<ChainView>({
		live: initial,
		syncing: false,
		mutating: false,
		error: "",
		storageError: "",
	});
	const store: ChainStore = {
		subscribe: state.subscribe,
		async at() {
			throw new Error("Historical replay is not used by this fixture.");
		},
		sync: async () => get(state).live ?? initial,
		append: async () => {
			throw new Error("unused");
		},
		dispose() {},
	};
	return {
		store,
		publish: (live: ChainState) =>
			state.update((state) => ({ ...state, live })),
	};
}

test("selected state invalidates metadata results from an earlier generation", async (t) => {
	const first = file(1);
	const live = chain(source([first]));
	const pending = deferred<FileMetadata>();
	const view = createMaterializedView(
		live.store,
		{ metadata: () => pending.promise },
		new AbortController().signal,
	);
	t.after(view.dispose);
	const result = view.file(bytesToHex(first.id), new AbortController().signal);
	const newer = { ...first, metadata: { hash: bytes(20), key: bytes(21) } };
	live.publish(source([newer], 2));
	pending.resolve({ attributes: { name: "stale" }, thumbnail: null });
	await assert.rejects(result, /abort/i);
	assert.equal(get(view).metadata.size, 0);
	assert.equal(get(view).selected?.sequence, 2);
});

test("metadata indexing distinguishes unavailable data from an empty or complete index", async (t) => {
	const a = file(1);
	const b = file(2);
	const deleted = { ...file(3), deleted: true };
	const live = chain(source([a, b, deleted]));
	let unavailable = true;
	const reads: string[] = [];
	const view = createMaterializedView(
		live.store,
		{
			metadata: async (file) => {
				const id = bytesToHex(file.id);
				reads.push(id);
				if (id === bytesToHex(b.id) && unavailable) {
					throw new Error("Missing ciphertext");
				}
				return { attributes: { name: id }, thumbnail: null };
			},
		},
		new AbortController().signal,
	);
	t.after(view.dispose);
	await view.index();
	assert.equal(get(view).total, 2);
	assert.equal(get(view).indexed, 2);
	assert.equal(get(view).complete, false);
	assert.equal(get(view).errors.size, 1);
	assert.ok(!reads.includes(bytesToHex(deleted.id)));
	unavailable = false;
	await view.index();
	assert.equal(get(view).complete, true);
	assert.equal(get(view).metadata.size, 2);
	assert.equal(reads.filter((id) => id === bytesToHex(a.id)).length, 1);
	live.publish(source([], 2));
	await view.index();
	assert.equal(get(view).complete, true);
	assert.equal(get(view).total, 0);
	assert.equal(get(view).metadata.size, 0);
});

test("cache reuse requires both metadata hash and key and purge clears decrypted metadata", async (t) => {
	const first = file(1);
	const live = chain(source([first]));
	let reads = 0;
	const view = createMaterializedView(
		live.store,
		{
			metadata: async () => ({
				attributes: { name: `version ${++reads}` },
				thumbnail: null,
			}),
		},
		new AbortController().signal,
	);
	t.after(view.dispose);
	await view.index();
	live.publish(source([first], 2));
	await view.index();
	assert.equal(reads, 1);
	const changed = { ...first, metadata: { ...first.metadata, key: bytes(30) } };
	live.publish(source([changed], 3));
	await view.index();
	assert.equal(reads, 2);
	live.publish(source([{ ...changed, purged: true, deleted: true }], 4));
	assert.equal(get(view).metadata.size, 0);
	await assert.rejects(
		view.file(bytesToHex(first.id), new AbortController().signal),
		/purged/,
	);
});
