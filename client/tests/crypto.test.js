import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bytesToHex, hexToBytes, utf8 } from "../src/lib/protocol/bytes.js";
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
} from "../src/lib/protocol/crypto.js";
import { encodePost } from "../src/lib/protocol/frame.js";

const vectors = JSON.parse(
	readFileSync(new URL("./test-vectors.json", import.meta.url), "utf8"),
);

test("library identity matches the rust vectors", async () => {
	const key = await loadKey(vectors.private_key);
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
		utf8(vectors.meta_json),
		nonce,
	);
	assert.equal(bytesToHex(meta), vectors.meta_ciphertext_hex);
	const frame = encodePost({
		meta,
		content,
		tags: vectors.token,
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

test("metadata is authenticated against the sealed-content hash", async () => {
	const key = await loadKey(vectors.private_key);
	const meta = hexToBytes(vectors.meta_ciphertext_hex);
	await assert.rejects(decrypt(key, metaAad("0".repeat(64)), meta));
	assert.equal(
		new TextDecoder().decode(
			await decrypt(key, metaAad(vectors.media_id), meta),
		),
		vectors.meta_json,
	);
});
