import assert from "node:assert/strict";
import test from "node:test";
import { hexToBytes } from "../src/lib/protocol/bytes.ts";
import {
	createRecord,
	decryptOperation,
	verifyRecord,
} from "../src/lib/protocol/chain.ts";
import {
	encodeBlockPayload,
	initialChainState,
	reduceBlock,
} from "../src/lib/protocol/chain-state.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";
import { createLibraryIdentity } from "../src/lib/services/library-identity.ts";
import vector from "./shared-seed-vectors.json" with { type: "json" };

const signal = () => new AbortController().signal;
const filled = (n: number) => new Uint8Array(32).fill(n);

test("shared seed chain opens the independent Rust/Node vector and rejects altered authority", async () => {
	const record = await verifyRecord(
		hexToBytes(vector.record),
		hexToBytes(vector.publicKey),
	);
	assert.deepEqual(record.hash, hexToBytes(vector.hash));
	const root = await crypto.subtle.importKey(
		"raw",
		hexToBytes(vector.encryptionRoot),
		"HKDF",
		false,
		["deriveKey"],
	);
	assert.deepEqual(
		await decryptOperation(record, root),
		hexToBytes(vector.plaintext),
	);
	const wrong = await createLibraryIdentity("https://example.test", signal());
	try {
		await assert.rejects(
			verifyRecord(record.bytes, wrong.identity.signing.publicKey),
			/signature/,
		);
	} finally {
		wrong.identity.dispose();
	}
	const damaged = record.bytes.slice();
	damaged[damaged.length - 1] ^= 1;
	await assert.rejects(verifyRecord(damaged, hexToBytes(vector.publicKey)));
	const extra = new Uint8Array(record.bytes.length + 1);
	extra.set(record.bytes);
	await assert.rejects(verifyRecord(extra, hexToBytes(vector.publicKey)));
});

test("sequence zero accepts ordinary encrypted publication and pure file lifecycle replay", async (t) => {
	const { identity } = await createLibraryIdentity(
		"https://example.test",
		signal(),
	);
	t.after(identity.dispose);
	let state = await initialChainState(identity.genesis);
	const id = filled(3);
	const ref = { hash: filled(4), key: filled(5) };
	const operation = {
		kind: "AddFile" as const,
		id,
		manifest: ref,
		metadata: ref,
	};
	const record = await createRecord(
		{
			library: state.library,
			sequence: 1,
			previous: state.head,
			effects: [["publish", id, filled(6)]],
		},
		identity.signing,
		identity.encryption,
		encodeBlockPayload({ time: 1, operation }),
	);
	state = reduceBlock(
		state,
		record,
		await decryptOperation(record, identity.encryption),
	);
	assert.equal(state.sequence, 1);
	assert.equal(state.files.size, 1);
	const removed = await createRecord(
		{ library: state.library, sequence: 2, previous: state.head, effects: [] },
		identity.signing,
		identity.encryption,
		encodeBlockPayload({ time: 1, operation: { kind: "DeleteFile", id } }),
	);
	const next = reduceBlock(
		state,
		removed,
		await decryptOperation(removed, identity.encryption),
	);
	assert(next.files.values().next().value?.deleted);
	assert.equal(state.files.values().next().value?.deleted, false);
	assert.throws(
		() => reduceBlock(next, record, encodeBlockPayload({ time: 1, operation })),
		/parent/,
	);
	const malformed = await createRecord(
		{ library: next.library, sequence: 3, previous: next.head, effects: [] },
		identity.signing,
		identity.encryption,
		encode([1, ["InvalidOperation"]]),
	);
	assert.throws(
		() => reduceBlock(next, malformed, encode([1, ["InvalidOperation"]])),
		/unknown operation/,
	);
	assert.equal(next.sequence, 2);
});
