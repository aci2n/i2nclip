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
	decodeBlockPayload,
	encodeBlockPayload,
	type FileOperation,
	type HistoryEntry,
	initialChainState,
	inverseOperation,
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
		const plaintext = encodeBlockPayload({ time: 1, operation });
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
	const purged = await f.data(deletedAgain.state, { kind: "PurgeFile", id }, [
		["purge", id],
	]);
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
		f.data(added.state, { kind: "PurgeFile", id }, [["purge", id]]),
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
		f.data(added.state, { kind: "DeleteFile", id }, [["purge", id]]),
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
		f.data(deleted.state, { kind: "PurgeFile", id }, [["purge", filled(2)]]),
		/purge effect mismatch/,
	);
	await assert.rejects(
		f.data(deleted.state, { kind: "PurgeFile", id: filled(2) }, [
			["purge", filled(2)],
		]),
		/lifecycle/,
	);
	assert.equal(deleted.state.files.get(bytesToHex(id))?.purged, false);
	assert.equal(deleted.state.sequence, f.initial.sequence + 2);
});

test("private operations require compact canonical arrays with one purged file", () => {
	for (const operation of [
		{ kind: "DeleteFile", id: filled(1) },
		["DeleteFile", filled(1), "extra"],
		["PurgeFiles", [filled(1)]],
		["PurgeFile", [filled(1)]],
		["PurgeFile", filled(1), filled(2)],
		["unknown", filled(1)],
	]) {
		assert.throws(() => decodeBlockPayload(encode([1, operation])));
	}
});

test("block payloads carry a canonical non-negative millisecond time", () => {
	const operation = { kind: "DeleteFile" as const, id: filled(1) };
	const time = Date.UTC(2026, 9, 22, 12);
	assert.deepEqual(
		decodeBlockPayload(encodeBlockPayload({ time, operation })),
		{ time, operation },
	);
	for (const value of [
		[-1, ["DeleteFile", filled(1)]],
		[1.5, ["DeleteFile", filled(1)]],
		["1", ["DeleteFile", filled(1)]],
		[Number.MAX_SAFE_INTEGER + 1, ["DeleteFile", filled(1)]],
		[1, ["DeleteFile", filled(1)], "extra"],
		["DeleteFile", filled(1)],
	]) {
		assert.throws(() => decodeBlockPayload(encode(value)), /Invalid chain/);
	}
});

test("undo reverses a block only while the current state still reflects it", async () => {
	const f = await fixture();
	const id = filled(1);
	const added = await f.data(
		f.initial,
		{ kind: "AddFile", id, manifest: reference(2), metadata: reference(4) },
		[["publish", id, filled(6)]],
	);
	const edited = await f.data(
		added.state,
		{ kind: "ReplaceMetadata", id, metadata: reference(7) },
		[["commit", id, [filled(7)]]],
	);
	const deleted = await f.data(edited.state, { kind: "DeleteFile", id });
	const restored = await f.data(deleted.state, { kind: "RestoreFile", id });
	const entry = (
		sequence: number,
		operation: FileOperation,
		previous: HistoryEntry["previous"] = null,
	): HistoryEntry => ({ sequence, time: 1, operation, previous });
	const add = entry(1, {
		kind: "AddFile",
		id,
		manifest: reference(2),
		metadata: reference(4),
	});
	const edit = entry(
		2,
		{ kind: "ReplaceMetadata", id, metadata: reference(7) },
		reference(4),
	);
	const remove = entry(3, { kind: "DeleteFile", id });
	const restore = entry(4, { kind: "RestoreFile", id });
	const purge = entry(5, { kind: "PurgeFile", id });

	assert.deepEqual(inverseOperation(add, edited.state), {
		kind: "DeleteFile",
		id,
	});
	assert.deepEqual(inverseOperation(edit, edited.state), {
		kind: "ReplaceMetadata",
		id,
		metadata: reference(4),
	});
	assert.deepEqual(inverseOperation(remove, deleted.state), {
		kind: "RestoreFile",
		id,
	});
	assert.deepEqual(inverseOperation(restore, restored.state), {
		kind: "DeleteFile",
		id,
	});
	// Already reversed or superseded changes no longer apply.
	assert.equal(inverseOperation(add, deleted.state), null);
	assert.equal(inverseOperation(edit, added.state), null);
	assert.equal(inverseOperation(edit, deleted.state), null);
	assert.equal(inverseOperation(remove, restored.state), null);
	assert.equal(inverseOperation(restore, deleted.state), null);

	const deletedAgain = await f.data(restored.state, { kind: "DeleteFile", id });
	const purged = await f.data(deletedAgain.state, { kind: "PurgeFile", id }, [
		["purge", id],
	]);
	for (const item of [add, edit, remove, restore, purge]) {
		assert.equal(inverseOperation(item, purged.state), null);
	}
});
