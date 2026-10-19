import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hexToBytes, utf8 } from "../src/lib/protocol/bytes.ts";
import {
	authorizationHeader,
	loadKey,
	openDescriptorBytes,
	openMetadata,
	requestMessage,
	sealDescriptorBytes,
	sealMetadata,
	sealTagLabel,
	tagToken,
} from "../src/lib/protocol/crypto.ts";
import { encodeMeta, encodeUpload } from "../src/lib/protocol/frame.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { withNonce } from "./random.ts";

import vectors from "./test-vectors.json" with { type: "json" };

test("library identity matches the rust vectors", async (t) => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	assert.equal(bytesToHex(key.publicKey), vectors.public_hex);
	assert.equal(key.registrationKey, vectors.public_key);
	assert.equal(await tagToken(key, vectors.tag), vectors.token);
	assert.equal(await tagToken(key, " vacation "), vectors.token);
	assert.equal(await tagToken(key, vectors.cafe_tag), vectors.cafe_token);

	const meta = await withNonce(t, hexToBytes(vectors.nonce_hex), () =>
		sealMetadata(
			key.fileKeyMaterial,
			vectors.media_id,
			hexToBytes(vectors.meta_plaintext_hex),
		),
	);
	assert.equal(bytesToHex(meta), vectors.meta_ciphertext_hex);
	assert.equal(
		bytesToHex(await openMetadata(key.fileKeyMaterial, vectors.media_id, meta)),
		vectors.meta_plaintext_hex,
	);

	assert.equal(
		bytesToHex(
			encodeUpload({
				id: vectors.media_id,
				plaintext_bytes: vectors.chunk_v2.size,
				descriptor: hexToBytes(vectors.chunk_v2.descriptor_hex),
				meta,
				tags: [],
			}),
		),
		vectors.frame_hex,
	);

	const body = utf8(vectors.sign_body_utf8);
	const request = requestMessage({
		origin: vectors.sign_origin,
		ts: vectors.sign_ts,
		nonce: vectors.sign_nonce,
		method: vectors.sign_method,
		path: vectors.sign_path,
		hash: vectors.body_hash,
	});
	assert.equal(new TextDecoder().decode(request), vectors.request_text);
	assert.equal(
		await authorizationHeader({
			key,
			origin: vectors.sign_origin,
			ts: vectors.sign_ts,
			nonce: vectors.sign_nonce,
			method: vectors.sign_method,
			path: vectors.sign_path,
			body,
		}),
		vectors.authorization,
	);
});

test("metadata document carries the complete prior ciphertext hash", () => {
	const prevMetaHash = new Uint8Array(32).fill(0x5a);
	const meta = new Uint8Array([1, 2]);
	assert.deepEqual(decode(encodeMeta({ prevMetaHash, meta, tags: [] })), {
		prev_meta_hash: prevMetaHash,
		meta,
		tags: [],
	});
	assert.throws(
		() => encodeMeta({ prevMetaHash: new Uint8Array(31), meta, tags: [] }),
		/32 bytes/,
	);
});

test("file encryption separates IDs, purposes and identities and rejects tampering", async (t) => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const other = await loadKey((await generatePrivateKey()).privateKey);
	const id = vectors.media_id;
	const anotherId = "ab".repeat(32);
	const plain = utf8("same plaintext");
	const nonce = new Uint8Array(12).fill(0x99);
	const metadata = await withNonce(t, nonce, () =>
		sealMetadata(key.fileKeyMaterial, id, plain),
	);
	const descriptor = await withNonce(t, nonce, () =>
		sealDescriptorBytes(key.fileKeyMaterial, id, plain),
	);
	const another = await withNonce(t, nonce, () =>
		sealMetadata(key.fileKeyMaterial, anotherId, plain),
	);
	// Compare ciphertext excluding authentication tags: distinct AAD alone would
	// change tags, but not the encryption stream under a reused key/nonce.
	const ciphertext = (blob: Uint8Array) =>
		(decode(blob) as { ct: Uint8Array }).ct.slice(0, -16);
	assert.notDeepEqual(ciphertext(metadata), ciphertext(descriptor));
	assert.notDeepEqual(ciphertext(metadata), ciphertext(another));
	assert.deepEqual(
		await openDescriptorBytes(key.fileKeyMaterial, id, descriptor),
		plain,
	);
	await assert.rejects(openMetadata(key.fileKeyMaterial, anotherId, metadata));
	await assert.rejects(openMetadata(other.fileKeyMaterial, id, metadata));
	await assert.rejects(openMetadata(key.fileKeyMaterial, id, descriptor));
	await assert.rejects(openDescriptorBytes(key.fileKeyMaterial, id, metadata));
	for (const invalid of ["", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
		await assert.rejects(
			sealMetadata(key.fileKeyMaterial, invalid, plain),
			/identifier/,
		);
		await assert.rejects(
			openMetadata(key.fileKeyMaterial, invalid, metadata),
			/identifier/,
		);
		await assert.rejects(
			sealDescriptorBytes(key.fileKeyMaterial, invalid, plain),
			/identifier/,
		);
		await assert.rejects(
			openDescriptorBytes(key.fileKeyMaterial, invalid, descriptor),
			/identifier/,
		);
	}
	const corrupt = metadata.slice();
	corrupt[corrupt.length - 1] ^= 1;
	for (const invalid of [
		corrupt,
		metadata.slice(0, -1),
		new Uint8Array(),
		encode({ v: 2, iv: nonce, ct: new Uint8Array(16) }),
		encode({ v: 1, iv: new Uint8Array(11), ct: new Uint8Array(16) }),
		encode({ v: 1, iv: nonce, ct: new Uint8Array(15) }),
	]) {
		await assert.rejects(openMetadata(key.fileKeyMaterial, id, invalid));
	}
});

test("metadata edits use fresh nonces while the descriptor remains usable", async () => {
	const key = await loadKey((await generatePrivateKey()).privateKey);
	const id = "ab".repeat(32);
	const descriptor = await sealDescriptorBytes(
		key.fileKeyMaterial,
		id,
		utf8("immutable"),
	);
	const before = descriptor.slice();
	const first = await sealMetadata(key.fileKeyMaterial, id, utf8("first"));
	const second = await sealMetadata(key.fileKeyMaterial, id, utf8("second"));
	assert.notDeepEqual(
		(decode(first) as { iv: Uint8Array }).iv,
		(decode(second) as { iv: Uint8Array }).iv,
	);
	assert.deepEqual(
		await openMetadata(key.fileKeyMaterial, id, first),
		utf8("first"),
	);
	assert.deepEqual(
		await openMetadata(key.fileKeyMaterial, id, second),
		utf8("second"),
	);
	assert.deepEqual(descriptor, before);
	assert.deepEqual(
		await openDescriptorBytes(key.fileKeyMaterial, id, descriptor),
		utf8("immutable"),
	);
});

test("encryption operations use non-extractable AES keys", async (t) => {
	const key = await loadKey((await generatePrivateKey()).privateKey);
	const encryption = t.mock.method(crypto.subtle, "encrypt");
	const id = "ab".repeat(32);
	await sealMetadata(key.fileKeyMaterial, id, utf8("metadata"));
	await sealDescriptorBytes(key.fileKeyMaterial, id, utf8("descriptor"));
	await sealTagLabel(key.tagLabelKey, "token", utf8("label"));
	assert.equal(encryption.mock.calls.length, 3);
	for (const call of encryption.mock.calls) {
		const aes = call.arguments[1];
		assert.equal(aes.extractable, false);
		assert.equal(aes.algorithm.name, "AES-GCM");
		await assert.rejects(crypto.subtle.exportKey("raw", aes));
	}
	await assert.rejects(crypto.subtle.exportKey("raw", key.fileKeyMaterial));
});
