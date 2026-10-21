import assert from "node:assert/strict";
import test from "node:test";
import { loadSigningKey } from "../src/lib/protocol/crypto.ts";
import {
	generatePrivateKey,
	parsePrivateKey,
} from "../src/lib/protocol/identity.ts";

test("generated identities load and mismatched public keys are rejected", async () => {
	const first = await generatePrivateKey();
	const second = await generatePrivateKey();
	const key = await loadSigningKey(first.privateKey);
	assert.equal(key.registrationKey, first.publicKey);
	assert.equal(key.privateCryptoKey.extractable, false);
	assert.equal(Object.hasOwn(key, "seed"), false);
	assert.equal(parsePrivateKey(first.privateKey).seed.length, 32);
	const mismatched = {
		...first.privateKey,
		public_key: second.privateKey.public_key,
	};
	await assert.rejects(loadSigningKey(mismatched), /does not match/);
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
	await loadSigningKey(privateKey);
	await loadSigningKey(privateKey);
	assert(privateKey.seed.some((byte) => byte !== 0));
});

for (const fail of [false, true]) {
	test(`loading wipes temporary seed copies on ${fail ? "failure" : "success"}`, async (t) => {
		const { privateKey } = await generatePrivateKey();
		const seed = privateKey.seed.slice();
		const nativeImport = crypto.subtle.importKey.bind(crypto.subtle);
		const imported = t.mock.method(
			crypto.subtle,
			"importKey",
			(...args: Parameters<typeof crypto.subtle.importKey>) => {
				if (fail) {
					throw new Error("import failed");
				}
				return nativeImport(...args);
			},
		);
		if (fail) {
			await assert.rejects(loadSigningKey(privateKey), /import failed/);
		} else {
			await loadSigningKey(privateKey);
		}
		const copies = imported.mock.calls
			.filter(
				({ arguments: args }) => args[0] === "pkcs8" || args[2] === "HKDF",
			)
			.map(({ arguments: args }) => args[1]);
		assert.equal(copies.length, 1);
		for (const copy of copies) {
			assert(copy instanceof Uint8Array);
			assert(copy.every((byte) => byte === 0));
		}
		assert.deepEqual(privateKey.seed, seed);
	});
}
