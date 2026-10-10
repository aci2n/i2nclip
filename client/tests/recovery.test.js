import assert from "node:assert/strict";
import test from "node:test";
import { utf8 } from "../src/lib/protocol/bytes.js";
import {
	contentAad,
	decrypt,
	encrypt,
	loadKey,
	tagToken,
} from "../src/lib/protocol/crypto.js";
import { generatePrivateKey } from "../src/lib/protocol/identity.js";
import {
	parseRecoveryFile,
	recoveryFile,
} from "../src/lib/protocol/recovery.js";
import { unwrapPrivateKey, wrapPrivateKey } from "../src/lib/protocol/vault.js";

test("encrypted recovery preserves decryption, tags and identity", async () => {
	const created = await generatePrivateKey();
	const original = await loadKey(created.privateKey);
	const wrappedKey = await wrapPrivateKey(
		created.privateKey,
		"test password",
		1000,
	);
	const text = recoveryFile({
		serverUrl: "https://clip.example.com",
		wrappedKey,
	});
	assert.equal(text.includes(JSON.parse(created.privateKey).seed), false);
	const recovered = parseRecoveryFile(text);
	await assert.rejects(
		unwrapPrivateKey(recovered.wrappedKey, "wrong"),
		/Wrong password/,
	);
	const restored = await loadKey(
		await unwrapPrivateKey(recovered.wrappedKey, "test password"),
	);
	assert.equal(restored.registrationKey, original.registrationKey);
	assert.equal(
		await tagToken(restored, "vacation"),
		await tagToken(original, "vacation"),
	);
	const aad = contentAad("test");
	const ciphertext = await encrypt(original, aad, utf8("original upload"));
	assert.equal(
		new TextDecoder().decode(await decrypt(restored, aad, ciphertext)),
		"original upload",
	);
	for (const changed of [
		{ v: 2 },
		{ serverUrl: "javascript:alert(1)" },
		{ wrappedKey: { ...wrappedKey, v: 2 } },
		{ wrappedKey: { ...wrappedKey, iterations: 9_000_000 } },
		{ wrappedKey: { ...wrappedKey, salt: "AAAA" } },
		{ wrappedKey: { ...wrappedKey, ct: "!!!!" } },
	]) {
		assert.throws(
			() =>
				parseRecoveryFile(JSON.stringify({ ...JSON.parse(text), ...changed })),
			/Invalid/,
		);
	}
});
