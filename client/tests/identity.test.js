import assert from "node:assert/strict";
import test from "node:test";
import { loadKey } from "../src/lib/protocol/crypto.js";
import {
	generatePrivateKey,
	parsePrivateKey,
} from "../src/lib/protocol/identity.js";

test("generated identities load and mismatched public keys are rejected", async () => {
	const first = await generatePrivateKey();
	const second = await generatePrivateKey();
	const key = await loadKey(first.privateKey);
	assert.equal(key.registrationKey, first.publicKey);
	assert.equal(key.privateCryptoKey.extractable, false);
	assert.equal(key.encryptionKey.extractable, false);
	assert.equal(key.tagKey.extractable, false);
	assert.equal(Object.hasOwn(key, "seed"), false);
	assert.equal(parsePrivateKey(first.privateKey).seed.length, 32);
	const mismatched = {
		...first.privateKey,
		public_key: second.privateKey.public_key,
	};
	await assert.rejects(loadKey(mismatched), /does not match/);
	for (const text of [
		"invalid",
		"null",
		'{"v":2}',
		'{"v":1,"seed":"AAAA","publicKey":"AAAA"}',
	]) {
		assert.throws(() => parsePrivateKey(text), /Invalid library identity/);
	}
});

test("loading keys preserves the document and copies borrowed decoded fields", async () => {
	const { encode, decode } = await import("../src/lib/protocol/msgpack.js");
	const { privateKey } = await generatePrivateKey();
	const bytes = encode(privateKey);
	const decoded = decode(bytes);
	const parsed = parsePrivateKey(decoded);
	bytes.fill(0);
	assert.deepEqual(parsed.seed, privateKey.seed);
	await loadKey(privateKey);
	await loadKey(privateKey);
	assert(privateKey.seed.some((byte) => byte !== 0));
});
