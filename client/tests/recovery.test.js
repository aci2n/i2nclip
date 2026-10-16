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
import { decode, encode } from "../src/lib/protocol/msgpack.js";
import { exportRecovery, openRecovery } from "../src/lib/protocol/recovery.js";

test("portable recovery preserves content decryption, normalized tags and public identity", async () => {
	const created = await generatePrivateKey();
	const original = await loadKey(created.privateKey);
	const text = await exportRecovery(
		{
			server_url: "https://clip.example.com",
			private_key: created.privateKey,
		},
		"test password",
	);
	assert(!Buffer.from(text).includes(created.privateKey.seed));
	await assert.rejects(openRecovery(text, "wrong"), /Wrong password/);
	const { identity: recovered, key: restored } = await openRecovery(
		text,
		"test password",
	);
	assert.deepEqual(Object.keys(recovered).sort(), [
		"private_key",
		"server_url",
	]);
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
		{ encrypted: { ...decode(text).encrypted, iterations: 9_000_000 } },
		{ encrypted: { ...decode(text).encrypted, salt: "AAAA" } },
		{ encrypted: { ...decode(text).encrypted, iv: "AAAA" } },
	]) {
		await assert.rejects(
			openRecovery(encode({ ...decode(text), ...changed }), "test password"),
			/Invalid|Wrong password/,
		);
	}
	await assert.rejects(
		exportRecovery(
			{
				server_url: "javascript:alert(1)",
				private_key: created.privateKey,
			},
			"test password",
		),
	);
});
