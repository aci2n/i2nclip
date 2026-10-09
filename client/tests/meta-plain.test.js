import assert from "node:assert/strict";
import test from "node:test";

import { decodeMetaPlain, encodeMetaPlain, MAX_META_PLAINTEXT } from "../src/lib/meta-plain.js";

test("meta plain roundtrips with and without a thumb", () => {
  const meta = {
    name: "dot.png",
    content_type: "image/png",
    size: 42,
    tags: ["a"],
    image: { width: 1, height: 1 },
  };
  const thumb = new Uint8Array([0x52, 0x49, 0x46, 0x46]); // not a real webp; length check only
  const packed = encodeMetaPlain(meta, thumb);
  const back = decodeMetaPlain(packed);
  assert.deepEqual(back.metadata, meta);
  assert.deepEqual(back.thumb, thumb);

  const empty = decodeMetaPlain(encodeMetaPlain(meta, null));
  assert.deepEqual(empty.metadata, meta);
  assert.equal(empty.thumb, null);
});

test("encode drops nothing when under the metadata cap", () => {
  const meta = { name: "x", content_type: "image/jpeg", size: 1, tags: [] };
  const thumb = new Uint8Array(8000);
  assert.ok(encodeMetaPlain(meta, thumb).length <= MAX_META_PLAINTEXT);
});
