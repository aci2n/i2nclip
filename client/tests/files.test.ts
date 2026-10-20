import assert from "node:assert/strict";
import test from "node:test";
import { writable } from "svelte/store";
import { createFiles, type FileApi } from "../src/lib/files.ts";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	compareBytes,
	createRecord,
	inventoryDigest,
	sha256,
} from "../src/lib/protocol/chain.ts";
import {
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { CHUNK_BYTES } from "../src/lib/protocol/content.ts";
import { createDevice } from "../src/lib/protocol/device.ts";
import {
	type ChainMutation,
	type ChainStore,
	type ChainView,
	stateCheckpoint,
} from "../src/lib/stores/chain.ts";

async function fixture(t: test.TestContext) {
	const device = await createDevice("https://example.test");
	let state = await initialChainState(device.key.publicKey);
	const view = writable<ChainView>({
		live: state,
		syncing: false,
		mutating: false,
		error: "",
		storageError: "",
	});
	const blobs = new Map<string, Uint8Array<ArrayBuffer>>();
	const mutations: ChainMutation[] = [];
	const inventory = new Map<
		string,
		Map<string, readonly [Uint8Array<ArrayBuffer>, number]>
	>();
	let failCommit = false;
	const chain: ChainStore = {
		subscribe: view.subscribe,
		async sync() {
			return state;
		},
		async append(mutation) {
			mutation.signal?.throwIfAborted();
			if (failCommit) {
				throw new Error("Temporary failure");
			}
			assert.deepEqual(mutation.expected, stateCheckpoint(state));
			for (const effect of mutation.effects) {
				if (!Array.isArray(effect)) {
					continue;
				}
				if (effect[0] === "publish") {
					const entries = inventory.get(bytesToHex(effect[1])) ?? new Map();
					assert.deepEqual(
						effect[2],
						await inventoryDigest(state.library, effect[1], [
							...entries.values(),
						]),
					);
				}
				if (effect[0] === "commit") {
					assert.deepEqual([...effect[2]].sort(compareBytes), effect[2]);
				}
			}
			const record = await createRecord(
				{
					library: state.library,
					sequence: state.sequence + 1,
					previous: state.head,
					epoch: 1,
					signer: device.key.publicKey,
					kind: mutation.kind,
					effects: mutation.effects,
				},
				device.key.privateCryptoKey,
				mutation.kind === "data"
					? {
							secret: device.identity.epochs[0]?.[1] ?? new Uint8Array(32),
							plaintext: mutation.plaintext ?? new Uint8Array(),
						}
					: undefined,
			);
			state = reduceBlock(state, record, mutation.plaintext);
			mutations.push(mutation);
			view.set({
				live: state,
				syncing: false,
				mutating: false,
				error: "",
				storageError: "",
			});
			return state;
		},
		dispose() {},
	};
	const quota = {
		maximumBytes: 512 * 1024 * 1024,
		maximumFiles: 10,
		usedBytes: 0,
		retainedFiles: 0,
		logBytes: 0,
	};
	const api: FileApi = {
		async quota() {
			return { ...quota };
		},
		async putBlob(file, blob) {
			const hash = await sha256(blob);
			const fileId = bytesToHex(file);
			const hashId = bytesToHex(hash);
			blobs.set(`${fileId}/${hashId}`, blob.slice());
			let entries = inventory.get(fileId);
			if (!entries) {
				entries = new Map();
				inventory.set(fileId, entries);
			}
			entries.set(hashId, [hash, blob.length]);
			return hash;
		},
		async blob(file, hash) {
			const value = blobs.get(`${file}/${hash}`);
			assert.ok(value);
			return value.slice();
		},
	};
	const controller = new AbortController();
	const files = createFiles(state.library, chain, api, controller.signal);
	t.after(files.dispose);
	return {
		files,
		blobs,
		mutations,
		quota,
		controller,
		api,
		current: () => state,
		fail: (value: boolean) => {
			failCommit = value;
		},
	};
}

test("sequential upload publishes the exact ciphertext inventory and rebuilds hash-based ranges", async (t) => {
	const f = await fixture(t);
	const bytes = new Uint8Array(CHUNK_BYTES + 3).fill(7);
	bytes.set([1, 2, 3], CHUNK_BYTES);
	const progress: number[] = [];
	const result = await f.files.upload({
		file: new Blob([bytes]),
		attributes: { name: "photo.bin", tags: ["Home"], custom: "kept" },
		thumbnail: new Uint8Array([1, 2, 3]),
		expected: stateCheckpoint(f.current()),
		signal: f.controller.signal,
		onProgress: (value) => progress.push(value),
	});
	assert.equal(f.mutations.length, 1);
	const file = f.current().files.get(result.id);
	assert.ok(file);
	const metadata = await f.files.metadata(file, f.controller.signal);
	assert.equal(metadata.attributes.custom, "kept");
	assert.deepEqual(
		await f.files.thumbnail(file, metadata, f.controller.signal),
		new Uint8Array([1, 2, 3]),
	);
	const manifest = await f.files.manifest(file, f.controller.signal);
	assert.equal(manifest.hashes.length, 2);
	assert.deepEqual(
		await f.files.readRange(
			manifest,
			CHUNK_BYTES - 2,
			CHUNK_BYTES + 3,
			f.controller.signal,
		),
		new Uint8Array([7, 7, 1, 2, 3]),
	);
	assert.equal(progress.at(-1), 100);
	assert.ok(
		progress.every(
			(n, index) => index === 0 || n >= (progress[index - 1] ?? 0),
		),
	);
	await assert.rejects(
		f.files.readRange(manifest, 0, CHUNK_BYTES + 1, f.controller.signal),
		/range/,
	);
	const chunk = manifest.hashes[1];
	assert.ok(chunk);
	f.blobs.set(`${result.id}/${bytesToHex(chunk)}`, new Uint8Array(19));
	await assert.rejects(
		f.files.readRange(
			manifest,
			CHUNK_BYTES,
			CHUNK_BYTES + 3,
			f.controller.signal,
		),
	);
});

test("quota and manifest preflight reject a source before its bytes are read", async (t) => {
	const f = await fixture(t);
	f.quota.maximumBytes = 1;
	const file = new Blob([new Uint8Array(16)]);
	let reads = 0;
	t.mock.method(file, "slice", () => {
		reads++;
		throw new Error("must not read");
	});
	await assert.rejects(
		f.files.upload({
			file,
			attributes: {},
			expected: stateCheckpoint(f.current()),
			signal: f.controller.signal,
		}),
		/quota/,
	);
	assert.equal(reads, 0);
	assert.equal(f.blobs.size, 0);
	assert.equal(f.mutations.length, 0);
	const enormous = new Blob();
	Object.defineProperty(enormous, "size", { value: 10 ** 15 });
	await assert.rejects(
		f.files.upload({
			file: enormous,
			attributes: {},
			expected: stateCheckpoint(f.current()),
			signal: f.controller.signal,
		}),
		/manifest larger/,
	);
});

test("metadata edits preserve unknown fields and retry the same staged references after failure", async (t) => {
	const f = await fixture(t);
	const uploaded = await f.files.upload({
		file: new Blob(["text"]),
		attributes: { name: "original", custom: { a: 1 } },
		thumbnail: new Uint8Array([1]),
		expected: stateCheckpoint(f.current()),
		signal: f.controller.signal,
	});
	const file = f.current().files.get(uploaded.id);
	assert.ok(file);
	const before = await f.files.metadata(file, f.controller.signal);
	const prepared = await f.files.prepareEdit(
		file,
		{ name: "renamed" },
		undefined,
		stateCheckpoint(f.current()),
		f.controller.signal,
	);
	const staged = f.blobs.size;
	f.fail(true);
	await assert.rejects(
		f.files.commit(prepared, f.controller.signal),
		/Temporary failure/,
	);
	f.fail(false);
	await f.files.commit(prepared, f.controller.signal);
	assert.equal(f.blobs.size, staged);
	const current = f.current().files.get(uploaded.id);
	assert.ok(current);
	const after = await f.files.metadata(current, f.controller.signal);
	assert.equal(after.attributes.name, "renamed");
	assert.deepEqual(after.attributes.custom, { a: 1 });
	assert.deepEqual(after.thumbnail, before.thumbnail);
	const count = f.blobs.size;
	await assert.rejects(
		f.files.prepareEdit(
			file,
			{ name: "stale" },
			null,
			stateCheckpoint(f.current()),
			f.controller.signal,
		),
		/changed/,
	);
	assert.equal(f.blobs.size, count);
});

test("disposal cancels owned file operations without publishing an upload", async (t) => {
	const f = await fixture(t);
	const put = f.api.putBlob;
	t.mock.method(f.api, "putBlob", async (...args: Parameters<typeof put>) => {
		f.files.dispose();
		return put(...args);
	});
	await assert.rejects(
		f.files.upload({
			file: new Blob(["text"]),
			attributes: {},
			expected: stateCheckpoint(f.current()),
			signal: f.controller.signal,
		}),
		/abort/i,
	);
	assert.equal(f.mutations.length, 0);
});
