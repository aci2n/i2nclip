import assert from "node:assert/strict";
import test from "node:test";
import {
	b64urlToBytes,
	bytesToHex,
	hexToBytes,
	utf8,
} from "../src/lib/protocol/bytes.ts";
import {
	authorizationHeader,
	bodyHash,
	contentAad,
	decrypt,
	encrypt,
	loadKey,
	metaAad,
	requestMessage,
	tagToken,
} from "../src/lib/protocol/crypto.ts";
import { encodeMeta, encodeUpload } from "../src/lib/protocol/frame.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";

import vectors from "./test-vectors.json" with { type: "json" };

test("library identity matches the rust vectors", async () => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	assert.equal(bytesToHex(key.publicKey), vectors.public_hex);
	assert.equal(key.registrationKey, vectors.public_key);
	assert.equal(await tagToken(key, vectors.tag), vectors.token);
	assert.equal(await tagToken(key, " vacation "), vectors.token);
	assert.equal(await tagToken(key, vectors.cafe_tag), vectors.cafe_token);

	const nonce = hexToBytes(vectors.nonce_hex);
	const content = await encrypt(
		key,
		contentAad(),
		utf8(vectors.plaintext_utf8),
		nonce,
	);
	assert.equal(bytesToHex(content), vectors.ciphertext_hex);
	assert.equal(await bodyHash(content), vectors.media_id);
	assert.equal(
		new TextDecoder().decode(await decrypt(key, contentAad(), content)),
		vectors.plaintext_utf8,
	);
	assert.equal(new TextDecoder().decode(contentAad()), vectors.aad);

	const meta = await encrypt(
		key,
		metaAad(vectors.media_id),
		hexToBytes(vectors.meta_plaintext_hex),
		nonce,
	);
	assert.equal(bytesToHex(meta), vectors.meta_ciphertext_hex);
	const frame = encodeUpload({
		meta,
		content,
		tags: [
			{
				token: b64urlToBytes(vectors.token),
				label: encode({ v: 1, iv: new Uint8Array(12), ct: new Uint8Array(17) }),
			},
		],
	});
	assert.equal(bytesToHex(frame), vectors.frame_hex);

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

test("metadata is authenticated against the sealed-content hash", async () => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const meta = hexToBytes(vectors.meta_ciphertext_hex);
	await assert.rejects(decrypt(key, metaAad("0".repeat(64)), meta));
	assert.equal(
		bytesToHex(await decrypt(key, metaAad(vectors.media_id), meta)),
		vectors.meta_plaintext_hex,
	);
});
