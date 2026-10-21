import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import {
	type Bytes,
	createRecord,
	decryptOperation,
	type StorageEffect,
} from "../src/lib/protocol/chain.ts";
import {
	type ChainState,
	decodeOperation,
	encodeOperation,
	type FileOperation,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createIdentity } from "./library-fixture.ts";

const filled = (value: number): Bytes => new Uint8Array(32).fill(value);
const reference = (value: number) => ({
	hash: filled(value),
	key: filled(value + 1),
});
async function fixture() {
	const identity = await createIdentity("https://example.test");
	const initial = await initialChainState(identity.genesis);
	async function data(
		state: ChainState,
		operation: FileOperation,
		effects: readonly StorageEffect[] = [],
	) {
		const plaintext = encodeOperation(operation);
		const block = await createRecord(
			{
				library: state.library,
				sequence: state.sequence + 1,
				previous: state.head,
				effects,
			},
			identity.signing,
			identity.encryption,
			plaintext,
		);
		return { block, plaintext, state: reduceBlock(state, block, plaintext) };
	}
	return { initial, data, identity };
}

test("file operations deterministically replay without fetching objects or mutating prior states", async () => {
	const f = await fixture();
	const id = filled(1);
	const added = await f.data(
		f.initial,
		{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
		[["publish", id, filled(6)]],
	);
	const updated = await f.data(
		added.state,
		{ kind: "ReplaceMetadata", id, metadata: reference(7) },
		[["commit", id, [filled(7)]]],
	);
	const deleted = await f.data(updated.state, { kind: "DeleteFile", id });
	const restored = await f.data(deleted.state, { kind: "RestoreFile", id });
	const deletedAgain = await f.data(restored.state, { kind: "DeleteFile", id });
	const purged = await f.data(
		deletedAgain.state,
		{ kind: "PurgeFiles", ids: [id] },
		[["purge", [id]]],
	);
	const key = bytesToHex(id);
	assert.equal(f.initial.files.size, 0);
	assert.deepEqual(added.state.files.get(key)?.metadata.hash, filled(4));
	assert.equal(updated.state.files.get(key)?.deleted, false);
	assert.equal(deleted.state.files.get(key)?.deleted, true);
	assert.equal(purged.state.files.get(key)?.purged, true);
	let replay = f.initial;
	for (const item of [
		added,
		updated,
		deleted,
		restored,
		deletedAgain,
		purged,
	]) {
		replay = reduceBlock(
			replay,
			item.block,
			await decryptOperation(item.block, f.identity.encryption),
		);
	}
	assert.deepEqual(replay, purged.state);
	await assert.rejects(
		f.data(purged.state, { kind: "RestoreFile", id }),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(
			purged.state,
			{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
			[["publish", id, filled(6)]],
		),
		/publication/,
	);
});

test("invalid storage effects and lifecycle transitions leave the accepted state unchanged", async () => {
	const f = await fixture();
	const id = filled(1);
	const added = await f.data(
		f.initial,
		{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
		[["publish", id, filled(6)]],
	);
	await assert.rejects(
		f.data(added.state, { kind: "PurgeFiles", ids: [id] }, [["purge", [id]]]),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(
			added.state,
			{ kind: "ReplaceMetadata", id, metadata: reference(8) },
			[["commit", id, [filled(9)]]],
		),
		/commitment/,
	);
	await assert.rejects(
		f.data(added.state, { kind: "DeleteFile", id }, [["purge", [id]]]),
		/storage effect/,
	);
	const deleted = await f.data(added.state, { kind: "DeleteFile", id });
	await assert.rejects(
		f.data(
			deleted.state,
			{ kind: "ReplaceMetadata", id, metadata: reference(8) },
			[["commit", id, [filled(8)]]],
		),
		/lifecycle/,
	);
	await assert.rejects(
		f.data(deleted.state, { kind: "PurgeFiles", ids: [id, filled(2)] }, [
			["purge", [id, filled(2)]],
		]),
		/lifecycle/,
	);
	assert.equal(deleted.state.files.get(bytesToHex(id))?.purged, false);
	assert.equal(deleted.state.sequence, f.initial.sequence + 2);
});

test("private operations require compact canonical arrays and sorted unique purge IDs", () => {
	for (const operation of [
		{ kind: "DeleteFile", id: filled(1) },
		["DeleteFile", filled(1), "extra"],
		["PurgeFiles", []],
		["PurgeFiles", [filled(2), filled(1)]],
		["PurgeFiles", [filled(1), filled(1)]],
		["unknown", filled(1)],
	]) {
		assert.throws(() => decodeOperation(encode(operation)));
	}
});
