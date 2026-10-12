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
import { exportRecovery, openRecovery } from "../src/lib/protocol/recovery.js";

test("portable recovery preserves content decryption, normalized tags and public identity", async () => {
	const created = await generatePrivateKey();
	const original = await loadKey(created.privateKey);
	const text = await exportRecovery(
		{
			serverUrl: "https://clip.example.com",
			privateKey: created.privateKey,
		},
		"test password",
	);
	assert(!text.includes(JSON.parse(created.privateKey).seed));
	await assert.rejects(openRecovery(text, "wrong"), /Wrong password/);
	const recovered = await openRecovery(text, "test password");
	assert.deepEqual(Object.keys(recovered).sort(), ["privateKey", "serverUrl"]);
	const restored = await loadKey(recovered.privateKey);
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
		{ v: 99 },
		{ encrypted: { v: 2 } },
		{ encrypted: { ...JSON.parse(text).encrypted, iterations: 9_000_000 } },
		{ encrypted: { ...JSON.parse(text).encrypted, salt: "AAAA" } },
		{ encrypted: { ...JSON.parse(text).encrypted, iv: "AAAA" } },
	]) {
		await assert.rejects(
			openRecovery(
				JSON.stringify({ ...JSON.parse(text), ...changed }),
				"test password",
			),
			/Invalid|Wrong password/,
		);
	}
	await assert.rejects(
		exportRecovery(
			{
				serverUrl: "javascript:alert(1)",
				privateKey: created.privateKey,
			},
			"test password",
		),
	);
});
