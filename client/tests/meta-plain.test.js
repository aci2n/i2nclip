import assert from "node:assert/strict";
import test from "node:test";

import {
	decodeMetaPlain,
	encodeMetaPlain,
	MAX_META_PLAINTEXT,
} from "../src/lib/protocol/meta-plain.js";

test("metadata stores camelCase JSON verbatim and keeps thumbnails outside JSON", () => {
	const meta = {
		name: "dot.png",
		contentType: "image/png",
		size: 42,
		tags: ["a"],
		image: { width: 1, height: 1 },
		sourceUrl: "https://example.com/photo",
		sourceTitle: "Example photo",
		extra_data: { cameraModel: "Example", camera_model: "Custom" },
	};
	const thumb = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // not a real webp; length check only
	const original = structuredClone(meta);
	const packed = encodeMetaPlain(meta, thumb);
	const jsonLength = new DataView(
		packed.buffer,
		packed.byteOffset,
		4,
	).getUint32(0);
	const stored = JSON.parse(
		new TextDecoder().decode(packed.subarray(4, 4 + jsonLength)),
	);
	assert.deepEqual(stored, original);
	assert.deepEqual(meta, original);
	const back = decodeMetaPlain(packed);
	assert.deepEqual(back.metadata, meta);
	assert.deepEqual(back.thumb, thumb);

	const empty = decodeMetaPlain(encodeMetaPlain(meta, null));
	assert.deepEqual(empty.metadata, meta);
	assert.equal(empty.thumb, null);
});

test("encode drops nothing when under the metadata cap", () => {
	const meta = { name: "x", contentType: "image/jpeg", size: 1, tags: [] };
	const thumb = Uint8Array.from({ length: 8000 }, (_, i) => i % 256);
	const packed = encodeMetaPlain(meta, thumb);
	assert.ok(packed.length <= MAX_META_PLAINTEXT);
	const decoded = decodeMetaPlain(packed);
	assert.deepEqual(decoded.metadata, meta);
	assert.deepEqual(decoded.thumb, thumb);
});
