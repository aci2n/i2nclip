import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex } from "../src/lib/protocol/bytes.ts";
import { createRecord } from "../src/lib/protocol/chain.ts";
import { stateCheckpoint } from "../src/lib/stores/chain.ts";
import { filled, memoryChain, publication, signal } from "./memory-chain.ts";

test("fixed-authority replay verifies cache publication and historical views", async (t) => {
	const f = await memoryChain(t);
	const initial = await f.chain.sync();
	assert.equal(initial.sequence, 0);
	const id = filled(9);
	await f.chain.append(publication(id));
	const second = await f.chain.append({
		effects: [],
		operation: { kind: "DeleteFile", id },
	});
	assert(second.files.get(bytesToHex(id))?.deleted);
	const historical = await f.chain.at(1, signal());
	assert.equal(historical.files.get(bytesToHex(id))?.deleted, false);
	assert.deepEqual(await f.storage.head(signal()), stateCheckpoint(second));
	assert.equal(f.transport.records.length, 2);
	await assert.rejects(
		f.chain.append({
			effects: [],
			operation: { kind: "DeleteFile", id },
		}),
		/file lifecycle transition/,
	);
	assert.equal(f.transport.records.length, 2);
});

test("a signed malformed operation never advances the trusted cached head", async (t) => {
	const f = await memoryChain(t);
	await f.chain.sync();
	const first = await f.chain.append(publication(filled(9)));
	const malformed = await createRecord(
		{ library: first.library, sequence: 2, previous: first.head, effects: [] },
		f.created.identity.signing,
		f.created.identity.encryption,
		new Uint8Array([0x91, 0x01]),
	);
	f.transport.records.push(malformed);
	await assert.rejects(f.chain.sync(), /Invalid chain operation/);
	assert.deepEqual(await f.storage.head(signal()), stateCheckpoint(first));
});

test("a server withholding a previously observed suffix is rejected", async (t) => {
	const f = await memoryChain(t);
	await f.chain.sync();
	await f.chain.append(publication(filled(9)));
	f.transport.records.length = 0;
	await assert.rejects(f.chain.sync());
	assert.equal((await f.storage.head(signal()))?.sequence, 1);
});

test("history lists each verified block with its time and superseded metadata", async (t) => {
	const f = await memoryChain(t);
	await f.chain.sync();
	const id = filled(9);
	const before = Date.now();
	await f.chain.append(publication(id));
	await f.chain.append({
		effects: [["commit", id, [filled(8)]]],
		operation: {
			kind: "ReplaceMetadata",
			id,
			metadata: { hash: filled(8), key: filled(6) },
		},
	});
	await f.chain.append({ effects: [], operation: { kind: "DeleteFile", id } });
	const entries = await f.chain.history(signal());
	assert.deepEqual(
		entries.map((entry) => [entry.sequence, entry.operation.kind]),
		[
			[1, "AddFile"],
			[2, "ReplaceMetadata"],
			[3, "DeleteFile"],
		],
	);
	for (const entry of entries) {
		assert.ok(entry.time >= before && entry.time <= Date.now());
	}
	assert.equal(entries[0].previous, null);
	assert.deepEqual(entries[1].previous?.hash, filled(5));
	f.transport.records.length = 0;
	await f.storage.discardRecords(signal());
	await assert.rejects(f.chain.history(signal()), /incomplete/);
});
