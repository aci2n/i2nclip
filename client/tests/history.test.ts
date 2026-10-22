import assert from "node:assert/strict";
import test from "node:test";
import { get, type Readable } from "svelte/store";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import type {
	MaterializedFile,
	ObjectReference,
} from "../src/lib/protocol/chain-state.ts";
import type { ChainStore } from "../src/lib/stores/chain.ts";
import { createHistory, type HistoryState } from "../src/lib/stores/history.ts";
import { deferred } from "./helpers.ts";
import { filled, memoryChain, publication } from "./memory-chain.ts";

function until<T>(store: Readable<T>, predicate: (value: T) => boolean) {
	return new Promise<T>((resolve) => {
		let done = false;
		let unsubscribe = () => {};
		unsubscribe = store.subscribe((value) => {
			if (!done && predicate(value)) {
				done = true;
				queueMicrotask(() => unsubscribe());
				resolve(value);
			}
		});
	});
}
const actions = (state: HistoryState) =>
	state.items.map((item) => `${item.sequence} ${item.action} ${item.name}`);

/** Metadata documents by the first byte of their hash; reverts seal a new hash. */
function fakeFiles(chain: ChainStore, names: Map<number, string>) {
	let next = 100;
	const reverts: ObjectReference[] = [];
	let gate: Promise<void> = Promise.resolve();
	return {
		reverts,
		hold(wait: Promise<void>) {
			gate = wait;
		},
		files: {
			async metadata(file: MaterializedFile) {
				return {
					attributes: { name: names.get(file.metadata.hash[0]) },
					thumbnail: null,
				};
			},
			async revertMetadata(
				file: MaterializedFile,
				previous: ObjectReference,
				signal: AbortSignal,
			) {
				reverts.push(previous);
				await gate;
				const hash = filled(next++);
				names.set(hash[0], names.get(previous.hash[0]) ?? "");
				return chain.append({
					check: (state) => {
						const current = state.files.get(bytesToHex(file.id));
						assert.deepEqual(current?.metadata.hash, file.metadata.hash);
					},
					effects: [["commit", file.id, [hash]]],
					operation: {
						kind: "ReplaceMetadata",
						id: file.id,
						metadata: { hash, key: filled(6) },
					},
					signal,
				});
			},
		},
	};
}
async function fixture(t: test.TestContext) {
	const f = await memoryChain(t);
	await f.chain.sync();
	const names = new Map([
		[5, "photo.jpg"],
		[8, "beach.jpg"],
	]);
	const fake = fakeFiles(f.chain, names);
	const controller = new AbortController();
	let changed = 0;
	const history = createHistory(f.chain, fake.files, controller.signal, {
		changed: () => changed++,
	});
	t.after(() => controller.abort());
	return { ...f, ...fake, history, changed: () => changed };
}
async function edit(chain: ChainStore, id: Uint8Array<ArrayBuffer>) {
	await chain.append({
		effects: [["commit", id, [filled(8)]]],
		operation: {
			kind: "ReplaceMetadata",
			id,
			metadata: { hash: filled(8), key: filled(6) },
		},
	});
}

test("history lists blocks newest first with current names and applicable undo", async (t) => {
	const f = await fixture(t);
	const id = filled(9);
	await f.chain.append(publication(id));
	await edit(f.chain, id);
	await f.history.open();
	const loaded = await until(f.history, (state) =>
		state.items.every((item) => item.name === "beach.jpg"),
	);
	assert.deepEqual(actions(loaded), [
		"2 ReplaceMetadata beach.jpg",
		"1 AddFile beach.jpg",
	]);
	assert.deepEqual(
		loaded.items.map((item) => item.undoable),
		[true, true],
	);
	assert.ok(loaded.items.every((item) => item.time > 0));
	assert.equal(loaded.more, false);
});

test("undo appends each inverse and the open timeline follows the new head", async (t) => {
	const f = await fixture(t);
	const id = filled(9);
	await f.chain.append(publication(id));
	await edit(f.chain, id);
	await f.history.open();
	await until(f.history, (state) => state.items.length === 2);

	assert.equal(await f.history.undo(2), true);
	assert.deepEqual(f.reverts[0]?.hash, filled(5));
	let state = await until(f.history, (value) => value.items.length === 3);
	assert.equal(state.items[0]?.action, "ReplaceMetadata");
	state = await until(
		f.history,
		(value) => value.items[0]?.name === "photo.jpg",
	);
	// The reverted edit no longer reflects the file; the revert itself does.
	assert.deepEqual(
		state.items.map((item) => item.undoable),
		[true, false, true],
	);

	assert.equal(await f.history.undo(1), true);
	state = await until(f.history, (value) => value.items.length === 4);
	assert.equal(state.items[0]?.action, "DeleteFile");
	assert.equal(get(f.chain).live?.files.get(bytesToHex(id))?.deleted, true);

	assert.equal(await f.history.undo(4), true);
	state = await until(f.history, (value) => value.items.length === 5);
	assert.equal(state.items[0]?.action, "RestoreFile");
	assert.equal(get(f.chain).live?.files.get(bytesToHex(id))?.deleted, false);
	assert.equal(f.changed(), 3);
});

test("overlapping or inapplicable undo appends nothing", async (t) => {
	const f = await fixture(t);
	const id = filled(9);
	await f.chain.append(publication(id));
	await edit(f.chain, id);
	await f.history.open();
	await until(f.history, (state) => state.items.length === 2);
	const gate = deferred();
	f.hold(gate.promise);
	const first = f.history.undo(2);
	await until(f.history, (state) => state.undoing === 2);
	assert.equal(await f.history.undo(1), false);
	assert.ok(get(f.history).items.every((item) => !item.undoable));
	gate.resolve();
	assert.equal(await first, true);
	await until(f.history, (state) => state.items.length === 3);

	// The superseded edit can no longer be undone and leaves the chain unchanged.
	const records = f.transport.records.length;
	assert.equal(await f.history.undo(2), false);
	assert.equal(f.transport.records.length, records);
	assert.match(
		get(f.history).items.find((item) => item.sequence === 2)?.error ?? "",
		/no longer be undone/,
	);
});

test("closing stops following the head and disposal clears the timeline", async (t) => {
	const f = await fixture(t);
	const id = filled(9);
	await f.chain.append(publication(id));
	await f.history.open();
	await until(f.history, (state) => state.items.length === 1);
	f.history.close();
	await edit(f.chain, id);
	assert.equal(get(f.history).items.length, 1);
	await f.history.open();
	await until(f.history, (state) => state.items.length === 2);
	f.history.dispose();
	assert.deepEqual(get(f.history).items, []);
	assert.throws(() => f.history.open(), /abort/i);
});
