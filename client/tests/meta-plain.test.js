import assert from "node:assert/strict";
import test from "node:test";
import {
	decodeMetaPlain,
	encodeMetaPlain,
	MAX_META_PLAINTEXT,
} from "../src/lib/protocol/meta-plain.js";
import { decode, encode } from "../src/lib/protocol/msgpack.js";

test("metadata preserves extensible fields and binary thumbnails", () => {
	const meta = {
		name: "dot.png",
		content_type: "image/png",
		size: 42,
		tags: ["a"],
		image: { width: 1, height: 1 },
		source_url: "https://example.com/photo",
		source_title: "Example photo",
		extra_data: { cameraModel: "Example", camera_model: "Custom" },
	};
	const thumb = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // not a real webp; length check only
	const original = structuredClone(meta);
	const packed = encodeMetaPlain(meta, thumb);
	const stored = decode(packed).metadata;
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
	const meta = { name: "x", content_type: "image/jpeg", size: 1, tags: [] };
	const thumb = Uint8Array.from({ length: 8000 }, (_, i) => i % 256);
	const packed = encodeMetaPlain(meta, thumb);
	assert.ok(packed.length <= MAX_META_PLAINTEXT);
	const decoded = decodeMetaPlain(packed);
	assert.deepEqual(decoded.metadata, meta);
	assert.deepEqual(decoded.thumb, thumb);
});

test("metadata rejects malformed documents and trailing values", () => {
	for (const value of [
		null,
		{},
		{ metadata: [], thumb: null },
		{ metadata: {}, thumb: "bad" },
	]) {
		assert.throws(() => decodeMetaPlain(encode(value)));
	}
	const bytes = encodeMetaPlain({ name: "x" }, null);
	assert.throws(() => decodeMetaPlain(new Uint8Array([...bytes, 0xc0])));
});
