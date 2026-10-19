import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hexToBytes, utf8 } from "../src/lib/protocol/bytes.ts";
import {
	CHUNK_BYTES,
	contentShape,
	createContent,
	decryptChunk,
	encryptChunk,
	openDescriptor,
	sealDescriptor,
} from "../src/lib/protocol/content.ts";
import { bodyHash, loadKey } from "../src/lib/protocol/crypto.ts";
import { decode } from "../src/lib/protocol/msgpack.ts";
import { withNonce } from "./random.ts";

import vectors from "./test-vectors.json" with { type: "json" };

test("independent chunks and immutable descriptors match Rust vectors", async (t) => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const v = vectors.chunk_v2;
	for (const size of [v.size, 0]) {
		const id = size ? v.id : v.empty_id;
		const { descriptor, content } = await withNonce(
			t,
			hexToBytes(v.nonce_hex),
			() =>
				sealDescriptor(
					key,
					id,
					size,
					hexToBytes(size ? v.key_hex : v.empty_key_hex),
				),
		);
		assert.equal(
			bytesToHex(descriptor),
			size ? v.descriptor_hex : v.empty_descriptor_hex,
		);
		const opened = await openDescriptor(key, id, descriptor);
		assert.equal(opened.key.extractable, false);
		const index = size ? 1 : 0;
		const plain = size ? utf8("abc") : new Uint8Array();
		const sealed = await encryptChunk(content, index, plain);
		assert.equal(bytesToHex(sealed), size ? v.final_hex : v.empty_hex);
		assert.deepEqual(await decryptChunk(opened, index, sealed), plain);
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
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const { content, descriptor } = await createContent(key, CHUNK_BYTES * 2);
	const sealed = await encryptChunk(content, 0, new Uint8Array(CHUNK_BYTES));
	for (const altered of [
		{ ...content, id: "00".repeat(32) },
		{ ...content, size: content.size + 1 },
		{ ...content, chunks: 3 },
		(await createContent(key, content.size)).content,
	]) {
		await assert.rejects(decryptChunk(altered, 0, sealed));
	}
	await assert.rejects(decryptChunk(content, 1, sealed));
	const corrupt = sealed.slice();
	corrupt[0] ^= 1;
	await assert.rejects(decryptChunk(content, 0, corrupt));
	await assert.rejects(decryptChunk(content, 0, sealed.slice(1)));
	await assert.rejects(openDescriptor(key, "00".repeat(32), descriptor));
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
