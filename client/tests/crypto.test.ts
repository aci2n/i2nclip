import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hexToBytes, utf8 } from "../src/lib/protocol/bytes.ts";
import {
	authorizationHeader,
	loadSigningKey,
	requestMessage,
} from "../src/lib/protocol/crypto.ts";
import { decode } from "../src/lib/protocol/msgpack.ts";
import vectors from "./test-vectors.json" with { type: "json" };

test("native signing identities and HTTP proofs match independent Rust vectors", async () => {
	const key = await loadSigningKey(decode(hexToBytes(vectors.private_key_hex)));
	assert.equal(bytesToHex(key.publicKey), vectors.public_hex);
	assert.equal(key.registrationKey, vectors.public_key);
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
			body: utf8(vectors.sign_body_utf8),
		}),
		vectors.authorization,
	);
});
