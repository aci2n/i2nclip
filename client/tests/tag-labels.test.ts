import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getTags } from "../src/lib/api.ts";
import {
	b64urlToBytes,
	bytesToHex,
	hexToBytes,
	utf8,
} from "../src/lib/protocol/bytes.ts";
import { encrypt, loadKey, tagToken } from "../src/lib/protocol/crypto.ts";
import { decode } from "../src/lib/protocol/msgpack.ts";
import {
	openTag,
	sealTags,
	tagLabelAad,
} from "../src/lib/protocol/tag-labels.ts";
import { bytes as binary, document } from "../src/lib/protocol/value.ts";
import { documentResponse } from "./msgpack-response.ts";

const vectors = JSON.parse(
	readFileSync(new URL("./test-vectors.json", import.meta.url), "utf8"),
);

test("tag labels share Rust vectors and bind ciphertext to the token", async () => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const aad = tagLabelAad(vectors.token);
	assert.equal(new TextDecoder().decode(aad), vectors.tag_label_aad);
	const sealed = await encrypt(
		key,
		aad,
		utf8("Vacation"),
		hexToBytes(vectors.nonce_hex),
	);
	assert.equal(bytesToHex(sealed), vectors.tag_label_hex);
	const pair = { token: b64urlToBytes(vectors.token), label: sealed };
	assert.equal(await openTag(key, pair), "Vacation");
	await assert.rejects(
		openTag(key, {
			...pair,
			token: b64urlToBytes(await tagToken(key, "other")),
		}),
	);
	sealed[sealed.length - 1] ^= 1;
	await assert.rejects(openTag(key, { ...pair, label: sealed }));
	const mismatch = await encrypt(key, aad, utf8("Other"));
	await assert.rejects(
		openTag(key, { ...pair, label: mismatch }),
		/does not match/,
	);
});

test("catalog isolates damaged entries and seals at most 64 distinct tags", async (t) => {
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	const tags = await sealTags(key, ["Vacation", "vacation", "Café"]);
	assert.equal(tags.length, 2);
	t.mock.method(globalThis, "fetch", async () =>
		documentResponse({
			tags: [tags[0], { token: tags[0].token, label: "invalid" }, tags[1]],
		}),
	);
	assert.deepEqual(await getTags({ key, serverUrl: "https://clip.example" }), {
		tags: ["Café", "Vacation"],
		invalid: 1,
	});
	assert.equal(
		(
			await sealTags(
				key,
				Array.from({ length: 64 }, (_, i) => `tag${i}`),
			)
		).length,
		64,
	);
	await assert.rejects(
		sealTags(
			key,
			Array.from({ length: 65 }, (_, i) => `tag${i}`),
		),
		/maximum 64/,
	);
});

test("upload labels and encrypted metadata contain the same ordinary tags", async (t) => {
	const { upload } = await import("../src/lib/api.ts");
	const { decodeMetaPlain } = await import("../src/lib/protocol/meta-plain.ts");
	const { decrypt, metaAad } = await import("../src/lib/protocol/crypto.ts");
	const key = await loadKey(decode(hexToBytes(vectors.private_key_hex)));
	let frame: unknown;
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: string | URL | Request, options: RequestInit = {}) => {
			frame = options.body;
			return documentResponse({ id: "saved", created_at: 1 });
		},
	);
	const saved = await upload({
		serverUrl: "https://clip.example",
		key,
		bytes: new Uint8Array([1]),
		name: "Summer holiday.txt",
		contentType: "text/plain",
	});
	const packet = document(decode(binary(frame)));
	const metadata = binary(packet.meta);
	const content = binary(packet.content);
	const tags = packet.tags;
	assert(Array.isArray(tags));
	const { bodyHash } = await import("../src/lib/protocol/crypto.ts");
	const opened = decodeMetaPlain(
		await decrypt(key, metaAad(await bodyHash(content)), metadata),
	);
	assert.deepEqual(opened.metadata.tags, saved.metadata.tags);
	assert.deepEqual(
		await Promise.all(tags.map((tag: unknown) => openTag(key, tag))),
		saved.metadata.tags,
	);
	assert(!new TextDecoder().decode(binary(frame)).includes("holiday"));
});
