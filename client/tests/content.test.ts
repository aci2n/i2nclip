import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hexToBytes, utf8 } from "../src/lib/protocol/bytes.ts";
import {
	CHUNK_BYTES,
	contentShape,
	decryptChunk,
	encryptChunk,
	importContentKey,
} from "../src/lib/protocol/content.ts";
import { bodyHash } from "../src/lib/protocol/crypto.ts";

import vectors from "./test-vectors.json" with { type: "json" };

test("complete independent chunks match Rust vectors", async () => {
	const v = vectors.chunk_v2;
	for (const size of [v.size, 0]) {
		const content = {
			id: size ? v.id : v.empty_id,
			size,
			chunks: contentShape(size).chunks,
			key: await importContentKey(
				hexToBytes(size ? v.key_hex : v.empty_key_hex),
			),
		};
		const index = size ? 1 : 0;
		const plain = size ? utf8("abc") : new Uint8Array();
		const sealed = await encryptChunk(content, index, plain);
		assert.equal(bytesToHex(sealed), size ? v.final_hex : v.empty_hex);
		assert.deepEqual(await decryptChunk(content, index, sealed), plain);
		if (size) {
			assert.equal(
				await bodyHash(
					await encryptChunk(
						content,
						0,
						new Uint8Array(CHUNK_BYTES).fill(0x5a),
					),
				),
				v.full_hash,
			);
		}
	}
});

test("chunks bind file, position, dimensions and key before releasing plaintext", async () => {
	const content = {
		id: "ab".repeat(32),
		size: CHUNK_BYTES * 2,
		chunks: 2,
		key: await importContentKey(new Uint8Array(32).fill(7)),
	};
	const sealed = await encryptChunk(content, 0, new Uint8Array(CHUNK_BYTES));
	for (const altered of [
		{ ...content, id: "00".repeat(32) },
		{ ...content, size: content.size + 1 },
		{ ...content, chunks: 3 },
		{ ...content, key: await importContentKey(new Uint8Array(32).fill(9)) },
	]) {
		await assert.rejects(decryptChunk(altered, 0, sealed));
	}
	await assert.rejects(decryptChunk(content, 1, sealed));
	const corrupt = sealed.slice();
	corrupt[0] ^= 1;
	await assert.rejects(decryptChunk(content, 0, corrupt));
	await assert.rejects(decryptChunk(content, 0, sealed.slice(1)));
	await assert.rejects(encryptChunk(content, 2, new Uint8Array()));
	await assert.rejects(encryptChunk(content, 0, new Uint8Array(1)));
});

test("shape removes old ceilings but rejects invalid and overflowing sizes", () => {
	assert.equal(contentShape(1024 ** 4).chunks, 262144);
	assert.deepEqual(contentShape(0), { chunks: 1, encryptedBytes: 16 });
	for (const size of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
		assert.throws(() => contentShape(size));
	}
});
