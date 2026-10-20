import assert from "node:assert/strict";
import test from "node:test";
import { bytesToHex, hexToBytes } from "../src/lib/protocol/bytes.ts";
import { openObject, sha256 } from "../src/lib/protocol/chain.ts";
import {
	CHUNK_BYTES,
	decryptChunk,
	encryptChunk,
} from "../src/lib/protocol/content.ts";
import {
	decodeManifest,
	encodeFileMetadata,
	encodeManifest,
	manifestSize,
	newFileContent,
	openFileMetadata,
	openManifest,
	sealFileMetadata,
	sealManifest,
	sealThumbnail,
} from "../src/lib/protocol/file-objects.ts";
import { MAX_META_PLAINTEXT } from "../src/lib/protocol/meta-plain.ts";
import { encode } from "../src/lib/protocol/msgpack.ts";

const bytes = (n: number) => new Uint8Array(32).fill(n);

test("manifests rebuild authenticated v2 content from ordered ciphertext hashes", async () => {
	const { content, rawKey } = await newFileContent(CHUNK_BYTES + 1);
	const file = hexToBytes(content.id);
	const library = bytes(1);
	const plain = [new Uint8Array(CHUNK_BYTES).fill(9), new Uint8Array([7])];
	const chunks = await Promise.all(
		plain.map((value, index) => encryptChunk(content, index, value)),
	);
	const hashes = await Promise.all(chunks.map(sha256));
	const sealed = await sealManifest(
		library,
		file,
		content.size,
		rawKey,
		hashes,
	);
	rawKey.fill(0);
	const rebuilt = await openManifest(library, file, sealed, sealed.bytes);
	assert.deepEqual(rebuilt.hashes, hashes);
	assert.equal(rebuilt.content.key.extractable, false);
	for (const [index, chunk] of chunks.entries()) {
		assert.deepEqual(
			await decryptChunk(rebuilt.content, index, chunk),
			plain[index],
		);
	}
	await assert.rejects(openManifest(library, bytes(3), sealed, sealed.bytes));
	await assert.rejects(
		decryptChunk(
			{ ...rebuilt.content, id: bytesToHex(bytes(3)) },
			1,
			chunks[1] as Uint8Array<ArrayBuffer>,
		),
	);
	const changed = sealed.bytes.slice();
	changed[changed.length - 1] ^= 1;
	await assert.rejects(
		openManifest(library, file, sealed, changed),
		/hash mismatch/,
	);
});

test("manifest preflight accounts for array widths and rejects huge dimensions without allocating hashes", async () => {
	for (const count of [1, 15, 16, 65_535, 65_536]) {
		const size = (count - 1) * CHUNK_BYTES + 1;
		const hashes = Array.from({ length: count }, () => bytes(1));
		assert.equal(
			encodeManifest(size, bytes(2), hashes).length,
			manifestSize(size),
		);
	}
	assert.throws(() => manifestSize(10 ** 15), /manifest larger/);
	assert.throws(() => manifestSize(-1), /size/);
	await assert.rejects(newFileContent(Number.MAX_SAFE_INTEGER));
	assert.throws(
		() => encodeManifest(CHUNK_BYTES + 1, bytes(2), [bytes(1)]),
		/chunk count/,
	);
	const invalid = encode([
		1,
		1,
		CHUNK_BYTES,
		2,
		bytes(2),
		[bytes(1), bytes(3)],
	]);
	await assert.rejects(decodeManifest(bytes(1), invalid), /dimensions/);
});

test("empty files retain one authenticated empty chunk", async () => {
	const { content, rawKey } = await newFileContent(0);
	const encrypted = await encryptChunk(content, 0, new Uint8Array());
	assert.equal(encrypted.length, 16);
	const manifest = await decodeManifest(
		hexToBytes(content.id),
		encodeManifest(0, rawKey, [await sha256(encrypted)]),
	);
	rawKey.fill(0);
	assert.deepEqual(
		await decryptChunk(manifest.content, 0, encrypted),
		new Uint8Array(),
	);
});

test("metadata preserves unknown attributes and thumbnail references without embedding thumbnail content", async () => {
	const library = bytes(1);
	const file = bytes(2);
	const preview = new Uint8Array([1, 2, 3]);
	const thumbnail = await sealThumbnail(library, file, preview);
	const attributes = {
		name: "photo",
		tags: [" Vacation ", "vacation", "Home"],
		custom: { binary: new Uint8Array([7, 8]) },
	};
	const reference = { hash: thumbnail.hash, key: thumbnail.key };
	const first = await sealFileMetadata(library, file, {
		attributes,
		thumbnail: reference,
	});
	const opened = await openFileMetadata(library, file, first, first.bytes);
	assert.deepEqual(opened.attributes.tags, ["Vacation", "Home"]);
	assert.deepEqual(opened.attributes.custom, attributes.custom);
	assert.deepEqual(opened.thumbnail, reference);
	assert.deepEqual(
		await openObject(
			library,
			file,
			"thumbnail",
			thumbnail.hash,
			thumbnail.key,
			thumbnail.bytes,
		),
		preview,
	);
	const updated = await sealFileMetadata(library, file, {
		attributes: { ...opened.attributes, name: "renamed" },
		thumbnail: opened.thumbnail,
	});
	assert.notDeepEqual(first.hash, updated.hash);
	assert.notDeepEqual(first.key, updated.key);
	assert.equal(
		(await openFileMetadata(library, file, first, first.bytes)).attributes.name,
		"photo",
	);
	assert.equal(
		(await openFileMetadata(library, file, updated, updated.bytes)).attributes
			.name,
		"renamed",
	);
	await assert.rejects(openFileMetadata(library, bytes(3), first, first.bytes));
	assert.throws(
		() =>
			encodeFileMetadata({
				attributes: { name: "x".repeat(MAX_META_PLAINTEXT) },
				thumbnail: null,
			}),
		/limit/,
	);
});
