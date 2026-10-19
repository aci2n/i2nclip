import assert from "node:assert/strict";
import test from "node:test";
import { utf8 } from "../src/lib/protocol/bytes.ts";
import {
	createContent,
	decryptChunk,
	encryptChunk,
	openDescriptor,
} from "../src/lib/protocol/content.ts";
import {
	loadKey,
	openMetadata,
	sealMetadata,
	tagToken,
} from "../src/lib/protocol/crypto.ts";
import { generatePrivateKey } from "../src/lib/protocol/identity.ts";
import { decode, encode } from "../src/lib/protocol/msgpack.ts";
import { exportRecovery, openRecovery } from "../src/lib/protocol/recovery.ts";
import { document } from "../src/lib/protocol/value.ts";

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
	assert(!Buffer.from(text).includes(Buffer.from(created.privateKey.seed)));
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
	const plain = utf8("original upload");
	const { descriptor, content } = await createContent(original, plain.length);
	const chunk = await encryptChunk(content, 0, plain);
	const reopened = await openDescriptor(restored, content.id, descriptor);
	assert.deepEqual(await decryptChunk(reopened, 0, chunk), plain);
	const id = content.id;
	const ciphertext = await sealMetadata(
		original.fileKeyMaterial,
		id,
		utf8("original upload"),
	);
	assert.equal(
		new TextDecoder().decode(
			await openMetadata(restored.fileKeyMaterial, id, ciphertext),
		),
		"original upload",
	);
	for (const changed of [
		{ v: 99 },
		{ encrypted: { v: 2 } },
		{
			encrypted: {
				...document(document(decode(text)).encrypted),
				iterations: 9_000_000,
			},
		},
		{
			encrypted: {
				...document(document(decode(text)).encrypted),
				salt: "AAAA",
			},
		},
		{
			encrypted: { ...document(document(decode(text)).encrypted), iv: "AAAA" },
		},
	]) {
		await assert.rejects(
			openRecovery(
				encode({ ...document(decode(text)), ...changed }),
				"test password",
			),
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
