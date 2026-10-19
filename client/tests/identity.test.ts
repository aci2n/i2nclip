import assert from "node:assert/strict";
import test from "node:test";
import { loadKey } from "../src/lib/protocol/crypto.ts";
import {
	generatePrivateKey,
	parsePrivateKey,
} from "../src/lib/protocol/identity.ts";

test("generated identities load and mismatched public keys are rejected", async () => {
	const first = await generatePrivateKey();
	const second = await generatePrivateKey();
	const key = await loadKey(first.privateKey);
	assert.equal(key.registrationKey, first.publicKey);
	assert.equal(key.privateCryptoKey.extractable, false);
	assert.equal(key.fileKeyMaterial.extractable, false);
	assert.equal(key.tagTokenKey.extractable, false);
	assert.equal(key.tagLabelKey.extractable, false);
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
	const { encode, decode } = await import("../src/lib/protocol/msgpack.ts");
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

for (const fail of [false, true]) {
	test(`loading wipes temporary seed copies on ${fail ? "failure" : "success"}`, async (t) => {
		const { privateKey } = await generatePrivateKey();
		const seed = privateKey.seed.slice();
		const imported = t.mock.method(crypto.subtle, "importKey");
		if (fail) {
			t.mock.method(crypto.subtle, "deriveKey", async () => {
				throw new Error("derivation failed");
			});
			await assert.rejects(loadKey(privateKey), /derivation failed/);
		} else {
			await loadKey(privateKey);
		}
		const copies = imported.mock.calls
			.filter(
				({ arguments: args }) => args[0] === "pkcs8" || args[2] === "HKDF",
			)
			.map(({ arguments: args }) => args[1]);
		assert.equal(copies.length, 2);
		for (const copy of copies) {
			assert(copy instanceof Uint8Array);
			assert(copy.every((byte) => byte === 0));
		}
		assert.deepEqual(privateKey.seed, seed);
	});
}
